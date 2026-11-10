import type { Types } from 'mongoose';

/**
 * A conversation tag as the conversation tag methods read it: a plain record, not the mongoose
 * document of `~/schema/conversationTag`. `count` is how many of the user's conversations carry
 * the tag; `position` orders the user's tags.
 */
export interface ConversationTagRecord {
  _id: Types.ObjectId;
  user: string;
  tag: string;
  description?: string;
  position: number;
  count: number;
  createdAt?: Date;
  [key: string]: unknown;
}
