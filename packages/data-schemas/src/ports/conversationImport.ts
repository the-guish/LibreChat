/**
 * Conversation import store port: the cleanup that undoes a failed conversation import, removing
 * what the import wrote. Nothing here may import `mongoose`. Signatures are copied verbatim from
 * `ConversationImportMethods` (`~/methods/import`); `conversationImport.spec.ts` fails the
 * typecheck if the two drift.
 *
 * A {@link ConversationImportCleanupScope} names the user, the conversation ids the import wrote
 * and the tenant they were written in (none when `tenantId` is absent). Cleanup removes only the
 * records of that user in that tenant, whatever tenant the caller runs in, and with them the
 * subagent content of those conversations. An empty list of conversation ids removes nothing.
 * Writing the import is not here: the importer writes through the conversation and message
 * methods.
 */
import type { ConversationImportCleanupScope } from '~/types';
import { listPortMethods } from './common';

export interface ConversationImportStore {
  /** Deletes the messages of the scope's conversations. */
  deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void>;
  /**
   * Deletes the scope's conversations and refreshes the stats of the user's chat projects they
   * were in.
   */
  deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void>;
}

/** Every method of {@link ConversationImportStore}, for adapters and conformance checks. */
export const CONVERSATION_IMPORT_STORE_METHODS: ReadonlyArray<keyof ConversationImportStore> =
  listPortMethods<ConversationImportStore>({
    deleteImportedMessages: true,
    deleteImportedConversations: true,
  });
