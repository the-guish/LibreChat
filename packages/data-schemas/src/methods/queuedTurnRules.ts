/**
 * The agent queued-turn store's database-neutral rules (`AgentQueuedTurnStore`,
 * `~/ports/queuedTurn`), shared by every backend: the MongoDB methods (`./queuedTurn`) and the
 * PostgreSQL store (`adapters/postgres/stores/queuedTurn.ts`). The payload normalization and its
 * fingerprint, the record shapes, the error classes (thrown by both backends, so `instanceof`
 * holds whichever one runs), and the whole protocol (the lane writer lease, the visible
 * reservation and its oldest-first repair, enqueue with its replay, conflict and capacity rules,
 * the reads, delivery reservation and publication, the claim with its admission slot, the
 * admission and its receipt, dead-lettering and reconciliation, the effective predecessor, and
 * the deletion steps) are written once here on the storage steps of {@link AgentQueuedTurnSteps},
 * their filters and updates stated in the store query language. Each step is one atomic
 * operation of the backend; the partial unique indexes on the turns (one claimed turn, one turn
 * past the admission boundary and one admission slot per lane; one sequence, one active slot and
 * one request id per conversation scope) decide the races, as duplicate keys the protocol turns
 * into replays or retries. Only `ensureAgentQueuedTurnIndexes` stays with each backend. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import { createHash, randomUUID } from 'node:crypto';
import { reasoningOverrideSchema } from 'librechat-data-provider';
import { Constants, CODE_APPROVAL_MODES } from 'librechat-data-provider';
import type { TReasoningOverride } from 'librechat-data-provider';
import type { CodeApprovalMode } from 'librechat-data-provider';
import type {
  AgentQueuedTurnActiveRecord,
  AgentQueuedTurnClaim,
  AgentQueuedTurnFailure,
  AgentQueuedTurnFileRef,
  AgentQueuedTurnRecord,
  IAgentQueuedTurn,
  IAgentQueuedTurnSequence,
  AgentQueuedTurnDeletionTarget,
  CancelAgentQueuedTurnResult,
  ReleaseAgentQueuedTurnResult,
  AdmitAgentQueuedTurnResult,
  DeadLetterAgentQueuedTurnResult,
  ScheduleAgentQueuedTurnResult,
  ReserveAgentQueuedTurnDeliveryResult,
  ClaimAgentQueuedTurnResult,
  BeginAgentQueuedTurnAdmissionResult,
  AgentQueuedTurnAdmissionEvidence,
  AgentQueuedTurnPredecessor,
  ClaimAgentQueuedTurnReconciliationInput,
} from '~/types/queuedTurn';
import type {
  AgentQueuedTurnStore,
  AgentQueuedTurnStoreOwnerScope,
  AgentQueuedTurnStoreClaimFence,
  EnqueueAgentQueuedTurnStoreInput,
  AgentQueuedTurnStoreConversationScope,
} from '~/ports/queuedTurn';
import type { IdLike } from '~/ports/common';

const MAX_FILES = 20;
const MAX_QUOTES = 10;
const MAX_QUOTE_LENGTH = 1500;
const MAX_MANUAL_SKILLS = 32;
const MAX_TEXT_LENGTH = 32_768;
export const MAX_ACTIVE_AGENT_QUEUED_TURNS = 100;
const LANE_WRITER_LEASE_MS = 30_000;
const LANE_WRITER_RETRY_MS = 5;
const LANE_WRITER_RETRIES = LANE_WRITER_LEASE_MS / LANE_WRITER_RETRY_MS;
const RETIRED_LANE_RETENTION_MS = 24 * 60 * 60_000;
const ROOT_LINEAGE_PREDECESSOR_PREFIX = 'root:';

export class AgentQueuedTurnConflictError extends Error {
  constructor(clientRequestId: string) {
    super(`Agent queued turn idempotency conflict: ${clientRequestId}`);
    this.name = 'AgentQueuedTurnConflictError';
  }
}

export class AgentQueuedTurnCapacityError extends Error {
  constructor() {
    super(`Agent queued turn capacity is limited to ${MAX_ACTIVE_AGENT_QUEUED_TURNS}`);
    this.name = 'AgentQueuedTurnCapacityError';
  }
}

export class AgentQueuedTurnLaneRetiredError extends Error {
  constructor() {
    super('Agent queued turn conversation is being deleted');
    this.name = 'AgentQueuedTurnLaneRetiredError';
  }
}

class AgentQueuedTurnLaneMissingError extends Error {
  constructor() {
    super('Agent queued turn lane is missing');
    this.name = 'AgentQueuedTurnLaneMissingError';
  }
}

class AgentQueuedTurnLaneGenerationError extends Error {
  constructor() {
    super('Agent queued turn belongs to a retired lane generation');
    this.name = 'AgentQueuedTurnLaneGenerationError';
  }
}

interface AgentQueuedTurnLaneWriter {
  writerId: string;
  laneId: string;
}

function getRootLineagePredecessorId(parentMessageId: string): string {
  return `${ROOT_LINEAGE_PREDECESSOR_PREFIX}${createHash('sha256')
    .update(requireBoundedString(parentMessageId, Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH))
    .digest('base64url')}`;
}

function isRootLineagePredecessorId(lineagePredecessorId: string): boolean {
  return lineagePredecessorId.startsWith(ROOT_LINEAGE_PREDECESSOR_PREFIX);
}

function tenantScope(tenantId: string | undefined):
  | { tenantId: string }
  | {
      tenantId: { $exists: false };
    } {
  return tenantId == null ? { tenantId: { $exists: false } } : { tenantId };
}

function ownerScope(input: AgentQueuedTurnStoreOwnerScope) {
  return { user: input.user, ...tenantScope(input.tenantId) };
}

function ownerFields(input: AgentQueuedTurnStoreOwnerScope) {
  return {
    user: input.user,
    ...(input.tenantId != null && { tenantId: input.tenantId }),
  };
}

/** The filter of one conversation scope: owner, tenant (absent: untenanted) and conversation. */
export function conversationScope(input: AgentQueuedTurnStoreConversationScope): QueuedTurnQuery {
  return {
    ...ownerScope(input),
    conversationId: requireBoundedString(input.conversationId, 256),
  };
}

/** The scope fields a record of the conversation is written with. */
export function conversationFields(input: AgentQueuedTurnStoreConversationScope): QueuedTurnQuery {
  return {
    ...ownerFields(input),
    conversationId: requireBoundedString(input.conversationId, 256),
  };
}

function deletionScope(input: { user: IdLike; targets: readonly AgentQueuedTurnDeletionTarget[] }) {
  const targets = input.targets.map((target) => {
    const conversationId = requireBoundedString(target.conversationId, 256);
    if (target.allTenants === true) {
      return { conversationId };
    }
    return { conversationId, ...tenantScope(target.tenantId) };
  });
  if (targets.length === 0) {
    throw new TypeError('Agent queued turn deletion requires at least one conversation');
  }
  return { user: input.user, $or: targets };
}

export function requireBoundedString(value: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new TypeError('Agent queued turn value must be a string');
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new TypeError('Agent queued turn value has an invalid length');
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined, maxLength: number): string | undefined {
  if (value == null) {
    return undefined;
  }
  return requireBoundedString(value, maxLength);
}

function normalizeDeliveryPath(
  value: AgentQueuedTurnFileRef['llmDeliveryPath'],
): AgentQueuedTurnFileRef['llmDeliveryPath'] {
  if (value == null) {
    return undefined;
  }
  const normalized = requireBoundedString(value, 32);
  if (normalized !== 'provider' && normalized !== 'text' && normalized !== 'none') {
    throw new TypeError('Agent queued turn file delivery path is invalid');
  }
  return normalized;
}

function normalizeFiles(files: readonly AgentQueuedTurnFileRef[] | undefined) {
  if (files == null || files.length === 0) {
    return undefined;
  }
  if (files.length > MAX_FILES) {
    throw new TypeError('Agent queued turn has too many files');
  }
  const seen = new Set<string>();
  const normalized: AgentQueuedTurnFileRef[] = [];
  for (const file of files) {
    const fileId = requireBoundedString(file.file_id, 256);
    if (seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    normalized.push({
      file_id: fileId,
      ...(normalizeOptionalString(file.type, 256) != null && {
        type: normalizeOptionalString(file.type, 256),
      }),
      ...(normalizeOptionalString(file.filepath, 2048) != null && {
        filepath: normalizeOptionalString(file.filepath, 2048),
      }),
      ...(normalizeOptionalString(file.filename, 1024) != null && {
        filename: normalizeOptionalString(file.filename, 1024),
      }),
      ...(normalizeDeliveryPath(file.llmDeliveryPath) != null && {
        llmDeliveryPath: normalizeDeliveryPath(file.llmDeliveryPath),
      }),
      ...(file.height != null && {
        height: requireNonnegativeNumber(file.height),
      }),
      ...(file.width != null && {
        width: requireNonnegativeNumber(file.width),
      }),
      ...(file.bytes != null && {
        bytes: requireNonnegativeNumber(file.bytes),
      }),
    });
  }
  return normalized.length === 0 ? undefined : normalized;
}

function requireNonnegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('Agent queued turn file metadata must be nonnegative');
  }
  return value;
}

function normalizeQuotes(quotes: readonly string[] | undefined) {
  if (quotes == null || quotes.length === 0) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const quote of quotes) {
    if (typeof quote !== 'string') {
      throw new TypeError('Agent queued turn quote must be a string');
    }
    const trimmed = quote.trim();
    if (trimmed.length === 0) {
      continue;
    }
    normalized.push(trimmed.slice(0, MAX_QUOTE_LENGTH));
    if (normalized.length >= MAX_QUOTES) {
      break;
    }
  }
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeManualSkills(manualSkills: readonly string[] | undefined) {
  if (manualSkills == null || manualSkills.length === 0) {
    return undefined;
  }
  if (manualSkills.length > MAX_MANUAL_SKILLS) {
    throw new TypeError('Agent queued turn has too many manual skills');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const skill of manualSkills) {
    const name = requireBoundedString(skill, 256);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeText(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('Agent queued turn text must be a string');
  }
  const normalized = text.trim();
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new TypeError('Agent queued turn text is too long');
  }
  return normalized;
}

function normalizeReasoningOverride(
  reasoningOverride: TReasoningOverride | undefined,
): TReasoningOverride | undefined {
  if (reasoningOverride == null) {
    return undefined;
  }
  return reasoningOverrideSchema.parse(reasoningOverride);
}

function normalizePredecessor(value: number | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Agent queued turn predecessor epoch must be a nonnegative integer');
  }
  return value;
}

function requireCodeApprovalMode(mode: CodeApprovalMode): CodeApprovalMode {
  if (!CODE_APPROVAL_MODES.includes(mode)) {
    throw new TypeError('Agent queued turn coding approval mode is invalid');
  }
  return mode;
}

