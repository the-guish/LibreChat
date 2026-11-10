import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { AclEntryStore, StoreTransaction, StoreTransactions } from '~/ports';
import type * as t from '~/types';
import { createMongoStoreTransactionMethods } from './storeTransactions';
import { createAclEntryMethods } from '~/methods/aclEntry';
import aclEntrySchema from '~/schema/aclEntry';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const AclEntry: mongoose.Model<t.IAclEntry> =
  mongoose.models.AclEntry || mongoose.model<t.IAclEntry>('AclEntry', aclEntrySchema);

/** The stores as a port caller sees them. */
let acl: AclEntryStore;
let stores: StoreTransactions;

const resourceType = ResourceType.AGENT;

/**
 * Readies the ACL collection on the current connection before any test runs. Mongoose creates a
 * model's collection and builds its indexes in the background once it connects, and
 * `createCollection()` alone does not wait for those builds; a transaction that writes while one
 * is still running fails with a catalog-change error ("Unable to write to collection … due to
 * catalog changes") or a lock timeout. So wait for mongoose's own initialization, then make sure
 * the collection and every index exist on this connection (mongoose does not rebuild them after a
 * reconnect to another server) before any transaction starts.
 */
async function prepareAclCollection() {
  await AclEntry.init();
  await AclEntry.createCollection();
  await AclEntry.ensureIndexes();
}

function userEntryFilter(resourceId: Types.ObjectId, principalId: Types.ObjectId) {
  return { principalType: PrincipalType.USER, principalId, resourceType, resourceId };
}

function grantUser(
  resourceId: Types.ObjectId,
  principalId: Types.ObjectId,
  permBits: number,
  tx?: StoreTransaction,
) {
  return acl.grantPermission(
    PrincipalType.USER,
    principalId,
    resourceType,
    resourceId,
    permBits,
    principalId,
    tx,
  );
}

