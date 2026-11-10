import mongoose from 'mongoose';
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ToolApprovalGrantStore } from './toolApprovalGrant';
import { createToolApprovalGrantMethods } from '~/methods/toolApprovalGrant';
import { TOOL_APPROVAL_GRANT_STORE_METHODS } from './toolApprovalGrant';

/**
 * Tool approval grant methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ToolApprovalGrantStore, ToolApprovalGrantStorage>>,
  Assert<EveryMethodPlaced<ToolApprovalGrantStore, ToolApprovalGrantStorage, Excluded>>,
  Assert<ExclusionsHold<ToolApprovalGrantStore, Excluded>>,
];

describe('ToolApprovalGrantStore port', () => {
  const methods = createToolApprovalGrantMethods(mongoose);

  it('matches the MongoDB tool approval grant methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TOOL_APPROVAL_GRANT_STORE_METHODS).size).toBe(
      TOOL_APPROVAL_GRANT_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...TOOL_APPROVAL_GRANT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB tool approval grant methods', () => {
    const store: ToolApprovalGrantStore = methods;
    for (const name of TOOL_APPROVAL_GRANT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