function normalizeEnqueue(input: EnqueueAgentQueuedTurnStoreInput) {
  const normalized = {
    agentId: requireBoundedString(input.agentId, 256),
    parentMessageId: requireBoundedString(
      input.parentMessageId,
      Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH,
    ),
    clientRequestId: requireBoundedString(input.clientRequestId, 128),
    text: normalizeText(input.text),
    files: normalizeFiles(input.files),
    quotes: normalizeQuotes(input.quotes),
    manualSkills: normalizeManualSkills(input.manualSkills),
    ...(input.codeApprovalMode != null && {
      codeApprovalMode: requireCodeApprovalMode(input.codeApprovalMode),
    }),
    reasoningOverride: normalizeReasoningOverride(input.reasoningOverride),
    expectedPredecessorCreatedAt: normalizePredecessor(input.expectedPredecessorCreatedAt),
    priority: input.priority === true,
  };
  if (normalized.text.length === 0 && normalized.files == null && normalized.quotes == null) {
    throw new TypeError('Agent queued turn must contain text, a file, or a quote');
  }
  return normalized;
}

function fingerprint(payload: ReturnType<typeof normalizeEnqueue>): string {
  /** Delivery routing is display metadata, not user intent. Excluding it keeps
   * retries compatible with replicas deployed before the field was persisted. */
  const stableIntent = {
    ...payload,
    files: payload.files?.map(({ llmDeliveryPath: _displayMetadata, ...file }) => file),
  };
  return createHash('sha256').update(JSON.stringify(stableIntent)).digest('base64url');
}

export function laneKey(input: AgentQueuedTurnStoreConversationScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.tenantId ?? null,
        input.user.toString(),
        requireBoundedString(input.conversationId, 256),
      ]),
    )
    .digest('base64url');
}

function effectiveDeliveryState(turn: IAgentQueuedTurn) {
  if (turn.deliveryState != null) {
    return turn.deliveryState;
  }
  if (turn.deliveryKey == null) {
    return 'pending' as const;
  }
  if (turn.scheduledAt == null) {
    return 'publishing' as const;
  }
  return 'published' as const;
}

function toRecord(turn: IAgentQueuedTurn): AgentQueuedTurnRecord {
  if (
    turn._id == null ||
    turn.createdAt == null ||
    turn.sequence == null ||
    turn.status === 'reserving'
  ) {
    throw new Error('Agent queued turn is missing its durable identity');
  }
  return {
    queuedTurnId: turn._id.toString(),
    user: turn.user,
    ...(turn.tenantId != null && { tenantId: turn.tenantId }),
    conversationId: turn.conversationId,
    agentId: turn.agentId,
    parentMessageId: turn.parentMessageId,
    clientRequestId: turn.clientRequestId,
    fingerprint: turn.fingerprint,
    ...(turn.laneId != null && { laneId: turn.laneId }),
    sequence: turn.sequence,
    ...(turn.activeSlot != null && { activeSlot: turn.activeSlot }),
    ...(turn.admissionSlot === true && { admissionSlot: true }),
    status: turn.status,
    priority: turn.priority,
    text: turn.text,
    ...(turn.files != null && { files: turn.files }),
    ...(turn.quotes != null && { quotes: turn.quotes }),
    ...(turn.manualSkills != null && { manualSkills: turn.manualSkills }),
    ...(turn.codeApprovalMode != null && { codeApprovalMode: turn.codeApprovalMode }),
    ...(turn.reasoningOverride != null && { reasoningOverride: turn.reasoningOverride }),
    ...(turn.expectedPredecessorCreatedAt != null && {
      expectedPredecessorCreatedAt: turn.expectedPredecessorCreatedAt,
    }),
    attempts: turn.attempts,
    availableAt: turn.availableAt,
    ...(turn.deliveryKey != null && { deliveryKey: turn.deliveryKey }),
    deliveryState: effectiveDeliveryState(turn),
    ...(turn.scheduledAt != null && { scheduledAt: turn.scheduledAt }),
    ...(turn.claimId != null && { claimId: turn.claimId }),
    ...(turn.claimBy != null && { claimBy: turn.claimBy }),
    ...(turn.claimUntil != null && { claimUntil: turn.claimUntil }),
    ...(turn.admissionId != null && { admissionId: turn.admissionId }),
    ...(turn.admissionStartedAt != null && { admissionStartedAt: turn.admissionStartedAt }),
    ...(turn.admissionEffectivePredecessorCreatedAt != null && {
      admissionEffectivePredecessorCreatedAt: turn.admissionEffectivePredecessorCreatedAt,
    }),
    ...(turn.admissionLineagePredecessorId != null && {
      admissionLineagePredecessorId: turn.admissionLineagePredecessorId,
    }),
    ...(turn.admissionProtocolVersion != null && {
      admissionProtocolVersion: turn.admissionProtocolVersion,
    }),
    ...(turn.reconciliationAvailableAt != null && {
      reconciliationAvailableAt: turn.reconciliationAvailableAt,
    }),
    ...(turn.reconciliationClaimId != null && {
      reconciliationClaimId: turn.reconciliationClaimId,
    }),
    ...(turn.reconciliationClaimBy != null && {
      reconciliationClaimBy: turn.reconciliationClaimBy,
    }),
    ...(turn.reconciliationClaimUntil != null && {
      reconciliationClaimUntil: turn.reconciliationClaimUntil,
    }),
    ...(turn.reconciliationAttempts != null && {
      reconciliationAttempts: turn.reconciliationAttempts,
    }),
    ...(turn.terminalReceipt != null && {
      terminalReceipt: turn.terminalReceipt,
    }),
    createdAt: turn.createdAt,
    ...(turn.updatedAt != null && { updatedAt: turn.updatedAt }),
  };
}

function toActiveRecord(turn: IAgentQueuedTurn): AgentQueuedTurnActiveRecord {
  const record = toRecord(turn);
  return {
    queuedTurnId: record.queuedTurnId,
    conversationId: record.conversationId,
    agentId: record.agentId,
    parentMessageId: record.parentMessageId,
    clientRequestId: record.clientRequestId,
    sequence: record.sequence,
    ...(record.activeSlot != null && { activeSlot: record.activeSlot }),
    status: record.status,
    priority: record.priority,
    text: record.text,
    ...(record.files != null && { files: record.files }),
    ...(record.quotes != null && { quotes: record.quotes }),
    ...(record.manualSkills != null && { manualSkills: record.manualSkills }),
    ...(record.codeApprovalMode != null && { codeApprovalMode: record.codeApprovalMode }),
    ...(record.reasoningOverride != null && { reasoningOverride: record.reasoningOverride }),
    ...(record.expectedPredecessorCreatedAt != null && {
      expectedPredecessorCreatedAt: record.expectedPredecessorCreatedAt,
    }),
    attempts: record.attempts,
    availableAt: record.availableAt,
    ...(record.deliveryKey != null && { deliveryKey: record.deliveryKey }),
    ...(record.deliveryState != null && { deliveryState: record.deliveryState }),
    ...(record.scheduledAt != null && { scheduledAt: record.scheduledAt }),
    createdAt: record.createdAt,
    ...(record.updatedAt != null && { updatedAt: record.updatedAt }),
    ...(record.terminalReceipt != null && { terminalReceipt: record.terminalReceipt }),
  };
}

function requireClaim(turn: IAgentQueuedTurn | null): AgentQueuedTurnClaim | null {
  if (
    turn == null ||
    turn.status !== 'claimed' ||
    turn.admissionSlot !== true ||
    turn.claimId == null ||
    turn.claimBy == null ||
    turn.claimUntil == null
  ) {
    return null;
  }
  return toRecord(turn) as AgentQueuedTurnClaim;
}

/** A filter or update in the store query language. */
export type QueuedTurnQuery = Record<string, unknown>;

/** The options of a read step: the order (most significant first), a bound and a projection. */
export interface QueuedTurnReadOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  select?: string | Record<string, 1>;
}

/** The storage steps of one collection (turns or lanes), each one atomic on its own. */
export interface QueuedTurnCollectionSteps<T> {
  /** The first record matching `filter` (by `sort`), or `null`. */
  findOne(
    filter: QueuedTurnQuery,
    options?: Omit<QueuedTurnReadOptions, 'limit'>,
  ): Promise<T | null>;
  /** The records matching `filter`, by `sort`, at most `limit`. */
  find(filter: QueuedTurnQuery, options?: QueuedTurnReadOptions): Promise<T[]>;
  /** A match's id, or `null` when none matches. */
  exists(filter: QueuedTurnQuery): Promise<{ _id: unknown } | null>;
  /** The distinct values at `path` among the matching records. */
  distinct(path: string, filter: QueuedTurnQuery): Promise<unknown[]>;
  /** Inserts a record built and validated by the schema; rejects with a duplicate key. */
  create(document: QueuedTurnQuery): Promise<T>;
  /**
   * Updates the first record matching `filter` (by `sort`; inserting one with `upsert`) and
   * resolves it updated, or `null`; rejects with a duplicate key.
   */
  findOneAndUpdate(
    filter: QueuedTurnQuery,
    update: QueuedTurnQuery,
    options?: { sort?: Record<string, 1 | -1>; upsert?: boolean },
  ): Promise<T | null>;
  /** Updates the first record matching `filter`. */
  updateOne(
    filter: QueuedTurnQuery,
    update: QueuedTurnQuery,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  /** Updates every record matching `filter`. */
  updateMany(filter: QueuedTurnQuery, update: QueuedTurnQuery): Promise<unknown>;
  /** Deletes every record matching `filter`. */
  deleteMany(filter: QueuedTurnQuery): Promise<{ deletedCount: number }>;
}

/** The storage steps the protocol runs on. */
export interface AgentQueuedTurnSteps {
  /** The turns (`agentqueuedturns`). */
  turns: QueuedTurnCollectionSteps<IAgentQueuedTurn>;
  /** The lanes (`agentqueuedturnsequences`), keyed by {@link laneKey}. */
  lanes: QueuedTurnCollectionSteps<IAgentQueuedTurnSequence>;
  /** Whether `error` is the backend's duplicate-key error. */
  isDuplicateKey(error: unknown): boolean;
}

/** Every method of the port but `ensureAgentQueuedTurnIndexes`, which each backend supplies. */
export type AgentQueuedTurnProtocol = Omit<AgentQueuedTurnStore, 'ensureAgentQueuedTurnIndexes'>;

/** The protocol on `steps`; one instance serializes the lane writes it makes itself. */
export function createAgentQueuedTurnProtocol(
  steps: AgentQueuedTurnSteps,
): AgentQueuedTurnProtocol {
  const localLaneTails = new Map<string, Promise<void>>();

  async function serializeLocalLane<T>(
    input: AgentQueuedTurnStoreConversationScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = laneKey(input);
    const previous = localLaneTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    localLaneTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (localLaneTails.get(key) === tail) {
        localLaneTails.delete(key);
      }
    }
  }

