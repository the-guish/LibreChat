import mongoose from 'mongoose';
import { createConversationMethods } from '~/methods/conversation';
import { createMongoConversationStore } from './conversationStore';
import { CONVERSATION_STORE_METHODS } from '~/ports/conversation';

describe('createMongoConversationStore', () => {
  const methods = createConversationMethods(mongoose);
  const store = createMongoConversationStore(methods);

  it('exposes exactly the port methods', () => {
    expect(Object.keys(store).sort()).toEqual([...CONVERSATION_STORE_METHODS].sort());
  });

  it('hands out the same functions as the methods instance it wraps', () => {
    for (const name of CONVERSATION_STORE_METHODS) {
      expect(store[name]).toBe(methods[name]);
    }
  });

  it('leaves the methods outside the port on the methods instance', () => {
    for (const name of ['saveConvo', 'deleteConvos', 'bulkSaveConvos', 'searchConversation']) {
      expect(store).not.toHaveProperty(name);
      expect(typeof methods[name as keyof typeof methods]).toBe('function');
    }
  });
});
