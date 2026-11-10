import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { MCPServerMethods } from '~/methods/mcpServer';
import type { MCPServerStore } from './mcpServer';
import { createMCPServerMethods } from '~/methods/mcpServer';
import { MCP_SERVER_STORE_METHODS } from './mcpServer';

/**
 * MCP server methods left out of the port, each with the reason:
 * - `getListMCPServersByIds`: its `otherParams` is a raw MongoDB filter (`RootFilterQuery`), and
 *   its `ids` are typed `Types.ObjectId[]`.
 *
 * The other methods' signatures are database-neutral but for ids typed `Types.ObjectId`, which
 * the port states as `IdLike`.
 */
const EXCLUDED = ['getListMCPServersByIds'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<MCPServerStore, MCPServerMethods>>,
  Assert<EveryMethodPlaced<MCPServerStore, MCPServerMethods, Excluded>>,
  Assert<ExclusionsHold<MCPServerStore, Excluded>>,
];

describe('MCPServerStore port', () => {
  const methods = createMCPServerMethods(mongoose, {
    getSoleOwnedResourceIds: async () => [],
  });

  it('matches the MongoDB MCP server methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(MCP_SERVER_STORE_METHODS).size).toBe(MCP_SERVER_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...MCP_SERVER_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB MCP server methods', () => {
    const store: MCPServerStore = methods;
    for (const name of MCP_SERVER_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
