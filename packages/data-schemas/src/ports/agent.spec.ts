import mongoose from 'mongoose';
import type {
  Assert,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { AgentMethods } from '~/methods/agent';
import type { AgentStore } from './agent';
import { createAgentMethods } from '~/methods/agent';
import { AGENT_STORE_METHODS } from './agent';

/**
 * Agent methods left out of the port, each with the reason:
 * - `getAgent`: takes a raw MongoDB filter (`FilterQuery<IAgent>`) and a projection; callers
 *   pass `{ id }` (most), `{ _id, tenantId }`, or `{ id, 'avatar.filepath': { $in } }`.
 * - `getAgentVersions`: takes a raw MongoDB filter; callers pass `{ id }`.
 * - `getAgentWithVersionCount`: takes a raw MongoDB filter, matched in an aggregation; callers
 *   pass `{ id }` or `{ id, tenantId }`.
 * - `getAgents`: takes a raw MongoDB filter and a projection; callers pass `$in`, `$or` and
 *   `$exists` conditions.
 * - `updateAgent`: takes a raw MongoDB filter, and an update that may carry raw `$push`,
 *   `$pull`, `$addToSet` and `$unset` operators.
 * - `deleteAgent`: takes a raw MongoDB filter; callers pass `{ id }` or `{ id, tenantId }`.
 * - `revertAgentVersion`: takes a raw MongoDB filter; callers pass `{ id }`.
 * - `getListAgentsByAccess`: its `otherParams` is a raw MongoDB filter merged into the query
 *   (callers pass `category`, `is_promoted` with `$ne`, `author` and a regex `$or`).
 * - `generateActionMetadataHash`: a pure hashing helper; it reads and writes nothing.
 *
 * The other methods' signatures are copied verbatim, but for ids typed `Types.ObjectId`, which
 * the port states as `IdLike`.
 */
const EXCLUDED = [
  'getAgent',
  'getAgentVersions',
  'getAgentWithVersionCount',
  'getAgents',
  'updateAgent',
  'deleteAgent',
  'revertAgentVersion',
  'getListAgentsByAccess',
  'generateActionMetadataHash',
] as const;
type Excluded = (typeof EXCLUDED)[number];

/** The port methods whose ids the port states as `IdLike`. */
type IdLikeMethods =
  | 'getAgentIdsByMCPServerName'
  | 'getAgentModelSummaries'
  | 'getAgentManagementListByAccess';

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AgentStore, AgentMethods>>,
  Assert<SameSignatures<Omit<AgentStore, IdLikeMethods>, AgentMethods>>,
  Assert<EveryMethodPlaced<AgentStore, AgentMethods, Excluded>>,
  Assert<ExclusionsHold<AgentStore, Excluded>>,
];

describe('AgentStore port', () => {
  const methods = createAgentMethods(mongoose, {
    removeAllPermissions: async () => undefined,
    getActions: async () => [],
    getSoleOwnedResourceIds: async () => [],
    getUserPrincipals: async () => [],
    findAccessibleResources: async () => [],
  });

  it('matches the MongoDB agent methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(AGENT_STORE_METHODS).size).toBe(AGENT_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...AGENT_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB agent methods', () => {
    const store: AgentStore = methods;
    for (const name of AGENT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
