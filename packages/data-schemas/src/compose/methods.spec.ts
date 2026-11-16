import mongoose from 'mongoose';
import type {
  DataModules,
  DataMethods,
  DataMethodsBackend,
  DataModuleFactories,
  ComposedDataMethods,
} from './types';
import type { MongoDataStoreBackend } from '~/adapters/mongo/backend';
import type { MongoDataModules } from '~/adapters/mongo/factories';
import type { AllMethods, CreateMethodsDeps } from '~/methods';
import type { Assert } from '~/ports/conformance';
import type { DataStore } from '~/ports';
import { createMongoDataModuleFactories } from '~/adapters/mongo/factories';
import { mongoStoreIds } from '~/adapters/mongo/storeIds';
import { composeDataMethods } from './methods';
import { DATA_STORE_METHODS } from '~/ports';
import { createMethods } from '~/methods';

/*
 * Type-level checks: the MongoDB modules are at least what the composition root needs, what it
 * composes from them is `AllMethods`, every backend's composition is `DataMethods`, and the
 * MongoDB backend is a `DataMethodsBackend`.
 */
type Assignable<From, To> = [From] extends [To] ? true : false;
type Checks = [
  Assert<Assignable<MongoDataModules, DataModules>>,
  Assert<Assignable<ComposedDataMethods<MongoDataModules>, AllMethods>>,
  Assert<Assignable<AllMethods, DataMethods>>,
  Assert<Assignable<MongoDataStoreBackend, DataMethodsBackend>>,
  Assert<Assignable<ComposedDataMethods<DataModules>, DataMethods>>,
];

type Factories = DataModuleFactories<MongoDataModules>;
type ModuleName = Exclude<keyof Factories, 'ids'>;
type Instance = Record<string, unknown>;
type Factory = (deps?: unknown) => Instance;

/** The documented build order (`composeDataMethods`). */
const BUILD_ORDER: ModuleName[] = [
  'tx',
  'tokenTransactions',
  'tokenSpending',
  'messages',
  'agentQueuedTurns',
  'agentTriggerDeliveries',
  'conversations',
  'aclEntries',
  'systemGrants',
  'roles',
  'userGroups',
  'prompts',
  'skills',
  'actions',
  'agents',
  'toolApprovalGrants',
  'tokenLists',
  'openidRefreshFlights',
  'resourceLocks',
  'userKeys',
  'toolFavorites',
  'agentCategories',
  'banners',
  'categories',
  'scheduleConsents',
  'principals',
  'sessions',
  'tokens',
  'refreshTokenBridges',
  'passkeys',
  'presets',
  'toolCalls',
  'assistants',
  'pluginAuths',
  'memories',
  'fileStorage',
  'users',
  'accessRoles',
  'agentApiKeys',
  'mcpServers',
  'configOverrides',
  'auditLogs',
  'codeEnvironments',
  'chatProjects',
  'conversationTags',
  'insights',
  'skillSync',
  'skillLifecycle',
  'subagentContent',
  'conversationImports',
  'sharedLinks',
  'files',
  'schedules',
  'mcpAuthorities',
  'mcpAuthorizationFenceRetries',
  'browserSetup',
  'transactions',
];

/** The order the instances are spread into the flat methods (a later one wins a shared name). */
const SPREAD_ORDER: ModuleName[] = [
  'users',
  'toolApprovalGrants',
  'sessions',
  'tokens',
  'tokenLists',
  'refreshTokenBridges',
  'openidRefreshFlights',
  'resourceLocks',
  'subagentContent',
  'passkeys',
  'roles',
  'userKeys',
  'files',
  'fileStorage',
  'memories',
  'toolFavorites',
  'agentCategories',
  'agentApiKeys',
  'mcpServers',
  'codeEnvironments',
  'accessRoles',
  'userGroups',
  'aclEntries',
  'systemGrants',
  'auditLogs',
  'sharedLinks',
  'pluginAuths',
  'actions',
  'assistants',
  'banners',
  'toolCalls',
  'categories',
  'presets',
  'conversationTags',
  'conversationImports',
  'messages',
  'conversations',
  'chatProjects',
  'tx',
  'tokenTransactions',
  'tokenSpending',
  'prompts',
  'skills',
  'skillSync',
  'skillLifecycle',
  'agentTriggerDeliveries',
  'agentQueuedTurns',
  'schedules',
  'scheduleConsents',
  'agents',
  'configOverrides',
  'principals',
  'mcpAuthorities',
  'insights',
  'mcpAuthorizationFenceRetries',
  'browserSetup',
  'transactions',
];

