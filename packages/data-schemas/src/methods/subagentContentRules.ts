/**
 * The subagent content store's database-neutral rules (`SubagentContentStore`,
 * `~/ports/subagentContent`), shared by every backend: the MongoDB methods (`./subagentContent`)
 * and the PostgreSQL store (`adapters/postgres/stores/subagentContent.ts`). The batch checks, the
 * storage encoding of a batch (fragments under a commit record, their deterministic ids and
 * digest), the conditions a run's content lives under (its seed message, parent conversation and
 * thread, and the live lease for appends), and the decoding of a run's committed records back into
 * batches. Filters here are in MongoDB's query language, which both backends accept. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import type { SubagentContentBatch, SubagentContentScope } from '~/types';
import { activeExpirationFilter } from '~/utils/retention';

/** A stored record of a run's content: a payload fragment, or the commit record (`fragment: -1`). */
export interface SubagentContentRecord {
  revision: number;
  /** -1 is the commit record, published only after every payload fragment exists. */
  fragment: number;
  fragments: number;
  fromSequence: number;
  throughSequence: number;
  digest: string;
  payload?: string;
}

/** The run's tenant as a filter: records stored without one when the scope names none. */
export const subagentContentTenantFilter = (
  tenantId?: string,
): { tenantId: string } | { tenantId: { $exists: false } } =>
  tenantId == null ? { tenantId: { $exists: false } } : { tenantId };

/** The run's records: every scope field, the tenant included. */
export const subagentContentScopeFilter = (
  scope: SubagentContentScope,
): Record<string, unknown> => ({
  ...scope,
  ...subagentContentTenantFilter(scope.tenantId),
});

/** Throws for a revision below 1 or sequences that are not a valid range. */
export function validateSubagentContentBatch(
  batch: Pick<SubagentContentBatch, 'revision' | 'fromSequence' | 'throughSequence'>,
): void {
  const { revision, fromSequence, throughSequence } = batch;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(fromSequence) ||
    fromSequence < 0 ||
    !Number.isSafeInteger(throughSequence) ||
    throughSequence < fromSequence
  ) {
    throw new Error('Invalid subagent content batch');
  }
}

/** Fragments keep even a single large tool body well below Mongo's BSON ceiling.
 * This is a storage encoding, not a content-retention limit. */
const FRAGMENT_CHARS = 128 * 1024;

/** BSON string fragments must not divide a supplementary Unicode character. */
export function fragmentSubagentContent(payload: string): string[] {
  const fragments: string[] = [];
  let start = 0;
  while (start < payload.length) {
    let end = Math.min(start + FRAGMENT_CHARS, payload.length);
    const previous = payload.charCodeAt(end - 1);
    const next = payload.charCodeAt(end);
    if (
      end < payload.length &&
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      end--;
    fragments.push(payload.slice(start, end));
    start = end;
  }
  return fragments;
}

/** The digest a commit record holds and its fragments must reproduce. */
export const subagentContentDigest = (eventsJson: string): string =>
  createHash('sha256').update(eventsJson).digest('hex');

/** The deterministic id of one record of a batch (`-1`: its commit record). */
export function subagentContentRecordId(
  scope: SubagentContentScope,
  revision: number,
  fragment: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.tenantId ?? null,
        scope.user,
        scope.conversationId,
        scope.taskId,
        revision,
        fragment,
      ]),
    )
    .digest('hex');
}

/** The run's owner (its user and tenant), as a filter. */
const ownerFilter = (scope: SubagentContentScope) => ({
  user: scope.user,
  ...subagentContentTenantFilter(scope.tenantId),
});

/** The run's seed message (`<taskId>:user`) while it is unexpired and its content not deleted. */
export function subagentContentSeedFilter(scope: SubagentContentScope): Record<string, unknown> {
  return {
    ...ownerFilter(scope),
    conversationId: scope.conversationId,
    messageId: `${scope.taskId}:user`,
    'subagentContent.deleted': { $ne: true },
    ...activeExpirationFilter(),
  };
}

