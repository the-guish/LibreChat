import { Types } from 'mongoose';
import { createHash } from 'crypto';
import { ResourceType, MAX_AGENT_CODE_ENVIRONMENT_CHOICES } from 'librechat-data-provider';
import type { CodeEnvironmentUserSettings } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  CodeEnvironmentDocument,
  CreateCodeEnvironmentInput,
  IAclEntry,
  OrphanedCodeEnvironment,
} from '~/types';
import type {
  CodeEnvironmentSetupBinding,
  CodeEnvironmentSetupRecord,
} from '~/types/codeEnvironmentSetup';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

const CODE_ENVIRONMENT_TOMBSTONES = 'code_environment_tombstones';
const REFERENCE_LEASE_MS = 2 * 60_000;
const REFERENCE_RENEW_INTERVAL_MS = REFERENCE_LEASE_MS / 3;
const REMOVAL_LEASE_MS = 2 * 60_000;
const CODE_ENVIRONMENT_RECONCILIATION = 'code_environment_reconciliation';
const AGENT_REFERENCE_CLEANUP_CHECKPOINT = 'agent-reference-cleanup';

/** The progress of the agent reference sweep, kept across leader changes. */
type CodeEnvironmentReconciliationCheckpoint = {
  _id: string;
  lastId: Types.ObjectId | null;
  upperId?: Types.ObjectId | null;
};

type CodeEnvironmentTombstone = {
  _id: string;
  tenantId: string;
  environmentId: string;
  deletedAt: Date;
  setupBinding?: string;
  setupResourceId?: string;
};

function tenantScope(tenantId?: string): string {
  const resolved = tenantId ?? getTenantId();
  return resolved == null || resolved === SYSTEM_TENANT_ID ? '' : resolved;
}

function tombstoneId(environmentId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(`librechat-code-environment-tombstone\0${tenantScope(tenantId)}\0${environmentId}`)
    .digest('hex');
}

function setupTombstoneId(attemptId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(`librechat-code-environment-setup-tombstone\0${tenantScope(tenantId)}\0${attemptId}`)
    .digest('hex');
}

function tombstones(mongoose: typeof import('mongoose')) {
  const db = mongoose.connection.db;
  if (db == null) {
    throw new Error('MongoDB is not connected');
  }
  return db.collection<CodeEnvironmentTombstone>(CODE_ENVIRONMENT_TOMBSTONES);
}

function ownerSlotId(ownerId: Types.ObjectId, slot: number): Types.ObjectId {
  const hex = createHash('sha256')
    .update(`librechat-code-environment-slot\0${ownerId.toHexString()}\0${slot}`)
    .digest('hex')
    .slice(0, 24);
  return new Types.ObjectId(hex);
}

function agentReferenceFilter(environmentId: string, tenantId?: string) {
  return {
    $or: [{ code_environment_id: environmentId }, { code_environment_ids: environmentId }],
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
  };
}

export type CodeEnvironmentReferenceReservation = {
  environmentId: string;
  reservationId: string;
};

export class CodeEnvironmentReferenceError extends Error {
  readonly statusCode = 409;
  constructor(environmentId: string) {
    super(`Code environment is being removed: ${environmentId}`);
    this.name = 'CodeEnvironmentReferenceError';
  }
}

export async function reserveCodeEnvironmentReference(
  mongoose: typeof import('mongoose'),
  environmentId: string | undefined,
): Promise<CodeEnvironmentReferenceReservation | undefined> {
  if (environmentId == null || environmentId.length === 0) return undefined;
  const CodeEnvironment = mongoose.models.CodeEnvironment as
    | Model<CodeEnvironmentDocument>
    | undefined;
  if (CodeEnvironment == null) return undefined;
  const reservationId = new Types.ObjectId().toHexString();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFERENCE_LEASE_MS);
  const reserved = await CodeEnvironment.findOneAndUpdate(
    {
      environmentId,
      registrationPendingAt: { $exists: false },
      deletionCommittedAt: { $exists: false },
      deletionStartedAt: { $exists: false },
    },
    { $push: { pendingAgentReferences: { reservationId, expiresAt } } },
    { new: true },
  ).lean<CodeEnvironmentDocument>();
  if (reserved != null) return { environmentId, reservationId };

  const [persisted, tombstone] = await Promise.all([
    CodeEnvironment.exists({ environmentId }),
    tombstones(mongoose).findOne({ _id: tombstoneId(environmentId) }),
  ]);
  if (persisted != null || tombstone != null) {
    throw new CodeEnvironmentReferenceError(environmentId);
  }
  // Deployment-owned configuration does not have a registry row.
  return undefined;
}

export async function releaseCodeEnvironmentReference(
  mongoose: typeof import('mongoose'),
  reservation: CodeEnvironmentReferenceReservation | undefined,
): Promise<void> {
  if (reservation == null) return;
  const CodeEnvironment = mongoose.models.CodeEnvironment as
    | Model<CodeEnvironmentDocument>
    | undefined;
  if (CodeEnvironment == null) return;
  await CodeEnvironment.updateOne(
    { environmentId: reservation.environmentId },
    { $pull: { pendingAgentReferences: { reservationId: reservation.reservationId } } },
  );
}