  async function acquireLaneWriter(
    input: AgentQueuedTurnStoreConversationScope,
    createIfMissing = true,
  ): Promise<AgentQueuedTurnLaneWriter> {
    const _id = laneKey(input);
    const scope = conversationScope(input);
    const writerId = randomUUID();
    const insertedLaneId = randomUUID();
    for (let attempt = 0; attempt < LANE_WRITER_RETRIES; attempt++) {
      const now = new Date();
      const lane = await steps.lanes
        .findOneAndUpdate(
          {
            _id,
            ...scope,
            retiredAt: { $exists: false },
            $or: [{ writerId: { $exists: false } }, { writerUntil: { $lte: now } }],
          },
          {
            $set: {
              writerId,
              writerUntil: new Date(now.getTime() + LANE_WRITER_LEASE_MS),
            },
            $setOnInsert: { ...conversationFields(input), laneId: insertedLaneId, value: 0 },
          },
          { upsert: createIfMissing },
        )
        .catch((error: unknown) => {
          if (steps.isDuplicateKey(error)) {
            return null;
          }
          throw error;
        });
      if (lane?.writerId === writerId) {
        if (lane.laneId == null) {
          throw new Error('Agent queued turn lane is missing its generation');
        }
        if (lane.laneId === insertedLaneId && lane.value === 0) {
          const predecessor = await steps.turns.findOne(
            { ...scope, sequence: { $exists: true } },
            { sort: { sequence: -1 }, select: 'sequence' },
          );
          if (predecessor?.sequence != null && predecessor.sequence > 0) {
            await steps.lanes.updateOne(
              { _id, ...scope, writerId, laneId: insertedLaneId },
              { $max: { value: predecessor.sequence } },
            );
          }
        }
        return { writerId, laneId: lane.laneId };
      }
      const retired = await steps.lanes.exists({ _id, ...scope, retiredAt: { $exists: true } });
      if (retired != null) {
        throw new AgentQueuedTurnLaneRetiredError();
      }
      if (!createIfMissing && (await steps.lanes.exists({ _id, ...scope })) == null) {
        throw new AgentQueuedTurnLaneMissingError();
      }
      await new Promise((resolve) => setTimeout(resolve, LANE_WRITER_RETRY_MS));
    }
    throw new Error('Agent queued turn lane writer lease did not become available');
  }

  async function releaseLaneWriter(
    input: AgentQueuedTurnStoreConversationScope,
    writerId: string,
  ): Promise<void> {
    await steps.lanes.updateOne(
      { _id: laneKey(input), ...conversationScope(input), writerId },
      { $unset: { writerId: 1, writerUntil: 1 } },
    );
  }

  async function repairLaneReservation(
    input: AgentQueuedTurnStoreConversationScope,
    writer: AgentQueuedTurnLaneWriter,
  ): Promise<void> {
    const _id = laneKey(input);
    const scope = conversationScope(input);
    const liveWriter = {
      _id,
      ...scope,
      writerId: writer.writerId,
      writerUntil: { $gt: new Date() },
      retiredAt: { $exists: false },
    };
    const lane = await steps.lanes.findOne(liveWriter);
    if (lane == null) {
      const retired = await steps.lanes.exists({ _id, ...scope, retiredAt: { $exists: true } });
      if (retired != null) {
        throw new AgentQueuedTurnLaneRetiredError();
      }
      throw new Error('Agent queued turn lane writer lease was lost');
    }
    if (lane.laneId !== writer.laneId) {
      throw new AgentQueuedTurnLaneGenerationError();
    }
    if (lane.reservationId != null) {
      await steps.turns.updateOne(
        {
          ...scope,
          _id: lane.reservationId,
          laneId: writer.laneId,
          status: 'reserving',
          sequence: { $exists: false },
        },
        { $set: { reservationWriterId: writer.writerId } },
      );
      await steps.turns.updateOne(
        {
          ...scope,
          _id: lane.reservationId,
          laneId: writer.laneId,
          status: 'reserving',
          sequence: { $exists: false },
          reservationWriterId: writer.writerId,
        },
        {
          $set: { status: 'queued', sequence: lane.value },
          $unset: { reservationWriterId: 1 },
        },
      );
      await steps.lanes.updateOne(
        { ...liveWriter, reservationId: lane.reservationId },
        { $unset: { reservationId: 1 } },
      );
      return;
    }
    const head = await steps.turns.findOne(
      {
        ...scope,
        laneId: writer.laneId,
        status: 'reserving',
        sequence: { $exists: false },
      },
      { sort: { createdAt: 1, _id: 1 } },
    );
    if (head?._id == null) {
      return;
    }
    const reservationId = head._id.toString();
    const owned = await steps.turns.updateOne(
      {
        ...scope,
        _id: reservationId,
        laneId: writer.laneId,
        status: 'reserving',
        sequence: { $exists: false },
      },
      { $set: { reservationWriterId: writer.writerId } },
    );
    if (owned.matchedCount !== 1) {
      return;
    }
    const claimed = await steps.lanes.findOneAndUpdate(
      { ...liveWriter, reservationId: { $exists: false } },
      { $inc: { value: 1 }, $set: { reservationId } },
    );
    if (claimed == null) {
      return;
    }
    const assigned = await steps.turns.updateOne(
      {
        ...scope,
        _id: reservationId,
        laneId: writer.laneId,
        status: 'reserving',
        sequence: { $exists: false },
        reservationWriterId: writer.writerId,
      },
      {
        $set: { status: 'queued', sequence: claimed.value },
        $unset: { reservationWriterId: 1 },
      },
    );
    await steps.lanes.updateOne(
      { ...liveWriter, reservationId, value: claimed.value },
      assigned.modifiedCount === 1
        ? { $unset: { reservationId: 1 } }
        : { $inc: { value: -1 }, $unset: { reservationId: 1 } },
    );
  }

  /** Finish reservations oldest-first. The lane record durably names the row
   * that owns its next value, so another process can complete either half. */
  async function finalizeVisibleReservation(
    target: IAgentQueuedTurn,
    writer: AgentQueuedTurnLaneWriter,
  ): Promise<AgentQueuedTurnRecord> {
    if (target._id == null) {
      throw new Error('Agent queued turn reservation is missing its durable identity');
    }
    const scopeInput: AgentQueuedTurnStoreConversationScope = {
      user: target.user,
      ...(target.tenantId != null && { tenantId: target.tenantId }),
      conversationId: target.conversationId,
    };
    const scope = conversationScope(scopeInput);
    const targetId = target._id.toString();
    if (target.laneId !== writer.laneId) {
      throw new AgentQueuedTurnLaneGenerationError();
    }
    for (let repair = 0; repair <= MAX_ACTIVE_AGENT_QUEUED_TURNS; repair++) {
      await repairLaneReservation(scopeInput, writer);
      const current = await steps.turns.findOne({ ...scope, _id: targetId });
      if (current == null) {
        throw new Error('Agent queued turn reservation disappeared');
      }
      if (current.status !== 'reserving') {
        return toRecord(current);
      }
    }
    throw new Error('Agent queued turn reservation repair exceeded lane capacity');
  }

