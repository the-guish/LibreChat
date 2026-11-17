/**
 * The PostgreSQL `AgentQueuedTurnStore` (`~/ports/queuedTurn`) on the `agentqueuedturns` table
 * (with its `files` child table) and the `agentqueuedturnsequences` lane table: the protocol of
 * `~/methods/queuedTurnRules` on the collection primitive's operations. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * Each step is one primitive operation, so each compare-and-set (`findOneAndUpdate` with its
 * guard: the lane writer lease, the claim, the admission fence, the reconciliation lease) is
 * atomic as on MongoDB (§3.5): the row is locked and the parent-column filter rechecked before
 * the write, and no filter reads the `files` child table. The races the protocol leaves to the
 * database are decided by the partial unique indexes of the migration, `NULLS NOT DISTINCT` so
 * the untenanted scope is one scope as on MongoDB: per lane one claimed turn, one turn past the
 * admission boundary and one admission slot; per conversation scope one sequence, one active
 * slot and one request id. A write they reject is a `StoreDuplicateKeyError`, which the protocol
 * turns into a replay, a blocked claim or the next free slot. A lane upsert that loses the
 * insert to another writer is the same duplicate key.
 *
 * `ensureAgentQueuedTurnIndexes` resolves at once: the indexes, fences included, come with the
 * migrations, so the MongoDB upgrade step that quarantines lanes without a total admission order
 * before installing the fences has nothing to do here (a lane with such legacy rows is left
 * alone, as on MongoDB once the fences exist).
 */
import type { QueuedTurnCollectionSteps, QueuedTurnReadOptions } from '~/methods/queuedTurnRules';
import type { IAgentQueuedTurn, IAgentQueuedTurnSequence } from '~/types';
import type { AgentQueuedTurnStore } from '~/ports/queuedTurn';
import type { PgCollection, PgRecord } from '../collection';
import type { PostgresStoreContext } from './context';
import { createAgentQueuedTurnProtocol } from '~/methods/queuedTurnRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';

type TurnRecord = IAgentQueuedTurn & PgRecord;
type LaneRecord = IAgentQueuedTurnSequence & PgRecord;

/** The protocol's steps on one collection of the primitive. */
function collectionSteps<T extends PgRecord>(
  collection: () => PgCollection<T>,
): QueuedTurnCollectionSteps<T> {
  const readOptions = (options: QueuedTurnReadOptions) => ({
    ...(options.sort != null && { sort: options.sort }),
    ...(options.limit != null && { limit: options.limit }),
    ...(options.select != null && { projection: options.select }),
  });
  return {
    findOne: (filter, options = {}) => collection().findOne(filter, readOptions(options)),
    find: (filter, options = {}) => collection().find(filter, readOptions(options)),
    exists: (filter) => collection().exists(filter),
    distinct: (path, filter) => collection().distinct(path, filter),
    create: (document) => collection().insertOne(document),
    findOneAndUpdate: (filter, update, options = {}) =>
      collection().findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        ...(options.sort != null && { sort: options.sort }),
        ...(options.upsert === true && { upsert: true }),
      }),
    updateOne: (filter, update) => collection().updateOne(filter, update),
    updateMany: (filter, update) => collection().updateMany(filter, update),
    deleteMany: (filter) => collection().deleteMany(filter),
  };
}

export function createPostgresAgentQueuedTurnStore(
  context: PostgresStoreContext,
): AgentQueuedTurnStore {
  const store: AgentQueuedTurnStore = {
    ensureAgentQueuedTurnIndexes: async () => undefined,
    ...createAgentQueuedTurnProtocol({
      turns: collectionSteps(() =>
        context.collections().collection<TurnRecord>('agentqueuedturns'),
      ),
      lanes: collectionSteps(() =>
        context.collections().collection<LaneRecord>('agentqueuedturnsequences'),
      ),
      isDuplicateKey: (error) => error instanceof StoreDuplicateKeyError,
    }),
  };
  return store;
}
