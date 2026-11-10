/**
 * A tool call as the tool call methods read and write it: a plain record, not the mongoose
 * document of `~/schema/toolCall`. Fields beyond the ones named are the call's stored result.
 */
export interface ToolCallRecord {
  messageId?: string;
  conversationId?: string;
  user?: string;
  [key: string]: unknown;
}
