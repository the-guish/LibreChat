import '~/contracts/credentialsEnv';

process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'copy-refresh-secret';
import { Mongoose } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel, ResourceType } from 'librechat-data-provider';
import type { MongoClient } from 'mongodb';
import type { ContractHarness } from '~/contracts/harness';
import type { DataStore } from '~/ports';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createTriggerDeliveryFixtures } from '~/contracts/triggerDelivery.fixtures';
import { queuedTurnFixtures } from '~/contracts/queuedTurn.fixtures';
import { DATA_STORE_METHODS } from '~/ports';
import { copyMongoToPostgres, formatMongoToPostgresReport } from './index';

/**
 * The copy tool end to end, through the stores (docs/postgres-port/PHASE4.md §8 X1, "Verify"): a
 * memory MongoDB is filled through the MongoDB stores (and the conversation domain functions),
 * plus legacy shapes through the raw driver; the copy tool copies it into a PostgreSQL test
 * database; then every store answers a representative read (for the write-only stores, a probe
 * whose answer depends on the copied records) on both backends, and the answers must be equal.
 *
 * Answers are compared as JSON (ids as hex strings, dates as ISO strings, key order ignored):
 * the port's known leak (R7) is that MongoDB hands out ObjectIds where PostgreSQL hands out their
 * hex strings, and both serialize the same.
 */
const mongoose = new Mongoose();
let server: MongoMemoryServer;
const mongo = createMongoContractHarness(
  {
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  },
  mongoose,
);

const USER = '6a0000000000000000000001';
const OTHER = '6a0000000000000000000002';
const AGENT_OBJECT = '6a0000000000000000000010';
const CONVO_1 = '11111111-1111-4111-8111-111111111111';
const CONVO_2 = '22222222-2222-4222-8222-222222222222';
const CONVO_9 = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-03-01T00:00:00.000Z');
const LATER = new Date('2999-01-01T00:00:00.000Z');

/** One store's case: what is written on MongoDB, and the read compared on both backends. */
interface StoreCase {
  seed?(stores: DataStore, harness: ContractHarness): Promise<unknown>;
  read(stores: DataStore, harness: ContractHarness): Promise<unknown>;
}

/** Whether an answer holds nothing: a read of records that were never written proves nothing. */
const isEmpty = (value: unknown): boolean =>
  value == null ||
  (Array.isArray(value) && value.every(isEmpty)) ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const toJson = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: (error as { code?: unknown }).code ?? (error as Error).name };
  }
}

const queued = queuedTurnFixtures(mongo, () => USER);
const deliveries = createTriggerDeliveryFixtures(mongo);
let deliveryKey: string;
let fileRecordId: string;
let groupId: string;
let skillId: string;
let environmentId: string;
let accessRoleResource: string;

const subagentScope = {
  user: USER,
  parentConversationId: 'convo-parent',
  conversationId: 'convo-child',
  taskId: 'task-1',
};

