/**
 * The PostgreSQL `MemoryStore` (`~/ports/memory`) on the `memoryentries` table, through the
 * collection primitive, with the partition filter and prompt formatting of
 * `~/methods/memoryRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: `setMemory` and `createMemory` write without validators (pinned by the contract),
 * `setMemoryById` validates; `createMemory` is an insert-only upsert; errors are wrapped with the
 * same messages, and `getFormattedMemories` reports a failed read instead of throwing. An id that
 * is not a store id (24 hex characters) reads as no memory.
 */
import type { PostgresStoreContext } from './context';
import type { MemoryStore } from '~/ports/memory';
import type * as t from '~/types';
import { formatMemories, memoryPartitionFilter } from '~/methods/memoryRules';
import { postgresStoreIds } from '../storeIds';
import logger from '~/config/winston';

const partitionFilter = memoryPartitionFilter;

/** The error a failed operation rethrows, naming what failed. */
function failure(what: string, error: unknown): Error {
  return new Error(
    `Failed to ${what}: ${error instanceof Error ? error.message : 'Unknown error'}`,
  );
}

const isReservedKey = (key?: string) => key?.toLowerCase() === 'nothing';

export function createPostgresMemoryStore(context: PostgresStoreContext): MemoryStore {
  const entries = () =>
    context.collections().collection<t.IMemoryEntryLean & Record<string, unknown>>('memoryentries');

  async function getUserMemories({
    userId,
    agentId,
  }: Parameters<MemoryStore['getUserMemories']>[0]): Promise<t.IMemoryEntryLean[]> {
    try {
      return await entries().find({ userId, ...partitionFilter(agentId) });
    } catch (error) {
      throw failure('get memories', error);
    }
  }

  const store: MemoryStore = {
    async setMemory({ userId, key, value, tokenCount = 0, agentId }) {
      try {
        if (isReservedKey(key)) {
          return { ok: false };
        }
        await entries().findOneAndUpdate(
          { userId, key, ...partitionFilter(agentId) },
          { value, tokenCount, ...(agentId ? { agentId } : {}), updated_at: new Date() },
          { upsert: true, returnDocument: 'after' },
        );
        return { ok: true };
      } catch (error) {
        throw failure('set memory', error);
      }
    },

    async createMemory({ userId, key, value, tokenCount = 0, agentId }) {
      try {
        if (isReservedKey(key)) {
          return { ok: false };
        }
        /** Insert-only upsert: one round trip decides existence, unlike a find-then-create. */
        const result = await entries().updateOne(
          { userId, key, ...partitionFilter(agentId) },
          {
            $setOnInsert: {
              value,
              tokenCount,
              ...(agentId ? { agentId } : {}),
              updated_at: new Date(),
            },
          },
          { upsert: true },
        );
        if (!result.upsertedCount) {
          throw new Error('Memory with this key already exists');
        }
        return { ok: true };
      } catch (error) {
        throw failure('create memory', error);
      }
    },

    async deleteMemory({ userId, key, agentId }) {
      try {
        const result = await entries().findOneAndDelete({
          userId,
          key,
          ...partitionFilter(agentId),
        });
        return { ok: !!result };
      } catch (error) {
        throw failure('delete memory', error);
      }
    },

    async setMemoryById({ userId, id, key, value, tokenCount = 0, agentId }) {
      try {
        if (!postgresStoreIds.isValid(id) || isReservedKey(key)) {
          return { ok: false };
        }
        const recordFilter = { _id: id, userId, ...partitionFilter(agentId) };
        const existingMemory = await entries().findOne(recordFilter);
        if (!existingMemory) {
          return { ok: false };
        }
        if (key != null && key !== existingMemory.key) {
          const duplicate = await entries().exists({
            userId,
            key,
            ...partitionFilter(agentId),
            _id: { $ne: existingMemory._id },
          });
          if (duplicate) {
            return { ok: false, conflict: true };
          }
        }
        const updatedMemory = await entries().findOneAndUpdate(
          recordFilter,
          { ...(key != null ? { key } : {}), value, tokenCount, updated_at: new Date() },
          { returnDocument: 'after', runValidators: true },
        );
        return updatedMemory ? { ok: true, memory: updatedMemory } : { ok: false };
      } catch (error) {
        throw failure('update memory', error);
      }
    },

    async deleteMemoryById({ userId, id, agentId }) {
      try {
        if (!postgresStoreIds.isValid(id)) {
          return { ok: false };
        }
        const result = await entries().findOneAndDelete({
          _id: id,
          userId,
          ...partitionFilter(agentId),
        });
        return { ok: !!result };
      } catch (error) {
        throw failure('delete memory', error);
      }
    },

    async getAllUserMemories(userId) {
      try {
        return await entries().find({ userId });
      } catch (error) {
        throw failure('get all memories', error);
      }
    },

    getUserMemories,

    async getFormattedMemories({ userId, agentId }) {
      try {
        return formatMemories(await getUserMemories({ userId, agentId }));
      } catch (error) {
        logger.error('Failed to get formatted memories:', error);
        /** A read failure is never presented as an eligible, empty memory partition. */
        return {
          withKeys: undefined,
          withoutKeys: undefined,
          totalTokens: 0,
          tokenCountsByKey: new Map<string, number>(),
          readFailed: true,
        };
      }
    },

    async deleteAllUserMemories(userId) {
      try {
        return (await entries().deleteMany({ userId })).deletedCount;
      } catch (error) {
        throw failure('delete all user memories', error);
      }
    },
  };
  return store;
}
