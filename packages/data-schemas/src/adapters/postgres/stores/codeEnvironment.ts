/**
 * The PostgreSQL `CodeEnvironmentStore` (`~/ports/codeEnvironment`): the code environment registry
 * on the `codeenvironments` table (document mode, tenant-scoped like the mongoose model) with its
 * `pendingAgentReferences` child table, the retired ids on the raw `code_environment_tombstones`
 * table and the sweep's progress on the raw `code_environment_reconciliation` table, all through
 * the collection primitive. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - Filters, updates, ids and records are the shared rules (`~/methods/codeEnvironmentRules`).
 * - **Leases** (removal, stale registration, revocation) are guarded single-record updates (§3.5).
 *   The removal claim's filter reads the child table (`pendingAgentReferences` `$size: 0` and
 *   `$not: { $elemMatch: { expiresAt: { $gt: now } } }`), so the primitive locks the candidate,
 *   re-evaluates the whole filter in a new statement and only then writes (the lease columns and
 *   the `$pull` of the expired references, tier 1 with child statements); an agent reservation
 *   committed while the lock was awaited makes the claim resolve `null`.
 * - **Owner slots**: an owner's slot `n` is a derived `_id` (`codeEnvironmentOwnerSlotHex`), so of
 *   two creates racing for one slot the primary key admits one; the other moves on.
 * - **Sweep**: keyset batches on `_id` up to the bound captured in the durable progress record,
 *   each batch's expired references pulled by one `updateMany` (child `DELETE`s), the progress
 *   advanced by a compare-and-set on `(lastId, upperId)`.
 * - **Orphans**: a hand-written anti-join on `users` (`NOT EXISTS`, not tenant-scoped, as the
 *   `$lookup` is not), then the projected records read through the primitive.
 * - **Agent reference reservations** (held by the agent store's writes, S7):
 *   {@link createPostgresCodeEnvironmentReferences} runs the shared protocol on this table.
 */
import { sql } from 'kysely';
import { ResourceType } from 'librechat-data-provider';
import type {
  CodeEnvironmentTombstone,
  CodeEnvironmentReferenceSteps,
  CodeEnvironmentReferenceReservation,
} from '~/methods/codeEnvironmentRules';
import type { CodeEnvironmentDocument, OrphanedCodeEnvironment } from '~/types';
import type { CodeEnvironmentSetupBinding } from '~/types/codeEnvironmentSetup';
import type { CodeEnvironmentStore } from '~/ports/codeEnvironment';
import type { PostgresStoreContext } from './context';
import type { PgRecord } from '../collection';
import {
  REFERENCE_LEASE_MS,
  CODE_ENVIRONMENT_TOMBSTONES,
  CODE_ENVIRONMENT_RECONCILIATION,
  AGENT_REFERENCE_CLEANUP_CHECKPOINT,
  CodeEnvironmentReferenceError,
  liveCodeEnvironmentFilter,
  codeEnvironmentTombstoneId,
  codeEnvironmentSetupRecord,
  codeEnvironmentSetupFilter,
  codeEnvironmentOwnerSlotHex,
  codeEnvironmentSetupIdentity,
  codeEnvironmentSettingsUpdates,
  codeEnvironmentSetupLiveFilter,
  codeEnvironmentRemovalClaimUpdate,
  codeEnvironmentRetirementWrites,
  codeEnvironmentSetupFenceWrites,
  codeEnvironmentRemovalClaimFilter,
  codeEnvironmentRetiredSetupIds,
  codeEnvironmentReservableFilter,
  codeEnvironmentRevocationRequest,
  codeEnvironmentDiscardedSetupRecord,
  codeEnvironmentSetupCollisionFilter,
  reservedCodeEnvironmentOwnerSlots,
  dueCodeEnvironmentRevocationFilter,
  agentCodeEnvironmentReferenceFilter,
  staleCodeEnvironmentRegistrationFilter,
  withCodeEnvironmentReferencesOnSteps,
} from '~/methods/codeEnvironmentRules';
import { postgresStoreErrors } from '../storeErrors';
import { runStoreSql, storeWhere } from './context';
import { postgresStoreIds } from '../storeIds';

type EnvironmentRecord = PgRecord & { _id: string; environmentId: string; ownerSlot?: unknown };
type TombstoneRecord = CodeEnvironmentTombstone & PgRecord;
type CheckpointRecord = PgRecord & { _id: string; lastId?: string | null; upperId?: string | null };