  async function enqueueAgentQueuedTurn(
    input: EnqueueAgentQueuedTurnStoreInput,
  ): Promise<{ turn: AgentQueuedTurnRecord; replayed: boolean }> {
    const scope = conversationScope(input);
    const normalized = normalizeEnqueue(input);
    if (input.codeApprovalMode != null && input.deliveryReservation == null) {
      throw new TypeError('Approval snapshots require a versioned delivery reservation');
    }
    const requestFingerprint = fingerprint(normalized);
    const existing = await steps.turns.findOne({
      ...scope,
      clientRequestId: normalized.clientRequestId,
    });
    if (existing != null) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AgentQueuedTurnConflictError(normalized.clientRequestId);
      }
      if (existing.status !== 'reserving') {
        return { turn: toRecord(existing), replayed: true };
      }
    }

    return serializeLocalLane(input, async () => {
      const writer = await acquireLaneWriter(input);
      try {
        const replay = await steps.turns.findOne({
          ...scope,
          clientRequestId: normalized.clientRequestId,
        });
        if (replay != null) {
          if (replay.fingerprint !== requestFingerprint) {
            throw new AgentQueuedTurnConflictError(normalized.clientRequestId);
          }
          return {
            turn:
              replay.status === 'reserving'
                ? await finalizeVisibleReservation(replay, writer)
                : toRecord(replay),
            replayed: true,
          };
        }

        const firstSlot =
          createHash('sha256').update(normalized.clientRequestId).digest().readUInt32BE(0) %
          MAX_ACTIVE_AGENT_QUEUED_TURNS;
        const usedSlots = new Set(
          (await steps.turns.distinct('activeSlot', {
            ...scope,
            activeSlot: { $exists: true },
          })) as number[],
        );
        for (let offset = 0; offset < MAX_ACTIVE_AGENT_QUEUED_TURNS; offset++) {
          const activeSlot = (firstSlot + offset) % MAX_ACTIVE_AGENT_QUEUED_TURNS;
          if (usedSlots.has(activeSlot)) {
            continue;
          }
          try {
            const created = await steps.turns.create({
              ...conversationFields(input),
              ...normalized,
              fingerprint: requestFingerprint,
              laneId: writer.laneId,
              activeSlot,
              status: 'reserving',
              attempts: 0,
              availableAt: input.availableAt ?? new Date(),
              deliveryState: input.deliveryReservation != null ? 'publishing' : 'pending',
              ...(input.deliveryReservation != null && {
                _id: requireBoundedString(input.deliveryReservation.queuedTurnId, 128),
                deliveryKey: requireBoundedString(input.deliveryReservation.deliveryKey, 128),
              }),
              reservationWriterId: writer.writerId,
            });
            return {
              turn: await finalizeVisibleReservation(created, writer),
              replayed: false,
            };
          } catch (error) {
            if (!steps.isDuplicateKey(error)) {
              throw error;
            }
            usedSlots.add(activeSlot);
            const racedReplay = await steps.turns.findOne({
              ...scope,
              clientRequestId: normalized.clientRequestId,
            });
            if (racedReplay != null) {
              if (racedReplay.fingerprint !== requestFingerprint) {
                throw new AgentQueuedTurnConflictError(normalized.clientRequestId);
              }
              return {
                turn:
                  racedReplay.status === 'reserving'
                    ? await finalizeVisibleReservation(racedReplay, writer)
                    : toRecord(racedReplay),
                replayed: true,
              };
            }
          }
        }
        throw new AgentQueuedTurnCapacityError();
      } finally {
        await releaseLaneWriter(input, writer.writerId);
      }
    });
  }

  async function listActiveAgentQueuedTurns(
    input: AgentQueuedTurnStoreConversationScope & { limit?: number },
  ): Promise<AgentQueuedTurnActiveRecord[]> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new TypeError('Agent queued turn list limit must be between 1 and 100');
    }
    const turns = await steps.turns.find(
      {
        ...conversationScope(input),
        status: { $in: ['queued', 'claimed'] },
      },
      { sort: { priority: -1, sequence: 1 }, limit: limit },
    );
    return turns.map(toActiveRecord);
  }

  async function ensureEffectiveAdmissionBoundary(
    turn: IAgentQueuedTurn,
  ): Promise<IAgentQueuedTurn> {
    if (
      turn._id == null ||
      turn.sequence == null ||
      turn.status !== 'admitted' ||
      turn.terminalReceipt?.outcome !== 'admitted'
    ) {
      return turn;
    }
    const rootPredecessorCreatedAt = normalizePredecessor(turn.expectedPredecessorCreatedAt);
    if (
      turn.terminalReceipt.lineagePredecessorId != null &&
      (turn.terminalReceipt.effectivePredecessorCreatedAt != null ||
        (isRootLineagePredecessorId(turn.terminalReceipt.lineagePredecessorId) &&
          turn.terminalReceipt.rootPredecessor === true))
    ) {
      return turn;
    }
    const resolvedPredecessor = await getEffectiveAgentQueuedTurnPredecessor({
      user: turn.user,
      ...(turn.tenantId != null && { tenantId: turn.tenantId }),
      conversationId: turn.conversationId,
      sequence: turn.sequence,
      rootParentMessageId: turn.parentMessageId,
      ...(rootPredecessorCreatedAt != null && {
        expectedPredecessorCreatedAt: rootPredecessorCreatedAt,
      }),
    });
    if (resolvedPredecessor === null) {
      return turn;
    }
    const effectivePredecessorCreatedAt = resolvedPredecessor.effectivePredecessorCreatedAt;
    await steps.turns.updateOne(
      {
        _id: turn._id,
        status: 'admitted',
        'terminalReceipt.outcome': 'admitted',
        $or: [
          { 'terminalReceipt.effectivePredecessorCreatedAt': { $exists: false } },
          { 'terminalReceipt.lineagePredecessorId': { $exists: false } },
          { 'terminalReceipt.rootPredecessor': { $exists: false } },
        ],
      },
      {
        $set: {
          ...(effectivePredecessorCreatedAt != null && {
            'terminalReceipt.effectivePredecessorCreatedAt': effectivePredecessorCreatedAt,
          }),
          'terminalReceipt.lineagePredecessorId': resolvedPredecessor.lineagePredecessorId,
          ...(effectivePredecessorCreatedAt == null &&
            isRootLineagePredecessorId(resolvedPredecessor.lineagePredecessorId) && {
              'terminalReceipt.rootPredecessor': true,
            }),
        },
      },
    );
    return {
      ...turn,
      terminalReceipt: {
        ...turn.terminalReceipt,
        ...(effectivePredecessorCreatedAt != null && { effectivePredecessorCreatedAt }),
        lineagePredecessorId: resolvedPredecessor.lineagePredecessorId,
        ...(effectivePredecessorCreatedAt == null &&
          isRootLineagePredecessorId(resolvedPredecessor.lineagePredecessorId) && {
            rootPredecessor: true as const,
          }),
      },
    };
  }

  async function listAgentQueuedTurnReceipts(
    input: AgentQueuedTurnStoreConversationScope & { clientRequestIds?: readonly string[] },
  ): Promise<AgentQueuedTurnActiveRecord[]> {
    const clientRequestIds = [
      ...new Set((input.clientRequestIds ?? []).map((value) => requireBoundedString(value, 128))),
    ];
    if (clientRequestIds.length > MAX_ACTIVE_AGENT_QUEUED_TURNS) {
      throw new TypeError(
        `Agent queued turn receipt lookup is limited to ${MAX_ACTIVE_AGENT_QUEUED_TURNS} ids`,
      );
    }
    const scope = conversationScope(input);
    const [active, dead, known] = await Promise.all([
      steps.turns.find(
        { ...scope, status: { $in: ['queued', 'claimed'] } },
        { sort: { priority: -1, sequence: 1 }, limit: MAX_ACTIVE_AGENT_QUEUED_TURNS },
      ),
      steps.turns.find(
        { ...scope, status: 'dead' },
        { sort: { sequence: -1 }, limit: MAX_ACTIVE_AGENT_QUEUED_TURNS },
      ),
      clientRequestIds.length === 0
        ? Promise.resolve([])
        : steps.turns.find(
            { ...scope, clientRequestId: { $in: clientRequestIds } },
            { limit: clientRequestIds.length },
          ),
    ]);
    const turns = new Map<string, IAgentQueuedTurn>();
    for (const turn of [...active, ...dead, ...known]) {
      if (turn._id != null) {
        turns.set(turn._id.toString(), turn);
      }
    }
    const repaired = await Promise.all([...turns.values()].map(ensureEffectiveAdmissionBoundary));
    return repaired
      .filter((turn) => turn.sequence != null)
      .sort(
        (left, right) =>
          Number(right.priority) - Number(left.priority) ||
          (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
      )
      .map(toActiveRecord);
  }

  async function getAgentQueuedTurnByClientRequestId(
    input: AgentQueuedTurnStoreConversationScope & { clientRequestId: string },
  ): Promise<AgentQueuedTurnRecord | null> {
    const turn = await steps.turns.findOne({
      ...conversationScope(input),
      clientRequestId: requireBoundedString(input.clientRequestId, 128),
    });
    return turn == null ? null : toRecord(await ensureEffectiveAdmissionBoundary(turn));
  }

  async function cancelAgentQueuedTurn(
    input: AgentQueuedTurnStoreOwnerScope & {
      queuedTurnId: string;
      conversationId?: string;
      settledAt?: Date;
    },
  ): Promise<CancelAgentQueuedTurnResult> {
    const settledAt = input.settledAt ?? new Date();
    const scope = {
      ...ownerScope(input),
      ...(input.conversationId != null && {
        conversationId: requireBoundedString(input.conversationId, 256),
      }),
    };
    const turn = await steps.turns.findOneAndUpdate(
      {
        ...scope,
        _id: input.queuedTurnId,
        status: { $in: ['queued', 'claimed', 'dead'] },
        admissionStartedAt: { $exists: false },
      },
      {
        $set: {
          status: 'cancelled',
          terminalReceipt: { outcome: 'cancelled', settledAt },
        },
        $unset: {
          activeSlot: 1,
          admissionSlot: 1,
          claimId: 1,
          claimBy: 1,
          claimUntil: 1,
        },
      },
    );
    if (turn != null) {
      const deliveryState =
        turn.deliveryKey == null ? 'retired' : (turn.deliveryState ?? 'published');
      const state = await steps.turns.findOneAndUpdate(
        {
          _id: turn._id,
          status: 'cancelled',
          ...(turn.deliveryKey == null && { deliveryKey: { $exists: false } }),
        },
        { $set: { deliveryState } },
      );
      return { outcome: 'cancelled', turn: toRecord(state ?? turn) };
    }
    const current = await steps.turns.findOne({ ...scope, _id: input.queuedTurnId });
    if (current == null) {
      return { outcome: 'not_found', turn: null };
    }
    if (current.status === 'cancelled') {
      return { outcome: 'already_cancelled', turn: toRecord(current) };
    }
    return { outcome: 'not_cancellable', turn: toRecord(current) };
  }

  async function findQueuedTurnsNeedingDelivery(
    limit = 100,
    activity?: { found: boolean },
  ): Promise<AgentQueuedTurnRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new TypeError('Agent queued turn recovery limit must be between 1 and 1000');
    }
    const reservations = await steps.turns.find(
      { status: 'reserving' },
      { sort: { createdAt: 1, _id: 1 }, limit: limit },
    );
    if (activity != null && reservations.length > 0) activity.found = true;
    for (const reservation of reservations) {
      const scopeInput: AgentQueuedTurnStoreConversationScope = {
        user: reservation.user,
        ...(reservation.tenantId != null && { tenantId: reservation.tenantId }),
        conversationId: reservation.conversationId,
      };
      try {
        await serializeLocalLane(scopeInput, async () => {
          const writer = await acquireLaneWriter(scopeInput, false);
          try {
            await finalizeVisibleReservation(reservation, writer);
          } finally {
            await releaseLaneWriter(scopeInput, writer.writerId);
          }
        });
      } catch (error) {
        if (
          !(error instanceof AgentQueuedTurnLaneRetiredError) &&
          !(error instanceof AgentQueuedTurnLaneMissingError) &&
          !(error instanceof AgentQueuedTurnLaneGenerationError)
        ) {
          throw error;
        }
        await steps.turns.updateOne(
          { _id: reservation._id, status: 'reserving' },
          {
            $set: {
              status: 'cancelled',
              deliveryState: 'retired',
              terminalReceipt: {
                outcome: 'cancelled',
                settledAt: new Date(),
                failure: {
                  code: 'OWNER_DRAINED',
                  message: 'Queued turn owner was drained',
                },
              },
            },
            $unset: { activeSlot: 1, reservationWriterId: 1 },
          },
        );
        continue;
      }
    }
    const turns = await steps.turns.find(
      {
        $or: [
          {
            status: 'queued',
            $or: [
              { deliveryState: { $in: ['pending', 'publishing'] } },
              { deliveryState: { $exists: false }, scheduledAt: { $exists: false } },
            ],
          },
          { status: { $in: ['cancelled', 'dead'] }, deliveryState: 'publishing' },
          {
            status: { $in: ['cancelled', 'dead'] },
            deliveryKey: { $exists: true },
            deliveryState: { $exists: false },
          },
        ],
      },
      { sort: { availableAt: 1, sequence: 1, _id: 1 }, limit: limit },
    );
    return turns.map(toRecord);
  }

  async function claimQueuedTurnsForAdmissionReconciliation(
    input: ClaimAgentQueuedTurnReconciliationInput,
    activity?: { found: boolean },
  ): Promise<AgentQueuedTurnRecord[]> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new TypeError('Agent queued turn reconciliation limit must be between 1 and 1000');
    }
    const claimId = requireBoundedString(input.claimId, 128);
    const claimBy = requireBoundedString(input.claimBy, 256);
    if (
      !Number.isFinite(input.now.getTime()) ||
      !Number.isFinite(input.leaseUntil.getTime()) ||
      input.leaseUntil <= input.now
    ) {
      throw new TypeError('Agent queued turn reconciliation lease is invalid');
    }
    const eligible: QueuedTurnQuery = {
      admissionId: { $exists: true },
      admissionStartedAt: { $exists: true },
      deliveryKey: { $exists: true },
      $and: [
        {
          $or: [
            {
              status: 'dead',
              'terminalReceipt.outcome': 'dead',
              'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
            },
            {
              status: 'claimed',
              'terminalReceipt.outcome': 'dead',
              'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
            },
            { status: 'claimed', claimUntil: { $lte: input.now } },
          ],
        },
        {
          $or: [
            { reconciliationAvailableAt: { $lte: input.now } },
            { reconciliationAvailableAt: { $exists: false } },
          ],
        },
        {
          $or: [
            { reconciliationClaimUntil: { $lte: input.now } },
            { reconciliationClaimUntil: { $exists: false } },
          ],
        },
      ],
    };
    const candidates = await steps.turns.find(
      {
        ...eligible,
      },
      {
        sort: { reconciliationAvailableAt: 1, admissionStartedAt: 1, _id: 1 },
        limit: limit,
        select: '_id',
      },
    );
    if (candidates.length === 0) {
      return [];
    }
    if (activity != null) activity.found = true;
    await steps.turns.updateMany(
      {
        ...eligible,
        _id: { $in: candidates.flatMap((turn) => (turn._id == null ? [] : [turn._id])) },
      },
      {
        $set: {
          reconciliationClaimId: claimId,
          reconciliationClaimBy: claimBy,
          reconciliationClaimUntil: input.leaseUntil,
        },
        $inc: { reconciliationAttempts: 1 },
      },
    );
    const turns = await steps.turns.find(
      { reconciliationClaimId: claimId, reconciliationClaimBy: claimBy },
      { sort: { reconciliationAvailableAt: 1, admissionStartedAt: 1, _id: 1 } },
    );
    return turns.map(toRecord);
  }

  async function deferAgentQueuedTurnAdmissionReconciliation(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      claimId: string;
      claimBy: string;
      availableAt: Date;
    },
  ): Promise<boolean> {
    if (!Number.isFinite(input.availableAt.getTime())) {
      throw new TypeError('Agent queued turn reconciliation availability is invalid');
    }
    const result = await steps.turns.updateOne(
      {
        ...conversationScope(input),
        _id: input.queuedTurnId,
        deliveryKey: requireBoundedString(input.deliveryKey, 128),
        status: { $in: ['claimed', 'dead'] },
        'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
        reconciliationClaimId: requireBoundedString(input.claimId, 128),
        reconciliationClaimBy: requireBoundedString(input.claimBy, 256),
      },
      {
        $set: { reconciliationAvailableAt: input.availableAt },
        $unset: {
          reconciliationClaimId: 1,
          reconciliationClaimBy: 1,
          reconciliationClaimUntil: 1,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async function reserveAgentQueuedTurnDelivery(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
    },
  ): Promise<ReserveAgentQueuedTurnDeliveryResult> {
    const scope = conversationScope(input);
    const deliveryKey = requireBoundedString(input.deliveryKey, 128);
    const turn = await steps.turns.findOneAndUpdate(
      {
        ...scope,
        _id: input.queuedTurnId,
        status: { $in: ['queued', 'claimed'] },
        $or: [{ deliveryState: 'pending' }, { deliveryState: { $exists: false } }],
        deliveryKey: { $exists: false },
      },
      { $set: { deliveryKey, deliveryState: 'publishing' } },
    );
    if (turn != null) {
      return { outcome: 'reserved', turn: toRecord(turn) };
    }
    const current = await steps.turns.findOne({ ...scope, _id: input.queuedTurnId });
    if (
      current?.deliveryKey === deliveryKey &&
      (current.deliveryState == null ||
        current.deliveryState === 'publishing' ||
        current.deliveryState === 'published')
    ) {
      return { outcome: 'already_reserved', turn: toRecord(current) };
    }
    return { outcome: 'conflict', turn: current == null ? null : toRecord(current) };
  }

  async function markQueuedTurnScheduled(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      scheduledAt?: Date;
    },
  ): Promise<ScheduleAgentQueuedTurnResult> {
    const deliveryKey = requireBoundedString(input.deliveryKey, 128);
    const turn = await steps.turns.findOneAndUpdate(
      {
        ...conversationScope(input),
        _id: input.queuedTurnId,
        deliveryKey,
        $or: [{ deliveryState: 'publishing' }, { deliveryState: { $exists: false } }],
        scheduledAt: { $exists: false },
      },
      {
        $set: {
          scheduledAt: input.scheduledAt ?? new Date(),
          deliveryState: 'published',
        },
      },
    );
    if (turn != null) {
      return { outcome: 'scheduled', turn: toRecord(turn) };
    }
    const current = await steps.turns.findOne({
      ...conversationScope(input),
      _id: input.queuedTurnId,
    });
    if (
      current?.scheduledAt != null &&
      current.deliveryKey === deliveryKey &&
      current.deliveryState === 'published'
    ) {
      return { outcome: 'already_scheduled', turn: toRecord(current) };
    }
    return {
      outcome: 'conflict',
      turn: current == null ? null : toRecord(current),
    };
  }

  async function claimNextAgentQueuedTurn(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      claimId: string;
      claimBy: string;
      now: Date;
      leaseUntil: Date;
    },
  ): Promise<ClaimAgentQueuedTurnResult> {
    const claimId = requireBoundedString(input.claimId, 128);
    const claimBy = requireBoundedString(input.claimBy, 256);
    if (input.leaseUntil.getTime() <= input.now.getTime()) {
      throw new TypeError('Agent queued turn lease must end after claim time');
    }
    const scope = conversationScope(input);
    const expected = await steps.turns.findOne({ ...scope, _id: input.queuedTurnId });
    if (
      expected == null ||
      expected.laneId == null ||
      (expected.status !== 'queued' && expected.status !== 'claimed')
    ) {
      return { outcome: 'missing', claim: null };
    }
    const laneScope = { ...scope, laneId: expected.laneId };
    const laneExists = await steps.lanes.exists({
      _id: laneKey(input),
      ...scope,
      laneId: expected.laneId,
      retiredAt: { $exists: false },
    });
    if (laneExists == null) {
      return { outcome: 'missing', claim: null };
    }
    const competingReservation = await steps.turns.exists({
      ...laneScope,
      _id: { $ne: input.queuedTurnId },
      $or: [
        { admissionSlot: true },
        // Pre-slot replicas and rows still expose their admission owner through
        // the claimed status. Keep that legacy shell inside the same boundary.
        { status: 'claimed' },
        {
          status: 'dead',
          'terminalReceipt.outcome': 'dead',
          'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
        },
      ],
    });
    if (competingReservation != null) {
      return { outcome: 'blocked', claim: null };
    }
    if (
      expected.status === 'claimed' &&
      expected.claimId === claimId &&
      expected.claimBy === claimBy &&
      expected.claimUntil != null &&
      expected.claimUntil.getTime() > input.now.getTime()
    ) {
      if (expected.admissionSlot !== true) {
        const migrated = await steps.turns
          .findOneAndUpdate(
            {
              ...laneScope,
              _id: input.queuedTurnId,
              status: 'claimed',
              claimId,
              claimBy,
              admissionSlot: { $exists: false },
            },
            { $set: { admissionSlot: true } },
          )
          .catch((error: unknown) => {
            if (steps.isDuplicateKey(error)) {
              return null;
            }
            throw error;
          });
        const migratedClaim = requireClaim(migrated);
        return migratedClaim == null
          ? { outcome: 'blocked', claim: null }
          : { outcome: 'replayed', claim: migratedClaim };
      }
      const replayedClaim = requireClaim(expected);
      if (replayedClaim != null) {
        return { outcome: 'replayed', claim: replayedClaim };
      }
    }

    const unfinishedReservation = await steps.turns.exists({ ...laneScope, status: 'reserving' });
    if (unfinishedReservation != null) {
      return { outcome: 'blocked', claim: null };
    }
    const head =
      expected.status === 'claimed'
        ? expected
        : await steps.turns.findOne(
            { ...laneScope, status: { $in: ['queued', 'dead'] } },
            { sort: { priority: -1, sequence: 1 } },
          );
    if (
      head == null ||
      head._id?.toString() !== input.queuedTurnId ||
      head.availableAt.getTime() > input.now.getTime() ||
      (head.status === 'claimed' &&
        head.claimUntil != null &&
        head.claimUntil.getTime() > input.now.getTime())
    ) {
      return { outcome: 'blocked', claim: null };
    }

    const turn = await steps.turns
      .findOneAndUpdate(
        {
          ...laneScope,
          _id: input.queuedTurnId,
          availableAt: { $lte: input.now },
          $or: [
            { status: 'queued', admissionSlot: { $exists: false } },
            {
              status: 'claimed',
              claimUntil: { $lte: input.now },
              admissionStartedAt: { $exists: false },
            },
          ],
        },
        {
          $set: {
            status: 'claimed',
            admissionSlot: true,
            claimId,
            claimBy,
            claimUntil: input.leaseUntil,
          },
          $inc: { attempts: 1 },
          $unset: { terminalReceipt: 1 },
        },
        { sort: { priority: -1, sequence: 1 } },
      )
      .catch((error: unknown) => {
        if (steps.isDuplicateKey(error)) {
          return null;
        }
        throw error;
      });
    const acquired = requireClaim(turn);
    if (acquired != null) {
      return { outcome: 'acquired', claim: acquired };
    }
    const racedReplay = await steps.turns.findOne({
      ...laneScope,
      _id: input.queuedTurnId,
      status: 'claimed',
      admissionSlot: true,
      claimId,
      claimBy,
      claimUntil: { $gt: input.now },
    });
    const racedClaim = requireClaim(racedReplay);
    return racedClaim == null
      ? { outcome: 'blocked', claim: null }
      : { outcome: 'replayed', claim: racedClaim };
  }

  async function releaseAgentQueuedTurn(
    input: AgentQueuedTurnStoreClaimFence &
      (
        | { disposition: 'retry'; availableAt: Date }
        | {
            disposition: 'dead';
            settledAt: Date;
            failure: AgentQueuedTurnFailure;
          }
      ),
  ): Promise<ReleaseAgentQueuedTurnResult> {
    const fence = {
      ...conversationScope(input),
      _id: input.queuedTurnId,
      status: 'claimed',
      claimId: requireBoundedString(input.claimId, 128),
      claimBy: requireBoundedString(input.claimBy, 256),
    };
    const update =
      input.disposition === 'retry'
        ? {
            $set: { status: 'queued', availableAt: input.availableAt },
            $unset: {
              claimId: 1,
              claimBy: 1,
              claimUntil: 1,
              admissionSlot: 1,
              admissionId: 1,
              admissionStartedAt: 1,
              admissionEffectivePredecessorCreatedAt: 1,
              admissionLineagePredecessorId: 1,
              admissionProtocolVersion: 1,
              terminalReceipt: 1,
            },
          }
        : {
            $set: {
              status: 'dead',
              terminalReceipt: {
                outcome: 'dead',
                settledAt: input.settledAt,
                failure: {
                  code: requireBoundedString(input.failure.code, 128),
                  message: requireBoundedString(input.failure.message, 2048),
                },
              },
            },
            $unset: {
              activeSlot: 1,
              admissionSlot: 1,
              claimId: 1,
              claimBy: 1,
              claimUntil: 1,
              admissionId: 1,
              admissionStartedAt: 1,
              admissionEffectivePredecessorCreatedAt: 1,
              admissionLineagePredecessorId: 1,
              admissionProtocolVersion: 1,
            },
          };
    const turn = await steps.turns.findOneAndUpdate(fence, update);
    if (turn != null) {
      return {
        outcome: input.disposition === 'retry' ? 'released' : 'dead',
        turn: toRecord(turn),
      };
    }
    const current = await steps.turns.findOne({
      ...conversationScope(input),
      _id: input.queuedTurnId,
    });
    return {
      outcome: 'conflict',
      turn: current == null ? null : toRecord(current),
    };
  }

  async function beginAgentQueuedTurnAdmission(
    input: AgentQueuedTurnStoreClaimFence & {
      admissionId: string;
      startedAt: Date;
      admissionProtocolVersion?: 2;
    },
  ): Promise<BeginAgentQueuedTurnAdmissionResult> {
    const admissionId = requireBoundedString(input.admissionId, 128);
    if (!Number.isFinite(input.startedAt.getTime())) {
      throw new TypeError('Agent queued turn admission start is invalid');
    }
    const retireObsoleteClaim = async (): Promise<AgentQueuedTurnRecord | null> => {
      const retired = await steps.turns.findOneAndUpdate(
        {
          ...conversationScope(input),
          _id: input.queuedTurnId,
          status: 'claimed',
          claimId: requireBoundedString(input.claimId, 128),
          claimBy: requireBoundedString(input.claimBy, 256),
          admissionStartedAt: { $exists: false },
        },
        {
          $set: {
            status: 'cancelled',
            terminalReceipt: {
              outcome: 'cancelled',
              settledAt: input.startedAt,
              failure: {
                code: 'LANE_RETIRED',
                message: 'The queued turn belongs to a retired conversation lane',
              },
            },
          },
          $unset: {
            activeSlot: 1,
            admissionSlot: 1,
            claimId: 1,
            claimBy: 1,
            claimUntil: 1,
          },
        },
      );
      return retired == null ? null : toRecord(retired);
    };
    return serializeLocalLane(input, async () => {
      let writer: AgentQueuedTurnLaneWriter;
      try {
        writer = await acquireLaneWriter(input, false);
      } catch (error) {
        if (
          error instanceof AgentQueuedTurnLaneRetiredError ||
          error instanceof AgentQueuedTurnLaneMissingError
        ) {
          const retired = await retireObsoleteClaim();
          if (retired != null) {
            return { outcome: 'retired', turn: retired };
          }
          const current = await steps.turns.findOne({
            ...conversationScope(input),
            _id: input.queuedTurnId,
          });
          return {
            outcome: 'conflict',
            turn: current == null ? null : toRecord(current),
          };
        }
        throw error;
      }
      try {
        const current = await steps.turns.findOne({
          ...conversationScope(input),
          _id: input.queuedTurnId,
        });
        if (
          current?.status === 'claimed' &&
          current.claimId === input.claimId &&
          current.claimBy === input.claimBy &&
          current.admissionSlot === true &&
          current.deliveryKey === admissionId &&
          current.deliveryState === 'published' &&
          current.laneId === writer.laneId &&
          current.admissionId === admissionId &&
          current.admissionStartedAt != null
        ) {
          return { outcome: 'already_started', turn: toRecord(current) };
        }
        if (
          current?.status === 'claimed' &&
          current.claimId === input.claimId &&
          current.claimBy === input.claimBy &&
          current.admissionStartedAt == null &&
          current.laneId !== writer.laneId
        ) {
          const retired = await retireObsoleteClaim();
          if (retired != null) {
            return { outcome: 'retired', turn: retired };
          }
        }
        if (
          current?.status !== 'claimed' ||
          current.claimId !== input.claimId ||
          current.claimBy !== input.claimBy ||
          current.admissionSlot !== true ||
          current.deliveryKey !== admissionId ||
          current.deliveryState !== 'published' ||
          current.laneId !== writer.laneId ||
          current.admissionId != null ||
          current.sequence == null
        ) {
          return {
            outcome: 'conflict',
            turn: current == null ? null : toRecord(current),
          };
        }

        const rootPredecessorCreatedAt = normalizePredecessor(current.expectedPredecessorCreatedAt);
        const resolvedPredecessor = await getEffectiveAgentQueuedTurnPredecessor({
          user: current.user,
          ...(current.tenantId != null && { tenantId: current.tenantId }),
          conversationId: current.conversationId,
          sequence: current.sequence,
          rootParentMessageId: current.parentMessageId,
          ...(rootPredecessorCreatedAt != null && {
            expectedPredecessorCreatedAt: rootPredecessorCreatedAt,
          }),
          allowLegacyPredecessorInference: true,
        });
        if (resolvedPredecessor === null) {
          const dead = await steps.turns.findOneAndUpdate(
            {
              ...conversationScope(input),
              _id: input.queuedTurnId,
              status: 'claimed',
              claimId: requireBoundedString(input.claimId, 128),
              claimBy: requireBoundedString(input.claimBy, 256),
              admissionSlot: true,
              deliveryKey: admissionId,
              deliveryState: 'published',
              laneId: writer.laneId,
              admissionId: { $exists: false },
            },
            {
              $set: {
                status: 'dead',
                terminalReceipt: {
                  outcome: 'dead',
                  settledAt: input.startedAt,
                  failure: {
                    code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE',
                    message:
                      'The queued turn admission order could not be reconstructed safely. Review this turn before sending it.',
                  },
                },
              },
              $unset: {
                activeSlot: 1,
                admissionSlot: 1,
                claimId: 1,
                claimBy: 1,
                claimUntil: 1,
              },
            },
          );
          if (dead != null) {
            return { outcome: 'order_unavailable', turn: toRecord(dead) };
          }
          const conflicted = await steps.turns.findOne({
            ...conversationScope(input),
            _id: input.queuedTurnId,
          });
          return {
            outcome: 'conflict',
            turn: conflicted == null ? null : toRecord(conflicted),
          };
        }
        const effectivePredecessorCreatedAt = resolvedPredecessor.effectivePredecessorCreatedAt;
        const turn = await steps.turns.findOneAndUpdate(
          {
            ...conversationScope(input),
            _id: input.queuedTurnId,
            status: 'claimed',
            claimId: requireBoundedString(input.claimId, 128),
            claimBy: requireBoundedString(input.claimBy, 256),
            admissionSlot: true,
            deliveryKey: admissionId,
            deliveryState: 'published',
            laneId: writer.laneId,
            admissionId: { $exists: false },
          },
          {
            $set: {
              admissionId,
              admissionStartedAt: input.startedAt,
              ...(effectivePredecessorCreatedAt != null && {
                admissionEffectivePredecessorCreatedAt: effectivePredecessorCreatedAt,
              }),
              admissionLineagePredecessorId: resolvedPredecessor.lineagePredecessorId,
              ...(input.admissionProtocolVersion != null && {
                admissionProtocolVersion: input.admissionProtocolVersion,
              }),
            },
          },
        );
        if (turn != null) {
          return { outcome: 'started', turn: toRecord(turn) };
        }
        const raced = await steps.turns.findOne({
          ...conversationScope(input),
          _id: input.queuedTurnId,
        });
        if (
          raced?.status === 'claimed' &&
          raced.claimId === input.claimId &&
          raced.claimBy === input.claimBy &&
          raced.admissionSlot === true &&
          raced.deliveryKey === admissionId &&
          raced.deliveryState === 'published' &&
          raced.laneId === writer.laneId &&
          raced.admissionId === admissionId &&
          raced.admissionStartedAt != null &&
          raced.admissionEffectivePredecessorCreatedAt === effectivePredecessorCreatedAt &&
          raced.admissionLineagePredecessorId === resolvedPredecessor.lineagePredecessorId
        ) {
          return { outcome: 'already_started', turn: toRecord(raced) };
        }
        return {
          outcome: 'conflict',
          turn: raced == null ? null : toRecord(raced),
        };
      } finally {
        await releaseLaneWriter(input, writer.writerId);
      }
    });
  }

  async function markAgentQueuedTurnAdmitted(
    input: AgentQueuedTurnStoreClaimFence & {
      admissionId: string;
      admissionMode: 'warm' | 'ordinary';
      generationId?: string;
      generationCreatedAt?: number;
      effectivePredecessorCreatedAt?: number;
      lineagePredecessorId?: string;
      settledAt: Date;
    },
  ): Promise<AdmitAgentQueuedTurnResult> {
    const admissionId = requireBoundedString(input.admissionId, 128);
    const generationId = normalizeOptionalString(input.generationId, 256);
    const generationCreatedAt = normalizePredecessor(input.generationCreatedAt);
    const effectivePredecessorCreatedAt = normalizePredecessor(input.effectivePredecessorCreatedAt);
    const lineagePredecessorId = normalizeOptionalString(input.lineagePredecessorId, 128);
    const turn = await steps.turns.findOneAndUpdate(
      {
        ...conversationScope(input),
        _id: input.queuedTurnId,
        deliveryKey: admissionId,
        deliveryState: 'published',
        admissionId,
        admissionStartedAt: { $exists: true },
        ...(effectivePredecessorCreatedAt != null
          ? { admissionEffectivePredecessorCreatedAt: effectivePredecessorCreatedAt }
          : { admissionEffectivePredecessorCreatedAt: { $exists: false } }),
        ...(lineagePredecessorId != null
          ? { admissionLineagePredecessorId: lineagePredecessorId }
          : { admissionLineagePredecessorId: { $exists: false } }),
        $or: [
          {
            status: 'claimed',
            claimId: requireBoundedString(input.claimId, 128),
            claimBy: requireBoundedString(input.claimBy, 256),
          },
          {
            status: 'dead',
            'terminalReceipt.outcome': 'dead',
            'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
          },
          {
            status: 'claimed',
            'terminalReceipt.outcome': 'dead',
            'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
          },
        ],
      },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: input.settledAt,
            admissionId,
            admissionMode: input.admissionMode,
            ...(generationId != null && { generationId }),
            ...(generationCreatedAt != null && { generationCreatedAt }),
            ...(effectivePredecessorCreatedAt != null && { effectivePredecessorCreatedAt }),
            ...(lineagePredecessorId != null && { lineagePredecessorId }),
            ...(effectivePredecessorCreatedAt == null &&
              lineagePredecessorId != null &&
              isRootLineagePredecessorId(lineagePredecessorId) && {
                rootPredecessor: true,
              }),
          },
        },
        $unset: {
          activeSlot: 1,
          admissionSlot: 1,
          claimId: 1,
          claimBy: 1,
          claimUntil: 1,
          admissionId: 1,
          admissionStartedAt: 1,
          admissionEffectivePredecessorCreatedAt: 1,
          admissionLineagePredecessorId: 1,
          admissionProtocolVersion: 1,
          reconciliationAvailableAt: 1,
          reconciliationClaimId: 1,
          reconciliationClaimBy: 1,
          reconciliationClaimUntil: 1,
        },
      },
    );
    if (turn != null) {
      return { outcome: 'admitted', turn: toRecord(turn) };
    }
    const current = await steps.turns.findOne({
      ...conversationScope(input),
      _id: input.queuedTurnId,
    });
    if (
      current?.status === 'admitted' &&
      current.terminalReceipt?.outcome === 'admitted' &&
      current.terminalReceipt.admissionId === admissionId
    ) {
      return { outcome: 'already_admitted', turn: toRecord(current) };
    }
    return {
      outcome: 'conflict',
      turn: current == null ? null : toRecord(current),
    };
  }

  async function hasAgentQueuedTurnAdmissionReceipt(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      admissionId: string;
      generationId: string;
      generationCreatedAt: number;
      effectivePredecessorCreatedAt?: number;
      lineagePredecessorId?: string;
    },
  ): Promise<boolean> {
    const generationCreatedAt = normalizePredecessor(input.generationCreatedAt);
    const effectivePredecessorCreatedAt = normalizePredecessor(input.effectivePredecessorCreatedAt);
    const lineagePredecessorId = normalizeOptionalString(input.lineagePredecessorId, 128);
    if (generationCreatedAt == null) {
      throw new TypeError('Agent queued turn admission generation is invalid');
    }
    return (
      (await steps.turns.exists({
        ...conversationScope(input),
        _id: input.queuedTurnId,
        status: 'admitted',
        'terminalReceipt.outcome': 'admitted',
        'terminalReceipt.admissionId': requireBoundedString(input.admissionId, 128),
        'terminalReceipt.generationId': requireBoundedString(input.generationId, 256),
        'terminalReceipt.generationCreatedAt': generationCreatedAt,
        ...(effectivePredecessorCreatedAt != null && {
          'terminalReceipt.effectivePredecessorCreatedAt': effectivePredecessorCreatedAt,
        }),
        ...(lineagePredecessorId != null && {
          'terminalReceipt.lineagePredecessorId': lineagePredecessorId,
        }),
      })) != null
    );
  }

  async function deadLetterAgentQueuedTurn(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      settledAt: Date;
      failure: AgentQueuedTurnFailure;
      admissionEvidence?: AgentQueuedTurnAdmissionEvidence;
      reconciliationClaimId?: string;
      reconciliationClaimBy?: string;
    },
  ): Promise<DeadLetterAgentQueuedTurnResult> {
    const scope = conversationScope(input);
    const deliveryKey = requireBoundedString(input.deliveryKey, 128);
    if (input.admissionEvidence != null) {
      const generationId = normalizeOptionalString(input.admissionEvidence.generationId, 256);
      const generationCreatedAt = normalizePredecessor(input.admissionEvidence.generationCreatedAt);
      if (generationCreatedAt == null) {
        throw new TypeError('Agent queued turn admission evidence is invalid');
      }
      const admission = await steps.turns.findOne(
        {
          ...scope,
          _id: input.queuedTurnId,
          deliveryKey,
          admissionId: deliveryKey,
          admissionStartedAt: { $exists: true },
        },
        {
          select: {
            sequence: 1,
            parentMessageId: 1,
            expectedPredecessorCreatedAt: 1,
            admissionEffectivePredecessorCreatedAt: 1,
            admissionLineagePredecessorId: 1,
            admissionProtocolVersion: 1,
          },
        },
      );
      let effectivePredecessorCreatedAt = normalizePredecessor(
        admission?.admissionEffectivePredecessorCreatedAt,
      );
      let lineagePredecessorId = normalizeOptionalString(
        admission?.admissionLineagePredecessorId,
        128,
      );
      if (admission?.sequence != null) {
        const rootPredecessorCreatedAt = normalizePredecessor(
          admission.expectedPredecessorCreatedAt,
        );
        const resolvedPredecessor = await getEffectiveAgentQueuedTurnPredecessor({
          user: input.user,
          ...(input.tenantId != null && { tenantId: input.tenantId }),
          conversationId: input.conversationId,
          sequence: admission.sequence,
          rootParentMessageId: admission.parentMessageId,
          ...(rootPredecessorCreatedAt != null && {
            expectedPredecessorCreatedAt: rootPredecessorCreatedAt,
          }),
        });
        const lineageConflict =
          resolvedPredecessor === null ||
          (lineagePredecessorId != null &&
            lineagePredecessorId !== resolvedPredecessor.lineagePredecessorId) ||
          (effectivePredecessorCreatedAt != null &&
            effectivePredecessorCreatedAt !== resolvedPredecessor.effectivePredecessorCreatedAt);
        if (lineageConflict) {
          effectivePredecessorCreatedAt = undefined;
          lineagePredecessorId = undefined;
        } else {
          effectivePredecessorCreatedAt = resolvedPredecessor.effectivePredecessorCreatedAt;
          lineagePredecessorId = resolvedPredecessor.lineagePredecessorId;
        }
      }
      /** GenerationJob evidence predates the source-receipt protocol. For v2,
       * only the exact late source callback may prove provider admission. */
      const reconciled =
        admission?.admissionProtocolVersion === 2 || lineagePredecessorId == null
          ? null
          : await steps.turns.findOneAndUpdate(
              {
                ...scope,
                _id: input.queuedTurnId,
                deliveryKey,
                admissionId: deliveryKey,
                admissionStartedAt: { $exists: true },
                ...(input.reconciliationClaimId != null && {
                  reconciliationClaimId: requireBoundedString(input.reconciliationClaimId, 128),
                }),
                ...(input.reconciliationClaimBy != null && {
                  reconciliationClaimBy: requireBoundedString(input.reconciliationClaimBy, 256),
                }),
                $or: [
                  { status: 'claimed' },
                  {
                    status: 'dead',
                    'terminalReceipt.outcome': 'dead',
                    'terminalReceipt.failure.code': 'ADMISSION_INDETERMINATE',
                  },
                ],
              },
              {
                $set: {
                  status: 'admitted',
                  terminalReceipt: {
                    outcome: 'admitted',
                    settledAt: input.settledAt,
                    admissionId: deliveryKey,
                    admissionMode: 'ordinary',
                    ...(generationId != null && { generationId }),
                    generationCreatedAt,
                    ...(effectivePredecessorCreatedAt != null && {
                      effectivePredecessorCreatedAt,
                    }),
                    lineagePredecessorId,
                    ...(effectivePredecessorCreatedAt == null &&
                      isRootLineagePredecessorId(lineagePredecessorId) && {
                        rootPredecessor: true,
                      }),
                  },
                },
                $unset: {
                  activeSlot: 1,
                  admissionSlot: 1,
                  claimId: 1,
                  claimBy: 1,
                  claimUntil: 1,
                  admissionId: 1,
                  admissionStartedAt: 1,
                  admissionEffectivePredecessorCreatedAt: 1,
                  admissionLineagePredecessorId: 1,
                  admissionProtocolVersion: 1,
                  reconciliationAvailableAt: 1,
                  reconciliationClaimId: 1,
                  reconciliationClaimBy: 1,
                  reconciliationClaimUntil: 1,
                },
              },
            );
      if (reconciled != null) {
        return { outcome: 'admission_reconciled', turn: toRecord(reconciled) };
      }
    }
    const turn = await steps.turns.findOneAndUpdate(
      {
        ...scope,
        _id: input.queuedTurnId,
        deliveryKey,
        status: { $in: ['queued', 'claimed'] },
        admissionStartedAt: { $exists: false },
      },
      {
        $set: {
          status: 'dead',
          terminalReceipt: {
            outcome: 'dead',
            settledAt: input.settledAt,
            failure: {
              code: requireBoundedString(input.failure.code, 128),
              message: requireBoundedString(input.failure.message, 2048),
            },
          },
        },
        $unset: {
          activeSlot: 1,
          admissionSlot: 1,
          claimId: 1,
          claimBy: 1,
          claimUntil: 1,
        },
      },
    );
    if (turn != null) {
      return { outcome: 'dead', turn: toRecord(turn) };
    }
    const current = await steps.turns.findOne({ ...scope, _id: input.queuedTurnId });
    if (current == null) {
      return { outcome: 'missing', turn: null };
    }
    if (
      current.status === 'claimed' &&
      current.deliveryKey === deliveryKey &&
      current.admissionStartedAt != null &&
      current.terminalReceipt?.failure?.code !== 'ADMISSION_INDETERMINATE'
    ) {
      const quarantined = await steps.turns.findOneAndUpdate(
        {
          ...scope,
          _id: input.queuedTurnId,
          deliveryKey,
          status: 'claimed',
          admissionId: deliveryKey,
          admissionStartedAt: { $exists: true },
        },
        {
          $set: {
            status: 'claimed',
            reconciliationAvailableAt: input.settledAt,
            reconciliationAttempts: 0,
            terminalReceipt: {
              outcome: 'dead',
              settledAt: input.settledAt,
              failure: {
                code: 'ADMISSION_INDETERMINATE',
                message: 'The queued turn may have been admitted and requires reconciliation',
              },
            },
          },
          $unset: {
            claimId: 1,
            claimBy: 1,
            claimUntil: 1,
            reconciliationClaimId: 1,
            reconciliationClaimBy: 1,
            reconciliationClaimUntil: 1,
          },
        },
      );
      if (quarantined != null) {
        return { outcome: 'admission_indeterminate', turn: toRecord(quarantined) };
      }
    }
    if (
      ['admitted', 'cancelled', 'dead'].includes(current.status) ||
      (current.status === 'claimed' &&
        current.terminalReceipt?.outcome === 'dead' &&
        current.terminalReceipt.failure?.code === 'ADMISSION_INDETERMINATE')
    ) {
      return { outcome: 'already_terminal', turn: toRecord(current) };
    }
    return { outcome: 'conflict', turn: toRecord(current) };
  }

  async function getEffectiveAgentQueuedTurnPredecessor(
    input: AgentQueuedTurnStoreConversationScope & {
      sequence: number;
      rootParentMessageId: string;
      expectedPredecessorCreatedAt?: number;
      allowLegacyPredecessorInference?: boolean;
    },
  ): Promise<AgentQueuedTurnPredecessor | null> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) {
      throw new TypeError('Agent queued turn sequence must be a positive integer');
    }
    const rootEpoch = normalizePredecessor(input.expectedPredecessorCreatedAt);
    const rootParentMessageId = requireBoundedString(
      input.rootParentMessageId,
      Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH,
    );
    const rootLineagePredecessorId = getRootLineagePredecessorId(rootParentMessageId);
    const predecessors = await steps.turns.find(
      {
        ...conversationScope(input),
        sequence: { $ne: input.sequence },
        ...(rootEpoch == null
          ? { expectedPredecessorCreatedAt: { $exists: false } }
          : { expectedPredecessorCreatedAt: rootEpoch }),
        parentMessageId: rootParentMessageId,
        status: 'admitted',
        'terminalReceipt.outcome': 'admitted',
      },
      { select: { sequence: 1, terminalReceipt: 1 } },
    );
    /** Queued-turn identities define lineage; timestamps are payload evidence,
     * never graph nodes. One legacy row may be inserted at the proven tail
     * while the caller owns admission. Missing output evidence, branches, and
     * disconnected rows remain fail-closed. */
    const edges = new Map<string, { queuedTurnId: string; generationCreatedAt: number }>();
    const legacyRows: { queuedTurnId: string; generationCreatedAt: number }[] = [];
    for (const turn of predecessors) {
      const queuedTurnId = turn._id?.toString();
      const generationCreatedAt = normalizePredecessor(turn.terminalReceipt?.generationCreatedAt);
      if (queuedTurnId == null || generationCreatedAt == null) {
        return null;
      }
      const lineagePredecessorId = normalizeOptionalString(
        turn.terminalReceipt?.lineagePredecessorId,
        128,
      );
      if (lineagePredecessorId == null) {
        legacyRows.push({ queuedTurnId, generationCreatedAt });
        continue;
      }
      if (edges.has(lineagePredecessorId)) {
        return null;
      }
      edges.set(lineagePredecessorId, { queuedTurnId, generationCreatedAt });
    }
    if (
      legacyRows.length > 0 &&
      (input.allowLegacyPredecessorInference !== true || legacyRows.length > 1)
    ) {
      return null;
    }
    let lineagePredecessorId = rootLineagePredecessorId;
    let effectivePredecessorCreatedAt = rootEpoch;
    let traversed = 0;
    const visited = new Set<string>();
    const advanceExactEdges = () => {
      while (edges.has(lineagePredecessorId)) {
        const edge = edges.get(lineagePredecessorId) as {
          queuedTurnId: string;
          generationCreatedAt: number;
        };
        if (visited.has(edge.queuedTurnId)) {
          return false;
        }
        visited.add(edge.queuedTurnId);
        lineagePredecessorId = edge.queuedTurnId;
        effectivePredecessorCreatedAt = edge.generationCreatedAt;
        traversed += 1;
      }
      return true;
    };
    if (!advanceExactEdges()) {
      return null;
    }
    if (legacyRows.length === 1) {
      const legacy = legacyRows[0];
      if (visited.has(legacy.queuedTurnId)) {
        return null;
      }
      visited.add(legacy.queuedTurnId);
      lineagePredecessorId = legacy.queuedTurnId;
      effectivePredecessorCreatedAt = legacy.generationCreatedAt;
      traversed += 1;
      if (!advanceExactEdges()) {
        return null;
      }
    }
    if (traversed !== predecessors.length) {
      return null;
    }
    return {
      lineagePredecessorId,
      ...(effectivePredecessorCreatedAt != null && { effectivePredecessorCreatedAt }),
    };
  }

  async function deleteAgentQueuedTurns(
    input: AgentQueuedTurnStoreOwnerScope & { conversationId?: string },
  ): Promise<number> {
    const scope = {
      ...ownerScope(input),
      ...(input.conversationId != null && {
        conversationId: requireBoundedString(input.conversationId, 256),
      }),
    };
    const [turns] = await Promise.all([
      steps.turns.deleteMany(scope),
      steps.lanes.deleteMany(scope),
    ]);
    return turns.deletedCount;
  }

  async function retireConversationLane(
    user: IdLike,
    target: AgentQueuedTurnDeletionTarget,
    retiredAt: Date,
  ): Promise<void> {
    if (target.allTenants === true) {
      const lanes = await steps.lanes.find(
        { user, conversationId: requireBoundedString(target.conversationId, 256) },
        { select: 'tenantId' },
      );
      for (const lane of lanes) {
        await retireConversationLane(
          user,
          {
            conversationId: target.conversationId,
            ...(lane.tenantId != null && { tenantId: lane.tenantId }),
          },
          retiredAt,
        );
      }
      return;
    }
    const input: AgentQueuedTurnStoreConversationScope = {
      user,
      ...(target.tenantId != null && { tenantId: target.tenantId }),
      conversationId: target.conversationId,
    };
    const _id = laneKey(input);
    const scope = conversationScope(input);
    return serializeLocalLane(input, async () => {
      let writer: AgentQueuedTurnLaneWriter;
      try {
        writer = await acquireLaneWriter(input);
      } catch (error) {
        if (error instanceof AgentQueuedTurnLaneRetiredError) {
          return;
        }
        throw error;
      }
      try {
        const admissionInFlight = await steps.turns.exists({
          ...scope,
          admissionStartedAt: { $exists: true },
        });
        if (admissionInFlight != null) {
          throw new Error('Agent queued turn admission must settle before conversation deletion');
        }
        const retired = await steps.lanes.updateOne(
          { _id, ...scope, writerId: writer.writerId, retiredAt: { $exists: false } },
          {
            $set: {
              retiredAt,
              expiresAt: new Date(retiredAt.getTime() + RETIRED_LANE_RETENTION_MS),
            },
            $unset: { writerId: 1, writerUntil: 1 },
          },
        );
        if (retired.modifiedCount !== 1) {
          throw new Error('Agent queued turn lane retirement fence was lost');
        }
      } finally {
        await releaseLaneWriter(input, writer.writerId);
      }
    });
  }

  async function prepareAgentQueuedTurnConversationDeletion(input: {
    user: IdLike;
    targets: readonly AgentQueuedTurnDeletionTarget[];
    settledAt?: Date;
  }): Promise<string[]> {
    const scope = deletionScope(input);
    const settledAt = input.settledAt ?? new Date();
    for (const target of input.targets) {
      await retireConversationLane(input.user, target, settledAt);
    }
    await steps.turns.updateMany(
      {
        $and: [
          scope,
          {
            $or: [
              { status: { $in: ['reserving', 'queued'] } },
              { status: 'claimed', admissionStartedAt: { $exists: false } },
            ],
          },
        ],
      },
      {
        $set: {
          status: 'cancelled',
          terminalReceipt: {
            outcome: 'cancelled',
            settledAt,
            failure: {
              code: 'OWNER_DRAINED',
              message: 'Queued turn owner was drained',
            },
          },
        },
        $unset: {
          activeSlot: 1,
          admissionSlot: 1,
          reservationWriterId: 1,
          claimId: 1,
          claimBy: 1,
          claimUntil: 1,
          admissionId: 1,
          admissionStartedAt: 1,
        },
      },
    );
    await Promise.all([
      steps.turns.updateMany(
        { ...scope, status: 'cancelled', deliveryKey: { $exists: false } },
        { $set: { deliveryState: 'retired' } },
      ),
      steps.turns.updateMany(
        {
          ...scope,
          status: { $in: ['admitted', 'cancelled', 'dead'] },
          deliveryKey: { $exists: true },
          deliveryState: { $exists: false },
        },
        { $set: { deliveryState: 'published' } },
      ),
    ]);
    const turns = await steps.turns.find(
      {
        ...scope,
        status: { $in: ['admitted', 'cancelled', 'dead'] },
        deliveryKey: { $exists: true },
        deliveryState: { $ne: 'retired' },
      },
      { select: 'deliveryKey' },
    );
    return [
      ...new Set(turns.flatMap((turn) => (turn.deliveryKey == null ? [] : [turn.deliveryKey]))),
    ];
  }

  async function deletePreparedAgentQueuedTurnConversations(input: {
    user: IdLike;
    targets: readonly AgentQueuedTurnDeletionTarget[];
  }): Promise<number> {
    const scope = deletionScope(input);
    const blocker = await steps.turns.exists({
      $and: [
        scope,
        {
          $or: [
            { deliveryKey: { $exists: true }, deliveryState: { $ne: 'retired' } },
            { status: { $in: ['reserving', 'queued', 'claimed'] } },
            { admissionStartedAt: { $exists: true } },
          ],
        },
      ],
    });
    if (blocker != null) {
      throw new Error('Agent queued turn deliveries must retire before conversation deletion');
    }
    const turns = await steps.turns.deleteMany(scope);
    return turns.deletedCount;
  }

  async function markAgentQueuedTurnDeliveryRetired(input: {
    deliveryKey: string;
  }): Promise<boolean> {
    const deliveryKey = requireBoundedString(input.deliveryKey, 128);
    const result = await steps.turns.updateOne(
      {
        deliveryKey,
        status: { $in: ['admitted', 'cancelled', 'dead'] },
      },
      { $set: { deliveryState: 'retired' } },
    );
    if (result.modifiedCount === 1) {
      return true;
    }
    const achieved = await steps.turns.exists({
      deliveryKey,
      deliveryState: 'retired',
    });
    return achieved != null;
  }

  /** Freezes a terminal source before probing another collection for an aged
   * delivery receipt. A scheduler can only advance `publishing` to
   * `published`, so it can never cross this fence after the absence read. */
  async function beginAgentQueuedTurnMissingDeliveryRetirement(input: {
    deliveryKey: string;
  }): Promise<boolean> {
    const deliveryKey = requireBoundedString(input.deliveryKey, 128);
    const result = await steps.turns.updateOne(
      {
        deliveryKey,
        status: { $in: ['admitted', 'cancelled', 'dead'] },
        deliveryState: 'published',
      },
      { $set: { deliveryState: 'retiring' } },
    );
    if (result.modifiedCount === 1) {
      return true;
    }
    return (
      (await steps.turns.exists({
        deliveryKey,
        status: { $in: ['admitted', 'cancelled', 'dead'] },
        deliveryState: 'retiring',
      })) != null
    );
  }

  /** A retirement-fenced source proves that its delivery was durably created
   * before the absence read. Once that delivery has aged out, absence is
   * terminal proof rather than permission to publish the payload again. */
  async function markAgentQueuedTurnMissingDeliveryRetired(input: {
    deliveryKey: string;
  }): Promise<boolean> {
    const deliveryKey = requireBoundedString(input.deliveryKey, 128);
    const result = await steps.turns.updateOne(
      {
        deliveryKey,
        status: { $in: ['admitted', 'cancelled', 'dead'] },
        deliveryState: 'retiring',
      },
      { $set: { deliveryState: 'retired' } },
    );
    if (result.modifiedCount === 1) {
      return true;
    }
    return (
      (await steps.turns.exists({
        deliveryKey,
        status: { $in: ['admitted', 'cancelled', 'dead'] },
        deliveryState: 'retired',
      })) != null
    );
  }

  async function deleteAllAgentQueuedTurnsForUser(input: { user: IdLike }): Promise<number> {
    const [turns] = await Promise.all([
      steps.turns.deleteMany({ user: input.user }),
      steps.lanes.deleteMany({ user: input.user }),
    ]);
    return turns.deletedCount;
  }

  return {
    enqueueAgentQueuedTurn,
    getAgentQueuedTurnByClientRequestId,
    listActiveAgentQueuedTurns,
    listAgentQueuedTurnReceipts,
    findQueuedTurnsNeedingDelivery,
    claimQueuedTurnsForAdmissionReconciliation,
    deferAgentQueuedTurnAdmissionReconciliation,
    reserveAgentQueuedTurnDelivery,
    markQueuedTurnScheduled,
    cancelAgentQueuedTurn,
    claimNextAgentQueuedTurn,
    beginAgentQueuedTurnAdmission,
    releaseAgentQueuedTurn,
    markAgentQueuedTurnAdmitted,
    hasAgentQueuedTurnAdmissionReceipt,
    deadLetterAgentQueuedTurn,
    getEffectiveAgentQueuedTurnPredecessor,
    deleteAgentQueuedTurns,
    prepareAgentQueuedTurnConversationDeletion,
    deletePreparedAgentQueuedTurnConversations,
    markAgentQueuedTurnDeliveryRetired,
    beginAgentQueuedTurnMissingDeliveryRetirement,
    markAgentQueuedTurnMissingDeliveryRetired,
    deleteAllAgentQueuedTurnsForUser,
  };
}
