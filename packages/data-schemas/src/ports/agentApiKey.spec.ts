import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { AgentApiKeyMethods } from '~/methods/agentApiKey';
import type { AgentApiKeyStore } from './agentApiKey';
import { createAgentApiKeyMethods } from '~/methods/agentApiKey';
import { AGENT_API_KEY_STORE_METHODS } from './agentApiKey';

/**
 * Agent API key methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for user and key ids typed `Types.ObjectId`, which the port
 * states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AgentApiKeyStore, AgentApiKeyMethods>>,
  Assert<EveryMethodPlaced<AgentApiKeyStore, AgentApiKeyMethods, Excluded>>,
  Assert<ExclusionsHold<AgentApiKeyStore, Excluded>>,
];

describe('AgentApiKeyStore port', () => {
  const methods = createAgentApiKeyMethods(mongoose);

  it('matches the MongoDB agent API key methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(AGENT_API_KEY_STORE_METHODS).size).toBe(AGENT_API_KEY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...AGENT_API_KEY_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB agent API key methods', () => {
    const store: AgentApiKeyStore = methods;
    for (const name of AGENT_API_KEY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});
