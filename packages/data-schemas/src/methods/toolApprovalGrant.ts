import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { StoredGrant, StoredGrantToken } from './toolApprovalGrantRules';
import {
  GRANT_FIELDS,
  GRANT_TOKEN_FIELDS,
  createToolApprovalGrantStorage,
} from './toolApprovalGrantRules';

/** The grant rules (`./toolApprovalGrantRules`) on the `ToolApprovalGrant` and `Token` models. */
export function createToolApprovalGrantMethods(
  mongoose: typeof import('mongoose'),
): ToolApprovalGrantStorage {
  return createToolApprovalGrantStorage({
    findGrants: (filter) =>
      mongoose.models.ToolApprovalGrant.find(filter).select(GRANT_FIELDS).lean<StoredGrant[]>(),
    findTokens: (filter) =>
      mongoose.models.Token.find(filter)
        .select(GRANT_TOKEN_FIELDS)
        .lean<StoredGrantToken[]>({ flattenMaps: true }),
    updateGrant: (filter, update, options) =>
      mongoose.models.ToolApprovalGrant.updateOne(filter, update, {
        ...(options.upsert ? { upsert: true } : {}),
        runValidators: true,
      }),
    isDuplicateKey: (error) =>
      error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 11000,
  });
}
