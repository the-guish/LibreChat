/**
 * The database-neutral rules of the conversation import cleanup, shared by the MongoDB methods
 * (`./import`) and the PostgreSQL store: the scope's filter (the user, the listed conversations,
 * the tenant they were written in or none) and the chunks the conversation ids are deleted in.
 * Nothing here may import `mongoose` or touch a model.
 */
import type { ConversationImportCleanupScope } from '~/types';

/** Keeps generated UUID arrays well below MongoDB's 16 MiB command limit. */
export const CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE = 10_000;

/** The records of the scope's user among `conversationIds`, in the scope's tenant (or none). */
export function createImportCleanupFilter(
  scope: ConversationImportCleanupScope,
  conversationIds: readonly string[],
): Record<string, unknown> {
  return {
    user: scope.user,
    conversationId: { $in: conversationIds },
    ...(scope.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: scope.tenantId }),
  };
}

/** The conversation ids in chunks of {@link CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE}. */
export function chunkConversationIds(conversationIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < conversationIds.length;
    index += CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE
  ) {
    chunks.push(conversationIds.slice(index, index + CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE));
  }
  return chunks;
}
