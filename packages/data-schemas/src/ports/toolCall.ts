/**
 * Tool call store port: the results of tools users run by hand in a conversation. Nothing here
 * may import `mongoose`. Signatures are those of `ToolCallMethods` (`~/methods/toolCall`) with
 * the delete result stated as `DeleteCount` and read records as plain `ToolCallRecord`s;
 * `toolCall.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 */
import type { ToolCallRecord } from '~/types';
import type { DeleteCount } from './common';
import { listPortMethods } from './common';

export interface ToolCallStore {
  /** Stores a tool call; throws an error naming the cause when the write fails. */
  createToolCall(toolCallData: ToolCallRecord): Promise<ToolCallRecord>;
  /** Deletes the user's tool calls, only those of `conversationId` when given. */
  deleteToolCalls(userId: string, conversationId?: string): Promise<DeleteCount>;
  /** The user's tool calls in the conversation, as plain records with their store id. */
  getToolCallsByConvo(conversationId: string, userId: string): Promise<ToolCallRecord[]>;
}

/** Every method of {@link ToolCallStore}, for adapters and conformance checks. */
export const TOOL_CALL_STORE_METHODS: ReadonlyArray<keyof ToolCallStore> =
  listPortMethods<ToolCallStore>({
    createToolCall: true,
    deleteToolCalls: true,
    getToolCallsByConvo: true,
  });
