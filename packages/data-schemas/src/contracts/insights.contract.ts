/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `InsightsStore` contract (`~/ports/insights`), ported from `methods/insights.spec.ts`: the
 * output shape of the usage report (summary totals, the daily series with every local date of
 * the range filled, top users, churned users, the latest conversations page), what it counts
 * (the selected agents only, a conversation by the agent it started with and a response by the
 * agent that wrote it, never temporary conversations, temporary messages or subagent threads),
 * the tenant scope (records outside any tenant without one), the time-zone buckets across a
 * daylight saving change, and the search over conversation ids and users but not message text.
 *
 * The cases that spy on the aggregation pipelines run (their stages and their count) stay in the
 * method spec. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { InsightsOptions } from '~/types';
import { useContractHarness } from './support';

const selectedAgents = [{ id: 'agent-a', name: 'Agent A' }];
const day = 24 * 60 * 60 * 1000;

export function describeInsightsContract(harness: ContractHarness): void {
  describe(`InsightsStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const newId = () => harness.ids.generate();
    const insights = (options: InsightsOptions) =>
      harness
        .createStores()
        .insights.getInsights({ ...options, agents: selectedAgents, agentIds: ['agent-a'] });
    const seedUsers = (records: RawRecord[]) => harness.seedRaw('users', records);
    /** Conversations default to agent A, as the method spec's fixtures do. */
    const seedConversations = (records: RawRecord[]) =>
      harness.seedRaw(
        'conversations',
        records.map((record) => ({
          _id: newId(),
          agent_id: 'agent-a',
          endpoint: 'agents',
          isTemporary: false,
          ...record,
        })),
      );
    /** Responses default to agent A as their source, as the method spec's fixtures do. */
    const seedMessages = (records: RawRecord[]) =>
      harness.seedRaw(
        'messages',
        records.map((record) => ({
          _id: newId(),
          ...(record.isCreatedByUser === false ? { model: 'agent-a' } : {}),
          isTemporary: false,
          ...record,
        })),
      );

    it('answers the empty report in its full shape with no options', async () => {
      const result = await harness.createStores().insights.getInsights();
      expect(Object.keys(result).sort()).toEqual(
        ['agents', 'churnedUsers', 'daily', 'latest', 'summary', 'topUsers'].sort(),
      );
      expect(result.agents).toEqual([]);
      expect(result.summary).toEqual({
        totalUsers: 0,
        totalConversations: 0,
        totalMessages: 0,
        totalTokens: 0,
      });
      expect(result.daily.length).toBeGreaterThanOrEqual(7);
      expect(result.daily.length).toBeLessThanOrEqual(8);
      for (const point of result.daily) {
        expect(point).toEqual({
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          conversations: 0,
          users: 0,
          messages: 0,
          totalTokens: 0,
        });
      }
      expect(result.topUsers).toEqual([]);
      expect(result.churnedUsers).toEqual([]);
      expect(result.latest).toEqual({
        conversations: [],
        page: 1,
        pageSize: expect.any(Number),
        pages: 1,
      });
    });

    it('counts active users from prompts and all of the tenant’s messages for top users', async () => {
      const now = Date.now();
      const activeAt = new Date(now - day);
      const activeUser = newId();
      const newUser = newId();
      const otherTenantUser = newId();
      await seedUsers([
        { _id: activeUser, tenantId: 'tenant-a', name: 'Active', email: 'active@example.com' },
        { _id: newUser, tenantId: 'tenant-a', name: 'New', email: 'new@example.com' },
        { _id: otherTenantUser, tenantId: 'tenant-b', name: 'Other', email: 'other@example.com' },
      ]);
      await seedConversations([
        {
          conversationId: 'old-conversation',
          tenantId: 'tenant-a',
          user: activeUser,
          createdAt: new Date(now - 10 * day),
          updatedAt: activeAt,
        },
        {
          conversationId: 'new-conversation',
          tenantId: 'tenant-a',
          user: newUser,
          createdAt: activeAt,
          updatedAt: activeAt,
        },
        {
          conversationId: 'other-conversation',
          tenantId: 'tenant-b',
          user: otherTenantUser,
          createdAt: activeAt,
          updatedAt: activeAt,
        },
      ]);
      const rows: Array<[string, string, string, boolean]> = [
        ['old-user', 'old-conversation', activeUser, true],
        ['old-assistant', 'old-conversation', activeUser, false],
        ['new-user', 'new-conversation', newUser, true],
        ['new-assistant', 'new-conversation', newUser, false],
        ['other-user', 'other-conversation', otherTenantUser, true],
        ['other-assistant', 'other-conversation', otherTenantUser, false],
      ];
      await seedMessages([
        ...rows.map(([messageId, conversationId, user, isCreatedByUser]) => ({
          messageId,
          conversationId,
          tenantId: conversationId === 'other-conversation' ? 'tenant-b' : 'tenant-a',
          user,
          createdAt: activeAt,
          updatedAt: activeAt,
          isCreatedByUser,
          text: messageId,
          tokenCount: 10,
        })),
        ...[null, ''].map((user, index) => ({
          messageId: `unattributed-${index}`,
          conversationId: 'old-conversation',
          tenantId: 'tenant-a',
          user,
          createdAt: activeAt,
          updatedAt: activeAt,
          isCreatedByUser: false,
          text: 'Unattributed message',
          tokenCount: 10,
        })),
      ]);

      const result = await insights({ tenantId: 'tenant-a', range: '7d' });
      expect(result.agents).toEqual(selectedAgents);
      expect(result.summary).toEqual({
        totalUsers: 2,
        totalConversations: 1,
        totalMessages: 4,
        totalTokens: 40,
      });
      expect(result.daily).toContainEqual(
        expect.objectContaining({ conversations: 1, users: 2, messages: 4, totalTokens: 40 }),
      );
      expect(result.topUsers).toHaveLength(2);
      expect(result.topUsers).toEqual(
        expect.arrayContaining([
          {
            userId: activeUser,
            name: 'Active',
            email: 'active@example.com',
            conversations: 1,
            messages: 2,
          },
          { userId: newUser, name: 'New', email: 'new@example.com', conversations: 1, messages: 2 },
        ]),
      );
    });

    it('lists the users whose 28-day inactivity threshold falls within the range', async () => {
      const now = Date.now();
      const daysAgo = (days: number) => new Date(now - days * day);
      const churned = newId();
      const previouslyChurned = newId();
      const active = newId();
      const otherTenant = newId();
      await seedUsers([
        { _id: churned, tenantId: 'tenant-a', name: 'Churned', email: 'churned@example.com' },
        { _id: previouslyChurned, tenantId: 'tenant-a', name: 'Before', email: 'b@example.com' },
        { _id: active, tenantId: 'tenant-a', name: 'Active', email: 'active@example.com' },
        { _id: otherTenant, tenantId: 'tenant-b', name: 'Other', email: 'other@example.com' },
      ]);
      await seedConversations(
        [
          ['churned-1', 'tenant-a', churned, 60],
          ['churned-2', 'tenant-a', churned, 29],
          ['before', 'tenant-a', previouslyChurned, 40],
          ['active', 'tenant-a', active, 27],
          ['other', 'tenant-b', otherTenant, 35],
        ].map(([conversationId, tenantId, user, days]) => ({
          conversationId,
          tenantId,
          user,
          createdAt: daysAgo(days as number),
        })),
      );
      await seedMessages(
        (
          [
            ['churned-first', 'churned-1', 'tenant-a', churned, 60, true],
            ['churned-second', 'churned-1', 'tenant-a', churned, 45, true],
            ['churned-last', 'churned-2', 'tenant-a', churned, 29, true],
            ['recent-response', 'churned-2', 'tenant-a', churned, 1, false],
            ['before-prompt', 'before', 'tenant-a', previouslyChurned, 40, true],
            ['active-prompt', 'active', 'tenant-a', active, 27, true],
            ['other-prompt', 'other', 'tenant-b', otherTenant, 35, true],
          ] as Array<[string, string, string, string, number, boolean]>
        ).map(([messageId, conversationId, tenantId, user, days, isCreatedByUser]) => ({
          messageId,
          conversationId,
          tenantId,
          user,
          createdAt: daysAgo(days),
          updatedAt: daysAgo(days),
          isCreatedByUser,
        })),
      );

      const result = await insights({ tenantId: 'tenant-a', range: '7d' });
      expect(result.churnedUsers).toEqual([
        {
          userId: churned,
          name: 'Churned',
          email: 'churned@example.com',
          conversations: 2,
          messages: 3,
          firstSeen: daysAgo(60).toISOString(),
          lastSeen: daysAgo(29).toISOString(),
        },
      ]);
      expect(result.summary).not.toHaveProperty('churnedUsers');
    });

    it('attributes a conversation to the agent it started with and a response to its source', async () => {
      const now = new Date();
      const user = newId();
      await seedUsers([{ _id: user, tenantId: 'tenant-a', name: 'Mixed', email: 'm@example.com' }]);
      const base = { tenantId: 'tenant-a', user, createdAt: now, updatedAt: now };
      await seedConversations([
        { ...base, conversationId: 'legacy-agent-a' },
        {
          ...base,
          conversationId: 'primary-agent-a',
          initial_agent_id: 'agent-a',
          agent_id: 'agent-b',
        },
        { ...base, conversationId: 'unattributed', initial_agent_id: null, agent_id: 'agent-a' },
        {
          ...base,
          conversationId: 'subagent-thread',
          initial_agent_id: 'agent-a',
          subagentThread: { parentConversationId: 'primary-agent-a' },
        },
        { ...base, conversationId: 'temporary', isTemporary: true },
      ]);
      await seedMessages([
        {
          ...base,
          messageId: 'primary-user',
          conversationId: 'primary-agent-a',
          isCreatedByUser: true,
          tokenCount: 5,
        },
        {
          ...base,
          messageId: 'secondary',
          conversationId: 'primary-agent-a',
          isCreatedByUser: false,
          model: 'agent-b',
          tokenCount: 7,
        },
        {
          ...base,
          messageId: 'unattributed-response',
          conversationId: 'unattributed',
          isCreatedByUser: false,
          tokenCount: 13,
        },
        {
          ...base,
          messageId: 'subagent-response',
          conversationId: 'subagent-thread',
          isCreatedByUser: false,
          tokenCount: 11,
        },
        {
          ...base,
          messageId: 'temporary-prompt',
          conversationId: 'temporary',
          isCreatedByUser: true,
          isTemporary: true,
          tokenCount: 17,
        },
      ]);

      const agentA = await insights({ tenantId: 'tenant-a', range: '7d' });
      const agentB = await harness.createStores().insights.getInsights({
        tenantId: 'tenant-a',
        range: '7d',
        agents: [{ id: 'agent-b', name: 'Agent B' }],
        agentIds: ['agent-b'],
      });
      expect(agentA.summary).toEqual(
        expect.objectContaining({ totalConversations: 2, totalMessages: 1, totalTokens: 5 }),
      );
      expect(agentB.summary).toEqual(
        expect.objectContaining({ totalConversations: 0, totalMessages: 1, totalTokens: 7 }),
      );
      expect(agentB.agents).toEqual([{ id: 'agent-b', name: 'Agent B' }]);
    });

    it('bounds the latest conversations’ message totals to a custom range', async () => {
      const inRange = new Date('2026-01-02T12:00:00.000Z');
      const afterRange = new Date('2026-01-08T12:00:00.000Z');
      const user = newId();
      await seedUsers([
        { _id: user, tenantId: 'tenant-a', name: 'Historical', email: 'h@example.com' },
      ]);
      await seedConversations([
        {
          conversationId: 'historical',
          tenantId: 'tenant-a',
          user,
          title: 'Historical conversation',
          createdAt: inRange,
          updatedAt: afterRange,
        },
      ]);
      const message = (messageId: string, at: Date, record: RawRecord) => ({
        messageId,
        conversationId: 'historical',
        tenantId: 'tenant-a',
        user,
        createdAt: at,
        updatedAt: at,
        ...record,
      });
      await seedMessages([
        message('temporary-prompt', new Date('2026-01-02T11:59:00.000Z'), {
          isCreatedByUser: true,
          isTemporary: true,
          text: 'Temporary prompt',
          tokenCount: 100,
        }),
        message('prompt', inRange, {
          isCreatedByUser: true,
          text: 'Historical prompt',
          tokenCount: 10,
        }),
        message('response', inRange, { isCreatedByUser: false, text: 'Response', tokenCount: 20 }),
        message('later', afterRange, { isCreatedByUser: false, text: 'Later', tokenCount: 30 }),
      ]);

      const result = await insights({
        tenantId: 'tenant-a',
        range: 'custom',
        fromTimestamp: '2026-01-01T00:00:00.000Z',
        toTimestamp: '2026-01-07T23:59:59.999Z',
      });
      expect(result.latest.conversations).toEqual([
        {
          conversationId: 'historical',
          agentId: 'agent-a',
          agentName: 'Agent A',
          date: expect.any(String),
          userId: user,
          name: 'Historical',
          email: 'h@example.com',
          firstMessage: 'Historical prompt',
          messages: 2,
          totalTokens: 30,
        },
      ]);
      expect(new Date(result.latest.conversations[0].date).getTime()).toBe(inRange.getTime());
      expect(result.latest).toMatchObject({ page: 1, pages: 1 });
    });

    it('buckets days in the selected time zone and fills every local date of the range', async () => {
      const user = newId();
      const activity = [new Date('2026-08-01T12:00:00.000Z'), new Date('2026-08-03T12:00:00.000Z')];
      await seedUsers([
        { _id: user, tenantId: 'tenant-a', name: 'Pacific', email: 'p@example.com' },
      ]);
      await seedConversations(
        activity.map((createdAt, index) => ({
          conversationId: `pacific-${index}`,
          tenantId: 'tenant-a',
          user,
          createdAt,
          updatedAt: createdAt,
        })),
      );
      await seedMessages(
        activity.map((createdAt, index) => ({
          messageId: `pacific-message-${index}`,
          conversationId: `pacific-${index}`,
          tenantId: 'tenant-a',
          user,
          createdAt,
          updatedAt: createdAt,
          isCreatedByUser: true,
          text: `Message ${index}`,
        })),
      );
      const result = await insights({
        tenantId: 'tenant-a',
        range: 'custom',
        fromTimestamp: '2026-08-01T07:00:00.000Z',
        toTimestamp: '2026-08-04T06:59:59.999Z',
        timeZone: 'America/Los_Angeles',
      });
      expect(result.daily).toEqual([
        { date: '2026-08-01', conversations: 1, messages: 1, totalTokens: 0, users: 1 },
        { date: '2026-08-02', conversations: 0, messages: 0, totalTokens: 0, users: 0 },
        { date: '2026-08-03', conversations: 1, messages: 1, totalTokens: 0, users: 1 },
      ]);

      const dst = await insights({
        tenantId: 'tenant-a',
        range: 'custom',
        fromTimestamp: '2026-03-08T04:30:00.000Z',
        toTimestamp: '2026-03-09T04:30:00.000Z',
        timeZone: 'America/New_York',
      });
      expect(dst.daily.map(({ date }) => date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    });

    it('searches the tenant’s conversations by id and user, never by message text', async () => {
      const now = new Date();
      const alice = newId();
      const bob = newId();
      const secret = newId();
      await seedUsers([
        { _id: alice, tenantId: 'tenant-a', name: 'Alice Example', email: 'alice@example.com' },
        { _id: bob, tenantId: 'tenant-a', name: 'Bob Example', email: 'bob@example.com' },
        { _id: secret, tenantId: 'tenant-b', name: 'Secret User', email: 'secret@example.com' },
      ]);
      const rows: Array<[string, string, string, string]> = [
        ['incident-review-123', 'tenant-a', alice, 'Review the production incident'],
        ['capacity-plan-456', 'tenant-a', bob, 'Forecast the sapphire cluster capacity'],
        ['other-tenant-789', 'tenant-b', secret, 'Cross tenant secret phrase'],
      ];
      await seedConversations(
        rows.map(([conversationId, tenantId, user]) => ({
          conversationId,
          tenantId,
          user,
          createdAt: now,
          updatedAt: now,
        })),
      );
      await seedMessages(
        rows.map(([conversationId, tenantId, user, text]) => ({
          messageId: `message-${conversationId}`,
          conversationId,
          tenantId,
          user,
          createdAt: now,
          updatedAt: now,
          isCreatedByUser: true,
          text,
        })),
      );
      const ids = async (search: string) =>
        (await insights({ tenantId: 'tenant-a', range: '7d', search })).latest.conversations.map(
          (row) => row.conversationId,
        );
      const byId = await insights({ tenantId: 'tenant-a', range: '7d', search: 'review-123' });
      expect(byId.summary.totalConversations).toBe(2);
      expect(byId.latest.conversations.map((row) => row.conversationId)).toEqual([
        'incident-review-123',
      ]);
      expect(await ids('alice@example.com')).toEqual(['incident-review-123']);
      expect(await ids('SAPPHIRE CLUSTER')).toEqual([]);
      const crossTenant = await insights({
        tenantId: 'tenant-a',
        range: '7d',
        search: 'secret phrase',
      });
      expect(crossTenant.latest).toEqual(expect.objectContaining({ conversations: [], pages: 1 }));
    });

    it('reads only the records outside any tenant without a tenant id', async () => {
      const now = new Date();
      const user = newId();
      await seedUsers([{ _id: user, name: 'Tenantless', email: 't@example.com' }]);
      await seedConversations([
        { conversationId: 'tenantless', user, createdAt: now, updatedAt: now },
        { conversationId: 'tenanted', user, tenantId: 'tenant-a', createdAt: now, updatedAt: now },
      ]);
      await seedMessages([
        {
          messageId: 'm1',
          conversationId: 'tenantless',
          user,
          createdAt: now,
          isCreatedByUser: true,
        },
        {
          messageId: 'm2',
          conversationId: 'tenanted',
          user,
          tenantId: 'tenant-a',
          createdAt: now,
          isCreatedByUser: true,
        },
      ]);
      const result = await insights({ range: '7d' });
      expect(result.summary).toMatchObject({ totalConversations: 1, totalMessages: 1 });
      expect(result.latest.conversations.map((row) => row.conversationId)).toEqual(['tenantless']);
    });
  });
}