/** Every store of the `DataStore`, but the transaction runner (it holds no records). */
const CASES: Record<Exclude<keyof DataStore, 'transactions'>, StoreCase> = {
  users: {
    seed: async (stores) => {
      await stores.users.createUser(
        {
          _id: USER,
          email: 'one@example.com',
          name: 'One',
          username: 'one',
          provider: 'local',
        } as never,
        undefined,
        true,
      );
      await stores.users.createUser(
        {
          _id: OTHER,
          email: 'two@example.com',
          name: 'Two',
          provider: 'openid',
          openidId: 'o2',
        } as never,
        undefined,
        true,
      );
    },
    read: async (stores) => [
      await stores.users.getUserById(USER),
      await stores.users.findUser({ email: 'two@example.com' }),
    ],
  },
  principals: { read: (stores) => stores.principals.findPrincipalUser(USER) },
  browserSetup: { read: (stores) => stores.browserSetup.getUser(USER) },
  sessions: {
    seed: (stores) => stores.sessions.createSession(USER),
    read: (stores) => stores.sessions.findSession({ userId: USER }),
  },
  tokens: {
    seed: (stores) =>
      stores.tokens.createToken({
        userId: USER,
        email: 'one@example.com',
        type: 'mcp_oauth',
        identifier: 'mcp:server',
        token: 'value',
        expiresIn: 3600,
        metadata: { credential_set_id: 'set-a', nested: { a: 1 } },
      } as never),
    read: (stores) => stores.tokens.findToken({ userId: USER, identifier: 'mcp:server' } as never),
  },
  tokenLists: {
    read: (stores) => stores.tokenLists.findTokensOfUser({ userId: USER, type: 'mcp_oauth' }),
  },
  passkeys: {
    seed: (stores) =>
      stores.passkeys.createPasskey({
        user: USER,
        credentialId: 'credential-one',
        publicKey: Buffer.from([1, 2, 3, 0]),
        counter: 0,
        transports: ['internal'],
        deviceType: 'multiDevice',
        backedUp: true,
        name: 'This device',
      } as never),
    read: (stores) => stores.passkeys.findPasskeysByUser(USER),
  },
  refreshTokenBridges: {
    seed: (stores) =>
      stores.refreshTokenBridges.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'old-hash',
        encryptedNewRefreshToken: 'encrypted-new',
        userId: USER,
        openidIssuer: 'https://issuer.example.com',
        expiresAt: LATER,
      } as never),
    read: (stores) =>
      stores.refreshTokenBridges.findRefreshTokenBridge({
        oldRefreshTokenHash: 'old-hash',
        userId: USER,
      } as never),
  },
  openidRefreshFlights: {
    seed: (stores) =>
      stores.openidRefreshFlights.acquireOpenIDRefreshFlight({
        key: 'flight-key',
        ownerId: 'owner-1',
        lockExpiresAt: LATER,
        expiresAt: LATER,
      } as never),
    read: (stores) =>
      stores.openidRefreshFlights.findOpenIDRefreshFlight({ key: 'flight-key' } as never),
  },
  userKeys: {
    seed: (stores) =>
      stores.userKeys.updateUserKey({
        userId: USER,
        name: 'openAI',
        value: JSON.stringify({ apiKey: 'sk-secret' }),
        expiresAt: LATER,
      }),
    read: (stores) => stores.userKeys.getUserKeyValues({ userId: USER, name: 'openAI' }),
  },
  pluginAuths: {
    seed: (stores) =>
      stores.pluginAuths.updatePluginAuth({
        userId: USER,
        authField: 'API_KEY',
        pluginKey: 'mcp_server',
        value: 'encrypted',
      } as never),
    read: (stores) =>
      stores.pluginAuths.findPluginAuthsByKeys({
        userId: USER,
        pluginKeys: ['mcp_server'],
      } as never),
  },
  agentApiKeys: {
    seed: (stores) =>
      stores.agentApiKeys.createAgentApiKey({ userId: USER, name: 'remote', expiresAt: LATER }),
    read: (stores) => stores.agentApiKeys.listAgentApiKeys(USER),
  },
  memories: {
    seed: (stores) =>
      stores.memories.createMemory({
        userId: USER,
        key: 'context',
        value: 'personal',
        tokenCount: 1,
      }),
    read: (stores) => stores.memories.getAllUserMemories(USER),
  },
  toolFavorites: {
    seed: (stores) =>
      stores.toolFavorites.addToolFavorite({
        userId: USER,
        itemType: 'tool',
        itemId: 'calculator',
      } as never),
    read: (stores) => stores.toolFavorites.getToolFavorites(USER),
  },
  toolApprovalGrants: {
    seed: (stores) =>
      stores.toolApprovalGrants.rememberToolApprovalGrants(
        { userId: USER, agentId: 'agent-a', conversationId: 'chat-a' } as never,
        [
          { toolName: 'query', instanceName: 'query', binding: 'digest-a', scope: 'always' },
        ] as never,
      ),
    read: (stores) =>
      stores.toolApprovalGrants.getToolApprovalGrants(
        { userId: USER, agentId: 'agent-a', conversationId: 'chat-a' } as never,
        [{ toolName: 'query', instanceName: 'query', binding: 'digest-a' }] as never,
      ),
  },
  resourceLocks: {
    seed: (stores) =>
      stores.resourceLocks.acquireResourceLock({
        key: 'acl:agent:1',
        ownerId: 'a',
        ttlMs: 3_600_000,
      }),
    /** A probe: the copied lease is still held by its owner. */
    read: async (stores) => [
      await stores.resourceLocks.acquireResourceLock({
        key: 'acl:agent:1',
        ownerId: 'b',
        ttlMs: 1000,
      }),
      await stores.resourceLocks.renewResourceLock({
        key: 'acl:agent:1',
        ownerId: 'a',
        ttlMs: 1000,
      }),
    ],
  },
  banners: {
    seed: (stores) =>
      stores.banners.saveBanner({
        bannerId: 'banner-1',
        message: 'Hello',
        displayFrom: AT,
        displayTo: LATER,
        isPublic: true,
        persistable: false,
      } as never),
    read: (stores) => stores.banners.getCurrentBannerRecord(),
  },
  categories: { read: (stores) => stores.categories.getCategories() },
  agentCategories: {
    seed: (stores) =>
      stores.agentCategories.createCategory({ value: 'research', label: 'Research', order: 1 }),
    read: (stores) => stores.agentCategories.getAllCategories(),
  },
  roles: {
    seed: (stores) => stores.roles.initializeRoles(),
    read: async (stores) => [
      await stores.roles.getRoleByName('USER'),
      await stores.roles.listRoles(),
    ],
  },
  accessRoles: {
    seed: async (stores) => {
      accessRoleResource = 'agent';
      await stores.accessRoles.createRole({
        accessRoleId: 'agent_custom',
        name: 'Custom',
        resourceType: accessRoleResource,
        permBits: 3,
      } as never);
    },
    read: (stores) => stores.accessRoles.findRolesByResourceType(accessRoleResource),
  },
  aclEntries: {
    seed: (stores) =>
      stores.aclEntries.grantPermission(
        PrincipalType.USER,
        USER,
        ResourceType.AGENT,
        AGENT_OBJECT,
        7,
        OTHER,
      ),
    read: (stores) => stores.aclEntries.findEntriesByResource(ResourceType.AGENT, AGENT_OBJECT),
  },
  systemGrants: {
    seed: (stores) =>
      stores.systemGrants.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'ADMIN',
        capability: 'access:admin' as never,
      }),
    read: async (stores) => [
      ...(await stores.systemGrants.getHeldCapabilities({
        principals: [{ principalType: PrincipalType.ROLE, principalId: 'ADMIN' }],
        capabilities: ['access:admin', 'manage:users'] as never,
      })),
    ],
  },
  userGroups: {
    seed: async (stores) => {
      const group = await stores.userGroups.createGroup({
        name: 'Engineering',
        email: 'eng@example.com',
        source: 'local',
        memberIds: [USER],
      } as never);
      groupId = String(group._id);
    },
    read: (stores) => stores.userGroups.findGroupById(groupId),
  },
  configOverrides: {
    seed: (stores) =>
      stores.configOverrides.upsertConfig(
        PrincipalType.ROLE,
        'admin',
        PrincipalModel.ROLE,
        { interface: { modelSelect: false } } as never,
        10,
      ),
    read: (stores) => stores.configOverrides.listAllConfigs(),
  },
  auditLogs: {
    seed: (stores) =>
      stores.auditLogs.recordAuditEntry(
        {
          action: 'grant.assigned',
          actor: { type: 'user', id: USER, name: 'One' },
          target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
          metadata: { capability: 'manage:users' },
          tenantId: 'tenant-a',
        } as never,
        { failClosed: true } as never,
      ),
    read: (stores) => stores.auditLogs.listAuditLogPage('tenant-a', {} as never),
  },
  mcpServers: {
    seed: (stores) =>
      stores.mcpServers.createMCPServer({
        config: { type: 'sse', url: 'https://example.com/mcp', title: 'Docs' } as never,
        author: USER,
      }),
    read: (stores) => stores.mcpServers.findMCPServerByServerName('docs'),
  },
  mcpAuthorities: {
    /** A probe: resolving for a user the copy did not bring fails the same way on both. */
    read: (stores) =>
      rejectionOf(
        stores.mcpAuthorities.resolveMCPAuthorityProof({
          userId: '6affffffffffffffffffffff',
          serverName: 'docs',
        } as never),
      ),
  },
  mcpAuthorizationFenceRetries: {
    seed: (stores) =>
      stores.mcpAuthorizationFenceRetries.upsert({
        scope: { userId: USER, serverName: 'github' } as never,
        tenantId: 'tenant-a',
        version: 'v1',
        now: AT,
      }),
    read: (stores) => stores.mcpAuthorizationFenceRetries.list(10),
  },
  actions: {
    seed: (stores) =>
      stores.actions.updateAction(
        { actionId: 'act-1', agentId: 'agent-1', user: USER } as never,
        { metadata: { domain: 'example.com', auth: { type: 'none' } } } as never,
      ),
    read: (stores) => stores.actions.getActions({ actionId: 'act-1' } as never, true),
  },
  assistants: {
    seed: (stores) =>
      stores.assistants.updateAssistantDoc(
        { assistantId: 'asst-1', user: USER } as never,
        { conversation_starters: ['hi'], append_current_datetime: true } as never,
      ),
    read: (stores) => stores.assistants.getAssistants({ user: USER } as never),
  },
  presets: {
    seed: (stores) =>
      stores.presets.savePreset(USER, { presetId: 'p1', title: 'Preset', endpoint: 'openAI' }),
    read: (stores) => stores.presets.getPresets(USER),
  },
  toolCalls: {
    seed: (stores) =>
      stores.toolCalls.createToolCall({
        conversationId: CONVO_1,
        messageId: 'msg-1',
        toolId: 'execute_code',
        user: USER,
        result: { stdout: 'ok', nested: [1, 2] },
        attachments: [{ file_id: 'file-1', filename: 'out.txt' }],
        blockIndex: 0,
        partIndex: 2,
      } as never),
    read: (stores) => stores.toolCalls.getToolCallsByConvo(CONVO_1, USER),
  },
  conversations: {
    seed: async (_stores, harness) => {
      const domain = harness.createConversationDomain();
      await domain.saveConvo(
        { userId: USER } as never,
        { conversationId: CONVO_1, title: 'First', endpoint: 'openAI', tags: ['work'] } as never,
      );
      await domain.saveConvo(
        { userId: USER } as never,
        {
          conversationId: CONVO_2,
          title: 'Second',
          endpoint: 'agents',
          agent_id: 'agent-1',
        } as never,
      );
    },
    read: async (stores) => [
      await stores.conversations.getConvo(USER, CONVO_1),
      await stores.conversations.getConvosByCursor(USER, {} as never),
    ],
  },
  messages: {
    seed: async (stores) => {
      for (const [index, messageId] of ['msg-1', 'msg-2'].entries()) {
        await stores.messages.saveMessage({ userId: USER }, {
          messageId,
          conversationId: CONVO_1,
          parentMessageId: index === 0 ? '00000000-0000-0000-0000-000000000000' : 'msg-1',
          text: `message ${index}`,
          sender: index === 0 ? 'User' : 'GPT',
          isCreatedByUser: index === 0,
          content: [{ type: 'text', text: `message ${index}` }] as never,
        } as never);
      }
    },
    read: (stores) => stores.messages.getMessages({ conversationId: CONVO_1 }),
  },
  conversationImports: {
    seed: (_stores, harness) =>
      harness.seedRaw('conversations', [
        {
          _id: '6a0000000000000000000a01',
          conversationId: 'imported-1',
          user: OTHER,
          title: 'Imported',
          endpoint: 'openAI',
          createdAt: AT,
          updatedAt: AT,
        },
      ]),
    /** A probe: the import cleanup removes the copied conversation on both backends. */
    read: async (stores) => {
      const before = await stores.conversations.getConvo(OTHER, 'imported-1');
      await stores.conversationImports.deleteImportedConversations({
        user: OTHER,
        conversationIds: ['imported-1'],
      } as never);
      return [before, await stores.conversations.getConvo(OTHER, 'imported-1')];
    },
  },
  conversationTags: {
    seed: (stores) =>
      stores.conversationTags.createConversationTag(USER, {
        tag: 'work',
        description: 'Work chats',
      } as never),
    read: (stores) => stores.conversationTags.getConversationTags(USER),
  },
  sharedLinks: {
    seed: (stores) => stores.sharedLinks.createSharedLink(USER, CONVO_1),
    read: (stores) => stores.sharedLinks.getSharedLinks(USER),
  },
  chatProjects: {
    seed: (stores) => stores.chatProjects.createChatProject(USER, { name: 'Project' } as never),
    read: (stores) => stores.chatProjects.listChatProjects(USER),
  },
  insights: { read: (stores) => stores.insights.getInsights() },
  files: {
    seed: async (stores) => {
      const file = await stores.files.createFile(
        {
          user: USER,
          file_id: 'file-1',
          filename: 'notes.txt',
          filepath: '/uploads/notes.txt',
          type: 'text/plain',
          bytes: 12,
          object: 'file',
          usage: 0,
          context: 'message_attachment',
        } as never,
        true,
      );
      fileRecordId = String(file?._id);
    },
    read: (stores) => stores.files.getFiles({ user: USER }),
  },
  fileStorage: {
    /** A probe: the copied file takes a provisioning claim, then refuses a deletion. */
    read: async (stores) => {
      const claim = { file_id: 'file-1', userId: USER, token: 'code-a' };
      return [
        await stores.fileStorage.acquireFileProvision(claim),
        await stores.fileStorage.acquireFileDeletion({ ...claim, updatedAt: new Date() } as never),
        fileRecordId !== undefined,
      ];
    },
  },
  agents: {
    seed: (stores) =>
      stores.agents.createAgent({
        id: 'agent-1',
        name: 'Helper',
        provider: 'openAI',
        model: 'gpt-4o',
        author: USER,
        tools: ['calculator'],
        model_parameters: { temperature: 0.2, top_p: 1 },
      }),
    read: (stores) => stores.agents.getAgent({ id: 'agent-1' }),
  },
  skills: {
    seed: async (stores) => {
      const created = await stores.skills.createSkill({
        name: 'summarize',
        description: 'Summarizes text',
        body: '# Summarize',
        author: USER,
        authorName: 'One',
      } as never);
      skillId = String((created as { skill: { _id: unknown } }).skill._id);
    },
    read: (stores) => stores.skills.getSkillById(skillId),
  },
  skillLifecycle: {
    seed: (_stores, harness) =>
      harness.seedRaw('skilldeletions', [
        {
          _id: '6a0000000000000000000b01',
          skillId: '6a0000000000000000000b02',
          author: USER,
          name: 'old-skill',
          startedAt: AT,
        },
      ]),
    read: (stores) => stores.skillLifecycle.listPendingSkillDeletions(),
  },
  skillSync: {
    seed: (stores) =>
      stores.skillSync.upsertSkillSyncStatus({
        provider: 'github',
        credentialKey: 'github-skills-prod',
        owner: 'acme',
        repo: 'skills',
        ref: 'main',
        paths: ['skills/'],
        status: 'success',
        startedAt: AT,
        finishedAt: AT,
        syncedSkillCount: 3,
      } as never),
    read: (stores) => stores.skillSync.listSkillSyncStatuses('github' as never),
  },
  codeEnvironments: {
    seed: async (stores) => {
      const environment = await stores.codeEnvironments.createCodeEnvironment({
        environmentId: 'env-1',
        name: 'Machine env-1',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        createdBy: USER,
      } as never);
      environmentId = String(environment._id);
    },
    read: (stores) => stores.codeEnvironments.findCodeEnvironmentsByIds([environmentId]),
  },
  schedules: {
    seed: (stores) =>
      stores.schedules.createSchedule({
        id: 'schedule-1',
        user: USER,
        agent_id: 'root',
        name: 'Digest',
        prompt: 'Read',
        cadence: { frequency: 'hourly', minute: 0, hour: 1 },
        timezone: 'UTC',
        enabled: true,
      } as never),
    read: (stores) => stores.schedules.getSchedulesByUser(USER),
  },
  scheduleConsents: {
    read: (stores) =>
      stores.scheduleConsents.readScheduleMCPConsent({
        scheduleId: 'schedule-1',
        ownerId: USER,
        agentId: 'root',
        invocationMode: 'delegated',
      } as never),
  },
  tokenTransactions: {
    seed: async (stores) => {
      await stores.tokenTransactions.updateBalance({ user: USER, incrementValue: 1000 });
      await stores.tokenTransactions.bulkInsertTransactions([
        {
          user: USER,
          conversationId: CONVO_1,
          tokenType: 'prompt',
          model: 'gpt-4o',
          context: 'message',
          rawAmount: -10,
          tokenValue: -20,
          rate: 2,
        },
      ] as never);
    },
    read: async (stores) => [
      await stores.tokenTransactions.findBalanceByUser(USER),
      await stores.tokenTransactions.getTransactions({ user: USER }),
    ],
  },
  tokenSpending: {
    seed: (stores) =>
      stores.tokenSpending.spendTokens(
        { user: OTHER, conversationId: CONVO_9, model: 'gpt-4o', context: 'message' } as never,
        { promptTokens: 100, completionTokens: 50 },
      ),
    /** What the spending wrote, through the transaction store's read. */
    read: (stores) => stores.tokenTransactions.getTransactions({ user: OTHER }),
  },
  prompts: {
    seed: (stores) =>
      stores.prompts.createPromptGroup({
        prompt: { prompt: 'Summarize {{text}}', type: 'text' },
        group: { name: 'Summaries', category: '' },
        author: USER,
        authorName: 'One',
      } as never),
    read: (stores) => stores.prompts.getAllPromptGroups({} as never),
  },
  subagentContent: {
    seed: async (stores, harness) => {
      const owner = { user: USER };
      await harness.seedRaw('messages', [
        {
          _id: '6a0000000000000000000c01',
          ...owner,
          conversationId: subagentScope.conversationId,
          messageId: `${subagentScope.taskId}:user`,
          isCreatedByUser: true,
          text: 'Investigate',
          subagentContent: { version: 1, throughSequence: 0 },
        },
      ]);
      await harness.seedRaw('conversations', [
        {
          _id: '6a0000000000000000000c02',
          ...owner,
          conversationId: subagentScope.parentConversationId,
          endpoint: 'agents',
        },
        {
          _id: '6a0000000000000000000c03',
          ...owner,
          conversationId: subagentScope.conversationId,
          endpoint: 'agents',
          subagentThread: {
            rootConversationId: subagentScope.parentConversationId,
            parentConversationId: subagentScope.parentConversationId,
            parentMessageId: 'parent-message',
            parentToolCallId: 'parent-tool',
            subagentType: 'researcher',
            subagentKind: 'agent',
            depth: 1,
          },
          subagentThreadLease: {
            token: 'lease-token',
            taskId: subagentScope.taskId,
            expiresAt: LATER,
          },
        },
      ]);
      await stores.subagentContent.appendSubagentContentBatch({
        ...subagentScope,
        revision: 1,
        fromSequence: 0,
        throughSequence: 2,
        eventsJson: JSON.stringify([{ sequence: 0 }, { sequence: 2 }]),
        leaseToken: 'lease-token',
      });
    },
    read: (stores) => stores.subagentContent.getSubagentContentHead(subagentScope),
  },
  agentQueuedTurns: {
    seed: () => queued.enqueue(),
    read: (stores) =>
      stores.agentQueuedTurns.listActiveAgentQueuedTurns({ ...queued.scope(), limit: 10 }),
  },
  agentTriggerDeliveries: {
    seed: async () => {
      const enqueued = await deliveries.enqueue();
      deliveryKey =
        (enqueued as { delivery?: { deliveryKey: string } }).delivery?.deliveryKey ??
        String((enqueued as { deliveryKey?: string }).deliveryKey);
    },
    read: (stores) => stores.agentTriggerDeliveries.getAgentTriggerDelivery(deliveryKey),
  },
};

