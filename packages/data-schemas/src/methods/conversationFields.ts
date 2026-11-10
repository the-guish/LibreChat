/**
 * Conversation fields that ordinary writes must never reach, and the helpers that strip them.
 * Database-neutral: shared by the MongoDB conversation methods and `createSaveConvo`.
 */

const ACTOR_CHECKPOINT_FIELDS = [
  'agentEventActor',
  'agentEventActorCleanup',
  'agentEventActorReconciliations',
  'agentEventActorSuspension',
] as const;

/** Written only by the lane methods, so no save, unset or import may reach them. */
export const LANE_PRIVATE_FIELDS = ['laneGit', 'laneGitSeq', 'codeAttachmentEpoch'] as const;

/** Removes each field and every dotted path beneath it, which Mongo reads as a write to the field. */
export function stripFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (fields.some((field) => key === field || key.startsWith(`${field}.`))) {
      delete record[key];
    }
  }
}

export function stripActorCheckpointFields(record: Record<string, unknown>): void {
  stripFields(record, ACTOR_CHECKPOINT_FIELDS);
}
