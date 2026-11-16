/**
 * The memory store's database-neutral rules (`MemoryStore`, `~/ports/memory`), shared by every
 * backend: the MongoDB methods (`./memory`) and the PostgreSQL store
 * (`adapters/postgres/stores/memory.ts`). Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import type * as t from '~/types';

/**
 * Formats a date in YYYY-MM-DD format
 */
const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

/** Partition filter: `agentId: null` matches both null and missing fields,
 *  so pre-partition entries remain part of the shared personal pool. */
export const memoryPartitionFilter = (agentId?: string): { agentId: string | null } => ({
  agentId: agentId ?? null,
});

/**
 * A partition's memories formatted for the prompt, oldest update first: with their keys and
 * token counts, without them, the total and the count per key. Sorts `memories` in place.
 */
export function formatMemories(memories: t.IMemoryEntryLean[]): t.FormattedMemoriesResult {
  if (!memories || memories.length === 0) {
    return {
      withKeys: '',
      withoutKeys: '',
      totalTokens: 0,
      tokenCountsByKey: new Map<string, number>(),
    };
  }

  const sortedMemories = memories.sort(
    (a, b) => new Date(a.updated_at!).getTime() - new Date(b.updated_at!).getTime(),
  );

  const { totalTokens, tokenCountsByKey } = sortedMemories.reduce(
    (counts, memory) => {
      const tokenCount = memory.tokenCount || 0;
      counts.totalTokens += tokenCount;
      counts.tokenCountsByKey.set(memory.key, tokenCount);
      return counts;
    },
    { totalTokens: 0, tokenCountsByKey: new Map<string, number>() },
  );

  const withKeys = sortedMemories
    .map((memory, index) => {
      const date = formatDate(new Date(memory.updated_at!));
      const tokenInfo = memory.tokenCount ? ` [${memory.tokenCount} tokens]` : '';
      return `${index + 1}. [${date}]. ["key": "${memory.key}"]${tokenInfo}. ["value": "${memory.value}"]`;
    })
    .join('\n\n');

  const withoutKeys = sortedMemories
    .map((memory, index) => {
      const date = formatDate(new Date(memory.updated_at!));
      return `${index + 1}. [${date}]. ${memory.value}`;
    })
    .join('\n\n');

  return { withKeys, withoutKeys, totalTokens, tokenCountsByKey };
}
