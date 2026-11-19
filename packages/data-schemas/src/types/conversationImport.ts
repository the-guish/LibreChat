/** The conversations (and their messages) one import wrote for a user, to remove on failure. */
export interface ConversationImportCleanupScope {
  user: string;
  conversationIds: readonly string[];
  tenantId?: string;
}