async function renewCodeEnvironmentReference(
  mongoose: typeof import('mongoose'),
  reservation: CodeEnvironmentReferenceReservation,
): Promise<void> {
  const CodeEnvironment = mongoose.models.CodeEnvironment as
    | Model<CodeEnvironmentDocument>
    | undefined;
  if (CodeEnvironment == null) return;
  const result = await CodeEnvironment.updateOne(
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
}

/** Hold every machine reference until the write settles. Nesting the existing
 * guards renews already-acquired leases and releases them if a later acquisition fails. */
export async function withCodeEnvironmentReferences<T>(
  mongoose: typeof import('mongoose'),
  environmentIds: string[],
  operation: () => Promise<T>,
  onReferenceLoss?: (result: T, environmentId: string) => Promise<void>,
): Promise<T> {
  if (environmentIds.length > MAX_AGENT_CODE_ENVIRONMENT_CHOICES + 1) {
    throw new Error('Agent code environment references exceed the storage safety ceiling');
  }
  const ids = [...new Set(environmentIds.filter(Boolean))];
  const run = (index: number): Promise<T> =>
    index === ids.length
      ? operation()
      : withCodeEnvironmentReference(
          mongoose,
          ids[index],
          () => run(index + 1),
          undefined,
          (result) => onReferenceLoss?.(result, ids[index]) ?? Promise.resolve(),
        );
  return await run(0);
}

export async function withCodeEnvironmentReference<T>(
  mongoose: typeof import('mongoose'),
  environmentId: string | undefined,
  operation: () => Promise<T>,
  renewIntervalMs: number = REFERENCE_RENEW_INTERVAL_MS,
  onReferenceLoss?: (result: T) => Promise<void>,
): Promise<T> {
  const reservation = await reserveCodeEnvironmentReference(mongoose, environmentId);
  if (reservation == null) return await operation();

  let renewal = Promise.resolve();
  let renewalError: unknown;
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => renewCodeEnvironmentReference(mongoose, reservation))
      .catch((error) => {
        renewalError ??= error;
        logger.error('[code-environments] agent reference lease renewal failed:', error);
      });
  }, renewIntervalMs);
  timer.unref();
  try {
    const result = await operation();
    /** Freeze the renewal chain before awaiting it. Otherwise the interval can
     * append one last renewal after this await has captured an earlier promise. */
    clearInterval(timer);
    await renewal;
    if (renewalError != null) {
      try {
        await renewCodeEnvironmentReference(mongoose, reservation);
        renewalError = undefined;
      } catch (error) {
        await onReferenceLoss?.(result);
        throw error;
      }
    }
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
    await releaseCodeEnvironmentReference(mongoose, reservation);
  }
}

