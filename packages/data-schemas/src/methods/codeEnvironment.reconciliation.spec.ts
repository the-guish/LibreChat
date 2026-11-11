import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createCodeEnvironmentMethods } from './codeEnvironment';
import { createModels } from '~/models';

/**
 * The code environment methods the lifecycle reconciler, the registry's revocation request and
 * the worker revocation at an account deletion (`packages/api`) run on: each runs the query those
 * callers ran on the models (and the reconciliation checkpoint collection) directly.
 */

const LEASE_MS = 2 * 60_000;
const CHECKPOINTS = 'code_environment_reconciliation';
const CHECKPOINT_ID = 'agent-reference-cleanup';

let mongoServer: MongoMemoryServer;
let CodeEnvironment: mongoose.Model<t.CodeEnvironmentDocument>;
let methods: ReturnType<typeof createCodeEnvironmentMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  CodeEnvironment = mongoose.models.CodeEnvironment as mongoose.Model<t.CodeEnvironmentDocument>;
  methods = createCodeEnvironmentMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

const past = (ms = 60_000) => new Date(Date.now() - ms);
const future = (ms = 60_000) => new Date(Date.now() + ms);

async function createEnvironment(
  environmentId: string,
  fields: Partial<t.CodeEnvironment> & { _id?: mongoose.Types.ObjectId } = {},
): Promise<t.CodeEnvironmentDocument> {
  const created = await CodeEnvironment.create({
    environmentId,
    name: environmentId,
    type: 'attached',
    baseURL: 'https://code.example.com',
    controlPlaneId: 'shared-code-api',
    createdBy: new mongoose.Types.ObjectId(),
    ...fields,
  });
  return created.toObject() as t.CodeEnvironmentDocument;
}

const read = (id: mongoose.Types.ObjectId) =>
  CodeEnvironment.findById(id).lean<t.CodeEnvironmentDocument>();

const ids = (rows: Array<{ _id: mongoose.Types.ObjectId }>) =>
  rows.map(({ _id }) => _id.toString());

describe('agent references and revocation requests', () => {
  it('reports whether an agent of the tenant selects the environment', async () => {
    await mongoose.models.Agent.create({
      id: 'agent_single',
      name: 'Single',
      provider: 'test',
      model: 'test',
      author: new mongoose.Types.ObjectId(),
      code_environment_id: 'env-single',
    });
    await mongoose.models.Agent.create({
      id: 'agent_many',
      name: 'Many',
      provider: 'test',
      model: 'test',
      author: new mongoose.Types.ObjectId(),
      code_environment_ids: ['env-many'],
    });

    await expect(methods.isCodeEnvironmentReferencedByAgent('env-single')).resolves.toBe(true);
    await expect(methods.isCodeEnvironmentReferencedByAgent('env-many')).resolves.toBe(true);
    await expect(methods.isCodeEnvironmentReferencedByAgent('env-unused')).resolves.toBe(false);
    // An agent outside every tenant does not reference a tenant's environment.
    await expect(methods.isCodeEnvironmentReferencedByAgent('env-many', 'tenant-a')).resolves.toBe(
      false,
    );
  });

  it('marks a live environment for revocation and refuses a committed or absent one', async () => {
    const live = await createEnvironment('env-live', {
      revocationAttempts: 2,
      revocationLastError: 'boom',
      revocationReconcileAfter: future(),
    });
    const committed = await createEnvironment('env-committed', { deletionCommittedAt: past() });

    await expect(methods.requestCodeEnvironmentRevocation('env-live')).resolves.toBe(true);
    await expect(methods.requestCodeEnvironmentRevocation('env-committed')).resolves.toBe(false);
    await expect(methods.requestCodeEnvironmentRevocation('env-absent')).resolves.toBe(false);

    const marked = await read(live._id);
    expect(marked?.revocationPendingAt).toBeInstanceOf(Date);
    expect(marked?.revocationAttempts).toBe(3);
    expect(marked?.revocationLastError).toBeUndefined();
    expect(marked?.revocationReconcileAfter).toBeUndefined();
    expect((await read(committed._id))?.revocationPendingAt).toBeUndefined();
  });
});

