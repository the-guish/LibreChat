import type { mongo } from 'mongoose';
import type { BrowserSetupAllocation, BrowserSetupSessionDocument } from './browserSetupRules';
import type { BrowserSetupStore, BrowserSetupBackend } from '~/types/browserSetup';
import type { CodeEnvironmentStore } from '~/ports/codeEnvironment';
import type { IUser } from '~/types/user';
import { createBrowserSetupStoreOnSteps } from './browserSetupRules';
import { createCodeEnvironmentMethods } from './codeEnvironment';
import { buildIndexWithRetry } from '~/utils/retry';

type SessionDocument = BrowserSetupSessionDocument;
type Allocation = BrowserSetupAllocation;

type AllocationBudget = { _id: string; allocations: Allocation[] };
type RequestBudget = {
  _id: string;
  expiresAt: number;
  count: number;
  peers: Record<string, number>;
};

function duplicate(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 11000;
}

/** The setup session store on the raw collections (`createBrowserSetupStoreOnSteps`). */
export function createBrowserSetupStore(mongoose: typeof import('mongoose')): BrowserSetupStore {
  const db = mongoose.connection.db;
  if (db == null) throw new Error('MongoDB is not connected');
  const sessions = db.collection<SessionDocument>('browser_setup_sessions');
  const budgets = db.collection<AllocationBudget>('browser_setup_budget');
  const requests = db.collection<RequestBudget>('browser_setup_requests');
  async function initialize(): Promise<void> {
    await buildIndexWithRetry(
      () => sessions.createIndex({ deleteAfter: 1 }, { expireAfterSeconds: 0 }),
      'browser-setup-ttl',
    );
    await buildIndexWithRetry(
      () => sessions.createIndex({ reconciledAt: 1, expiresAt: 1, _id: 1 }),
      'browser-setup-reconciliation',
    );
    await Promise.all([
      requests
        .updateOne(
          { _id: 'global' },
          { $setOnInsert: { expiresAt: 0, count: 0, peers: {} } },
          { upsert: true },
        )
        .catch((error: unknown) => {
          if (!duplicate(error)) throw error;
        }),
      budgets
        .updateOne({ _id: 'global' }, { $setOnInsert: { allocations: [] } }, { upsert: true })
        .catch((error: unknown) => {
          if (!duplicate(error)) throw error;
        }),
    ]);
  }

  async function writeSessions(
    operations: mongo.AnyBulkWriteOperation<SessionDocument>[],
  ): Promise<void> {
    // Attempt IDs are deployment-global; raw batches use exact IDs and CAS/lease predicates.
    // eslint-disable-next-line no-restricted-syntax
    await sessions.bulkWrite(operations);
  }

  return createBrowserSetupStoreOnSteps({
    initialize,
    isDuplicateKey: duplicate,
    sessions: {
      findOne: (filter) => sessions.findOne(filter as mongo.Filter<SessionDocument>),
      find: (filter, sort, limit) =>
        sessions
          .find(filter as mongo.Filter<SessionDocument>)
          .sort(sort)
          .limit(limit)
          .toArray(),
      findOneAndUpdate: (filter, update) =>
        sessions.findOneAndUpdate(
          filter as mongo.Filter<SessionDocument>,
          update as mongo.UpdateFilter<SessionDocument>,
          { returnDocument: 'after' },
        ),
      async updateOne(filter, update, options) {
        const result = await sessions.updateOne(
          filter as mongo.Filter<SessionDocument>,
          update as mongo.UpdateFilter<SessionDocument>,
          ...(options?.upsert ? [{ upsert: true }] : []),
        );
        return { matchedCount: result.matchedCount, upsertedCount: result.upsertedCount };
      },
      write: (operations) =>
        writeSessions(operations as mongo.AnyBulkWriteOperation<SessionDocument>[]),
    },
    allocations: {
      async claim(allocation, limits) {
        const active = '$allocations';
        const claimed = await budgets.findOneAndUpdate(
          {
            _id: 'global',
            'allocations.session.attemptId': { $ne: allocation.attemptId },
            $expr: {
              $and: [
                { $lt: [{ $size: active }, limits.global] },
                {
                  $lt: [
                    {
                      $size: {
                        $filter: {
                          input: active,
                          as: 'entry',
                          cond: { $eq: ['$$entry.ipHash', { $literal: allocation.ipHash }] },
                        },
                      },
                    },
                    limits.perIp,
                  ],
                },
              ],
            },
          },
          { $push: { allocations: allocation } },
          {
            returnDocument: 'after',
            projection: {
              allocations: { $elemMatch: { 'session.attemptId': allocation.attemptId } },
            },
          },
        );
        return claimed?.allocations[0] ?? null;
      },
      async find(attemptId) {
        const reservation = await budgets.findOne(
          { _id: 'global', 'allocations.session.attemptId': attemptId },
          { projection: { allocations: { $elemMatch: { 'session.attemptId': attemptId } } } },
        );
        return reservation?.allocations[0] ?? null;
      },
      async release(attemptIds) {
        await budgets.updateOne(
          { _id: 'global' },
          { $pull: { allocations: { attemptId: { $in: attemptIds } } } },
        );
      },
      missingSessions: (limit) =>
        budgets
          .aggregate<Allocation>([
            { $match: { _id: 'global' } },
            { $unwind: '$allocations' },
            {
              $lookup: {
                from: sessions.collectionName,
                localField: 'allocations.attemptId',
                foreignField: '_id',
                as: 'persisted',
              },
            },
            { $match: { persisted: { $size: 0 } } },
            { $replaceRoot: { newRoot: '$allocations' } },
            { $limit: limit },
          ])
          .toArray(),
    },
    requests: {
      async updateOne(filter, update) {
        const result = await requests.updateOne(
          filter as mongo.Filter<RequestBudget>,
          update as mongo.UpdateFilter<RequestBudget>,
        );
        return { matchedCount: result.matchedCount };
      },
    },
  });
}

/**
 * The browser setup backend over `mongoose`. `codeEnvironments` supplies the code environment
 * setup index build that `ensureRegistration` runs; `createMethods` passes its own code
 * environment methods so the build is cached once per process. Without it, the backend builds a
 * code environment methods instance of its own (with its own cache).
 */
export function createBrowserSetupBackend(
  mongoose: typeof import('mongoose'),
  codeEnvironments: Pick<
    CodeEnvironmentStore,
    'ensureSetupEnvironmentIndexes'
  > = createCodeEnvironmentMethods(mongoose),
): BrowserSetupBackend {
  return {
    ensureRegistration: codeEnvironments.ensureSetupEnvironmentIndexes,
    createStore: () => createBrowserSetupStore(mongoose),
    isConnected: () => mongoose.connection.readyState === 1,
    async getUser(id) {
      const user = await mongoose.models.User.findById(id)
        .select(
          '_id tenantId role idOnTheSource provider emailVerified twoFactorEnabled termsAccepted expiresAt agentTriggerDeletionStartedAt',
        )
        .lean<IUser>();
      if (user == null) return null;
      return {
        id: user._id.toString(),
        tenantId: user.tenantId,
        role: user.role,
        idOnTheSource: user.idOnTheSource ?? null,
        provider: user.provider,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        termsAccepted: user.termsAccepted,
        expiresAt: user.expiresAt,
        agentTriggerDeletionStartedAt: user.agentTriggerDeletionStartedAt,
      };
    },
  };
}
