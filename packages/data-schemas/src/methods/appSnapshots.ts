import mongoose from 'mongoose';
import type { Resource } from './appSnapshotRules';
import { fitBoundAppSnapshotsBy, MAX_MCP_APP_MESSAGE_BSON_BYTES } from './appSnapshotRules';

/** Moved to the shared rules (`./appSnapshotRules`); re-exported here unchanged. */
export { hasBoundAppSnapshots, MAX_MCP_APP_MESSAGE_BSON_BYTES } from './appSnapshotRules';

/** The BSON size of one resource as the field of a document, which estimates its saving. */
const measureResource = (resource: Resource): number =>
  mongoose.mongo.BSON.calculateObjectSize({ resource });

/**
 * Called only for messages containing a bound App. The caller supplies BSON size of the ENTIRE
 * candidate document, not just its attachments. Work on copies, so a later full-row save with the
 * original in-memory attachments cannot sneak an oversized document back into storage.
 *
 * Estimates are used only to pick the largest documents to drop first. The final BSON calculation
 * is exact; if the candidate still exceeds the budget we omit all optional Apps or fail explicitly
 * when the canonical message / non-App attachments alone are too large.
 */
export function fitBoundAppSnapshots(
  attachments: unknown[],
  bsonSize: (attachments: unknown[]) => number,
  maxBytes: number = MAX_MCP_APP_MESSAGE_BSON_BYTES,
): unknown[] {
  return fitBoundAppSnapshotsBy(attachments, bsonSize, measureResource, maxBytes);
}