/** The run's parent conversation while it is unexpired. */
export function subagentContentParentFilter(scope: SubagentContentScope): Record<string, unknown> {
  return {
    ...ownerFilter(scope),
    conversationId: scope.parentConversationId,
    ...activeExpirationFilter(),
  };
}

/**
 * The run's thread while it is unexpired and belongs to the parent; with `lease`, while it also
 * holds a live lease for the task (with `leaseToken`, that lease).
 */
export function subagentContentThreadFilter(
  scope: SubagentContentScope,
  lease?: { leaseToken?: string },
): Record<string, unknown> {
  return {
    ...ownerFilter(scope),
    conversationId: scope.conversationId,
    'subagentThread.parentConversationId': scope.parentConversationId,
    ...(lease == null
      ? {}
      : {
          'subagentThreadLease.taskId': scope.taskId,
          'subagentThreadLease.expiresAt': { $gt: new Date() },
          ...(lease.leaseToken == null ? {} : { 'subagentThreadLease.token': lease.leaseToken }),
        }),
    ...activeExpirationFilter(),
  };
}

/** The records of one batch: the payload fragments and the commit record, with their ids. */
export interface SubagentContentBatchRecords {
  digest: string;
  /** The payload fragments, in order (`fragment` 0, 1, ...). */
  fragments: Array<Record<string, unknown> & { _id: string; fragment: number }>;
  /** The commit record (`fragment: -1`). */
  commit: Record<string, unknown> & { _id: string; fragment: -1 };
}

/**
 * The records that store one batch: each fragment and the commit record carry the run's scope,
 * the batch's revision and sequences, the digest and the fragment count, and the seed message's
 * deadline when it has one.
 */
export function subagentContentBatchRecords(
  scope: SubagentContentScope,
  batch: SubagentContentBatch,
  seedExpiredAt: Date | null | undefined,
): SubagentContentBatchRecords {
  const { revision, fromSequence, throughSequence, eventsJson } = batch;
  const digest = subagentContentDigest(eventsJson);
  const payloads = fragmentSubagentContent(eventsJson);
  const fragments = payloads.length;
  const base = {
    ...scope,
    revision,
    fromSequence,
    throughSequence,
    digest,
    fragments,
    ...(seedExpiredAt == null ? {} : { expiredAt: seedExpiredAt }),
  };
  return {
    digest,
    fragments: Array.from({ length: fragments }, (_, fragment) => ({
      _id: subagentContentRecordId(scope, revision, fragment),
      ...base,
      fragment,
      payload: payloads[fragment],
    })),
    commit: { _id: subagentContentRecordId(scope, revision, -1), ...base, fragment: -1 },
  };
}

/**
 * Decodes a run's committed records, read in revision then fragment order, into its batches.
 * Throws when a committed batch is incomplete or does not match its digest, or a fragment does
 * not belong to the batch before it.
 */
export async function* decodeSubagentContentRecords(
  rows: AsyncIterable<SubagentContentRecord>,
): AsyncGenerator<SubagentContentBatch> {
  let commit: SubagentContentRecord | undefined;
  let payloads: string[] = [];
  const decode = (): SubagentContentBatch => {
    if (commit == null || payloads.length !== commit.fragments) {
      throw new Error('Incomplete committed subagent content batch');
    }
    const eventsJson = payloads.join('');
    if (subagentContentDigest(eventsJson) !== commit.digest) {
      throw new Error('Invalid committed subagent content digest');
    }
    return {
      revision: commit.revision,
      fromSequence: commit.fromSequence,
      throughSequence: commit.throughSequence,
      eventsJson,
    };
  };
  for await (const row of rows) {
    if (row.fragment === -1) {
      if (commit != null) yield decode();
      commit = row;
      payloads = [];
      continue;
    }
    if (
      commit == null ||
      row.revision !== commit.revision ||
      row.fragment !== payloads.length ||
      row.digest !== commit.digest ||
      typeof row.payload !== 'string'
    ) {
      throw new Error('Invalid committed subagent content fragment');
    }
    payloads.push(row.payload);
  }
  if (commit != null) yield decode();
}
