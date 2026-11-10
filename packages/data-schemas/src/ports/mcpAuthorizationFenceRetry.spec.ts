import mongoose from 'mongoose';
import type { MCPAuthorizationFenceRetryStorage } from '~/methods/mcpAuthorizationFenceRetry';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { MCPAuthorizationFenceRetryStore } from './mcpAuthorizationFenceRetry';
import { createMCPAuthorizationFenceRetryStorage } from '~/methods/mcpAuthorizationFenceRetry';
import { MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS } from './mcpAuthorizationFenceRetry';

/**
 * MCP authorization fence retry methods left out of the port, each with the reason: none. Every
 * method's signature is database-neutral; `list` returns the stored records, which carry their
 * id and creation time besides the fields the port states, so the check is `Satisfies`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<MCPAuthorizationFenceRetryStore, MCPAuthorizationFenceRetryStorage>>,
  Assert<
    EveryMethodPlaced<MCPAuthorizationFenceRetryStore, MCPAuthorizationFenceRetryStorage, Excluded>
  >,
  Assert<ExclusionsHold<MCPAuthorizationFenceRetryStore, Excluded>>,
];

describe('MCPAuthorizationFenceRetryStore port', () => {
  const methods = createMCPAuthorizationFenceRetryStorage(mongoose);

  it('matches the MongoDB fence retry storage at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS).size).toBe(
      MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB fence retry storage', () => {
    const store: MCPAuthorizationFenceRetryStore = methods;
    for (const name of MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
