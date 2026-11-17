/**
 * The browser setup session store's database-neutral rules (`BrowserSetupStore`,
 * `~/types/browserSetup`), shared by every backend: the MongoDB store (`./browserSetup`) and the
 * PostgreSQL one (`adapters/postgres/stores/browserSetup.ts`). The whole store (the validation of
 * every input, idempotent starts on the allocation budget, the revision compare-and-set with its
 * write-once fields, the leases, the nonces, the request budget, the reconciliation listing and
 * the allocation release that arms the TTL date) is written once here on the storage steps of
 * {@link BrowserSetupStorageSteps}, its filters and updates stated in the store query language.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import type {
  BrowserSetupStore,
  BrowserSetupSession,
  BrowserSetupStatus,
  BrowserSetupProgress,
  BrowserSetupStartResult,
  BrowserSetupNonceResult,
  BrowserSetupBudgetLimits,
} from '~/types/browserSetup';

/** A filter or update in the store query language. */
export type BrowserSetupQuery = Record<string, unknown>;

/** A setup session as stored (`browser_setup_sessions`), with its private bookkeeping. */
export type BrowserSetupSessionDocument = BrowserSetupSession & {
  _id: string;
  nonces: Array<{ nonce: string; expiresAt: number }>;
  operations: number;
  deleteAfter?: Date;
  allocationReleased?: boolean;
  reconciledAt?: number;
};

/** One open allocation of the budget singleton (`browser_setup_budget`). */
export type BrowserSetupAllocation = {
  attemptId: string;
  ipHash: string;
  expiresAt: number;
  session: BrowserSetupSession;
};

/** A guarded update of one session, as a bulk write carries it. */
export interface BrowserSetupSessionWrite {
  updateOne: { filter: BrowserSetupQuery; update: BrowserSetupQuery; upsert?: boolean };
}

/** The storage steps the store runs on, each one atomic on its own. */
export interface BrowserSetupStorageSteps {
  /**
   * Prepares the storage once per store (MongoDB: the session indexes) and creates the two
   * singletons when missing: the request budget `{ _id: 'global', expiresAt: 0, count: 0, peers:
   * {} }` and the allocation budget `{ _id: 'global', allocations: [] }`.
   */
  initialize(): Promise<void>;
  sessions: {
    /** The session matching `filter`, or `null`. */
    findOne(filter: BrowserSetupQuery): Promise<BrowserSetupSessionDocument | null>;
    /** The sessions matching `filter`, in `sort` order, at most `limit`. */
    find(
      filter: BrowserSetupQuery,
      sort: Record<string, 1 | -1>,
      limit: number,
    ): Promise<BrowserSetupSessionDocument[]>;
    /** Updates the first session matching `filter`; resolves it updated, or `null`. */
    findOneAndUpdate(
      filter: BrowserSetupQuery,
      update: BrowserSetupQuery,
    ): Promise<BrowserSetupSessionDocument | null>;
    /** Updates (or with `upsert` inserts) one session; how many matched and were upserted. */
    updateOne(
      filter: BrowserSetupQuery,
      update: BrowserSetupQuery,
      options?: { upsert?: boolean },
    ): Promise<{ matchedCount: number; upsertedCount: number }>;
    /** Runs the guarded updates as one bulk write (each on an exact id). */
    write(operations: BrowserSetupSessionWrite[]): Promise<void>;
  };
  allocations: {
    /**
     * Appends `allocation` to the budget singleton when no allocation holds its attempt id, fewer
     * than `limits.global` are open and fewer than `limits.perIp` carry its `ipHash`, all in one
     * atomic step; resolves the appended allocation, or `null` when the budget refused it.
     */
    claim(
      allocation: BrowserSetupAllocation,
      limits: BrowserSetupBudgetLimits,
    ): Promise<BrowserSetupAllocation | null>;
    /** The open allocation of the attempt, or `null`. */
    find(attemptId: string): Promise<BrowserSetupAllocation | null>;
    /** Removes the open allocations of the attempts. */
    release(attemptIds: string[]): Promise<void>;
    /**
     * Up to `limit` open allocations, in budget order, whose session record is missing (an insert
     * lost after the budget was reserved).
     */
    missingSessions(limit: number): Promise<BrowserSetupAllocation[]>;
  };
  requests: {
    /** Updates the request budget singleton when it matches `filter`; how many matched. */
    updateOne(
      filter: BrowserSetupQuery,
      update: BrowserSetupQuery,
    ): Promise<{ matchedCount: number }>;
  };
  /** Whether `error` is the backend's duplicate-key error. */
  isDuplicateKey(error: unknown): boolean;
}

function boundedInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function publicSession(document: BrowserSetupSessionDocument): BrowserSetupSession {
  const {
    _id,
    nonces: _nonces,
    operations: _operations,
    deleteAfter: _deleteAfter,
    allocationReleased: _allocationReleased,
    reconciledAt: _reconciledAt,
    ...session
  } = document;
  return session;
}

function terminal(status: BrowserSetupStatus): boolean {
  return ['completed', 'denied', 'cancelled', 'expired', 'failed'].includes(status);
}

/** The singleton bounds anonymous allocation state, including distinct attacker-controlled IPs. */
export function createBrowserSetupStoreOnSteps(steps: BrowserSetupStorageSteps): BrowserSetupStore {
  const { sessions, allocations, requests } = steps;
  let initialization: Promise<void> | undefined;
  async function ready(): Promise<void> {
    const current = (initialization ??= steps.initialize());
    try {
      await current;
    } catch (error) {
      if (initialization === current) initialization = undefined;
      throw error;
    }
  }

  async function get(attemptId: string): Promise<BrowserSetupSession | null> {
    await ready();
    const found = await sessions.findOne({ _id: attemptId });
    if (found == null) return null;
    await releaseResolved([found]);
    return publicSession(found);
  }

  async function start({
    session,
    ipHash,
    now,
    limits,
  }: Parameters<BrowserSetupStore['start']>[0]): Promise<BrowserSetupStartResult> {
    if (
      !boundedInteger(limits.global, 512) ||
      !boundedInteger(limits.perIp, 100_000) ||
      !boundedInteger(limits.windowMs, 86_400_000) ||
      !Number.isSafeInteger(now) ||
      !/^[a-f0-9]{64}$/.test(ipHash) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(session.attemptId) ||
      !/^[a-f0-9]{64}$/.test(session.requestHash) ||
      Buffer.byteLength(session.requestCanonical) > 8192 ||
      createHash('sha256').update(session.requestCanonical).digest('hex') !== session.requestHash ||
      !Number.isFinite(Date.parse(session.createdAt)) ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      session.verificationCode.length > 128 ||
      session.workerId.length > 128 ||
      session.status !== 'pending' ||
      session.revision !== 0 ||
      Object.keys(session).some(
        (key) =>
          ![
            'attemptId',
            'requestCanonical',
            'requestHash',
            'createdAt',
            'expiresAt',
            'verificationCode',
            'workerId',
            'status',
            'revision',
          ].includes(key),
      )
    )
      throw new Error('Invalid browser setup allocation');
    await ready();
    const existing = await get(session.attemptId);
    if (existing != null)
      return existing.requestCanonical === session.requestCanonical &&
        existing.requestHash === session.requestHash
        ? { status: 'replay', session: existing }
        : { status: 'conflict' };

    const claimed = await allocations.claim(
      {
        attemptId: session.attemptId,
        ipHash,
        expiresAt: now + limits.windowMs,
        session,
      },
      limits,
    );
    // A crash after reserving the budget must preserve the first session's random code and expiry.
    const reservation = claimed ?? (await allocations.find(session.attemptId));
    const original = reservation?.session;
    if (original == null) return { status: 'limited' };
    if (
      original.requestCanonical !== session.requestCanonical ||
      original.requestHash !== session.requestHash
    )
      return { status: 'conflict' };
    let inserted = false;
    try {
      const result = await sessions.updateOne(
        { _id: session.attemptId },
        { $setOnInsert: { ...original, nonces: [], operations: 0 } },
        { upsert: true },
      );
      inserted = result.upsertedCount === 1;
    } catch (error) {
      if (!steps.isDuplicateKey(error)) throw error;
    }
    const persisted = await get(session.attemptId);
    if (persisted == null) throw new Error('Browser setup allocation disappeared');
    if (
      persisted.requestCanonical !== session.requestCanonical ||
      persisted.requestHash !== session.requestHash
    )
      return { status: 'conflict' };
    return { status: inserted ? 'created' : 'replay', session: persisted };
  }

  async function update({
    attemptId,
    requestHash,
    revision,
    patch,
    leaseId,
  }: Parameters<BrowserSetupStore['update']>[0]): Promise<BrowserSetupSession | null> {
    await ready();
    const existing = await get(attemptId);
    if (
      existing == null ||
      existing.requestHash !== requestHash ||
      existing.revision !== revision ||
      existing.leaseId !== leaseId
    )
      return null;
    const frozen = ['ownerId', 'tenantId', 'planeId', 'baseURL', 'tokenEnv', 'approval'] as const;
    for (const key of frozen) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] == null)
        throw new Error('Invalid frozen browser setup field');
      if (
        patch[key] != null &&
        existing[key] != null &&
        JSON.stringify(patch[key]) !== JSON.stringify(existing[key])
      )
        return null;
    }
    if (
      Object.keys(patch).some(
        (key) =>
          !['status', ...frozen, 'progress', 'failureCode', 'purgeAt', 'stopReason'].includes(key),
      )
    )
      throw new Error('Invalid browser setup update');
    if (
      patch.stopReason != null &&
      existing.stopReason != null &&
      patch.stopReason !== existing.stopReason &&
      patch.stopReason !== 'withdrawn'
    )
      return null;
    for (const key of ['ownerId', 'tenantId', 'planeId', 'baseURL', 'tokenEnv'] as const) {
      const value = patch[key];
      if (
        value != null &&
        (typeof value !== 'string' ||
          (value.length === 0 && key !== 'tenantId') ||
          value.length > (key === 'baseURL' ? 2048 : 256))
      )
        throw new Error('Invalid frozen browser setup field');
    }
    if (patch.tokenEnv != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(patch.tokenEnv))
      throw new Error('Invalid browser setup token environment reference');
    if (
      patch.approval != null &&
      (patch.approval.attemptId !== attemptId ||
        patch.approval.requestHash !== requestHash ||
        patch.approval.workerId !== existing.workerId ||
        patch.approval.expiresAt !== existing.expiresAt ||
        Buffer.byteLength(JSON.stringify(patch.approval)) > 8192)
    )
      throw new Error('Invalid browser setup approval binding');
    const statuses = [
      'pending',
      'provisioning',
      'approved',
      'completing',
      'completed',
      'denied',
      'cancelled',
      'expired',
      'failed',
    ];
    if (patch.status != null && !statuses.includes(patch.status))
      throw new Error('Invalid browser setup status');
    if (
      patch.stopReason != null &&
      !['denied', 'cancelled', 'expired', 'withdrawn'].includes(patch.stopReason)
    )
      throw new Error('Invalid browser setup stop reason');
    if (
      patch.progress != null &&
      Object.entries(patch.progress).some(
        ([key, value]) =>
          !['registryReserved', 'registryCompleted', 'issued', 'redemption', 'cleanup'].includes(
            key,
          ) || typeof value !== 'boolean',
      )
    )
      throw new Error('Invalid browser setup progress');
    const status = patch.status ?? existing.status;
    const withdrawn = (patch.stopReason ?? existing.stopReason) === 'withdrawn';
    if (
      terminal(existing.status) &&
      status !== existing.status &&
      !(existing.status === 'completed' && status === 'failed' && withdrawn)
    )
      return null;
    const withdrawing = patch.stopReason === 'withdrawn' && existing.stopReason !== 'withdrawn';
    const progress = {
      ...existing.progress,
      ...(withdrawing ? { cleanup: false } : {}),
      ...patch.progress,
    };
    if (
      Object.entries(existing.progress ?? {}).some(
        ([key, value]) =>
          value === true &&
          patch.progress?.[key as keyof BrowserSetupProgress] === false &&
          !(key === 'cleanup' && withdrawing),
      )
    )
      return null;
    if (patch.failureCode != null && !/^[A-Z][A-Z0-9_]{0,79}$/.test(patch.failureCode))
      throw new Error('Invalid browser setup failure code');
    if (
      patch.purgeAt != null &&
      (!terminal(status) ||
        progress.cleanup !== true ||
        !Number.isFinite(Date.parse(patch.purgeAt)))
    )
      throw new Error('Unresolved browser setup cannot expire from storage');
    const updated = await sessions.findOneAndUpdate(
      {
        _id: attemptId,
        requestHash,
        revision,
        ...(leaseId == null
          ? { leaseId: { $exists: false } }
          : { leaseId, leaseExpiresAt: { $gt: Date.now() } }),
      },
      {
        $set: { ...patch, progress },
        ...(withdrawing ? { $unset: { deleteAfter: '' } } : {}),
        $inc: { revision: 1 },
      },
    );
    if (updated == null) return null;
    await releaseResolved([updated]);
    return publicSession(updated);
  }

  async function claimNonce({
    attemptId,
    requestHash,
    nonce,
    now,
    expiresAt,
    maxNonces,
    maxOperations,
  }: Parameters<BrowserSetupStore['claimNonce']>[0]): Promise<BrowserSetupNonceResult> {
    if (
      !boundedInteger(maxNonces, 10_000) ||
      !boundedInteger(maxOperations, 100_000) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(nonce) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    )
      throw new Error('Invalid browser setup nonce');
    await ready();
    const claim = async (): Promise<boolean> => {
      const result = await sessions.updateOne(
        {
          _id: attemptId,
          requestHash,
          operations: { $lt: maxOperations },
          nonces: { $not: { $elemMatch: { nonce, expiresAt: { $gt: now } } } },
          [`nonces.${maxNonces - 1}`]: { $exists: false },
        },
        { $push: { nonces: { nonce, expiresAt } }, $inc: { operations: 1 } },
      );
      return result.matchedCount === 1;
    };
    if (await claim()) return 'claimed';
    let found = await sessions.findOne({ _id: attemptId, requestHash });
    if (found == null) return 'missing';
    if (found.nonces.some((entry) => entry.nonce === nonce && entry.expiresAt > now))
      return 'replay';
    if (found.operations >= maxOperations) return 'limited';
    if (found.nonces.some((entry) => entry.expiresAt <= now)) {
      await sessions.updateOne(
        { _id: attemptId, requestHash },
        { $pull: { nonces: { expiresAt: { $lte: now } } } },
      );
      if (await claim()) return 'claimed';
      found = await sessions.findOne({ _id: attemptId, requestHash });
      if (found == null) return 'missing';
      if (found.nonces.some((entry) => entry.nonce === nonce && entry.expiresAt > now))
        return 'replay';
    }
    return 'limited';
  }

  async function consumeRequest({
    ipHash,
    now,
    limits,
  }: Parameters<BrowserSetupStore['consumeRequest']>[0]): Promise<boolean> {
    if (
      !/^[a-f0-9]{64}$/.test(ipHash) ||
      !Number.isSafeInteger(now) ||
      !boundedInteger(limits.global, 100_000) ||
      !boundedInteger(limits.perIp, 100_000) ||
      !boundedInteger(limits.windowMs, 86_400_000)
    )
      throw new Error('Invalid browser setup request budget');
    await ready();
    // The validated hash is a bounded field in one singleton, never a new attacker-owned bucket.
    const peer = `peers.${ipHash}`;
    const increment = async (): Promise<boolean> => {
      const result = await requests.updateOne(
        {
          _id: 'global',
          expiresAt: { $gt: now },
          count: { $lt: limits.global },
          $or: [{ [peer]: { $exists: false } }, { [peer]: { $lt: limits.perIp } }],
        },
        { $inc: { count: 1, [peer]: 1 } },
      );
      return result.matchedCount === 1;
    };
    if (await increment()) return true;
    await requests.updateOne(
      { _id: 'global', expiresAt: { $lte: now } },
      { $set: { expiresAt: now + limits.windowMs, count: 0, peers: {} } },
    );
    return await increment();
  }

  async function claim({
    attemptId,
    requestHash,
    revision,
    leaseId,
    now,
    leaseMs,
  }: Parameters<BrowserSetupStore['claim']>[0]): Promise<BrowserSetupSession | null> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(leaseId) ||
      !Number.isSafeInteger(now) ||
      !boundedInteger(leaseMs, 300_000)
    )
      throw new Error('Invalid browser setup lease');
    await ready();
    const found = await sessions.findOneAndUpdate(
      {
        _id: attemptId,
        requestHash,
        revision,
        $or: [{ leaseId: { $exists: false } }, { leaseExpiresAt: { $lte: now } }],
      },
      {
        $set: { leaseId, leaseExpiresAt: now + leaseMs, reconciledAt: now },
        $unset: { deleteAfter: '' },
        $inc: { revision: 1 },
      },
    );
    return found == null ? null : publicSession(found);
  }

  async function release({
    attemptId,
    requestHash,
    revision,
    leaseId,
  }: Parameters<BrowserSetupStore['release']>[0]): Promise<BrowserSetupSession | null> {
    await ready();
    const found = await sessions.findOneAndUpdate(
      { _id: attemptId, requestHash, revision, leaseId },
      { $unset: { leaseId: '', leaseExpiresAt: '' }, $inc: { revision: 1 } },
    );
    if (found == null) return null;
    await releaseResolved([found]);
    return publicSession(found);
  }

  async function restoreAllocations(limit: number): Promise<void> {
    const missing = await allocations.missingSessions(limit);
    if (missing.length === 0) return;
    await sessions.write(
      missing.map(({ session }) => ({
        updateOne: {
          filter: { _id: session.attemptId },
          update: { $setOnInsert: { ...session, nonces: [], operations: 0 } },
          upsert: true,
        },
      })),
    );
  }

  async function releaseResolved(documents: BrowserSetupSessionDocument[]): Promise<void> {
    const resolved = documents.filter(
      (entry) =>
        terminal(entry.status) &&
        entry.leaseId == null &&
        entry.progress?.cleanup === true &&
        (!entry.allocationReleased || (entry.purgeAt != null && entry.deleteAfter == null)),
    );
    if (resolved.length === 0) return;
    await allocations.release(resolved.map((entry) => entry.attemptId));
    // TTL is armed only after occupancy release. A crash before this write remains reconcilable.
    await sessions.write(
      resolved.map((entry) => ({
        updateOne: {
          filter: {
            _id: entry.attemptId,
            revision: entry.revision,
            leaseId: { $exists: false },
            'progress.cleanup': true,
          },
          update: {
            $set: {
              allocationReleased: true,
              ...(entry.purgeAt == null ? {} : { deleteAfter: new Date(entry.purgeAt) }),
            },
          },
        },
      })),
    );
  }

  async function listReconcile(
    limit: number,
    now: number = Date.now(),
  ): Promise<BrowserSetupSession[]> {
    if (!boundedInteger(limit, 512) || !Number.isSafeInteger(now))
      throw new Error('Invalid browser setup reconciliation limit');
    await ready();
    await restoreAllocations(limit);
    const found = await sessions.find(
      {
        $and: [
          {
            $or: [
              { status: { $ne: 'pending' } },
              { expiresAt: { $lte: new Date(now).toISOString() } },
            ],
          },
          {
            $or: [
              { 'progress.cleanup': { $ne: true } },
              { allocationReleased: { $ne: true } },
              { purgeAt: { $exists: true }, deleteAfter: { $exists: false } },
            ],
          },
          { $or: [{ leaseId: { $exists: false } }, { leaseExpiresAt: { $lte: now } }] },
        ],
      },
      { reconciledAt: 1, expiresAt: 1, _id: 1 },
      limit,
    );
    await releaseResolved(found);
    return found.map(publicSession);
  }

  return { start, get, update, claimNonce, consumeRequest, claim, release, listReconcile };
}
