import type { ConversationMethods } from '~/methods/conversation';
import type { ConversationStore } from '~/ports/conversation';
import { CONVERSATION_STORE_METHODS } from '~/ports/conversation';

/**
 * MongoDB adapter for {@link ConversationStore}.
 *
 * Hands out the functions of an existing `ConversationMethods` instance rather than building a
 * new one: the methods share per-instance state (and `saveConvo` and `deleteConvos`, which are
 * not in the port, must keep working through the same instance the port reads through).
 */
export function createMongoConversationStore(methods: ConversationMethods): ConversationStore {
  const store: Partial<Record<keyof ConversationStore, unknown>> = {};
  for (const name of CONVERSATION_STORE_METHODS) {
    store[name] = methods[name];
  }
  return store as ConversationStore;
}
