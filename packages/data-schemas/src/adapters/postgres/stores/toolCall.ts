/**
 * The PostgreSQL `ToolCallStore` (`~/ports/toolCall`) on the `toolcalls` table, through the
 * collection primitive. Must not import `mongoose`, `mongodb` or `bson`. Errors carry the same
 * messages as on MongoDB.
 */
import type { ToolCallStore } from '~/ports/toolCall';
import type { PostgresStoreContext } from './context';
import type { ToolCallRecord } from '~/types';
import { asRecord } from './context';

const messageOf = (error: unknown) => (error as Error).message;

export function createPostgresToolCallStore(context: PostgresStoreContext): ToolCallStore {
  const toolCalls = () =>
    context.collections().collection<ToolCallRecord & Record<string, unknown>>('toolcalls');
  const store: ToolCallStore = {
    async createToolCall(toolCallData) {
      try {
        return await toolCalls().insertOne(asRecord(toolCallData));
      } catch (error) {
        throw new Error(`Error creating tool call: ${messageOf(error)}`);
      }
    },

    async getToolCallsByConvo(conversationId, userId) {
      try {
        return await toolCalls().find({ conversationId, user: userId });
      } catch (error) {
        throw new Error(`Error fetching tool calls: ${messageOf(error)}`);
      }
    },

    async deleteToolCalls(userId, conversationId) {
      try {
        const query: Record<string, string> = { user: userId };
        if (conversationId) {
          query.conversationId = conversationId;
        }
        return await toolCalls().deleteMany(query);
      } catch (error) {
        throw new Error(`Error deleting tool call: ${messageOf(error)}`);
      }
    },
  };
  return store;
}