/** Flat members that belong to no store. */
const NON_STORE_KEYS = [
  // pure helpers
  'tokenValues',
  'premiumTokenValues',
  'getValueKey',
  'getMultiplier',
  'getPremiumRate',
  'getCacheMultiplier',
  'defaultRate',
  'cacheTokenValues',
  'generateActionMetadataHash',
  'calculateRelevanceScore',
  'sortPrincipalsByRelevance',
  'SessionError',
  // domain functions on the conversation store's steps
  'saveConvo',
  'bulkSaveConvos',
  'deleteConvos',
  'searchConversation',
  // MongoDB-only reads, outside the ports
  'aggregateAclEntries',
  'getMessagesByCursor',
  'searchMessages',
  // the ports
  'stores',
  'conversations',
];

interface Recorded {
  factories: Factories;
  order: ModuleName[];
  deps: Partial<Record<ModuleName, Record<string, unknown>>>;
  instances: Partial<Record<ModuleName, Instance>>;
}

/**
 * The MongoDB factories, each wrapped to record its call, its dependencies and its instance;
 * `overrides` replace members of an instance after it is built.
 */
function record(
  overrides: Partial<Record<ModuleName, (instance: Instance) => Instance>> = {},
  ids = mongoStoreIds,
): Recorded {
  const base = createMongoDataModuleFactories(mongoose);
  const recorded: Recorded = { factories: { ...base, ids }, order: [], deps: {}, instances: {} };
  const wrapped = recorded.factories as unknown as Record<string, Factory>;
  for (const name of Object.keys(base) as Array<keyof Factories>) {
    if (name === 'ids') {
      continue;
    }
    const build = base[name] as unknown as Factory;
    wrapped[name] = (deps?: unknown) => {
      const built = build(deps);
      const instance = overrides[name]?.(built) ?? built;
      recorded.order.push(name);
      recorded.deps[name] = deps as Record<string, unknown>;
      recorded.instances[name] = instance;
      return instance;
    };
  }
  return recorded;
}

const flat = (methods: unknown): Record<string, unknown> => methods as Record<string, unknown>;
const storeNames = Object.keys(DATA_STORE_METHODS) as Array<keyof DataStore>;