/** A record as the port hands it out (the port types it as a mongoose document, a known leak). */
const asEnvironment = (record: PgRecord): CodeEnvironmentDocument =>
  record as unknown as CodeEnvironmentDocument;
const asEnvironments = (records: PgRecord[]): CodeEnvironmentDocument[] =>
  records as unknown as CodeEnvironmentDocument[];
const orNull = (record: PgRecord | null): CodeEnvironmentDocument | null =>
  record == null ? null : asEnvironment(record);

/** Whether `error` is a duplicate key on an owner slot (its derived `_id` or the slot index). */
function isOwnerSlotCollision(error: unknown): boolean {
  const fields = postgresStoreErrors.duplicateKeyFields(error);
  return fields != null && (fields.includes('_id') || fields.includes('ownerSlot'));
}

/** The table accessors every module of this file shares. */
function codeEnvironmentTables(context: PostgresStoreContext) {
  return {
    environments: () => context.collections().collection<EnvironmentRecord>('codeenvironments'),
    tombstones: () => context.collections().raw<TombstoneRecord>(CODE_ENVIRONMENT_TOMBSTONES),
  };
}

/**
 * The agent reference reservations on PostgreSQL (`pendingAgentReferences`), for the agent
 * store's writes: `withCodeEnvironmentReferences(environmentIds, operation, onReferenceLoss)`
 * holds a live reservation on every environment the registry holds while `operation` runs, and
 * refuses (`CodeEnvironmentReferenceError`, 409) one that is pending, being removed or retired.
 * The MongoDB counterpart is `withCodeEnvironmentReferences` in `~/methods/codeEnvironment`.
 */
export function createPostgresCodeEnvironmentReferences(context: PostgresStoreContext): {
  withCodeEnvironmentReferences<T>(
    environmentIds: string[],
    operation: () => Promise<T>,
    onReferenceLoss?: (result: T, environmentId: string) => Promise<void>,
  ): Promise<T>;
} {
  const { environments, tombstones } = codeEnvironmentTables(context);
  const steps: CodeEnvironmentReferenceSteps = {
    async reserve(environmentId) {
      if (environmentId == null || environmentId.length === 0) return undefined;
      const reservationId = postgresStoreIds.generate();
      const expiresAt = new Date(Date.now() + REFERENCE_LEASE_MS);
      const reserved = await environments().findOneAndUpdate(
        codeEnvironmentReservableFilter(environmentId),
        { $push: { pendingAgentReferences: { reservationId, expiresAt } } },
        { returnDocument: 'after' },
      );
      if (reserved != null) return { environmentId, reservationId };
      const [persisted, tombstone] = await Promise.all([
        environments().exists({ environmentId }),
        tombstones().findOne({ _id: codeEnvironmentTombstoneId(environmentId) }),
      ]);
      if (persisted != null || tombstone != null) {
        throw new CodeEnvironmentReferenceError(environmentId);
      }
      // Deployment-owned configuration does not have a registry row.
      return undefined;
    },
    async renew(reservation: CodeEnvironmentReferenceReservation) {
      const result = await environments().updateOne(
        {
          environmentId: reservation.environmentId,
          deletionStartedAt: { $exists: false },
          'pendingAgentReferences.reservationId': reservation.reservationId,
        },
        {
          $set: {
            'pendingAgentReferences.$.expiresAt': new Date(Date.now() + REFERENCE_LEASE_MS),
          },
        },
      );
      if (result.matchedCount !== 1) {
        throw new CodeEnvironmentReferenceError(reservation.environmentId);
      }
    },
    async release(reservation) {
      if (reservation == null) return;
      await environments().updateOne(
        { environmentId: reservation.environmentId },
        { $pull: { pendingAgentReferences: { reservationId: reservation.reservationId } } },
      );
    },
  };
  return {
    withCodeEnvironmentReferences: (environmentIds, operation, onReferenceLoss) =>
      withCodeEnvironmentReferencesOnSteps(steps, environmentIds, operation, onReferenceLoss),
  };
}

