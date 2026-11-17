/**
 * The PostgreSQL `SubagentContentStore` (`~/ports/subagentContent`) on the `subagentcontents`
 * table, through the collection primitive, with the batch encoding and lifetime rules of
 * `~/methods/subagentContentRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - A batch is stored as on MongoDB: its payload fragments (`fragment` 0, 1, ...) and then its
 *   commit record (`fragment: -1`), each an upsert by its deterministic id and digest that only
 *   inserts (`$setOnInsert`). A retry with the same bytes matches every record and changes
 *   nothing; a retry with other bytes misses its record and its insert hits the primary key, which
 *   rejects the append (`StoreDuplicateKeyError`). The fragments go in one `bulk` (one
 *   transaction), the commit record after them, so a batch is visible only once all of it is
 *   stored.
 * - `streamSubagentContentBatches` reads the run's records by keyset pages on `(revision,
 *   fragment)` in an async generator (no cursor held across awaits; PHASE4.md §4 "Cursors and
 *   streaming") and decodes them with the shared decoder, which checks every batch's fragments and
 *   digest.
 * - Expired records are never read (`expiredAt` in the past); the TTL sweeper removes them.
 */
import type { SubagentContentRecord } from '~/methods/subagentContentRules';
import type { SubagentContentBatch, SubagentContentScope } from '~/types';
import type { SubagentContentStore } from '~/ports/subagentContent';
import type { PostgresStoreContext } from './context';
import {
  subagentContentSeedFilter,
  subagentContentScopeFilter,
  subagentContentThreadFilter,
  subagentContentParentFilter,
  subagentContentBatchRecords,
  decodeSubagentContentRecords,
  validateSubagentContentBatch,
} from '~/methods/subagentContentRules';
import { activeExpirationFilter } from '~/utils/retention';

/** Records per keyset page of a stream (each fragment holds up to 128 Ki characters). */
const PAGE_SIZE = 8;

type ContentRecord = SubagentContentRecord & Record<string, unknown>;

export function createPostgresSubagentContentStore(
  context: PostgresStoreContext,
): SubagentContentStore {
  const contents = () => context.collections().collection<ContentRecord>('subagentcontents');
  const messages = () => context.collections().collection('messages');
  const conversations = () => context.collections().collection('conversations');

  /** Whether the run's seed message, parent conversation and thread (with `lease`, its live lease) exist. */
  async function runAlive(
    scope: SubagentContentScope,
    lease?: { leaseToken?: string },
  ): Promise<{ alive: false } | { alive: true; seedExpiredAt?: Date | null }> {
    const [seed, parent, child] = await Promise.all([
      messages().findOne(subagentContentSeedFilter(scope), { projection: 'expiredAt' }),
      conversations().exists(subagentContentParentFilter(scope)),
      conversations().exists(subagentContentThreadFilter(scope, lease)),
    ]);
    if (seed == null || parent == null || child == null) {
      return { alive: false };
    }
    return { alive: true, seedExpiredAt: seed.expiredAt as Date | null | undefined };
  }

  const store: SubagentContentStore = {
    async appendSubagentContentBatch(input) {
      const { revision, fromSequence, throughSequence, eventsJson, leaseToken, ...scope } = input;
      validateSubagentContentBatch({ revision, fromSequence, throughSequence });
      const run = await runAlive(scope, { leaseToken });
      if (!run.alive) {
        await store.reconcileSubagentContent(scope);
        return { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
      }
      const { digest, fragments, commit } = subagentContentBatchRecords(
        scope,
        { revision, fromSequence, throughSequence, eventsJson },
        run.seedExpiredAt,
      );
      const scopeFilter = subagentContentScopeFilter(scope);
      await contents().bulk(
        fragments.map(({ _id, ...record }) => ({
          updateOne: {
            filter: { _id, ...scopeFilter, revision, fragment: record.fragment, digest },
            update: { $setOnInsert: record },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      /** A retry can only commit identical bytes; conflicting retries hit the primary key. */
      const { _id: commitId, ...commitRecord } = commit;
      await contents().updateOne(
        { _id: commitId, ...scopeFilter, revision, fragment: -1, digest },
        { $setOnInsert: commitRecord },
        { upsert: true },
      );
      return store.reconcileSubagentContent(scope);
    },

    /** Cleanup never replays payloads or requires a live execution lease. */
    async reconcileSubagentContent(scope) {
      const run = await runAlive(scope);
      if (!run.alive) {
        await contents().deleteMany(subagentContentScopeFilter(scope));
        return { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
      }
      return { ok: true };
    },

    async getSubagentContentHead(scope, throughRevision) {
      const head = await contents().findOne(
        {
          ...subagentContentScopeFilter(scope),
          fragment: -1,
          ...(throughRevision == null ? {} : { revision: { $lte: throughRevision } }),
          ...activeExpirationFilter(),
        },
        { sort: { revision: -1 }, projection: 'revision throughSequence -_id' },
      );
      return head == null
        ? null
        : { revision: head.revision, throughSequence: head.throughSequence };
    },

    streamSubagentContentBatches(scope, throughRevision, afterSequence = -1) {
      return streamBatches(scope, throughRevision, afterSequence);
    },
  };

  async function* streamBatches(
    scope: SubagentContentScope,
    throughRevision: number,
    afterSequence: number,
  ): AsyncGenerator<SubagentContentBatch> {
    if (throughRevision < 1) return;
    const scopeFilter = subagentContentScopeFilter(scope);
    let fromRevision = 1;
    if (afterSequence >= 0) {
      /** Commit sequences increase with revisions: the first commit ending after the sequence. */
      const first = await contents().findOne(
        {
          ...scopeFilter,
          fragment: -1,
          throughSequence: { $gt: afterSequence },
          ...activeExpirationFilter(),
        },
        { sort: { throughSequence: 1 }, projection: 'revision -_id' },
      );
      if (first == null || first.revision > throughRevision) return;
      fromRevision = first.revision;
    }
    yield* decodeSubagentContentRecords(records(scopeFilter, fromRevision, throughRevision));
  }

  /** The run's records from `fromRevision` through `throughRevision`, by keyset pages. */
  async function* records(
    scopeFilter: Record<string, unknown>,
    fromRevision: number,
    throughRevision: number,
  ): AsyncGenerator<SubagentContentRecord> {
    let after: { revision: number; fragment: number } | undefined;
    for (;;) {
      const page = await contents().find(
        {
          ...scopeFilter,
          revision: { $gte: fromRevision, $lte: throughRevision },
          ...activeExpirationFilter(),
          ...(after == null
            ? {}
            : {
                $and: [
                  {
                    $or: [
                      { revision: { $gt: after.revision } },
                      { revision: after.revision, fragment: { $gt: after.fragment } },
                    ],
                  },
                ],
              }),
        },
        { sort: { revision: 1, fragment: 1 }, limit: PAGE_SIZE },
      );
      yield* page;
      if (page.length < PAGE_SIZE) {
        return;
      }
      const last = page[page.length - 1];
      after = { revision: last.revision, fragment: last.fragment };
    }
  }

  return store;
}