describe('composeDataMethods', () => {
  it('fits the neutral types at the type level', () => {
    const typeChecks: Checks = [true, true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true, true]);
  });

  describe('with the MongoDB factories', () => {
    const recorded = record();
    const methods = flat(composeDataMethods(recorded.factories));
    const instance = (name: ModuleName): Instance => recorded.instances[name] as Instance;

    it('builds every module once, in the documented order', () => {
      expect(recorded.order).toEqual(BUILD_ORDER);
      expect([...SPREAD_ORDER].sort()).toEqual([...BUILD_ORDER].sort());
    });

    it('returns the same key set as createMethods: every store method and the non-store members', () => {
      const keys = Object.keys(methods);
      expect(keys).toEqual(Object.keys(createMethods(mongoose)));
      const storeMethodNames = storeNames.flatMap(
        (storeName) => DATA_STORE_METHODS[storeName] as ReadonlyArray<string>,
      );
      expect(new Set(storeMethodNames).size).toBe(storeMethodNames.length);
      expect(keys.filter((key) => !storeMethodNames.includes(key)).sort()).toEqual(
        [...NON_STORE_KEYS].sort(),
      );
      expect(keys).toHaveLength(storeMethodNames.length + NON_STORE_KEYS.length);
      expect(storeNames).toHaveLength(56);
      expect(storeMethodNames).toHaveLength(713);
      expect(keys).toHaveLength(734);
    });

    it('spreads the instances in order: each flat member is the last instance’s of its name', () => {
      for (const key of Object.keys(methods)) {
        if (key === 'stores' || key === 'conversations') {
          continue;
        }
        const owner = [...SPREAD_ORDER].reverse().find((name) => key in instance(name));
        expect(owner).toBeDefined();
        expect(methods[key]).toBe(instance(owner as ModuleName)[key]);
      }
    });

    it('serves each store from the instance its factory built, with the flat functions', () => {
      const stores = methods.stores as Record<string, Record<string, unknown>>;
      expect(Object.keys(stores).sort()).toEqual([...storeNames].sort());
      for (const storeName of storeNames) {
        const names = DATA_STORE_METHODS[storeName] as ReadonlyArray<string>;
        expect(Object.keys(stores[storeName]).sort()).toEqual([...names].sort());
        for (const name of names) {
          expect(stores[storeName][name]).toBe(instance(storeName)[name]);
          expect(stores[storeName][name]).toBe(methods[name]);
        }
      }
      expect(methods.conversations).toBe(stores.conversations);
    });

    it('builds each module with the functions of the modules it depends on', () => {
      const { deps } = recorded;
      expect(deps.tokenTransactions).toEqual({
        getMultiplier: instance('tx').getMultiplier,
        getCacheMultiplier: instance('tx').getCacheMultiplier,
      });
      expect(deps.tokenSpending).toEqual({
        createTransaction: instance('tokenTransactions').createTransaction,
        createStructuredTransaction: instance('tokenTransactions').createStructuredTransaction,
      });
      expect(deps.agentTriggerDeliveries?.releaseBatchProjections).toBe(
        instance('messages').releaseBackgroundToolResultClaims,
      );
      expect(deps.conversations).toMatchObject({
        getMessages: instance('messages').getMessages,
        deleteMessages: instance('messages').deleteMessages,
        searchMessages: instance('messages').searchMessages,
        eraseAgentTriggerDeliveryConversationResults:
          instance('agentTriggerDeliveries').eraseAgentTriggerDeliveryConversationResults,
        prepareAgentTriggerConversationResultErasure:
          instance('agentTriggerDeliveries').prepareAgentTriggerConversationResultErasure,
      });
      const acl = instance('aclEntries');
      const principals = instance('userGroups').getUserPrincipals;
      expect(deps.prompts).toMatchObject({
        getSoleOwnedResourceIds: acl.getSoleOwnedResourceIds,
        getUserPrincipals: principals,
        findAccessibleResources: acl.findAccessibleResources,
        findPublicResourceIds: acl.findPublicResourceIds,
      });
      expect(deps.skills?.getSoleOwnedResourceIds).toBe(acl.getSoleOwnedResourceIds);
      expect(deps.agents).toMatchObject({
        getActions: instance('actions').getActions,
        getSoleOwnedResourceIds: acl.getSoleOwnedResourceIds,
        getUserPrincipals: principals,
        findAccessibleResources: acl.findAccessibleResources,
      });
      expect(deps.mcpServers).toEqual({ getSoleOwnedResourceIds: acl.getSoleOwnedResourceIds });
      expect(deps.browserSetup?.codeEnvironments).toBe(instance('codeEnvironments'));
      expect(deps.prompts?.removeAllPermissions).toBe(deps.skills?.removeAllPermissions);
      expect(deps.agents?.removeAllPermissions).toBe(deps.skills?.removeAllPermissions);
    });

    it('builds a new instance of every module on each call', () => {
      const again = flat(composeDataMethods(createMongoDataModuleFactories(mongoose)));
      const shared = Object.keys(methods).filter(
        (key) => typeof methods[key] === 'function' && methods[key] === again[key],
      );
      /** Module-level functions the instances hand out as they are. */
      expect(shared.sort()).toEqual([
        'SessionError',
        'generateActionMetadataHash',
        'runAfterCommit',
      ]);
    });
  });

  describe('dependencies from the api layer', () => {
    it('passes them to the modules that take them, with defaults for tx', () => {
      const deps: CreateMethodsDeps = {
        matchModelName: jest.fn(),
        findMatchingPattern: jest.fn(),
        removeAllPermissions: jest.fn(),
        getCache: jest.fn(),
        getMCPAppMessageBudget: jest.fn(),
        isExternalSkillId: jest.fn(),
      };
      const recorded = record();
      composeDataMethods(recorded.factories, deps);
      expect(recorded.deps.tx).toEqual({
        matchModelName: deps.matchModelName,
        findMatchingPattern: deps.findMatchingPattern,
      });
      expect(recorded.deps.messages).toEqual({
        getMCPAppMessageBudget: deps.getMCPAppMessageBudget,
      });
      expect(recorded.deps.roles).toEqual({ getCache: deps.getCache });
      expect(recorded.deps.users).toEqual({ getCache: deps.getCache });
      expect(recorded.deps.userGroups?.getCache).toBe(deps.getCache);
      expect(recorded.deps.prompts?.getCache).toBe(deps.getCache);
      expect(recorded.deps.agents).toMatchObject({
        removeAllPermissions: deps.removeAllPermissions,
        isExternalSkillId: deps.isExternalSkillId,
        getCache: deps.getCache,
      });
      expect(recorded.deps.prompts?.removeAllPermissions).toBe(deps.removeAllPermissions);
      expect(recorded.deps.skills?.removeAllPermissions).toBe(deps.removeAllPermissions);

      const defaults = record();
      composeDataMethods(defaults.factories);
      const txDeps = defaults.deps.tx as {
        matchModelName: (model: string) => unknown;
        findMatchingPattern: (model: string, values: object) => unknown;
      };
      expect(txDeps.matchModelName('gpt-4o')).toBeUndefined();
      expect(txDeps.findMatchingPattern('gpt-4o', {})).toBeUndefined();
    });

    it('removes a resource’s ACL entries through the ACL module by default', async () => {
      const deleteAclEntries = jest.fn(async () => ({ deletedCount: 0 }));
      const recorded = record({ aclEntries: (acl) => ({ ...acl, deleteAclEntries }) });
      composeDataMethods(recorded.factories);
      const removeAllPermissions = recorded.deps.prompts?.removeAllPermissions as (params: {
        resourceType: string;
        resourceId: unknown;
      }) => Promise<void>;
      await expect(
        removeAllPermissions({ resourceType: 'prompt', resourceId: 'abc' }),
      ).resolves.toBeUndefined();
      expect(deleteAclEntries).toHaveBeenCalledWith({ resourceType: 'prompt', resourceId: 'abc' });
    });
  });

  describe('late binding', () => {
    it('invalidates the prompt access caches when group memberships are invalidated', async () => {
      const invalidatePromptGroupAccessContext = jest.fn(async () => undefined);
      const recorded = record({
        prompts: (prompts) => ({ ...prompts, invalidatePromptGroupAccessContext }),
      });
      composeDataMethods(recorded.factories);
      const { onMemberGroupsInvalidated } = recorded.deps.userGroups as {
        onMemberGroupsInvalidated: () => Promise<void> | undefined;
      };
      await onMemberGroupsInvalidated();
      expect(invalidatePromptGroupAccessContext).toHaveBeenCalledTimes(1);
    });
  });

  describe('queued-turn wiring', () => {
    const userId = '64b7f0c2a1b2c3d4e5f60718';

    function queuedTurnHarness(
      options: { retired: boolean[]; delivery?: unknown } = { retired: [] },
    ) {
      const queuedTurns = {
        deleteAllAgentQueuedTurnsForUser: jest.fn(async () => 2),
        prepareAgentQueuedTurnConversationDeletion: jest.fn(async () => ['delivery-1']),
        beginAgentQueuedTurnMissingDeliveryRetirement: jest.fn(async () => true),
        markAgentQueuedTurnMissingDeliveryRetired: jest.fn(async () => true),
        markAgentQueuedTurnDeliveryRetired: jest.fn(async () => true),
        deletePreparedAgentQueuedTurnConversations: jest.fn(async () => 1),
      };
      const retired = [...options.retired];
      const deliveries = {
        retireAgentTriggerDelivery: jest.fn(async () => retired.shift() ?? false),
        getAgentTriggerDelivery: jest.fn(async () => options.delivery ?? null),
      };
      const ids = {
        ...mongoStoreIds,
        isValid: jest.fn(mongoStoreIds.isValid),
        toStoreId: jest.fn(mongoStoreIds.toStoreId),
      };
      const recorded = record(
        {
          agentQueuedTurns: (instance) => ({ ...instance, ...queuedTurns }),
          agentTriggerDeliveries: (instance) => ({ ...instance, ...deliveries }),
        },
        ids,
      );
      composeDataMethods(recorded.factories);
      const conversationDeps = recorded.deps.conversations as {
        deleteAgentQueuedTurns: (
          user: unknown,
          conversations: Array<{ conversationId: string }>,
        ) => Promise<void>;
      };
      const deliveryDeps = recorded.deps.agentTriggerDeliveries as {
        purgeQueuedTurnsForUser: (user: unknown) => Promise<unknown>;
      };
      return { queuedTurns, deliveries, ids, conversationDeps, deliveryDeps };
    }

    it('purges an owner’s queued turns, casting a string owner with the backend’s ids', async () => {
      const { queuedTurns, ids, deliveryDeps } = queuedTurnHarness();
      await expect(deliveryDeps.purgeQueuedTurnsForUser(userId)).resolves.toBe(2);
      expect(ids.toStoreId).toHaveBeenCalledWith(userId);
      const [[input]] = queuedTurns.deleteAllAgentQueuedTurnsForUser.mock.calls as unknown as [
        [{ user: mongoose.Types.ObjectId }],
      ];
      expect(input.user).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(input.user.toString()).toBe(userId);

      const owner = new mongoose.Types.ObjectId(userId);
      await deliveryDeps.purgeQueuedTurnsForUser(owner);
      expect(queuedTurns.deleteAllAgentQueuedTurnsForUser).toHaveBeenLastCalledWith({
        user: owner,
      });
    });

    it('skips owners that are not store ids', async () => {
      const { queuedTurns, conversationDeps } = queuedTurnHarness();
      for (const user of ['synthetic-owner', 'abcdefghijkl', `${userId}0`]) {
        await conversationDeps.deleteAgentQueuedTurns(user, [{ conversationId: 'c1' }]);
      }
      expect(queuedTurns.prepareAgentQueuedTurnConversationDeletion).not.toHaveBeenCalled();
      expect(queuedTurns.deletePreparedAgentQueuedTurnConversations).not.toHaveBeenCalled();
    });

    it('retires each prepared delivery, then deletes the prepared turns', async () => {
      const { queuedTurns, deliveries, ids, conversationDeps } = queuedTurnHarness({
        retired: [true],
      });
      const targets = [{ conversationId: 'c1' }];
      await conversationDeps.deleteAgentQueuedTurns(userId.toUpperCase(), targets);
      expect(ids.toStoreId).toHaveBeenCalledWith(userId.toUpperCase());
      const [[prepared]] = queuedTurns.prepareAgentQueuedTurnConversationDeletion.mock
        .calls as unknown as [
        [{ user: mongoose.Types.ObjectId; targets: unknown; settledAt: Date }],
      ];
      expect(prepared.user.toString()).toBe(userId);
      expect(prepared.targets).toBe(targets);
      expect(deliveries.retireAgentTriggerDelivery).toHaveBeenCalledTimes(1);
      expect(deliveries.retireAgentTriggerDelivery).toHaveBeenCalledWith({
        deliveryKey: 'delivery-1',
        sourceId: 'agent-queued-turn',
        reason: 'queued_turn_conversation_deleted',
        settledAt: prepared.settledAt,
        allowSucceeded: true,
      });
      expect(queuedTurns.markAgentQueuedTurnDeliveryRetired).toHaveBeenCalledWith({
        deliveryKey: 'delivery-1',
      });
      expect(queuedTurns.deletePreparedAgentQueuedTurnConversations).toHaveBeenCalledWith({
        user: prepared.user,
        targets,
      });
    });

    it('retires a dead delivery, then a missing one, before marking the turn retired', async () => {
      const dead = queuedTurnHarness({ retired: [false, true] });
      await dead.conversationDeps.deleteAgentQueuedTurns(userId, [{ conversationId: 'c1' }]);
      expect(dead.deliveries.retireAgentTriggerDelivery).toHaveBeenLastCalledWith(
        expect.objectContaining({ deliveryKey: 'delivery-1', onlyIfDead: true }),
      );
      expect(dead.queuedTurns.beginAgentQueuedTurnMissingDeliveryRetirement).not.toHaveBeenCalled();
      expect(dead.queuedTurns.markAgentQueuedTurnDeliveryRetired).toHaveBeenCalledTimes(1);

      const missing = queuedTurnHarness({ retired: [false, false] });
      await missing.conversationDeps.deleteAgentQueuedTurns(userId, [{ conversationId: 'c1' }]);
      expect(
        missing.queuedTurns.beginAgentQueuedTurnMissingDeliveryRetirement,
      ).toHaveBeenCalledWith({ deliveryKey: 'delivery-1' });
      expect(missing.deliveries.getAgentTriggerDelivery).toHaveBeenCalledWith('delivery-1');
      expect(missing.queuedTurns.markAgentQueuedTurnMissingDeliveryRetired).toHaveBeenCalledWith({
        deliveryKey: 'delivery-1',
      });
      expect(missing.queuedTurns.markAgentQueuedTurnDeliveryRetired).toHaveBeenCalledTimes(1);

      const present = queuedTurnHarness({
        retired: [false, false],
        delivery: { deliveryKey: 'x' },
      });
      await present.conversationDeps.deleteAgentQueuedTurns(userId, [{ conversationId: 'c1' }]);
      expect(present.queuedTurns.markAgentQueuedTurnMissingDeliveryRetired).not.toHaveBeenCalled();
      expect(present.queuedTurns.markAgentQueuedTurnDeliveryRetired).not.toHaveBeenCalled();
      expect(present.queuedTurns.deletePreparedAgentQueuedTurnConversations).toHaveBeenCalledTimes(
        1,
      );
    });
  });
});
