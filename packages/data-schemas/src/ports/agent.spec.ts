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
 * - `generateActionMetadataHash`: a pure hashing helper; it reads and writes nothing.
 *
 * The other methods' signatures are copied verbatim, but for ids typed `Types.ObjectId`, which
 * the port states as `IdLike`, and for `getAgent`, `getAgents`, `getAgentVersions`,
 * `getAgentWithVersionCount`, `updateAgent`, `deleteAgent`, `revertAgentVersion` and
 * `getListAgentsByAccess`, whose criteria, projections and updates the port states in the store
 * query language.
 */
const EXCLUDED = ['generateActionMetadataHash'] as const;
type Excluded = (typeof EXCLUDED)[number];

/** The port methods whose ids the port states as `IdLike`. */
type IdLikeMethods =
  | 'getAgentIdsByMCPServerName'
  | 'getAgentModelSummaries'
  | 'getAgentManagementListByAccess';

/** The port methods stated in the store query language (`./query`). */
type QueryMethods =
  | 'getAgent'
  | 'getAgents'
  | 'getAgentVersions'
  | 'getAgentWithVersionCount'
  | 'updateAgent'
  | 'deleteAgent'
  | 'revertAgentVersion'
  | 'getListAgentsByAccess';

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AgentStore, AgentMethods>>,
  Assert<SameSignatures<Omit<AgentStore, IdLikeMethods | QueryMethods>, AgentMethods>>,
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
