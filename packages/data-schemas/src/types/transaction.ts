import type { Types } from 'mongoose';

export interface TransactionData {
  user: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
}

/** Input data for creating a transaction */
export interface TxData {
  user: string | Types.ObjectId;
  conversationId?: string;
  model?: string;
  context?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  rawAmount?: number;
  valueKey?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  inputTokens?: number;
  writeTokens?: number;
  /** Subset of `writeTokens` written to the 1-hour cache */
  write1hTokens?: number;
  readTokens?: number;
  balance?: { enabled?: boolean };
  transactions?: { enabled?: boolean };
}

/** Base transaction context passed by callers — does not include fields added internally */
export interface SpendTxData {
  user: string | Types.ObjectId;
  conversationId?: string;
  model?: string;
  context?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  balance?: { enabled?: boolean };
  transactions?: { enabled?: boolean };
  valueKey?: string;
}

/** Return value from a successful transaction that also updates the balance */
export interface TransactionResult {
  rate: number;
  user: string;
  balance: number;
  prompt?: number;
  completion?: number;
  credits?: number;
}