describe('MongoDB store transactions', () => {
  describe('with transaction support (replica set)', () => {
    let replSet: MongoMemoryReplSet;

    beforeAll(async () => {
      replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      await mongoose.connect(replSet.getUri());
      await prepareAclCollection();
      acl = createAclEntryMethods(mongoose);
      stores = createMongoStoreTransactionMethods(mongoose);
    });

    afterAll(async () => {
      await mongoose.disconnect();
      await replSet.stop();
    });

    beforeEach(async () => {
      await AclEntry.deleteMany({});
      jest.clearAllMocks();
    });

    it('hands the callback a transaction and resolves to what the callback resolves to', async () => {
      let received: StoreTransaction | undefined;
      const result = await stores.transaction(async (tx) => {
        received = tx;
        expect((tx as ClientSession).inTransaction()).toBe(true);
        return 'done';
      });
      expect(result).toBe('done');
      expect(received).toBeDefined();
      expect((received as ClientSession).hasEnded).toBe(true);
    });

    it('commits the writes made with the transaction, unseen outside it until then', async () => {
      const resourceId = new Types.ObjectId();
      const userId = new Types.ObjectId();

      await stores.transaction(async (tx) => {
        await grantUser(resourceId, userId, 1, tx);
        const inside = await acl.findEntriesByPrincipalsAndResource(
          [{ principalType: PrincipalType.USER, principalId: userId }],
          resourceType,
          resourceId,
          tx,
        );
        expect(inside.map((entry) => entry.permBits)).toEqual([1]);
        expect(await acl.findEntriesByResource(resourceType, resourceId)).toEqual([]);
      });

      const entries = await acl.findEntriesByResource(resourceType, resourceId);
      expect(entries.map((entry) => entry.permBits)).toEqual([1]);
    });

    it('rolls back every write made with the transaction and rethrows the error', async () => {
      const resourceId = new Types.ObjectId();
      const kept = new Types.ObjectId();
      const added = new Types.ObjectId();
      await grantUser(resourceId, kept, 1);
      const failure = new Error('fail after writing');

      await expect(
        stores.transaction(async (tx) => {
          await grantUser(resourceId, added, 3, tx);
          await acl.modifyPermissionBits(
            PrincipalType.USER,
            kept,
            resourceType,
            resourceId,
            2,
            null,
            tx,
          );
          await acl.bulkWriteAclEntries(
            [
              {
                updateMany: {
                  filter: userEntryFilter(resourceId, added),
                  update: { $set: { permBits: 7 } },
                },
              },
            ],
            { session: tx },
          );
          await acl.deleteAclEntries(userEntryFilter(resourceId, kept), { session: tx });
          throw failure;
        }),
      ).rejects.toBe(failure);

      const entries = await acl.findEntriesByResource(resourceType, resourceId);
      expect(entries.map((entry) => [entry.principalId?.toString(), entry.permBits])).toEqual([
        [kept.toString(), 1],
      ]);
    });

    it('applies port-shaped role and bulk writes in the transaction', async () => {
      const resourceId = new Types.ObjectId();
      const roleUser = new Types.ObjectId();
      const bulkUser = new Types.ObjectId();
      const roleId = new Types.ObjectId();

      const outcome = await stores.transaction(async (tx) => {
        const replaced = await acl.replaceRoleBits(
          [
            {
              filter: userEntryFilter(resourceId, roleUser),
              insert: {
                ...userEntryFilter(resourceId, roleUser),
                principalModel: PrincipalModel.USER,
              },
              roleBits: 3,
              metadata: { roleId, grantedBy: roleUser, grantedAt: new Date() },
            },
          ],
          { session: tx },
        );
        const written = await acl.bulkWriteAclEntries(
          [
            {
              updateOne: {
                filter: userEntryFilter(resourceId, bulkUser),
                update: {
                  $setOnInsert: {
                    ...userEntryFilter(resourceId, bulkUser),
                    principalModel: PrincipalModel.USER,
                    permBits: 1,
                    roleId,
                    grantedBy: bulkUser,
                    grantedAt: new Date(),
                  },
                },
                upsert: true,
              },
            },
          ],
          { session: tx, ordered: false },
        );
        return { replaced, written };
      });

      expect([...outcome.replaced.upsertedWrites]).toEqual([0]);
      expect(outcome.written).toMatchObject({
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 1,
      });
      const entries = await acl.findEntriesByResource(resourceType, resourceId);
      expect(
        entries.map((entry) => [entry.principalId?.toString(), entry.permBits]).sort(),
      ).toEqual(
        [
          [roleUser.toString(), 3],
          [bulkUser.toString(), 1],
        ].sort(),
      );
    });

    it('logs a failed rollback and rethrows the callback error, not the rollback error', async () => {
      const failure = new Error('callback failed');
      let received: StoreTransaction | undefined;

      await expect(
        stores.transaction(async (tx) => {
          received = tx;
          /** Aborting here makes the store's own rollback fail. */
          await (tx as ClientSession).abortTransaction();
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(logger.error).toHaveBeenCalledWith(
        '[StoreTransactions.transaction] Error aborting transaction:',
        expect.any(Error),
      );
      expect((received as ClientSession).hasEnded).toBe(true);
    });

    it('rejects when the commit fails', async () => {
      await expect(
        stores.transaction(async (tx) => {
          /** A transaction aborted before the commit cannot commit. */
          await (tx as ClientSession).abortTransaction();
        }),
      ).rejects.toThrow();
    });
  });

  describe('without transaction support (standalone server)', () => {
    let server: MongoMemoryServer;

    beforeAll(async () => {
      server = await MongoMemoryServer.create();
      await mongoose.connect(server.getUri());
      await prepareAclCollection();
      acl = createAclEntryMethods(mongoose);
      stores = createMongoStoreTransactionMethods(mongoose);
    });

    afterAll(async () => {
      await mongoose.disconnect();
      await server.stop();
    });

    beforeEach(async () => {
      await AclEntry.deleteMany({});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('runs the callback once with no transaction, keeping writes made before a failure', async () => {
      const resourceId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      const failure = new Error('fail after writing');
      const received: Array<StoreTransaction | undefined> = [];

      await expect(
        stores.transaction(async (tx) => {
          received.push(tx);
          await grantUser(resourceId, userId, 1, tx);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(received).toEqual([undefined]);
      const entries = await acl.findEntriesByResource(resourceType, resourceId);
      expect(entries.map((entry) => entry.permBits)).toEqual([1]);
    });

    it('resolves to what the callback resolves to, starting no session once support is known', async () => {
      const startSession = jest.spyOn(mongoose, 'startSession');
      await expect(stores.transaction(async (tx) => tx ?? 'no transaction')).resolves.toBe(
        'no transaction',
      );
      expect(startSession).not.toHaveBeenCalled();
    });

    it('probes once per store and then keeps the verdict', async () => {
      const fresh = createMongoStoreTransactionMethods(mongoose);
      const startSession = jest.spyOn(mongoose, 'startSession');
      await fresh.transaction(async () => undefined);
      const probes = startSession.mock.calls.length;
      expect(probes).toBeGreaterThan(0);
      await fresh.transaction(async () => undefined);
      expect(startSession).toHaveBeenCalledTimes(probes);
    });
  });
});
