import mongoose from 'mongoose';
import type { Assert, Equals, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { MCPAuthorityResolveInput, MCPAuthorityAssertInput } from '~/types';
import type { MCPAuthorityMethods } from '~/methods/mcpAuthority';
import type { MCPAuthorityStore } from './mcpAuthority';
import { createMCPAuthorityMethods } from '~/methods/mcpAuthority';
import { MCP_AUTHORITY_STORE_METHODS } from './mcpAuthority';

/**
 * MCP authority methods left out of the port: none. Both signatures are copied verbatim but
 * for the optional `session` key of their inputs, which no caller outside tests passes. The
 * module's error class (`MCPAuthorityProofError`) and revision helpers are not part of the
 * methods object.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<MCPAuthorityStore, MCPAuthorityMethods>>,
  Assert<
    Equals<
      Parameters<MCPAuthorityStore['resolveMCPAuthorityProof']>[0],
      Omit<MCPAuthorityResolveInput, 'session'>
    >
  >,
  Assert<
    Equals<
      Parameters<MCPAuthorityStore['assertMCPAuthorityProofsCurrent']>[0],
      Omit<MCPAuthorityAssertInput, 'session'>
    >
  >,
  Assert<EveryMethodPlaced<MCPAuthorityStore, MCPAuthorityMethods, Excluded>>,
  Assert<ExclusionsHold<MCPAuthorityStore, Excluded>>,
];

describe('MCPAuthorityStore port', () => {
  const methods = createMCPAuthorityMethods(mongoose);

  it('matches the MongoDB MCP authority methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(MCP_AUTHORITY_STORE_METHODS).size).toBe(MCP_AUTHORITY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...MCP_AUTHORITY_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB MCP authority methods', () => {
    const store: MCPAuthorityStore = methods;
    for (const name of MCP_AUTHORITY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