describePostgres('MongoDB → PostgreSQL copy, read back through every store', () => {
  const database = usePostgresTestDatabase({ template: 'empty' });
  const postgres = createPostgresContractHarness({
    connect: async () => database.uri,
    release: async () => undefined,
  });
  const seeded: Record<string, unknown> = {};

  beforeAll(async () => {
    await mongo.setup();
    const stores = mongo.createStores();
    for (const [name, item] of Object.entries(CASES)) {
      try {
        await item.seed?.(stores, mongo);
      } catch (error) {
        seeded[name] = error;
      }
    }
    /** Legacy shapes, as the raw driver would have left them. */
    const users = mongoose.connection.db!.collection('users');
    await users.updateOne({ email: 'one@example.com' }, { $set: { legacyFlag: { kept: true } } });
    await mongoose.connection
      .db!.collection('roles')
      .updateOne({ name: 'USER' }, { $set: { 'permissions.AGENTS.SHARED_GLOBAL': true } });
    await mongoose.connection
      .db!.collection('sharedlinks')
      .updateMany({}, { $set: { isPublic: true } });

    const report = await copyMongoToPostgres({
      mongo: {
        client: mongoose.connection.getClient() as unknown as MongoClient,
        dbName: mongoose.connection.db!.databaseName,
      },
      env: database.env(),
    });
    if (!report.ok) {
      throw new Error(formatMongoToPostgresReport(report));
    }
    await postgres.setup();
  }, 240_000);

  afterAll(async () => {
    await postgres.teardown();
    await mongo.teardown();
  });

  it('has a case for every store', () => {
    const covered = Object.keys(CASES).sort();
    const stores = Object.keys(DATA_STORE_METHODS)
      .filter((name) => name !== 'transactions')
      .sort();
    expect(covered).toEqual(stores);
  });

  it.each(Object.keys(CASES))('answers %s the same on both backends', async (name) => {
    expect(seeded[name]).toBeUndefined();
    const item = CASES[name as keyof typeof CASES];
    const fromMongo = toJson(await item.read(mongo.createStores(), mongo));
    expect(isEmpty(fromMongo)).toBe(false);
    const fromPostgres = toJson(await item.read(postgres.createStores(), postgres));
    expect(fromPostgres).toEqual(fromMongo);
  });

  it('keeps the legacy values the raw driver left (D7)', async () => {
    const { users, roles, sharedLinks } = postgres.createStores();
    expect(await users.getUserById(USER)).toMatchObject({ legacyFlag: { kept: true } });
    const role = await roles.getRoleByName('USER');
    expect((role.permissions as Record<string, Record<string, unknown>>).AGENTS).toMatchObject({
      SHARED_GLOBAL: true,
    });
    expect(await sharedLinks.getSharedLinks(USER)).toBeDefined();
    const [link] = await postgres.readRaw('sharedlinks');
    expect(link).toMatchObject({ isPublic: true });
  });
});