export function createCodeEnvironmentMethods(mongoose: typeof import('mongoose')): {
  ensureSetupEnvironmentIndexes: () => Promise<void>;
  reserveSetupEnvironment: (
    binding: CodeEnvironmentSetupBinding,
    maxOwned?: number,
  ) => Promise<CodeEnvironmentSetupRecord | null>;
  findSetupEnvironment: (
    binding: CodeEnvironmentSetupBinding,
  ) => Promise<CodeEnvironmentSetupRecord | null>;
  completeSetupEnvironment: (
    binding: CodeEnvironmentSetupBinding,
    resourceId: string,
  ) => Promise<CodeEnvironmentSetupRecord>;
  beginDiscardSetupEnvironment: (
    binding: CodeEnvironmentSetupBinding,
  ) => Promise<CodeEnvironmentSetupRecord | null>;
  finishDiscardSetupEnvironment: (
    binding: CodeEnvironmentSetupBinding,
    resourceId: string,
  ) => Promise<void>;
  createCodeEnvironment: (input: CreateCodeEnvironmentInput) => Promise<CodeEnvironmentDocument>;
  createCodeEnvironmentWithinOwnerLimit: (
    input: CreateCodeEnvironmentInput,
    maxOwned: number,
  ) => Promise<CodeEnvironmentDocument | null>;
  findCodeEnvironmentsByIds: (
    ids: Array<string | Types.ObjectId>,
  ) => Promise<CodeEnvironmentDocument[]>;
  findCodeEnvironmentByEnvironmentId: (
    environmentId: string,
  ) => Promise<CodeEnvironmentDocument | null>;
  updateCodeEnvironmentSettings: (
    environmentId: string,
    settings: CodeEnvironmentUserSettings,
  ) => Promise<CodeEnvironmentDocument | null>;
  listCodeEnvironmentIds: () => Promise<string[]>;
  findCodeEnvironmentsByCreator: (
    userId: string | Types.ObjectId,
  ) => Promise<CodeEnvironmentDocument[]>;
  deleteCodeEnvironmentById: (
    id: string | Types.ObjectId,
  ) => Promise<CodeEnvironmentDocument | null>;
  discardCodeEnvironmentById: (id: string | Types.ObjectId) => Promise<void>;
  completeCodeEnvironmentRegistration: (id: string | Types.ObjectId) => Promise<void>;
  beginCodeEnvironmentRemoval: (
    id: string | Types.ObjectId,
  ) => Promise<CodeEnvironmentDocument | null>;
  cancelCodeEnvironmentRemoval: (id: string | Types.ObjectId, leaseId: string) => Promise<void>;
  commitCodeEnvironmentRemoval: (id: string | Types.ObjectId, leaseId: string) => Promise<void>;
  deleteUserCodeEnvironments: (userId: string | Types.ObjectId) => Promise<number>;
  isCodeEnvironmentReferencedByAgent: (
    environmentId: string,
    tenantId?: string,
  ) => Promise<boolean>;
  requestCodeEnvironmentRevocation: (environmentId: string) => Promise<boolean>;
  sweepExpiredCodeEnvironmentReferences: (now: Date, limit: number) => Promise<boolean>;
  findExpiredCodeEnvironmentRemovals: (
    now: Date,
    limit: number,
  ) => Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>>;
  findStaleCodeEnvironmentRegistrations: (
    staleBefore: Date,
    now: Date,
    limit: number,
  ) => Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>>;
  claimStaleCodeEnvironmentRegistration: (
    id: string | Types.ObjectId,
    staleBefore: Date,
    leaseId: string,
    leaseMs: number,
  ) => Promise<CodeEnvironmentDocument | null>;
  deferCodeEnvironmentRegistration: (
    id: string | Types.ObjectId,
    leaseId: string,
    reconcileAfter: Date,
  ) => Promise<void>;
  deleteStaleCodeEnvironmentRegistration: (
    id: string | Types.ObjectId,
    leaseId: string,
  ) => Promise<void>;
  findCommittedCodeEnvironmentDeletions: (limit: number) => Promise<CodeEnvironmentDocument[]>;
  findOrphanedCodeEnvironments: (limit: number) => Promise<OrphanedCodeEnvironment[]>;
  requestOrphanedCodeEnvironmentRevocations: (
    ids: Array<string | Types.ObjectId>,
    now: Date,
  ) => Promise<void>;
  findCodeEnvironmentRevocationCandidates: (
    now: Date,
    limit: number,
  ) => Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>>;
  claimCodeEnvironmentRevocation: (
    id: string | Types.ObjectId,
    leaseId: string,
    leaseMs: number,
  ) => Promise<CodeEnvironmentDocument | null>;
  deferCodeEnvironmentRevocation: (
    id: string | Types.ObjectId,
    leaseId: string,
    error: string,
    reconcileAfter: Date,
  ) => Promise<void>;
  beginCodeEnvironmentWorkerRevocations: (ids: Array<string | Types.ObjectId>) => Promise<void>;
  commitCodeEnvironmentWorkerRevocation: (id: string | Types.ObjectId) => Promise<void>;
  recordCodeEnvironmentWorkerRevocationError: (
    id: string | Types.ObjectId,
    error: string,
  ) => Promise<void>;
} {
  const model = () => mongoose.models.CodeEnvironment as Model<CodeEnvironmentDocument>;
  let setupIndexInitialization: Promise<void> | undefined;
  async function ensureSetupEnvironmentIndexes(): Promise<void> {
    const current = (setupIndexInitialization ??= createIndexesWithRetry(model()));
    try {
      await current;
    } catch (error) {
      if (setupIndexInitialization === current) setupIndexInitialization = undefined;
      throw error;
    }
  }

  function setupFilter(binding: CodeEnvironmentSetupBinding) {
    return {
      environmentId: binding.environmentId,
      tenantId: tenantScope() === '' ? { $exists: false } : tenantScope(),
      setupAttemptId: binding.setupAttemptId,
      setupRequestHash: binding.requestHash,
      createdBy: new Types.ObjectId(binding.ownerId),
      name: binding.name,
      type: binding.type,
      baseURL: binding.baseURL,
      controlPlaneId: binding.controlPlaneId,
      workerId: binding.workerId ?? { $exists: false },
      revocationTokenEnv: binding.revocationTokenEnv ?? { $exists: false },
      ...(binding.workerPrincipal == null
        ? { workerPrincipal: { $exists: false } }
        : {
            'workerPrincipal.type': binding.workerPrincipal.type,
            'workerPrincipal.id': binding.workerPrincipal.id,
          }),
    };
  }

  function setupIdentity(
    binding: CodeEnvironmentSetupBinding,
    tenantId: string = tenantScope(),
  ): string {
    return JSON.stringify([
      tenantId,
      binding.setupAttemptId,
      binding.requestHash,
      binding.ownerId,
      binding.environmentId,
      binding.name,
      binding.type,
      binding.baseURL,
      binding.controlPlaneId,
      binding.workerId ?? null,
      binding.revocationTokenEnv ?? null,
      binding.workerPrincipal?.type ?? null,
      binding.workerPrincipal?.id ?? null,
    ]);
  }

  function rowSetupBinding(environment: CodeEnvironmentDocument): string | undefined {
    if (environment.setupAttemptId == null || environment.setupRequestHash == null)
      return undefined;
    return setupIdentity(
      {
        setupAttemptId: environment.setupAttemptId,
        requestHash: environment.setupRequestHash,
        ownerId: environment.createdBy.toString(),
        environmentId: environment.environmentId,
        name: environment.name,
        type: environment.type,
        baseURL: environment.baseURL,
        controlPlaneId: environment.controlPlaneId,
        workerId: environment.workerId,
        revocationTokenEnv: environment.revocationTokenEnv,
        workerPrincipal: environment.workerPrincipal,
      },
      tenantScope(environment.tenantId),
    );
  }

  async function retireEnvironment(environment: CodeEnvironmentDocument): Promise<void> {
    const setupBinding = rowSetupBinding(environment);
    const metadata =
      setupBinding == null ? {} : { setupBinding, setupResourceId: environment._id.toString() };
    const ids = [tombstoneId(environment.environmentId, environment.tenantId)];
    if (setupBinding != null)
      ids.push(setupTombstoneId(environment.setupAttemptId!, environment.tenantId));
    await Promise.all(
      ids.map(async (_id) =>
        tombstones(mongoose).updateOne(
          {
            _id,
            ...(setupBinding == null
              ? {}
              : { $or: [{ setupBinding: { $exists: false } }, { setupBinding }] }),
          },
          {
            $setOnInsert: {
              tenantId: tenantScope(environment.tenantId),
              environmentId: environment.environmentId,
              deletedAt: new Date(),
            },
            ...(setupBinding == null ? {} : { $set: metadata }),
          },
          { upsert: true },
        ),
      ),
    );
  }

  function retiredSetupFilter(binding: CodeEnvironmentSetupBinding) {
    return {
      _id: { $in: [tombstoneId(binding.environmentId), setupTombstoneId(binding.setupAttemptId)] },
    };
  }

  function setupRecord(environment: CodeEnvironmentDocument): CodeEnvironmentSetupRecord {
    return {
      resourceId: environment._id.toString(),
      id: environment.environmentId,
      name: environment.name,
      type: environment.type,
      pending: environment.registrationPendingAt != null,
    };
  }

  function setupLiveFilter(binding: CodeEnvironmentSetupBinding) {
    return {
      ...setupFilter(binding),
      setupDiscardedAt: { $exists: false },
      deletionStartedAt: { $exists: false },
      deletionCommittedAt: { $exists: false },
      revocationPendingAt: { $exists: false },
    };
  }

  async function findSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
  ): Promise<CodeEnvironmentSetupRecord | null> {
    const environment = await model()
      .findOne(setupLiveFilter(binding))
      .lean<CodeEnvironmentDocument>();
    if (environment != null) return setupRecord(environment);
    const [collision, retired] = await Promise.all([
      model().exists({
        tenantId: tenantScope() === '' ? { $exists: false } : tenantScope(),
        $or: [{ environmentId: binding.environmentId }, { setupAttemptId: binding.setupAttemptId }],
      }),
      tombstones(mongoose).findOne(retiredSetupFilter(binding)),
    ]);
    if (collision != null || retired != null)
      throw new Error('Browser setup registry binding is unavailable');
    return null;
  }

  async function reserveSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
    maxOwned?: number,
  ): Promise<CodeEnvironmentSetupRecord | null> {
    await ensureSetupEnvironmentIndexes();
    const replay = await findSetupEnvironment(binding);
    if (replay != null) return replay;
    const input: CreateCodeEnvironmentInput = {
      ...binding,
      createdBy: new Types.ObjectId(binding.ownerId),
      setupRequestHash: binding.requestHash,
    };
    let created: CodeEnvironmentDocument | null;
    try {
      created =
        maxOwned == null
          ? await createCodeEnvironment(input)
          : await createCodeEnvironmentWithinOwnerLimit(input, maxOwned);
    } catch (error) {
      const duplicate =
        typeof error === 'object' && error != null && 'code' in error && error.code === 11000;
      if (!duplicate) throw error;
      const replayed = await findSetupEnvironment(binding);
      if (replayed != null) return replayed;
      throw error;
    }
    if (created == null) return await findSetupEnvironment(binding);
    // A concurrent retirement can win between the initial lookup and insertion.
    if ((await tombstones(mongoose).findOne(retiredSetupFilter(binding))) != null) {
      await model().updateOne(
        { _id: created._id, ...setupFilter(binding) },
        { $set: { setupDiscardedAt: new Date() } },
      );
      throw new Error('Browser setup registry binding is retired');
    }
    return setupRecord(created);
  }

  async function completeSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
    resourceId: string,
  ): Promise<CodeEnvironmentSetupRecord> {
    const updated = await model()
      .findOneAndUpdate(
        { _id: new Types.ObjectId(resourceId), ...setupLiveFilter(binding) },
        { $unset: { registrationPendingAt: 1, registrationReconcileAfter: 1 } },
        { new: true },
      )
      .lean<CodeEnvironmentDocument>();
    if (updated == null) throw new Error('Browser setup registration could not be committed');
    return setupRecord(updated);
  }

  async function beginDiscardSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
  ): Promise<CodeEnvironmentSetupRecord | null> {
    const updated = await model()
      .findOneAndUpdate(
        setupFilter(binding),
        { $set: { setupDiscardedAt: new Date(), registrationPendingAt: new Date() } },
        { new: true },
      )
      .lean<CodeEnvironmentDocument>();
    if (updated != null) {
      await retireEnvironment(updated);
      return setupRecord(updated);
    }
    const [collision, retired] = await Promise.all([
      model().exists({
        $or: [{ environmentId: binding.environmentId }, { setupAttemptId: binding.setupAttemptId }],
        tenantId: tenantScope() === '' ? { $exists: false } : tenantScope(),
      }),
      tombstones(mongoose).findOne(retiredSetupFilter(binding)),
    ]);
    if (collision != null || (retired != null && retired.setupBinding !== setupIdentity(binding)))
      throw new Error('Browser setup registry binding does not match');
    // Fence an absent reservation, including compensation racing its first insertion.
    if (retired == null)
      await Promise.all(
        retiredSetupFilter(binding)._id.$in.map(async (_id) =>
          tombstones(mongoose).updateOne(
            { _id },
            {
              $setOnInsert: {
                tenantId: tenantScope(),
                environmentId: binding.environmentId,
                deletedAt: new Date(),
                setupBinding: setupIdentity(binding),
              },
            },
            { upsert: true },
          ),
        ),
      );
    return retired?.setupResourceId == null
      ? null
      : {
          resourceId: retired.setupResourceId,
          id: binding.environmentId,
          name: binding.name,
          type: binding.type,
          pending: true,
        };
  }

  async function finishDiscardSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
    resourceId: string,
  ): Promise<void> {
    await model().deleteOne({
      _id: new Types.ObjectId(resourceId),
      ...setupFilter(binding),
      setupDiscardedAt: { $exists: true },
    });
  }

  async function createCodeEnvironment(
    input: CreateCodeEnvironmentInput,
  ): Promise<CodeEnvironmentDocument> {
    if ((await tombstones(mongoose).findOne({ _id: tombstoneId(input.environmentId) })) != null) {
      throw new Error(`Code environment id was previously retired: ${input.environmentId}`);
    }
    return (
      await model().create({ ...input, registrationPendingAt: new Date() })
    ).toObject() as CodeEnvironmentDocument;
  }

  async function createCodeEnvironmentWithinOwnerLimit(
    input: CreateCodeEnvironmentInput,
    maxOwned: number,
  ): Promise<CodeEnvironmentDocument | null> {
    if ((await tombstones(mongoose).findOne({ _id: tombstoneId(input.environmentId) })) != null) {
      throw new Error(`Code environment id was previously retired: ${input.environmentId}`);
    }
    const existing = await model()
      .find({ createdBy: input.createdBy })
      .select('ownerSlot')
      .lean<Array<Pick<CodeEnvironmentDocument, 'ownerSlot'>>>();
    if (existing.length >= maxOwned) return null;
    const reserved = new Set(
      existing
        .map(({ ownerSlot }) => ownerSlot)
        .filter(
          (slot): slot is number =>
            typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 && slot < maxOwned,
        ),
    );
    for (let ownerSlot = 0; reserved.size < existing.length && ownerSlot < maxOwned; ownerSlot++) {
      reserved.add(ownerSlot);
    }
    for (let ownerSlot = 0; ownerSlot < maxOwned; ownerSlot++) {
      if (reserved.has(ownerSlot)) continue;
      try {
        return (
          await model().create({
            ...input,
            _id:
              input.setupAttemptId == null
                ? ownerSlotId(input.createdBy, ownerSlot)
                : new Types.ObjectId(),
            ownerSlot,
            registrationPendingAt: new Date(),
          })
        ).toObject() as CodeEnvironmentDocument;
      } catch (error) {
        const duplicateOwnerSlot =
          typeof error === 'object' &&
          error != null &&
          'code' in error &&
          error.code === 11000 &&
          'keyPattern' in error &&
          typeof error.keyPattern === 'object' &&
          error.keyPattern != null &&
          ('_id' in error.keyPattern || 'ownerSlot' in error.keyPattern);
        if (!duplicateOwnerSlot) {
          throw error;
        }
      }
    }
    return null;
  }

  async function findCodeEnvironmentsByIds(
    ids: Array<string | Types.ObjectId>,
  ): Promise<CodeEnvironmentDocument[]> {
    if (ids.length === 0) return [];
    return await model()
      .find({ _id: { $in: ids } })
      .sort({ createdAt: 1, _id: 1 })
      .lean<CodeEnvironmentDocument[]>();
  }

  async function findCodeEnvironmentByEnvironmentId(
    environmentId: string,
  ): Promise<CodeEnvironmentDocument | null> {
    return await model().findOne({ environmentId }).lean<CodeEnvironmentDocument>();
  }

  async function updateCodeEnvironmentSettings(
    environmentId: string,
    settings: CodeEnvironmentUserSettings,
  ): Promise<CodeEnvironmentDocument | null> {
    const updates: Record<string, string> = {};
    if (settings.permissions?.fileWrite != null) {
      updates['settings.permissions.fileWrite'] = settings.permissions.fileWrite;
    }
    if (settings.permissions?.commandExecution != null) {
      updates['settings.permissions.commandExecution'] = settings.permissions.commandExecution;
    }
    const lifecycleFilter = {
      environmentId,
      registrationPendingAt: { $exists: false },
      deletionStartedAt: { $exists: false },
      deletionCommittedAt: { $exists: false },
    };
    if (Object.keys(updates).length === 0) {
      return await model().findOne(lifecycleFilter).lean<CodeEnvironmentDocument>();
    }
    return await model()
      .findOneAndUpdate(lifecycleFilter, { $set: updates }, { new: true, runValidators: true })
      .lean<CodeEnvironmentDocument>();
  }

  async function listCodeEnvironmentIds(): Promise<string[]> {
    return await model().distinct('environmentId');
  }

  async function findCodeEnvironmentsByCreator(
    userId: string | Types.ObjectId,
  ): Promise<CodeEnvironmentDocument[]> {
    const creatorId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    return await model()
      .find({ createdBy: creatorId })
      .sort({ createdAt: 1, _id: 1 })
      .lean<CodeEnvironmentDocument[]>();
  }

  async function deleteCodeEnvironmentById(
    id: string | Types.ObjectId,
  ): Promise<CodeEnvironmentDocument | null> {
    const environment = await model().findById(id).lean<CodeEnvironmentDocument>();
    if (environment == null) return null;
    await retireEnvironment(environment);
    return await model().findByIdAndDelete(id).lean<CodeEnvironmentDocument>();
  }

  async function discardCodeEnvironmentById(id: string | Types.ObjectId): Promise<void> {
    await model().deleteOne({ _id: id, setupAttemptId: { $exists: false } });
  }

  async function completeCodeEnvironmentRegistration(id: string | Types.ObjectId): Promise<void> {
    const result = await model().updateOne(
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
  }

  async function beginCodeEnvironmentRemoval(
    id: string | Types.ObjectId,
  ): Promise<CodeEnvironmentDocument | null> {
    const now = new Date();
    const leaseId = new Types.ObjectId().toHexString();
    return await model()
      .findOneAndUpdate(
        {
          _id: id,
          deletionCommittedAt: { $exists: false },
          $and: [
            {
              $or: [
                { deletionStartedAt: { $exists: false } },
                { deletionLeaseExpiresAt: { $lte: now } },
              ],
            },
            {
              $or: [
                { pendingAgentReferences: { $exists: false } },
                { pendingAgentReferences: { $size: 0 } },
                {
                  pendingAgentReferences: {
                    $not: { $elemMatch: { expiresAt: { $gt: now } } },
                  },
                },
              ],
            },
          ],
        },
        {
          $set: {
            deletionStartedAt: now,
            deletionLeaseId: leaseId,
            deletionLeaseExpiresAt: new Date(now.getTime() + REMOVAL_LEASE_MS),
          },
          $pull: { pendingAgentReferences: { expiresAt: { $lte: now } } },
        },
        { new: true },
      )
      .lean<CodeEnvironmentDocument>();
  }

  async function cancelCodeEnvironmentRemoval(
    id: string | Types.ObjectId,
    leaseId: string,
  ): Promise<void> {
    await model().updateOne(
      { _id: id, deletionLeaseId: leaseId, deletionCommittedAt: { $exists: false } },
      {
        $unset: {
          deletionStartedAt: 1,
          deletionLeaseId: 1,
          deletionLeaseExpiresAt: 1,
        },
      },
    );
  }

  async function commitCodeEnvironmentRemoval(
    id: string | Types.ObjectId,
    leaseId: string,
  ): Promise<void> {
    const result = await model().updateOne(
      { _id: id, deletionLeaseId: leaseId },
      {
        $set: { deletionCommittedAt: new Date() },
        $unset: { deletionLeaseExpiresAt: 1 },
      },
    );
    if (result.matchedCount !== 1) {
      throw new Error('Code environment removal lease was lost');
    }
  }

  /** Delete unreferenced creator-owned records and grants after user removal.
   * Failed worker revocations and environments selected by surviving agents
   * remain durable for reconciliation instead of becoming dangling refs. */
  async function deleteUserCodeEnvironments(userId: string | Types.ObjectId): Promise<number> {
    const creatorId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const environments = await model()
      .find({
        createdBy: creatorId,
        revocationPendingAt: { $exists: false },
        deletionCommittedAt: { $exists: false },
      })
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (environments.length === 0) return 0;

    const Agent = mongoose.models.Agent;
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    let deleted = 0;
    for (const candidate of environments) {
      const claimed = await beginCodeEnvironmentRemoval(candidate._id);
      if (claimed == null || claimed.deletionLeaseId == null) continue;
      const referenced =
        Agent != null &&
        (await Agent.exists(agentReferenceFilter(claimed.environmentId, claimed.tenantId))) != null;
      if (referenced) {
        await cancelCodeEnvironmentRemoval(candidate._id, claimed.deletionLeaseId);
        continue;
      }
      await retireEnvironment(claimed);
      await AclEntry.deleteMany({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: candidate._id,
      });
      const result = await model().deleteOne({
        _id: candidate._id,
        deletionLeaseId: claimed.deletionLeaseId,
      });
      deleted += result.deletedCount ?? 0;
    }
    return deleted;
  }

  /** Whether an agent (in the environment's tenant) selects the environment. */
  async function isCodeEnvironmentReferencedByAgent(
    environmentId: string,
    tenantId?: string,
  ): Promise<boolean> {
    const Agent = mongoose.models.Agent;
    return (
      Agent != null && (await Agent.exists(agentReferenceFilter(environmentId, tenantId))) != null
    );
  }

  /**
   * Marks the environment's worker for revocation (counting the attempt and clearing the last
   * error and retry time); `false` when no environment with the id is left to remove.
   */
  async function requestCodeEnvironmentRevocation(environmentId: string): Promise<boolean> {
    const result = await model().updateOne(
      { environmentId, deletionCommittedAt: { $exists: false } },
      {
        $set: { revocationPendingAt: new Date() },
        $inc: { revocationAttempts: 1 },
        $unset: { revocationLastError: 1, revocationReconcileAfter: 1 },
      },
    );
    return result.matchedCount === 1;
  }

  /**
   * One step of the sweep of expired agent reference reservations: the next `limit`
   * environments (by id, up to the bound captured when the pass began) lose their reservations
   * that expired by `now`. The progress lives in the `code_environment_reconciliation`
   * collection, so it survives leader changes, and a competing sweep never rewinds it. `false`
   * when the reconciliation must stop here: the code environment or permission models are not
   * registered, or a competing sweep captured the bound first.
   */
  async function sweepExpiredCodeEnvironmentReferences(now: Date, limit: number): Promise<boolean> {
    const CodeEnvironment = mongoose.models.CodeEnvironment as
      | Model<CodeEnvironmentDocument>
      | undefined;
    const AclEntry = mongoose.models.AclEntry;
    if (CodeEnvironment == null || AclEntry == null) return false;
    const checkpoints = mongoose.connection.db!.collection<CodeEnvironmentReconciliationCheckpoint>(
      CODE_ENVIRONMENT_RECONCILIATION,
    );
    const checkpointId = AGENT_REFERENCE_CLEANUP_CHECKPOINT;
    await checkpoints.updateOne(
      { _id: checkpointId },
      { $setOnInsert: { lastId: null } },
      { upsert: true },
    );
    const checkpoint = await checkpoints.findOne({ _id: checkpointId });
    const lastId = checkpoint?.lastId ?? null;
    let upperId = checkpoint?.upperId;
    if (upperId == null) {
      const tail = await CodeEnvironment.findOne({})
        .hint('_id_')
        .sort({ _id: -1 })
        .select('_id')
        .lean<Pick<CodeEnvironmentDocument, '_id'>>();
      upperId = tail?._id ?? null;
      const captured = await checkpoints.updateOne(
        { _id: checkpointId, lastId, upperId: null },
        { $set: { upperId } },
      );
      if (captured.matchedCount !== 1) return false;
    }
    // Persist progress across leader changes and include old-replica writes on each sweep.
    const expiredReferenceCandidates = await CodeEnvironment.find({
      _id: { $lte: upperId, ...(lastId == null ? {} : { $gt: lastId }) },
    })
      .hint('_id_')
      .sort({ _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (expiredReferenceCandidates.length > 0) {
      await CodeEnvironment.updateMany(
        { _id: { $in: expiredReferenceCandidates.map(({ _id }) => _id) } },
        { $pull: { pendingAgentReferences: { expiresAt: { $lte: now } } } },
      );
    }
    // Advance only after cleanup succeeds; a competing sweep must not rewind progress.
    const nextId = expiredReferenceCandidates[expiredReferenceCandidates.length - 1]?._id;
    const sweepComplete = nextId == null || nextId.equals(upperId);
    await checkpoints.updateOne(
      { _id: checkpointId, lastId, upperId },
      {
        $set: {
          lastId: sweepComplete ? null : nextId,
          upperId: sweepComplete ? null : upperId,
        },
      },
    );
    return true;
  }

  /** Up to `limit` environments, by id, whose uncommitted removal lease expired by `now`. */
  async function findExpiredCodeEnvironmentRemovals(
    now: Date,
    limit: number,
  ): Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>> {
    return await model()
      .find({
        deletionCommittedAt: { $exists: false },
        deletionLeaseExpiresAt: { $lte: now },
      })
      .sort({ _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
  }

  /** The filter of a registration (not a setup reservation's) left pending since `staleBefore`. */
  function staleRegistrationFilter(staleBefore: Date, now: Date) {
    return {
      registrationPendingAt: { $lte: staleBefore },
      $and: [
        {
          $or: [
            { registrationReconcileAfter: { $exists: false } },
            { registrationReconcileAfter: { $lte: now } },
          ],
        },
        {
          $or: [
            { registrationLeaseExpiresAt: { $exists: false } },
            { registrationLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    };
  }

  /**
   * Up to `limit` environments (never setup reservations) pending registration since
   * `staleBefore` that are due for reconciliation at `now` and not leased, the earliest due first.
   */
  async function findStaleCodeEnvironmentRegistrations(
    staleBefore: Date,
    now: Date,
    limit: number,
  ): Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>> {
    return await model()
      .find({ setupAttemptId: { $exists: false }, ...staleRegistrationFilter(staleBefore, now) })
      .sort({ registrationReconcileAfter: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
  }

  /**
   * Leases the stale registration for `leaseMs` under `leaseId` (its `registrationLeaseId`) while
   * it is still stale, due and unleased; resolves to it, or `null`.
   */
  async function claimStaleCodeEnvironmentRegistration(
    id: string | Types.ObjectId,
    staleBefore: Date,
    leaseId: string,
    leaseMs: number,
  ): Promise<CodeEnvironmentDocument | null> {
    const leaseNow = new Date();
    return await model()
      .findOneAndUpdate(
        { _id: id, ...staleRegistrationFilter(staleBefore, leaseNow) },
        {
          $set: {
            registrationLeaseId: leaseId,
            registrationLeaseExpiresAt: new Date(leaseNow.getTime() + leaseMs),
          },
        },
        { new: true },
      )
      .lean<CodeEnvironmentDocument>();
  }

  /** Releases the registration lease and retries the stale registration after `reconcileAfter`. */
  async function deferCodeEnvironmentRegistration(
    id: string | Types.ObjectId,
    leaseId: string,
    reconcileAfter: Date,
  ): Promise<void> {
    await model().updateOne(
      { _id: id, registrationLeaseId: leaseId },
      {
        $set: { registrationReconcileAfter: reconcileAfter },
        $unset: { registrationLeaseId: 1, registrationLeaseExpiresAt: 1 },
      },
    );
  }

  /** Deletes the stale registration while it is still leased under `leaseId`. */
  async function deleteStaleCodeEnvironmentRegistration(
    id: string | Types.ObjectId,
    leaseId: string,
  ): Promise<void> {
    await model().deleteOne({ _id: id, registrationLeaseId: leaseId });
  }

  /** Up to `limit` environments whose removal was committed. */
  async function findCommittedCodeEnvironmentDeletions(
    limit: number,
  ): Promise<CodeEnvironmentDocument[]> {
    return await model()
      .find({ deletionCommittedAt: { $exists: true } })
      .limit(limit)
      .lean<CodeEnvironmentDocument[]>();
  }

  /**
   * Up to `limit` environments, by id, whose creator no longer exists, that are neither marked
   * for revocation nor committed for removal.
   */
  async function findOrphanedCodeEnvironments(limit: number): Promise<OrphanedCodeEnvironment[]> {
    return await model().aggregate<OrphanedCodeEnvironment>([
      {
        $match: {
          revocationPendingAt: { $exists: false },
          deletionCommittedAt: { $exists: false },
        },
      },
      {
        $lookup: {
          // eslint-disable-next-line no-restricted-syntax -- Collection name metadata only, no raw driver operations.
          from: mongoose.models.User.collection.name,
          localField: 'createdBy',
          foreignField: '_id',
          as: 'owner',
        },
      },
      { $match: { owner: { $size: 0 } } },
      { $sort: { _id: 1 } },
      { $limit: limit },
      { $project: { _id: 1, createdBy: 1, workerId: 1, workerPrincipal: 1 } },
    ]);
  }

  /**
   * Marks the environments' workers for revocation at `now` (counting the attempt and clearing
   * the last error and retry time).
   */
  async function requestOrphanedCodeEnvironmentRevocations(
    ids: Array<string | Types.ObjectId>,
    now: Date,
  ): Promise<void> {
    await model().updateMany(
      { _id: { $in: ids } },
      {
        $set: { revocationPendingAt: now },
        $inc: { revocationAttempts: 1 },
        $unset: { revocationLastError: 1, revocationReconcileAfter: 1 },
      },
    );
  }

  /** The filter of a revocation due at `now` and not leased. */
  function revocationDueFilter(now: Date) {
    return {
      revocationPendingAt: { $exists: true },
      $and: [
        {
          $or: [
            { revocationReconcileAfter: { $exists: false } },
            { revocationReconcileAfter: { $lte: now } },
          ],
        },
        {
          $or: [
            { revocationLeaseExpiresAt: { $exists: false } },
            { revocationLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    };
  }

  /**
   * Up to `limit` environments whose worker revocation is due at `now` and not leased, the
   * earliest due first.
   */
  async function findCodeEnvironmentRevocationCandidates(
    now: Date,
    limit: number,
  ): Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>> {
    return await model()
      .find(revocationDueFilter(now))
      .sort({ revocationReconcileAfter: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
  }

  /**
   * Leases the due revocation for `leaseMs` under `leaseId` (its `revocationLeaseId`), counting
   * the attempt; resolves to the environment, or `null` when it is no longer due or is leased.
   */
  async function claimCodeEnvironmentRevocation(
    id: string | Types.ObjectId,
    leaseId: string,
    leaseMs: number,
  ): Promise<CodeEnvironmentDocument | null> {
    const now = new Date();
    return await model()
      .findOneAndUpdate(
        { _id: id, ...revocationDueFilter(now) },
        {
          $set: {
            revocationLeaseId: leaseId,
            revocationLeaseExpiresAt: new Date(now.getTime() + leaseMs),
          },
          $inc: { revocationAttempts: 1 },
        },
        { new: true },
      )
      .lean<CodeEnvironmentDocument>();
  }

  /**
   * Records the failed revocation's error, releases its lease and retries it after
   * `reconcileAfter`, while it is still leased under `leaseId`.
   */
  async function deferCodeEnvironmentRevocation(
    id: string | Types.ObjectId,
    leaseId: string,
    error: string,
    reconcileAfter: Date,
  ): Promise<void> {
    await model().updateOne(
      { _id: id, revocationLeaseId: leaseId },
      {
        $set: {
          revocationLastError: error,
          revocationReconcileAfter: reconcileAfter,
        },
        $unset: { revocationLeaseId: 1, revocationLeaseExpiresAt: 1 },
      },
    );
  }

  /**
   * Marks the environments' workers for revocation now, at an account deletion (counting the
   * attempt and clearing the last error). Does nothing without the code environment model.
   */
  async function beginCodeEnvironmentWorkerRevocations(
    ids: Array<string | Types.ObjectId>,
  ): Promise<void> {
    const CodeEnvironment = mongoose.models.CodeEnvironment as
      | Model<CodeEnvironmentDocument>
      | undefined;
    if (CodeEnvironment == null) return;
    await CodeEnvironment.updateMany(
      { _id: { $in: ids } },
      {
        $set: { revocationPendingAt: new Date() },
        $inc: { revocationAttempts: 1 },
        $unset: { revocationLastError: 1 },
      },
    );
  }

  /**
   * Commits the removal of the environment whose worker was revoked, clearing its revocation
   * state. Does nothing without the code environment model.
   */
  async function commitCodeEnvironmentWorkerRevocation(id: string | Types.ObjectId): Promise<void> {
    const CodeEnvironment = mongoose.models.CodeEnvironment as
      | Model<CodeEnvironmentDocument>
      | undefined;
    await CodeEnvironment?.updateOne(
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
  }

  /**
   * Records why the environment's worker revocation failed. Does nothing without the code
   * environment model.
   */
  async function recordCodeEnvironmentWorkerRevocationError(
    id: string | Types.ObjectId,
    error: string,
  ): Promise<void> {
    const CodeEnvironment = mongoose.models.CodeEnvironment as
      | Model<CodeEnvironmentDocument>
      | undefined;
    await CodeEnvironment?.updateOne({ _id: id }, { $set: { revocationLastError: error } });
  }

  return {
    ensureSetupEnvironmentIndexes,
    reserveSetupEnvironment,
    findSetupEnvironment,
    completeSetupEnvironment,
    beginDiscardSetupEnvironment,
    finishDiscardSetupEnvironment,
    createCodeEnvironment,
    createCodeEnvironmentWithinOwnerLimit,
    findCodeEnvironmentsByIds,
    findCodeEnvironmentByEnvironmentId,
    updateCodeEnvironmentSettings,
    listCodeEnvironmentIds,
    findCodeEnvironmentsByCreator,
    deleteCodeEnvironmentById,
    discardCodeEnvironmentById,
    completeCodeEnvironmentRegistration,
    beginCodeEnvironmentRemoval,
    cancelCodeEnvironmentRemoval,
    commitCodeEnvironmentRemoval,
    deleteUserCodeEnvironments,
    isCodeEnvironmentReferencedByAgent,
    requestCodeEnvironmentRevocation,
    sweepExpiredCodeEnvironmentReferences,
    findExpiredCodeEnvironmentRemovals,
    findStaleCodeEnvironmentRegistrations,
    claimStaleCodeEnvironmentRegistration,
    deferCodeEnvironmentRegistration,
    deleteStaleCodeEnvironmentRegistration,
    findCommittedCodeEnvironmentDeletions,
    findOrphanedCodeEnvironments,
    requestOrphanedCodeEnvironmentRevocations,
    findCodeEnvironmentRevocationCandidates,
    claimCodeEnvironmentRevocation,
    deferCodeEnvironmentRevocation,
    beginCodeEnvironmentWorkerRevocations,
    commitCodeEnvironmentWorkerRevocation,
    recordCodeEnvironmentWorkerRevocationError,
  };
}

export type CodeEnvironmentMethods = ReturnType<typeof createCodeEnvironmentMethods>;
