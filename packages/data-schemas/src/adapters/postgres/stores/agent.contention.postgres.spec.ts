import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { DataStore } from '~/ports';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL agent store (docs/postgres-port/PHASE4.md §3.5): parallel
 * writes on separate pool clients lose none of the `tool_resources` file ids or the version
 * entries they add (tier 2 subpath writes into `json` under the row lock), the avatar
 * compare-and-set lets exactly one of several writers that read the same avatar win, and
 * concurrent deletes of agents sharing one graph prune every reference (the edge cleanup's
 * locked compare-and-set, retried by its sweeps). Each case runs with the shadow check off (the
 * production path) and on (the lock-then-write path the contract suites take).
 */
describePostgres('PostgreSQL agent store under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    let stores: DataStore;

    beforeAll(async () => {
      await harness.setup();
      stores = harness.createStores();
    }, 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const newId = () => harness.ids.generate();
    const author = '0123456789abcdef0123d000';
    const create = async (id: string, record: Record<string, unknown> = {}) => {
      await stores.agents.createAgent({
        id,
        name: 'Agent',
        provider: 'openAI',
        model: 'gpt-4o',
        author,
        ...record,
      });
    };
    const rawAgent = async (id: string) =>
      (await harness.readRaw('agents')).find((agent) => agent.id === id) as RawRecord;

    it('keeps every file id and version of 10 parallel tool-resource additions', async () => {
      await create('target', { tools: ['web_search'] });
      const fileIds = Array.from({ length: 10 }, (_, index) => `file-${index}`);
      await Promise.all(
        fileIds.map((file_id) =>
          stores.agents.addAgentResourceFile({
            agent_id: 'target',
            tool_resource: 'file_search',
            file_id,
          }),
        ),
      );
      const stored = await rawAgent('target');
      const resources = stored.tool_resources as { file_search: { file_ids: string[] } };
      expect([...resources.file_search.file_ids].sort()).toEqual([...fileIds].sort());
      expect(stored.tools).toEqual(['web_search', 'file_search']);
      expect(stored.versions as RawRecord[]).toHaveLength(11);
    });

    it('lets exactly one of 8 writers that read the same avatar replace it', async () => {
      await create('avatar');
      const read = { filepath: '/images/a.png', source: 'local' };
      expect(await stores.agents.updateAgentAvatar({ id: 'avatar', avatar: read })).toBe(true);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          stores.agents.updateAgentAvatar({
            id: 'avatar',
            avatar: { filepath: `/images/${index}.png`, source: 'local' },
            previousAvatar: read,
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect((await rawAgent('avatar')).avatar).toEqual({
        filepath: `/images/${winner}.png`,
        source: 'local',
      });
    });

    it('prunes every reference when 5 agents of one graph are deleted in parallel', async () => {
      const members = Array.from({ length: 5 }, (_, index) => `member-${index}`);
      for (const id of members) {
        await create(id);
      }
      await harness.seedRaw('agents', [
        {
          _id: newId(),
          id: 'graph',
          name: 'Graph',
          provider: 'openAI',
          model: 'gpt-4o',
          author,
          edges: [
            ...members.map((to) => ({ from: 'graph', to, edgeType: 'handoff' })),
            { from: 'graph', to: 'kept', edgeType: 'handoff' },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const deleted = await Promise.all(members.map((id) => stores.agents.deleteAgent({ id })));
      expect(deleted.every((agent) => agent != null)).toBe(true);
      expect((await rawAgent('graph')).edges).toEqual([
        { from: 'graph', to: 'kept', edgeType: 'handoff' },
      ]);
    });
  });
});