describe('agent reference sweep', () => {
  const checkpoint = () =>
    mongoose.connection
      .db!.collection<{ _id: string }>(CHECKPOINTS)
      .findOne({ _id: CHECKPOINT_ID });

  it('pulls expired reservations batch by batch up to the captured bound, then restarts', async () => {
    const references = () => [
      { reservationId: 'expired', expiresAt: past() },
      { reservationId: 'live', expiresAt: future() },
    ];
    const first = await createEnvironment('env-1', { pendingAgentReferences: references() });
    const second = await createEnvironment('env-2', { pendingAgentReferences: references() });
    const third = await createEnvironment('env-3', { pendingAgentReferences: references() });

    await expect(methods.sweepExpiredCodeEnvironmentReferences(new Date(), 2)).resolves.toBe(true);
    expect(await checkpoint()).toEqual({
      _id: CHECKPOINT_ID,
      lastId: second._id,
      upperId: third._id,
    });
    const reservations = async (id: mongoose.Types.ObjectId) =>
      (await read(id))?.pendingAgentReferences?.map(({ reservationId }) => reservationId);
    expect(await reservations(first._id)).toEqual(['live']);
    expect(await reservations(second._id)).toEqual(['live']);
    expect(await reservations(third._id)).toEqual(['expired', 'live']);

    // An environment created after the bound was captured waits for the next sweep.
    const later = await createEnvironment('env-4', { pendingAgentReferences: references() });
    await expect(methods.sweepExpiredCodeEnvironmentReferences(new Date(), 2)).resolves.toBe(true);
    expect(await checkpoint()).toEqual({ _id: CHECKPOINT_ID, lastId: null, upperId: null });
    expect(await reservations(third._id)).toEqual(['live']);
    expect(await reservations(later._id)).toEqual(['expired', 'live']);

    await expect(methods.sweepExpiredCodeEnvironmentReferences(new Date(), 10)).resolves.toBe(true);
    expect(await reservations(later._id)).toEqual(['live']);
  });

  it('completes at once without environments', async () => {
    await expect(methods.sweepExpiredCodeEnvironmentReferences(new Date(), 5)).resolves.toBe(true);
    expect(await checkpoint()).toEqual({ _id: CHECKPOINT_ID, lastId: null, upperId: null });
  });
});

describe('interrupted removals and committed deletions', () => {
  it('lists uncommitted removals whose lease expired, by id, up to the limit', async () => {
    const expiredA = await createEnvironment('env-a', { deletionLeaseExpiresAt: past() });
    const expiredB = await createEnvironment('env-b', { deletionLeaseExpiresAt: past() });
    await createEnvironment('env-c', { deletionLeaseExpiresAt: past() });
    await createEnvironment('env-leased', { deletionLeaseExpiresAt: future() });
    await createEnvironment('env-done', {
      deletionLeaseExpiresAt: past(),
      deletionCommittedAt: past(),
    });

    const listed = await methods.findExpiredCodeEnvironmentRemovals(new Date(), 2);
    expect(ids(listed)).toEqual([expiredA._id.toString(), expiredB._id.toString()]);
    expect(Object.keys(listed[0])).toEqual(['_id']);
  });

  it('lists committed deletions up to the limit', async () => {
    const committed = await createEnvironment('env-committed', { deletionCommittedAt: past() });
    await createEnvironment('env-live');

    const listed = await methods.findCommittedCodeEnvironmentDeletions(5);
    expect(ids(listed)).toEqual([committed._id.toString()]);
    expect(listed[0].environmentId).toBe('env-committed');
  });
});

