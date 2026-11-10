/**
 * Tool approval grant store port: remembered tool approvals and the fences that revoke them.
 * Nothing here may import `mongoose`.
 *
 * The port is `ToolApprovalGrantStorage` from `librechat-data-provider`, the database-neutral
 * contract its consumers already program against; `createToolApprovalGrantMethods`
 * (`~/methods/toolApprovalGrant`) returns exactly that type, and `toolApprovalGrant.spec.ts`
 * fails the typecheck if the two drift. The MongoDB adapter also reads the token collection, for
 * the OAuth credential generation a grant is bound to.
 */
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import { listPortMethods } from './common';

export type ToolApprovalGrantStore = ToolApprovalGrantStorage;

/** Every method of {@link ToolApprovalGrantStore}, for adapters and conformance checks. */
export const TOOL_APPROVAL_GRANT_STORE_METHODS: ReadonlyArray<keyof ToolApprovalGrantStore> =
  listPortMethods<ToolApprovalGrantStore>({
    getToolApprovalGrants: true,
    rememberToolApprovalGrants: true,
    resetToolApprovalGrants: true,
  });
