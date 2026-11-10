/** The subagent run whose content a record belongs to: its owner, its thread and its task. */
export type SubagentContentScope = {
  user: string;
  tenantId?: string;
  parentConversationId: string;
  conversationId: string;
  taskId: string;
};

/** The latest committed batch of a subagent run: its revision and the last event sequence. */
export type SubagentContentHead = { revision: number; throughSequence: number };

/** One committed batch of a subagent run's events, `fromSequence` to `throughSequence`. */
export type SubagentContentBatch = SubagentContentHead & {
  fromSequence: number;
  eventsJson: string;
};

/** Whether the run can still take content; `SUBAGENT_CONTENT_GONE` once its thread is gone. */
export type SubagentContentAppendResult =
  | { ok: true }
  | { ok: false; error: { code: 'SUBAGENT_CONTENT_GONE' } };