describe('stale registrations', () => {
  it('lists stale, due, unleased registrations that are not setup reservations', async () => {
    const staleBefore = past(5 * 60_000);
    const dueLater = await createEnvironment('env-due-later', {
      registrationPendingAt: past(10 * 60_000),
      registrationReconcileAfter: past(),
    });
    const dueFirst = await createEnvironment('env-due-first', {
      registrationPendingAt: past(10 * 60_000),
      registrationReconcileAfter: past(120_000),
    });
    const neverDeferred = await createEnvironment('env-never-deferred', {
      registrationPendingAt: past(10 * 60_000),
    });
    await createEnvironment('env-fresh', { registrationPendingAt: past(1_000) });
    await createEnvironment('env-setup', {
      registrationPendingAt: past(10 * 60_000),
      setupAttemptId: 'attempt',
    });
    await createEnvironment('env-deferred', {
      registrationPendingAt: past(10 * 60_000),
      registrationReconcileAfter: future(),
    });
    await createEnvironment('env-leased', {
      registrationPendingAt: past(10 * 60_000),
      registrationLeaseExpiresAt: future(),
    });

    const listed = await methods.findStaleCodeEnvironmentRegistrations(staleBefore, new Date(), 10);
    expect(ids(listed)).toEqual([
      neverDeferred._id.toString(),
      dueFirst._id.toString(),
      dueLater._id.toString(),
    ]);
    await expect(
      methods.findStaleCodeEnvironmentRegistrations(staleBefore, new Date(), 1),
    ).resolves.toHaveLength(1);
  });

  it('leases, defers and deletes a stale registration only under its lease', async () => {
    const staleBefore = past(5 * 60_000);
    const environment = await createEnvironment('env-stale', {
      registrationPendingAt: past(10 * 60_000),
    });
    const leaseId = new mongoose.Types.ObjectId().toHexString();

    const claimed = await methods.claimStaleCodeEnvironmentRegistration(
      environment._id,
      staleBefore,
      leaseId,
      LEASE_MS,
    );
    expect(claimed?.registrationLeaseId).toBe(leaseId);
    expect(claimed!.registrationLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    await expect(
      methods.claimStaleCodeEnvironmentRegistration(
        environment._id,
        staleBefore,
        'other',
        LEASE_MS,
      ),
    ).resolves.toBeNull();

    const reconcileAfter = future(5 * 60_000);
    await methods.deferCodeEnvironmentRegistration(environment._id, 'other', reconcileAfter);
    expect((await read(environment._id))?.registrationLeaseId).toBe(leaseId);
    await methods.deferCodeEnvironmentRegistration(environment._id, leaseId, reconcileAfter);
    const deferred = await read(environment._id);
    expect(deferred?.registrationReconcileAfter).toEqual(reconcileAfter);
    expect(deferred?.registrationLeaseId).toBeUndefined();
    expect(deferred?.registrationLeaseExpiresAt).toBeUndefined();
    // Deferred into the future: no longer claimable.
    await expect(
      methods.claimStaleCodeEnvironmentRegistration(
        environment._id,
        staleBefore,
        leaseId,
        LEASE_MS,
      ),
    ).resolves.toBeNull();

    await CodeEnvironment.updateOne(
      { _id: environment._id },
      { $set: { registrationReconcileAfter: past() } },
    );
    const reclaimed = await methods.claimStaleCodeEnvironmentRegistration(
      environment._id,
      staleBefore,
      'second-lease',
      LEASE_MS,
    );
    expect(reclaimed?.registrationLeaseId).toBe('second-lease');
    await methods.deleteStaleCodeEnvironmentRegistration(environment._id, leaseId);
    expect(await read(environment._id)).not.toBeNull();
    await methods.deleteStaleCodeEnvironmentRegistration(environment._id, 'second-lease');
    expect(await read(environment._id)).toBeNull();
  });
});

describe('orphaned environments', () => {
  it('lists live, unmarked environments whose creator is gone, projected', async () => {
    const owner = await mongoose.models.User.create({
      email: 'owner@example.com',
      provider: 'local',
    });
    await createEnvironment('env-owned', { createdBy: owner._id });
    const orphanA = await createEnvironment('env-orphan-a', {
      workerId: 'worker-a',
      workerPrincipal: { type: 'user', id: 'gone' },
    });
    const orphanB = await createEnvironment('env-orphan-b');
    await createEnvironment('env-orphan-marked', { revocationPendingAt: past() });
    await createEnvironment('env-orphan-committed', { deletionCommittedAt: past() });

    const listed = await methods.findOrphanedCodeEnvironments(10);
    expect(listed).toEqual([
      {
        _id: orphanA._id,
        createdBy: orphanA.createdBy,
        workerId: 'worker-a',
        workerPrincipal: { type: 'user', id: 'gone' },
      },
      { _id: orphanB._id, createdBy: orphanB.createdBy },
    ]);
    await expect(methods.findOrphanedCodeEnvironments(1)).resolves.toHaveLength(1);
  });

  it('marks the given orphans for revocation at the given time', async () => {
    const marked = await createEnvironment('env-marked', {
      revocationLastError: 'boom',
      revocationReconcileAfter: future(),
    });
    const untouched = await createEnvironment('env-untouched');
    const now = new Date();

    await methods.requestOrphanedCodeEnvironmentRevocations([marked._id], now);

    const row = await read(marked._id);
    expect(row?.revocationPendingAt).toEqual(now);
    expect(row?.revocationAttempts).toBe(1);
    expect(row?.revocationLastError).toBeUndefined();
    expect(row?.revocationReconcileAfter).toBeUndefined();
    expect((await read(untouched._id))?.revocationPendingAt).toBeUndefined();
  });
});

describe('worker revocations', () => {
  it('lists due, unleased revocations, the earliest due first', async () => {
    const dueLater = await createEnvironment('env-due-later', {
      revocationPendingAt: past(),
      revocationReconcileAfter: past(),
    });
    const dueFirst = await createEnvironment('env-due-first', {
      revocationPendingAt: past(),
      revocationReconcileAfter: past(120_000),
    });
    const neverDeferred = await createEnvironment('env-never-deferred', {
      revocationPendingAt: past(),
    });
    await createEnvironment('env-not-pending');
    await createEnvironment('env-deferred', {
      revocationPendingAt: past(),
      revocationReconcileAfter: future(),
    });
    await createEnvironment('env-leased', {
      revocationPendingAt: past(),
      revocationLeaseExpiresAt: future(),
    });

    const listed = await methods.findCodeEnvironmentRevocationCandidates(new Date(), 10);
    expect(ids(listed)).toEqual([
      neverDeferred._id.toString(),
      dueFirst._id.toString(),
      dueLater._id.toString(),
    ]);
    expect(Object.keys(listed[0])).toEqual(['_id']);
  });

  it('leases a due revocation, counting the attempt, and defers it under its lease', async () => {
    const environment = await createEnvironment('env-revoke', {
      revocationPendingAt: past(),
      revocationAttempts: 1,
    });
    const leaseId = new mongoose.Types.ObjectId().toHexString();

    const claimed = await methods.claimCodeEnvironmentRevocation(
      environment._id,
      leaseId,
      LEASE_MS,
    );
    expect(claimed?.revocationLeaseId).toBe(leaseId);
    expect(claimed?.revocationAttempts).toBe(2);
    expect(claimed!.revocationLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    await expect(
      methods.claimCodeEnvironmentRevocation(environment._id, 'other', LEASE_MS),
    ).resolves.toBeNull();

    const reconcileAfter = future(5 * 60_000);
    await methods.deferCodeEnvironmentRevocation(environment._id, 'other', 'lost', reconcileAfter);
    expect((await read(environment._id))?.revocationLastError).toBeUndefined();
    await methods.deferCodeEnvironmentRevocation(environment._id, leaseId, 'boom', reconcileAfter);
    const deferred = await read(environment._id);
    expect(deferred?.revocationLastError).toBe('boom');
    expect(deferred?.revocationReconcileAfter).toEqual(reconcileAfter);
    expect(deferred?.revocationLeaseId).toBeUndefined();
    expect(deferred?.revocationLeaseExpiresAt).toBeUndefined();
    expect(deferred?.revocationAttempts).toBe(2);
  });

  it('marks, commits and records failed revocations at an account deletion', async () => {
    const revoked = await createEnvironment('env-revoked', {
      revocationLastError: 'earlier',
      revocationReconcileAfter: future(),
    });
    const failed = await createEnvironment('env-failed');
    const untouched = await createEnvironment('env-untouched');

    await methods.beginCodeEnvironmentWorkerRevocations([revoked._id, failed._id]);
    const marked = await read(revoked._id);
    expect(marked?.revocationPendingAt).toBeInstanceOf(Date);
    expect(marked?.revocationAttempts).toBe(1);
    expect(marked?.revocationLastError).toBeUndefined();
    // Unlike the reconciler's orphan marking, the retry time is kept.
    expect(marked?.revocationReconcileAfter).toBeInstanceOf(Date);
    expect((await read(failed._id))?.revocationAttempts).toBe(1);
    expect((await read(untouched._id))?.revocationPendingAt).toBeUndefined();

    await methods.commitCodeEnvironmentWorkerRevocation(revoked._id);
    const committed = await read(revoked._id);
    expect(committed?.deletionCommittedAt).toBeInstanceOf(Date);
    expect(committed?.revocationPendingAt).toBeUndefined();
    expect(committed?.revocationAttempts).toBeUndefined();
    expect(committed?.revocationLastError).toBeUndefined();
    expect(committed?.revocationReconcileAfter).toBeUndefined();

    await methods.recordCodeEnvironmentWorkerRevocationError(failed._id, 'unreachable');
    const recorded = await read(failed._id);
    expect(recorded?.revocationLastError).toBe('unreachable');
    expect(recorded?.revocationPendingAt).toBeInstanceOf(Date);
    expect(recorded?.deletionCommittedAt).toBeUndefined();
  });
});