export function createPostgresCodeEnvironmentStore(
  context: PostgresStoreContext,
): CodeEnvironmentStore {
  const { environments, tombstones } = codeEnvironmentTables(context);
  const checkpoints = () =>
    context.collections().raw<CheckpointRecord>(CODE_ENVIRONMENT_RECONCILIATION);
  const agents = () => context.collections().collection('agents');

  const setupFilter = (binding: CodeEnvironmentSetupBinding) =>
    codeEnvironmentSetupFilter(binding, binding.ownerId);
  const setupLiveFilter = (binding: CodeEnvironmentSetupBinding) =>
    codeEnvironmentSetupLiveFilter(binding, binding.ownerId);
  const retiredSetupFilter = (binding: CodeEnvironmentSetupBinding) => ({
    _id: { $in: codeEnvironmentRetiredSetupIds(binding) },
  });

  async function retireEnvironment(environment: EnvironmentRecord): Promise<void> {
    await Promise.all(
      codeEnvironmentRetirementWrites(asEnvironment(environment)).map(({ filter, update }) =>
        tombstones().updateOne(filter, update, { upsert: true }),
      ),
    );
  }

  async function isRetired(environmentId: string): Promise<boolean> {
    return (await tombstones().findOne({ _id: codeEnvironmentTombstoneId(environmentId) })) != null;
  }

  async function isReferencedByAgent(environmentId: string, tenantId?: string): Promise<boolean> {
    return (
      (await agents().exists(agentCodeEnvironmentReferenceFilter(environmentId, tenantId))) != null
    );
  }

  const store: CodeEnvironmentStore = {
    /** The indexes come with the migrations. */
    async ensureSetupEnvironmentIndexes() {},

    async findSetupEnvironment(binding) {
      const environment = await environments().findOne(setupLiveFilter(binding));
      if (environment != null) return codeEnvironmentSetupRecord(asEnvironment(environment));
      const [collision, retired] = await Promise.all([
        environments().exists(codeEnvironmentSetupCollisionFilter(binding)),
        tombstones().findOne(retiredSetupFilter(binding)),
      ]);
      if (collision != null || retired != null)
        throw new Error('Browser setup registry binding is unavailable');
      return null;
    },

    async reserveSetupEnvironment(binding, maxOwned) {
      const replay = await store.findSetupEnvironment(binding);
      if (replay != null) return replay;
      const input = {
        ...binding,
        createdBy: binding.ownerId,
        setupRequestHash: binding.requestHash,
      } as unknown as Parameters<CodeEnvironmentStore['createCodeEnvironment']>[0];
      let created: CodeEnvironmentDocument | null;
      try {
        created =
          maxOwned == null
            ? await store.createCodeEnvironment(input)
            : await store.createCodeEnvironmentWithinOwnerLimit(input, maxOwned);
      } catch (error) {
        if (!postgresStoreErrors.isDuplicateKey(error)) throw error;
        const replayed = await store.findSetupEnvironment(binding);
        if (replayed != null) return replayed;
        throw error;
      }
      if (created == null) return await store.findSetupEnvironment(binding);
      // A concurrent retirement can win between the initial lookup and insertion.
      if ((await tombstones().findOne(retiredSetupFilter(binding))) != null) {
        await environments().updateOne(
          { _id: String(created._id), ...setupFilter(binding) },
          { $set: { setupDiscardedAt: new Date() } },
        );
        throw new Error('Browser setup registry binding is retired');
      }
      return codeEnvironmentSetupRecord(created);
    },

    async completeSetupEnvironment(binding, resourceId) {
      const updated = await environments().findOneAndUpdate(
        { _id: resourceId, ...setupLiveFilter(binding) },
        { $unset: { registrationPendingAt: 1, registrationReconcileAfter: 1 } },
        { returnDocument: 'after' },
      );
      if (updated == null) throw new Error('Browser setup registration could not be committed');
      return codeEnvironmentSetupRecord(asEnvironment(updated));
    },

    async beginDiscardSetupEnvironment(binding) {
      const updated = await environments().findOneAndUpdate(
        setupFilter(binding),
        { $set: { setupDiscardedAt: new Date(), registrationPendingAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (updated != null) {
        await retireEnvironment(updated);
        return codeEnvironmentSetupRecord(asEnvironment(updated));
      }
      const [collision, retired] = await Promise.all([
        environments().exists(codeEnvironmentSetupCollisionFilter(binding)),
        tombstones().findOne(retiredSetupFilter(binding)),
      ]);
      if (
        collision != null ||
        (retired != null && retired.setupBinding !== codeEnvironmentSetupIdentity(binding))
      )
        throw new Error('Browser setup registry binding does not match');
      // Fence an absent reservation, including compensation racing its first insertion.
      if (retired == null)
        await Promise.all(
          codeEnvironmentSetupFenceWrites(binding).map(({ filter, update }) =>
            tombstones().updateOne(filter, update, { upsert: true }),
          ),
        );
      return codeEnvironmentDiscardedSetupRecord(binding, retired);
    },

    async finishDiscardSetupEnvironment(binding, resourceId) {
      await environments().deleteOne({
        _id: resourceId,
        ...setupFilter(binding),
        setupDiscardedAt: { $exists: true },
      });
    },

    async createCodeEnvironment(input) {
      if (await isRetired(input.environmentId)) {
        throw new Error(`Code environment id was previously retired: ${input.environmentId}`);
      }
      return asEnvironment(
        await environments().insertOne({ ...input, registrationPendingAt: new Date() }),
      );
    },

    async createCodeEnvironmentWithinOwnerLimit(input, maxOwned) {
      if (await isRetired(input.environmentId)) {
        throw new Error(`Code environment id was previously retired: ${input.environmentId}`);
      }
      const existing = await environments().find(
        { createdBy: input.createdBy },
        { projection: 'ownerSlot' },
      );
      if (existing.length >= maxOwned) return null;
      const reserved = reservedCodeEnvironmentOwnerSlots(existing, maxOwned);
      const ownerHex = String(input.createdBy).toLowerCase();
      for (let ownerSlot = 0; ownerSlot < maxOwned; ownerSlot++) {
        if (reserved.has(ownerSlot)) continue;
        try {
          return asEnvironment(
            await environments().insertOne({
              ...input,
              _id:
                input.setupAttemptId == null
                  ? codeEnvironmentOwnerSlotHex(ownerHex, ownerSlot)
                  : postgresStoreIds.generate(),
              ownerSlot,
              registrationPendingAt: new Date(),
            }),
          );
        } catch (error) {
          if (!isOwnerSlotCollision(error)) {
            throw error;
          }
        }
      }
      return null;
    },

    async findCodeEnvironmentsByIds(ids) {
      if (ids.length === 0) return [];
      return asEnvironments(
        await environments().find({ _id: { $in: ids } }, { sort: { createdAt: 1, _id: 1 } }),
      );
    },

    async findCodeEnvironmentByEnvironmentId(environmentId) {
      return orNull(await environments().findOne({ environmentId }));
    },

    async updateCodeEnvironmentSettings(environmentId, settings) {
      const updates = codeEnvironmentSettingsUpdates(settings);
      const lifecycleFilter = liveCodeEnvironmentFilter(environmentId);
      if (Object.keys(updates).length === 0) {
        return orNull(await environments().findOne(lifecycleFilter));
      }
      return orNull(
        await environments().findOneAndUpdate(
          lifecycleFilter,
          { $set: updates },
          { returnDocument: 'after', runValidators: true },
        ),
      );
    },

    async listCodeEnvironmentIds() {
      return (await environments().distinct('environmentId')) as string[];
    },

    async findCodeEnvironmentsByCreator(userId) {
      return asEnvironments(
        await environments().find({ createdBy: userId }, { sort: { createdAt: 1, _id: 1 } }),
      );
    },

    async deleteCodeEnvironmentById(id) {
      const environment = await environments().findOne({ _id: id });
      if (environment == null) return null;
      await retireEnvironment(environment);
      return orNull(await environments().findOneAndDelete({ _id: id }));
    },

    async discardCodeEnvironmentById(id) {
      await environments().deleteOne({ _id: id, setupAttemptId: { $exists: false } });
    },

    async completeCodeEnvironmentRegistration(id) {
      const result = await environments().updateOne(
        {
          _id: id,
          registrationPendingAt: { $exists: true },
          setupAttemptId: { $exists: false },
          registrationLeaseId: { $exists: false },
        },
        { $unset: { registrationPendingAt: 1, registrationReconcileAfter: 1 } },
      );
      if (result.matchedCount !== 1) {
        throw new Error('Code environment registration could not be committed');
      }
    },

    async beginCodeEnvironmentRemoval(id) {
      const now = new Date();
      const leaseId = postgresStoreIds.generate();
      return orNull(
        await environments().findOneAndUpdate(
          { _id: id, ...codeEnvironmentRemovalClaimFilter(now) },
          codeEnvironmentRemovalClaimUpdate(now, leaseId),
          { returnDocument: 'after' },
        ),
      );
    },

    async cancelCodeEnvironmentRemoval(id, leaseId) {
      await environments().updateOne(
        { _id: id, deletionLeaseId: leaseId, deletionCommittedAt: { $exists: false } },
        { $unset: { deletionStartedAt: 1, deletionLeaseId: 1, deletionLeaseExpiresAt: 1 } },
      );
    },

    async commitCodeEnvironmentRemoval(id, leaseId) {
      const result = await environments().updateOne(
        { _id: id, deletionLeaseId: leaseId },
        { $set: { deletionCommittedAt: new Date() }, $unset: { deletionLeaseExpiresAt: 1 } },
      );
      if (result.matchedCount !== 1) {
        throw new Error('Code environment removal lease was lost');
      }
    },

    /** Delete unreferenced creator-owned records and grants after user removal.
     * Failed worker revocations and environments selected by surviving agents
     * remain durable for reconciliation instead of becoming dangling refs. */
    async deleteUserCodeEnvironments(userId) {
      const candidates = await environments().find(
        {
          createdBy: userId,
          revocationPendingAt: { $exists: false },
          deletionCommittedAt: { $exists: false },
        },
        { projection: '_id' },
      );
      let deleted = 0;
      for (const candidate of candidates) {
        const claimed = await store.beginCodeEnvironmentRemoval(candidate._id);
        if (claimed == null || claimed.deletionLeaseId == null) continue;
        if (await isReferencedByAgent(claimed.environmentId, claimed.tenantId)) {
          await store.cancelCodeEnvironmentRemoval(candidate._id, claimed.deletionLeaseId);
          continue;
        }
        await retireEnvironment(claimed as unknown as EnvironmentRecord);
        await context
          .collections()
          .collection('aclentries')
          .deleteMany({ resourceType: ResourceType.CODE_ENVIRONMENT, resourceId: candidate._id });
        const result = await environments().deleteOne({
          _id: candidate._id,
          deletionLeaseId: claimed.deletionLeaseId,
        });
        deleted += result.deletedCount;
      }
      return deleted;
    },

    isCodeEnvironmentReferencedByAgent: (environmentId, tenantId) =>
      isReferencedByAgent(environmentId, tenantId),

    async requestCodeEnvironmentRevocation(environmentId) {
      const result = await environments().updateOne(
        { environmentId, deletionCommittedAt: { $exists: false } },
        codeEnvironmentRevocationRequest(new Date()),
      );
      return result.matchedCount === 1;
    },

    async sweepExpiredCodeEnvironmentReferences(now, limit) {
      const checkpointId = AGENT_REFERENCE_CLEANUP_CHECKPOINT;
      await checkpoints().updateOne(
        { _id: checkpointId },
        { $setOnInsert: { lastId: null } },
        { upsert: true },
      );
      const checkpoint = await checkpoints().findOne({ _id: checkpointId });
      const lastId = checkpoint?.lastId ?? null;
      let upperId = checkpoint?.upperId;
      if (upperId == null) {
        const tail = await environments().findOne({}, { sort: { _id: -1 }, projection: '_id' });
        upperId = tail?._id ?? null;
        const captured = await checkpoints().updateOne(
          { _id: checkpointId, lastId, upperId: null },
          { $set: { upperId } },
        );
        if (captured.matchedCount !== 1) return false;
      }
      // Persist progress across leader changes and include old-replica writes on each sweep.
      const candidates =
        upperId == null
          ? []
          : await environments().find(
              { _id: { $lte: upperId, ...(lastId == null ? {} : { $gt: lastId }) } },
              { sort: { _id: 1 }, limit, projection: '_id' },
            );
      if (candidates.length > 0) {
        await environments().updateMany(
          { _id: { $in: candidates.map(({ _id }) => _id) } },
          { $pull: { pendingAgentReferences: { expiresAt: { $lte: now } } } },
        );
      }
      // Advance only after cleanup succeeds; a competing sweep must not rewind progress.
      const nextId = candidates[candidates.length - 1]?._id;
      const sweepComplete = nextId == null || nextId === upperId;
      await checkpoints().updateOne(
        { _id: checkpointId, lastId, upperId },
        {
          $set: {
            lastId: sweepComplete ? null : nextId,
            upperId: sweepComplete ? null : upperId,
          },
        },
      );
      return true;
    },

    async findExpiredCodeEnvironmentRemovals(now, limit) {
      return asEnvironments(
        await environments().find(
          { deletionCommittedAt: { $exists: false }, deletionLeaseExpiresAt: { $lte: now } },
          { sort: { _id: 1 }, limit, projection: '_id' },
        ),
      );
    },

    async findStaleCodeEnvironmentRegistrations(staleBefore, now, limit) {
      return asEnvironments(
        await environments().find(
          {
            setupAttemptId: { $exists: false },
            ...staleCodeEnvironmentRegistrationFilter(staleBefore, now),
          },
          { sort: { registrationReconcileAfter: 1, _id: 1 }, limit, projection: '_id' },
        ),
      );
    },

    async claimStaleCodeEnvironmentRegistration(id, staleBefore, leaseId, leaseMs) {
      const leaseNow = new Date();
      return orNull(
        await environments().findOneAndUpdate(
          { _id: id, ...staleCodeEnvironmentRegistrationFilter(staleBefore, leaseNow) },
          {
            $set: {
              registrationLeaseId: leaseId,
              registrationLeaseExpiresAt: new Date(leaseNow.getTime() + leaseMs),
            },
          },
          { returnDocument: 'after' },
        ),
      );
    },

    async deferCodeEnvironmentRegistration(id, leaseId, reconcileAfter) {
      await environments().updateOne(
        { _id: id, registrationLeaseId: leaseId },
        {
          $set: { registrationReconcileAfter: reconcileAfter },
          $unset: { registrationLeaseId: 1, registrationLeaseExpiresAt: 1 },
        },
      );
    },

    async deleteStaleCodeEnvironmentRegistration(id, leaseId) {
      await environments().deleteOne({ _id: id, registrationLeaseId: leaseId });
    },

    async findCommittedCodeEnvironmentDeletions(limit) {
      return asEnvironments(
        await environments().find({ deletionCommittedAt: { $exists: true } }, { limit }),
      );
    },

    async findOrphanedCodeEnvironments(limit) {
      const orphans = await runStoreSql<{ _id: string }>(
        context,
        sql`SELECT t._id FROM codeenvironments t WHERE ${storeWhere(context, 'codeenvironments', {
          revocationPendingAt: { $exists: false },
          deletionCommittedAt: { $exists: false },
        })} AND NOT EXISTS (SELECT 1 FROM users u WHERE u._id = t."createdBy")
        ORDER BY t._id LIMIT ${limit}`,
      );
      if (orphans.rows.length === 0) return [];
      const found = await environments().find(
        { _id: { $in: orphans.rows.map((row) => row._id) } },
        { sort: { _id: 1 }, projection: '_id createdBy workerId workerPrincipal' },
      );
      return found as unknown as OrphanedCodeEnvironment[];
    },

    async requestOrphanedCodeEnvironmentRevocations(ids, now) {
      await environments().updateMany({ _id: { $in: ids } }, codeEnvironmentRevocationRequest(now));
    },

    async findCodeEnvironmentRevocationCandidates(now, limit) {
      return asEnvironments(
        await environments().find(dueCodeEnvironmentRevocationFilter(now), {
          sort: { revocationReconcileAfter: 1, _id: 1 },
          limit,
          projection: '_id',
        }),
      );
    },

    async claimCodeEnvironmentRevocation(id, leaseId, leaseMs) {
      const now = new Date();
      return orNull(
        await environments().findOneAndUpdate(
          { _id: id, ...dueCodeEnvironmentRevocationFilter(now) },
          {
            $set: {
              revocationLeaseId: leaseId,
              revocationLeaseExpiresAt: new Date(now.getTime() + leaseMs),
            },
            $inc: { revocationAttempts: 1 },
          },
          { returnDocument: 'after' },
        ),
      );
    },

    async deferCodeEnvironmentRevocation(id, leaseId, error, reconcileAfter) {
      await environments().updateOne(
        { _id: id, revocationLeaseId: leaseId },
        {
          $set: { revocationLastError: error, revocationReconcileAfter: reconcileAfter },
          $unset: { revocationLeaseId: 1, revocationLeaseExpiresAt: 1 },
        },
      );
    },

    async beginCodeEnvironmentWorkerRevocations(ids) {
      await environments().updateMany(
        { _id: { $in: ids } },
        {
          $set: { revocationPendingAt: new Date() },
          $inc: { revocationAttempts: 1 },
          $unset: { revocationLastError: 1 },
        },
      );
    },

    async commitCodeEnvironmentWorkerRevocation(id) {
      await environments().updateOne(
        { _id: id },
        {
          $set: { deletionCommittedAt: new Date() },
          $unset: {
            revocationPendingAt: 1,
            revocationAttempts: 1,
            revocationLastError: 1,
            revocationReconcileAfter: 1,
          },
        },
      );
    },

    async recordCodeEnvironmentWorkerRevocationError(id, error) {
      await environments().updateOne({ _id: id }, { $set: { revocationLastError: error } });
    },
  };
  return store;
}
