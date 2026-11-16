/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AgentStore` contract (`~/ports/agent`), first part, ported from `methods/agent.spec.ts`:
 * the single and multiple reads with the filter and projection shapes callers pass (`versions`
 * left out of the single reads unless a projection asks for it), the version history and its
 * count, the display name, the graph nodes with and without resolved ACL principals, the MCP
 * server and model-list reads, the browser listing (`getListAgentsByAccess`: the accessible-id
 * and tenant modes, the response fields, every sort order with its cursor paging over ties, the
 * limit clamps, the cursor errors and the filters callers pass), the management listing with
 * its version counts and cursor, the shared tool-resource file check, the deletes with their
 * ACL, graph-edge and favorites cleanup, and tenant scoping.
 *
 * The writes (`createAgent`, `updateAgent` with its versioning and operators, the avatar, the
 * tool-resource files and `revertAgentVersion`) are in `agent.versions.contract.ts`.
 *
 * Not here (they stay in the method spec): the auth-user cache eviction (no cache is wired), the
 * edge-cleanup retry bounds (they need concurrent writers between two driver calls), the
 * code-environment reference leases, cases that make a query fail or count driver calls, and
 * the index declarations. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { AgentListSortOption } from '~/types';
import type { StoreFilter } from '~/ports/query';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const BASE = Date.parse('2026-05-01T00:00:00.000Z');
/** A fixed instant `minutes` after {@link BASE}. */
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const OWNER =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

export function describeAgentContract(harness: ContractHarness): void {
  describe(`AgentStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores();
    const agents = () => stores().agents;
    const newId = () => harness.ids.generate();
    const storeId = (hex: string) => harness.ids.toStoreId(hex);
    /** `count` new ids in ascending (insertion) order. */
    const ascendingIds = (count: number) =>
      Array.from({ length: count }, () => newId()).sort() as string[];
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const author = '0123456789abcdef0123a000';
    let sequence = 0;

    /**
     * Seeds one agent raw (no defaults): `agent_<n>` by `author`, an OpenAI model, created and
     * updated at `at(0)`, with `record` over it (an `undefined` value leaves the field out).
     * Returns the seeded record.
     */
    const seedAgent = async (record: RawRecord = {}): Promise<RawRecord> => {
      const seeded: RawRecord = {
        _id: newId(),
        id: `agent_${++sequence}`,
        name: 'Agent',
        provider: 'openAI',
        model: 'gpt-4o',
        author,
        category: 'general',
        is_promoted: false,
        conversation_starters: [],
        createdAt: at(0),
        updatedAt: at(0),
        ...record,
      };
      const stored = Object.fromEntries(
        Object.entries(seeded).filter(([, value]) => value !== undefined),
      );
      await harness.seedRaw('agents', [stored]);
      return stored;
    };
    const rawAgent = async (id: string, where: RawRecord = {}): Promise<RawRecord> => {
      const [record] = await readRawWhere(harness, 'agents', { id, ...where });
      return record;
    };
    const seedUser = async (record: RawRecord = {}): Promise<string> => {
      const _id = (record._id as string | undefined) ?? newId();
      await harness.seedRaw('users', [
        {
          _id,
          email: `${_id}@example.com`,
          provider: 'local',
          role: 'USER',
          createdAt: at(0),
          updatedAt: at(0),
          ...record,
        },
      ]);
      return _id;
    };
    const grant = (
      principalType: string,
      principalId: string | null,
      resourceId: string,
      bits: number,
      resourceType: string = ResourceType.AGENT,
    ) => {
      /** A user principal is stored as an id value, a role by its name, the public one as none. */
      let principal: ReturnType<typeof storeId> | string | null = principalId;
      if (principalId != null && principalType === PrincipalType.USER) {
        principal = storeId(principalId);
      }
      return stores().aclEntries.grantPermission(
        principalType,
        principal,
        resourceType,
        storeId(resourceId),
        bits,
      );
    };
    const logicalIds = (rows: ReadonlyArray<{ id?: unknown }>) => rows.map((row) => row.id);

    /* ------------------------------------------------------------------ single reads */

    describe('getAgent', () => {
      it('reads the first match without its history, or every field for an empty projection', async () => {
        const seeded = await seedAgent({
          id: 'agent_read',
          versions: [{ name: 'v1' }, { name: 'v2' }],
          tool_resources: { file_search: { file_ids: ['f1'] } },
        });
        const found = await agents().getAgent({ id: 'agent_read' });
        expect(found).toMatchObject({
          id: 'agent_read',
          name: 'Agent',
          provider: 'openAI',
          tool_resources: { file_search: { file_ids: ['f1'] } },
        });
        expect(found).not.toHaveProperty('versions');
        expect(idOf(harness, found?._id)).toBe(seeded._id);
        expect(idOf(harness, found?.author)).toBe(author);
        expect(timeOf((found as { updatedAt?: Date } | null)?.updatedAt)).toBe(at(0).getTime());
        const full = await agents().getAgent({ id: 'agent_read' }, {});
        expect(full?.versions).toEqual([{ name: 'v1' }, { name: 'v2' }]);
        expect(await agents().getAgent({ id: 'missing' })).toBeNull();
      });

      it('applies the projections callers pass', async () => {
        const seeded = await seedAgent({
          id: 'agent_p',
          avatar: { filepath: '/a.png', source: 'local' },
        });
        const idOnly = await agents().getAgent({ id: 'agent_p' }, { _id: 1 });
        expect(Object.keys(idOnly ?? {})).toEqual(['_id']);
        expect(idOf(harness, idOnly?._id)).toBe(seeded._id);
        const named = await agents().getAgent(
          { _id: seeded._id as string },
          { _id: 1, id: 1, name: 1 },
        );
        expect(Object.keys(named ?? {}).sort()).toEqual(['_id', 'id', 'name']);
        const withoutName = await agents().getAgent({ id: 'agent_p' }, { name: 0, versions: 0 });
        expect(withoutName).not.toHaveProperty('name');
        expect(withoutName).not.toHaveProperty('versions');
        expect(withoutName).toHaveProperty('model', 'gpt-4o');
      });

      it('matches the filter shapes callers pass', async () => {
        const legacy = await seedAgent({
          id: 'agent_f',
          avatar: { filepath: '/a.png', source: 'local' },
        });
        await seedAgent({ id: 'agent_f', tenantId: 'tenant-a', name: 'Tenanted' });
        expect((await agents().getAgent({ id: 'agent_f', tenantId: 'tenant-a' }))?.name).toBe(
          'Tenanted',
        );
        expect(
          idOf(
            harness,
            (
              await agents().getAgent(
                { _id: legacy._id as string, tenantId: { $exists: false } },
                { _id: 1 },
              )
            )?._id,
          ),
        ).toBe(legacy._id);
        expect(
          await agents().getAgent(
            { id: 'agent_f', 'avatar.filepath': { $in: ['/a.png', '/b.png'] } },
            { _id: 1 },
          ),
        ).not.toBeNull();
        expect(
          await agents().getAgent(
            { id: 'agent_f', 'avatar.filepath': { $in: ['/b.png'] } },
            { _id: 1 },
          ),
        ).toBeNull();
        expect(await agents().getAgent({ id: 'agent_f', tenantId: 'tenant-b' })).toBeNull();
      });
    });

    describe('getAgents', () => {
      it('reads every match with every field, or the selected ones', async () => {
        const [a, b, c] = ascendingIds(3);
        await seedAgent({ _id: a, id: 'a', versions: [{ name: 'v' }] });
        await seedAgent({ _id: b, id: 'b', tool_resources: { context: { file_ids: ['f1'] } } });
        await seedAgent({ _id: c, id: 'c', tool_resources: { file_search: { file_ids: ['f2'] } } });
        const all = await agents().getAgents({});
        expect(logicalIds(all).sort()).toEqual(['a', 'b', 'c']);
        expect(all.find((agent) => agent.id === 'a')?.versions).toEqual([{ name: 'v' }]);
        expect(
          logicalIds(await agents().getAgents({ id: { $in: ['a', 'c', 'x'] } })).sort(),
        ).toEqual(['a', 'c']);
        expect(
          logicalIds(
            await agents().getAgents({ id: { $in: ['a', 'b', 'c'] }, _id: { $in: [b, c] } }),
          ).sort(),
        ).toEqual(['b', 'c']);
        expect(
          logicalIds(
            await agents().getAgents({
              $or: [
                { 'tool_resources.context.file_ids': { $in: ['f1'] } },
                { 'tool_resources.file_search.file_ids': { $in: ['f2'] } },
              ],
            }),
          ).sort(),
        ).toEqual(['b', 'c']);
        const selected = await agents().getAgents({ id: 'b' }, { id: 1, tool_resources: 1 });
        expect(Object.keys(selected[0]).sort()).toEqual(['_id', 'id', 'tool_resources']);
        expect(await agents().getAgents({ id: 'missing' })).toEqual([]);
      });
    });

    describe('getAgentVersions and getAgentWithVersionCount', () => {
      it('reads the history alone, empty when there is none and null without an agent', async () => {
        await seedAgent({
          id: 'agent_v',
          versions: [{ name: 'v1' }, { name: 'v2', tools: ['x'] }],
        });
        await seedAgent({ id: 'agent_none' });
        expect(await agents().getAgentVersions({ id: 'agent_v' })).toEqual([
          { name: 'v1' },
          { name: 'v2', tools: ['x'] },
        ]);
        expect(await agents().getAgentVersions({ id: 'agent_none' })).toEqual([]);
        expect(await agents().getAgentVersions({ id: 'missing' })).toBeNull();
      });

      it('reads the agent with its version count instead of its history', async () => {
        await seedAgent({
          id: 'agent_v',
          versions: [{ name: 'v1' }, { name: 'v2' }, { name: 'v3' }],
        });
        await seedAgent({ id: 'agent_v', tenantId: 'tenant-a', versions: [{ name: 'only' }] });
        await seedAgent({ id: 'agent_none' });
        const counted = await agents().getAgentWithVersionCount({
          id: 'agent_v',
          tenantId: 'tenant-a',
        });
        expect(counted).toMatchObject({ id: 'agent_v', tenantId: 'tenant-a', version: 1 });
        expect(counted).not.toHaveProperty('versions');
        expect((await agents().getAgentWithVersionCount({ id: 'agent_none' }))?.version).toBe(0);
        expect(
          (await agents().getAgentWithVersionCount({ id: 'agent_v', tenantId: { $exists: false } }))
            ?.version,
        ).toBe(3);
        expect(await agents().getAgentWithVersionCount({ id: 'missing' })).toBeNull();
      });
    });

    describe('getAgentName', () => {
      it("reads the agent's display name in the given tenant only", async () => {
        await seedAgent({ id: 'agent_n', name: 'Legacy' });
        await seedAgent({ id: 'agent_n', name: 'Tenanted', tenantId: 'tenant-a' });
        await seedAgent({ id: 'agent_blank', name: '' });
        await seedAgent({ id: 'agent_unnamed', name: undefined });
        expect(await agents().getAgentName('agent_n')).toBe('Legacy');
        expect(await agents().getAgentName('agent_n', 'tenant-a')).toBe('Tenanted');
        expect(await agents().getAgentName('agent_n', 'tenant-b')).toBeUndefined();
        expect(await agents().getAgentName('agent_blank')).toBeUndefined();
        expect(await agents().getAgentName('agent_unnamed')).toBeUndefined();
        expect(await agents().getAgentName('missing')).toBeUndefined();
      });
    });

    describe('resolveAgentGraphAccess and getAgentGraphNodes', () => {
      const graphFields = {
        tools: ['web_search'],
        mcpServerNames: ['server'],
        agent_ids: ['legacy'],
        edges: [{ from: 'a', to: 'b', edgeType: 'handoff' }],
        subagents: { enabled: true, agent_ids: ['c'] },
      };

      it('reads only the graph fields of the listed agents', async () => {
        await seedAgent({ id: 'a', ...graphFields, instructions: 'secret', versions: [{}] });
        await seedAgent({ id: 'b', provider: 'anthropic', model: 'claude' });
        await seedAgent({ id: 'c' });
        const nodes = await agents().getAgentGraphNodes(['a', 'b', 'missing']);
        expect(nodes.sort((x, y) => x.id.localeCompare(y.id))).toEqual(
          [
            { id: 'a', provider: 'openAI', model: 'gpt-4o', ...graphFields },
            { id: 'b', provider: 'anthropic', model: 'claude', edges: undefined },
          ].map((node) =>
            Object.fromEntries(Object.entries(node).filter(([, v]) => v !== undefined)),
          ),
        );
        expect(await agents().getAgentGraphNodes([])).toEqual([]);
      });

      it('keeps only the agents the resolved principals may view', async () => {
        const user = await seedUser({ role: 'EDITOR' });
        const viewable = await seedAgent({ id: 'viewable' });
        const byRole = await seedAgent({ id: 'by-role' });
        const isPublic = await seedAgent({ id: 'public' });
        const editOnly = await seedAgent({ id: 'edit-only' });
        await seedAgent({ id: 'hidden' });
        await grant(PrincipalType.USER, user, viewable._id as string, PermissionBits.VIEW);
        await grant(PrincipalType.ROLE, 'EDITOR', byRole._id as string, PermissionBits.VIEW);
        await grant(PrincipalType.PUBLIC, null, isPublic._id as string, PermissionBits.VIEW);
        await grant(PrincipalType.USER, user, editOnly._id as string, PermissionBits.EDIT);
        const ids = ['viewable', 'by-role', 'public', 'edit-only', 'hidden'];
        const access = await agents().resolveAgentGraphAccess({ userId: user });
        expect(
          (await agents().getAgentGraphNodes(ids, access)).map((node) => node.id).sort(),
        ).toEqual(['by-role', 'public', 'viewable']);
        const noRole = await agents().resolveAgentGraphAccess({ userId: user, role: null });
        expect(
          (await agents().getAgentGraphNodes(ids, noRole)).map((node) => node.id).sort(),
        ).toEqual(['public', 'viewable']);
        expect((await agents().getAgentGraphNodes(ids)).length).toBe(5);
      });
    });

    describe('MCP server, model-list and promotion reads', () => {
      it('finds the agents referencing an MCP server, and lists those that reference any', async () => {
        const a = await seedAgent({ id: 'a', mcpServerNames: ['github', 'slack'] });
        const b = await seedAgent({ id: 'b', mcpServerNames: ['github'] });
        await seedAgent({ id: 'c', mcpServerNames: [] });
        await seedAgent({ id: 'd' });
        expect(
          (await agents().getAgentIdsByMCPServerName('github'))
            .map((id) => idOf(harness, id))
            .sort(),
        ).toEqual([a._id, b._id].sort());
        expect(await agents().getAgentIdsByMCPServerName('none')).toEqual([]);
        const referencing = await agents().getAgentsWithMCPServerNames();
        expect(
          referencing
            .map((agent) => [
              idOf(harness, agent._id),
              agent.mcpServerNames,
              Object.keys(agent).sort(),
            ])
            .sort(),
        ).toEqual(
          [
            [a._id, ['github', 'slack'], ['_id', 'mcpServerNames']],
            [b._id, ['github'], ['_id', 'mcpServerNames']],
          ].sort(),
        );
      });

      it('reads the model-list fields of the given store ids', async () => {
        const a = await seedAgent({
          id: 'a',
          description: 'Desc',
          instructions: 'never',
          versions: [{ name: 'v' }],
        });
        await seedAgent({ id: 'b' });
        const [summary, ...rest] = await agents().getAgentModelSummaries([
          storeId(a._id as string),
        ]);
        expect(rest).toEqual([]);
        expect(Object.keys(summary).sort()).toEqual([
          '_id',
          'author',
          'createdAt',
          'description',
          'id',
          'name',
          'provider',
        ]);
        expect(summary).toMatchObject({
          id: 'a',
          name: 'Agent',
          description: 'Desc',
          provider: 'openAI',
        });
        expect(idOf(harness, summary.author)).toBe(author);
        expect(await agents().getAgentModelSummaries([a._id as string])).toHaveLength(1);
        expect(await agents().getAgentModelSummaries([])).toEqual([]);
      });

      it('counts the promoted agents', async () => {
        await seedAgent({ is_promoted: true });
        await seedAgent({ is_promoted: true, tenantId: 'tenant-a' });
        await seedAgent({ is_promoted: false });
        await seedAgent({ is_promoted: undefined });
        expect(await agents().countPromotedAgents()).toBe(2);
        expect(await inTenant('tenant-a', () => agents().countPromotedAgents())).toBe(1);
      });
    });

    /* ------------------------------------------------------------------ browser listing */

    describe('getListAgentsByAccess', () => {
      type ListParams = Parameters<ReturnType<typeof agents>['getListAgentsByAccess']>[0];
      const list = (params: ListParams) => agents().getListAgentsByAccess(params);
      /** Every page of the listing with `params`, until `has_more` is false. */
      const allPages = async (params: ListParams): Promise<unknown[][]> => {
        const pages: unknown[][] = [];
        let after: string | null = null;
        for (let page = 0; page < 50; page++) {
          const result = await list({ ...params, after });
          pages.push(logicalIds(result.data));
          if (!result.has_more) {
            expect(result.after).toBeNull();
            return pages;
          }
          after = result.after;
        }
        throw new Error('getListAgentsByAccess did not finish paging');
      };

      it('lists the accessible agents with the listing fields, author as a string', async () => {
        const a = await seedAgent({
          id: 'a',
          updatedAt: at(2),
          description: 'Desc',
          instructions: 'never listed',
          tools: ['execute_code'],
          versions: [{ name: 'v' }],
          avatar: { filepath: '/a.png', source: 'local' },
          support_contact: { name: 'Support' },
        });
        const b = await seedAgent({ id: 'b', updatedAt: at(1) });
        await seedAgent({ id: 'hidden', updatedAt: at(3) });
        const result = await list({
          accessibleIds: [storeId(a._id as string), storeId(b._id as string)],
        });
        expect(result).toMatchObject({
          object: 'list',
          first_id: 'a',
          last_id: 'b',
          has_more: false,
          after: null,
        });
        expect(logicalIds(result.data)).toEqual(['a', 'b']);
        const [row] = result.data;
        expect(Object.keys(row).sort()).toEqual([
          '_id',
          'author',
          'avatar',
          'category',
          'conversation_starters',
          'description',
          'id',
          'is_promoted',
          'name',
          'support_contact',
          'updatedAt',
        ]);
        expect(row.author).toBe(author);
        expect(idOf(harness, row._id)).toBe(a._id);
        expect(timeOf(row.updatedAt)).toBe(at(2).getTime());
      });

      it('lists none without accessible ids, and the tenant agents for null ids', async () => {
        await seedAgent({ id: 'legacy' });
        await seedAgent({ id: 'nulled', tenantId: null });
        await seedAgent({ id: 'tenanted', tenantId: 'tenant-a' });
        expect((await list({})).data).toEqual([]);
        expect((await list({ accessibleIds: [] })).data).toEqual([]);
        expect(logicalIds((await list({ accessibleIds: null })).data).sort()).toEqual([
          'legacy',
          'nulled',
        ]);
        expect(
          logicalIds((await list({ accessibleIds: null, tenantId: 'tenant-a' })).data),
        ).toEqual(['tenanted']);
      });

      it('adds the skill and execution settings on request, of the tools only code execution', async () => {
        const a = await seedAgent({
          id: 'a',
          tools: ['web_search', 'execute_code'],
          skills: ['s1'],
          skills_enabled: true,
          skills_scope: 'selected',
          stateful_code_sessions: true,
          agent_ids: ['x'],
          edges: [{ from: 'a', to: 'b', edgeType: 'handoff', prompt: 'p' }],
          subagents: { enabled: true, agent_ids: ['c'], allowSelf: true },
        });
        const b = await seedAgent({ id: 'b', tools: ['web_search'] });
        const ids = [storeId(a._id as string), storeId(b._id as string)];
        const plain = (await list({ accessibleIds: ids })).data.find((row) => row.id === 'a');
        expect(plain).not.toHaveProperty('tools');
        expect(plain).not.toHaveProperty('skills');
        const detailed = await list({
          accessibleIds: ids,
          includeSkillConfig: true,
          includeExecutionConfig: true,
        });
        expect(detailed.data.find((row) => row.id === 'a')).toMatchObject({
          tools: ['execute_code'],
          skills: ['s1'],
          skills_enabled: true,
          skills_scope: 'selected',
          stateful_code_sessions: true,
          agent_ids: ['x'],
          edges: [{ from: 'a', to: 'b' }],
          subagents: { enabled: true, agent_ids: ['c'] },
        });
        const row = detailed.data.find((item) => item.id === 'a') as RawRecord;
        expect((row.edges as RawRecord[])[0]).not.toHaveProperty('prompt');
        expect(row.subagents).not.toHaveProperty('allowSelf');
        expect(detailed.data.find((item) => item.id === 'b')?.tools).toEqual([]);
      });

      it('pages the default order, most recently updated first, ties by id', async () => {
        const ids = ascendingIds(5);
        await seedAgent({ _id: ids[0], id: 'tie-1', updatedAt: at(5) });
        await seedAgent({ _id: ids[1], id: 'old', updatedAt: at(1) });
        await seedAgent({ _id: ids[2], id: 'tie-2', updatedAt: at(5) });
        await seedAgent({ _id: ids[3], id: 'new', updatedAt: at(9) });
        await seedAgent({ _id: ids[4], id: 'tie-3', updatedAt: at(5) });
        const accessibleIds = ids.map(storeId);
        expect(await allPages({ accessibleIds, limit: 2 })).toEqual([
          ['new', 'tie-1'],
          ['tie-2', 'tie-3'],
          ['old'],
        ]);
        expect(
          await allPages({ accessibleIds, limit: 2, sort: 'unknown' as AgentListSortOption }),
        ).toEqual([['new', 'tie-1'], ['tie-2', 'tie-3'], ['old']]);
        const unpaged = await list({ accessibleIds, limit: null });
        expect(logicalIds(unpaged.data)).toEqual(['new', 'tie-1', 'tie-2', 'tie-3', 'old']);
        expect(unpaged).toMatchObject({ has_more: false, after: null });
      });

      it('accepts a legacy cursor of the default order', async () => {
        const ids = ascendingIds(3);
        await seedAgent({ _id: ids[0], id: 'a', updatedAt: at(3) });
        await seedAgent({ _id: ids[1], id: 'b', updatedAt: at(2) });
        await seedAgent({ _id: ids[2], id: 'c', updatedAt: at(1) });
        const after = encodeCursor({ updatedAt: at(3).toISOString(), _id: ids[0] });
        expect(logicalIds((await list({ accessibleIds: ids.map(storeId), after })).data)).toEqual([
          'b',
          'c',
        ]);
      });

      it.each([
        [0, 20],
        [-5, 1],
        [5000, 1000],
        ['abc' as unknown as number, 20],
      ])('clamps the limit %p to %p', async (limit, expected) => {
        const ids = ascendingIds(25);
        for (const [index, _id] of ids.entries()) {
          await seedAgent({ _id, id: `a${index}`, updatedAt: at(index) });
        }
        const result = await list({ accessibleIds: ids.map(storeId), limit });
        expect(result.data).toHaveLength(Math.min(expected, 25));
        expect(result.has_more).toBe(expected < 25);
      });

      it('pages the newest and oldest orders by creation, missing creation times last or first', async () => {
        const ids = ascendingIds(5);
        await seedAgent({ _id: ids[0], id: 'c1', createdAt: at(1) });
        await seedAgent({ _id: ids[1], id: 'c3', createdAt: at(3) });
        await seedAgent({ _id: ids[2], id: 'none', createdAt: undefined });
        await seedAgent({ _id: ids[3], id: 'c2', createdAt: at(2) });
        await seedAgent({ _id: ids[4], id: 'null', createdAt: null });
        const accessibleIds = ids.map(storeId);
        expect((await allPages({ accessibleIds, limit: 2, sort: 'newest' })).flat()).toEqual([
          'c3',
          'c2',
          'c1',
          'none',
          'null',
        ]);
        expect((await allPages({ accessibleIds, limit: 2, sort: 'oldest' })).flat()).toEqual([
          'null',
          'none',
          'c1',
          'c2',
          'c3',
        ]);
        const page = await list({ accessibleIds, limit: 2, sort: 'newest' });
        expect(page.data[0]).not.toHaveProperty('createdAt');
      });

      it('orders by how many users of the tenant favor the agent, the rest by id', async () => {
        const ids = ascendingIds(5);
        await seedAgent({ _id: ids[0], id: 'zero-1' });
        await seedAgent({ _id: ids[1], id: 'two' });
        await seedAgent({ _id: ids[2], id: 'one' });
        await seedAgent({ _id: ids[3], id: 'zero-2' });
        await seedAgent({ _id: ids[4], id: 'three' });
        const favor = (agentIds: string[], tenantId?: string) =>
          seedUser({ favorites: agentIds.map((agentId) => ({ agentId })), tenantId });
        await favor(['three', 'two', 'one']);
        await favor(['three', 'two', 'two']);
        await favor(['three']);
        await favor(['zero-1', 'zero-1', 'zero-1', 'zero-1'], 'tenant-a');
        const accessibleIds = ids.map(storeId);
        expect(await allPages({ accessibleIds, limit: 2, sort: 'popular' })).toEqual([
          ['three', 'two'],
          ['one', 'zero-1'],
          ['zero-2'],
        ]);
        const page = await list({ accessibleIds, limit: 2, sort: 'popular' });
        expect(page.data[0]).not.toHaveProperty('favoriteCount');
      });

      it('orders by the owner name shown on the card, case-insensitively', async () => {
        const named = await seedUser({ name: 'charlie', username: 'c' });
        const emailNamed = await seedUser({ name: 'me@example.com', username: 'delta' });
        const ids = ascendingIds(5);
        await seedAgent({ _id: ids[0], id: 'nobody' });
        await seedAgent({ _id: ids[1], id: 'support-b', support_contact: { name: 'bravo' } });
        await seedAgent({ _id: ids[2], id: 'owned' });
        await seedAgent({ _id: ids[3], id: 'support-a', support_contact: { name: '  Alpha ' } });
        await seedAgent({ _id: ids[4], id: 'username' });
        await grant(PrincipalType.USER, named, ids[2], OWNER);
        await grant(PrincipalType.USER, emailNamed, ids[4], OWNER);
        const accessibleIds = ids.map(storeId);
        expect((await allPages({ accessibleIds, limit: 2, sort: 'author' })).flat()).toEqual([
          'support-a',
          'support-b',
          'owned',
          'username',
          'nobody',
        ]);
        const { data } = await list({ accessibleIds, sort: 'author' });
        const byId = Object.fromEntries(data.map((row) => [row.id, row]));
        expect(byId.owned).toMatchObject({
          owner_contact: { name: 'charlie' },
          _ownerContactResolved: true,
        });
        expect(byId.username).toMatchObject({ owner_contact: { name: 'delta' } });
        expect(byId['support-a']).not.toHaveProperty('owner_contact');
        expect(byId.nobody).not.toHaveProperty('owner_contact');
        expect(byId.owned).not.toHaveProperty('authorDisplayName');
        expect(byId.owned).not.toHaveProperty('authorSortKey');
        expect(byId.owned.author).toBe(author);
      });

      it.each(['newest', 'oldest', 'popular', 'author'] as AgentListSortOption[])(
        'refuses a cursor of another order under %p',
        async (sort) => {
          const ids = ascendingIds(3);
          for (const [index, _id] of ids.entries()) {
            await seedAgent({ _id, id: `a${index}`, updatedAt: at(index) });
          }
          const accessibleIds = ids.map(storeId);
          const recent = await list({ accessibleIds, limit: 1 });
          expect(recent.after).toEqual(expect.any(String));
          await expect(list({ accessibleIds, sort, after: recent.after })).rejects.toMatchObject({
            name: 'AgentSortCursorError',
            code: 'AGENT_SORT_CURSOR_INVALID',
            failure: 'ordering-mismatch',
          });
        },
      );

      it.each([
        ['garbage', 'not base64 json'],
        ['an array', encodeCursor([1])],
        [
          'a bad id',
          encodeCursor({
            sort: 'recent',
            version: 1,
            primary: at(1).toISOString(),
            secondary: 'x',
          }),
        ],
        [
          'a bad date',
          encodeCursor({ sort: 'recent', version: 1, primary: 'never', secondary: 'a'.repeat(24) }),
        ],
        [
          'an unknown order',
          encodeCursor({ sort: 'sideways', primary: '', secondary: 'a'.repeat(24) }),
        ],
      ])('refuses an unreadable cursor: %s', async (_label, after) => {
        const a = await seedAgent();
        await expect(
          list({ accessibleIds: [storeId(a._id as string)], after }),
        ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'unreadable' });
      });

      it('matches the filters callers pass, a string author as an id', async () => {
        const other = '0123456789abcdef0123a001';
        const ids = ascendingIds(5);
        await seedAgent({ _id: ids[0], id: 'mine', name: 'Research helper', category: 'research' });
        await seedAgent({
          _id: ids[1],
          id: 'theirs',
          author: other,
          description: 'A RESEARCH tool',
        });
        await seedAgent({ _id: ids[2], id: 'promoted', is_promoted: true, name: 'Writer' });
        await seedAgent({
          _id: ids[3],
          id: 'legacy-promoted',
          is_promoted: undefined,
          name: 'Old',
        });
        await seedAgent({ _id: ids[4], id: 'dotted', name: 'research.v2' });
        const accessibleIds = ids.map(storeId);
        const filtered = async (otherParams: StoreFilter, sort?: AgentListSortOption) =>
          logicalIds((await list({ accessibleIds, otherParams, sort })).data).sort();
        expect(await filtered({ author })).toEqual([
          'dotted',
          'legacy-promoted',
          'mine',
          'promoted',
        ]);
        expect(await filtered({ author: other }, 'author')).toEqual(['theirs']);
        expect(await filtered({ author: other }, 'popular')).toEqual(['theirs']);
        expect(await filtered({ category: 'research' })).toEqual(['mine']);
        expect(await filtered({ is_promoted: { $ne: true } })).toEqual([
          'dotted',
          'legacy-promoted',
          'mine',
          'theirs',
        ]);
        const search: StoreFilter = {
          $or: [
            { name: { $regex: 'research', $options: 'i' } },
            { description: { $regex: 'research', $options: 'i' } },
          ],
        };
        expect(await filtered(search)).toEqual(['dotted', 'mine', 'theirs']);
        expect(await filtered({ name: { $regex: 'research\\.v', $options: 'i' } })).toEqual([
          'dotted',
        ]);
      });
    });

    /* ------------------------------------------------------------------ management listing */

    describe('getAgentManagementListByAccess', () => {
      it("pages the tenant's agents, most recently updated first, with version counts", async () => {
        const ids = ascendingIds(5);
        await seedAgent({
          _id: ids[0],
          id: 'a',
          tenantId: 'tenant-a',
          updatedAt: at(3),
          versions: [{}, {}],
        });
        await seedAgent({ _id: ids[1], id: 'b', tenantId: 'tenant-a', updatedAt: at(5) });
        await seedAgent({
          _id: ids[2],
          id: 'c',
          tenantId: 'tenant-a',
          updatedAt: at(3),
          versions: [{}],
        });
        await seedAgent({ _id: ids[3], id: 'other', tenantId: 'tenant-b', updatedAt: at(9) });
        await seedAgent({ _id: ids[4], id: 'legacy', updatedAt: at(9) });
        const first = await agents().getAgentManagementListByAccess({
          accessibleIds: null,
          tenantId: 'tenant-a',
          limit: 2,
        });
        expect(logicalIds(first.data)).toEqual(['b', 'a']);
        expect(first.data.map((agent) => agent.version)).toEqual([0, 2]);
        expect(first.data[1]).not.toHaveProperty('versions');
        expect(first.data[1]).toMatchObject({ provider: 'openAI', tenantId: 'tenant-a' });
        expect(first.has_more).toBe(true);
        const second = await agents().getAgentManagementListByAccess({
          accessibleIds: null,
          tenantId: 'tenant-a',
          limit: 2,
          after: first.after,
        });
        expect(logicalIds(second.data)).toEqual(['c']);
        expect(second).toMatchObject({ has_more: false, after: null });
        expect(second.data[0].version).toBe(1);
        expect(timeOf(second.data[0].updatedAt)).toBe(at(3).getTime());
      });

      it('limits the page to the accessible agents', async () => {
        const ids = ascendingIds(3);
        await seedAgent({ _id: ids[0], id: 'a', tenantId: 'tenant-a' });
        await seedAgent({ _id: ids[1], id: 'b', tenantId: 'tenant-a' });
        await seedAgent({ _id: ids[2], id: 'c', tenantId: 'tenant-b' });
        const page = await agents().getAgentManagementListByAccess({
          accessibleIds: [storeId(ids[1]), storeId(ids[2])],
          tenantId: 'tenant-a',
          limit: 10,
        });
        expect(logicalIds(page.data)).toEqual(['b']);
        expect(
          (
            await agents().getAgentManagementListByAccess({
              accessibleIds: [],
              tenantId: 'tenant-a',
              limit: 10,
            })
          ).data,
        ).toEqual([]);
      });
    });

    /* ------------------------------------------------------------------ shared resources */

    describe('getSharedResourceFileIds', () => {
      it('reports the files another reference keeps, per agent and tool resource', async () => {
        const own = await seedAgent({
          id: 'own',
          tool_resources: {
            file_search: { file_ids: ['f1', 'f2'] },
            context: { file_ids: ['f2'] },
          },
        });
        await seedAgent({
          id: 'copy',
          tenantId: 'tenant-b',
          tool_resources: { execute_code: { file_ids: ['f3'] }, ocr: { file_ids: ['f1'] } },
        });
        await seedAgent({
          id: 'assistant',
          tool_resources: { code_interpreter: { file_ids: ['f4'] } },
        });
        const shared = (params: Record<string, string>) =>
          agents()
            .getSharedResourceFileIds({ file_ids: ['f1', 'f2', 'f3', 'f4'], ...params })
            .then((ids) => ids.sort());
        expect(await shared({})).toEqual(['f1', 'f2', 'f3']);
        expect(await shared({ excludeAgentObjectId: own._id as string })).toEqual(['f1', 'f3']);
        expect(
          await shared({
            excludeAgentObjectId: own._id as string,
            excludeToolResource: 'file_search',
          }),
        ).toEqual(['f1', 'f2', 'f3']);
        expect(
          await shared({ excludeAgentObjectId: own._id as string, excludeToolResource: 'context' }),
        ).toEqual(['f1', 'f2', 'f3']);
        expect(await agents().getSharedResourceFileIds({ file_ids: [] })).toEqual([]);
      });
    });

    /* ------------------------------------------------------------------ deletes */

    describe('deleteAgent', () => {
      it('deletes the first match with its ACL entries, then prunes graphs and favorites in its tenant', async () => {
        const target = await seedAgent({
          id: 'target',
          tenantId: 'tenant-a',
          versions: [{ name: 'v' }],
        });
        const sibling = await seedAgent({ id: 'target', tenantId: 'tenant-b' });
        await seedAgent({
          id: 'graph',
          tenantId: 'tenant-a',
          edges: [
            { from: 'graph', to: 'target', edgeType: 'handoff' },
            { from: ['graph', 'target'], to: 'helper', edgeType: 'direct' },
            { from: 'graph', to: 'helper', edgeType: 'handoff' },
          ],
        });
        await seedAgent({
          id: 'foreign-graph',
          tenantId: 'tenant-b',
          edges: [{ from: 'foreign-graph', to: 'target', edgeType: 'handoff' }],
        });
        const fan = await seedUser({
          tenantId: 'tenant-a',
          favorites: [{ agentId: 'target' }, { model: 'gpt-4o', endpoint: 'openAI' }],
        });
        const foreignFan = await seedUser({
          tenantId: 'tenant-b',
          favorites: [{ agentId: 'target' }],
        });
        const user = newId();
        await grant(PrincipalType.USER, user, target._id as string, OWNER);
        await grant(
          PrincipalType.USER,
          user,
          target._id as string,
          OWNER,
          ResourceType.REMOTE_AGENT,
        );
        await grant(PrincipalType.USER, user, sibling._id as string, OWNER);

        const deleted = await agents().deleteAgent({ id: 'target', tenantId: 'tenant-a' });
        expect(deleted).toMatchObject({
          id: 'target',
          tenantId: 'tenant-a',
          versions: [{ name: 'v' }],
        });
        expect(idOf(harness, deleted?._id)).toBe(target._id);
        expect(await rawAgent('target', { tenantId: 'tenant-a' })).toBeUndefined();
        expect(await rawAgent('target', { tenantId: 'tenant-b' })).toBeDefined();
        expect(
          (await harness.readRaw('aclentries')).map((entry) => idOf(harness, entry.resourceId)),
        ).toEqual([sibling._id]);
        expect((await rawAgent('graph')).edges).toEqual([
          { from: ['graph'], to: 'helper', edgeType: 'direct' },
          { from: 'graph', to: 'helper', edgeType: 'handoff' },
        ]);
        expect((await rawAgent('foreign-graph')).edges).toHaveLength(1);
        const [fanRecord] = await readRawWhere(harness, 'users', { _id: fan });
        expect(fanRecord.favorites).toEqual([{ model: 'gpt-4o', endpoint: 'openAI' }]);
        const [foreignRecord] = await readRawWhere(harness, 'users', { _id: foreignFan });
        expect(foreignRecord.favorites).toEqual([{ agentId: 'target' }]);
        expect(await agents().deleteAgent({ id: 'target', tenantId: 'tenant-a' })).toBeNull();
      });

      it('prunes untenanted graphs and favorites for an untenanted agent', async () => {
        await seedAgent({ id: 'target' });
        await seedAgent({
          id: 'graph',
          edges: [{ from: 'graph', to: 'target', edgeType: 'handoff' }],
        });
        // NOTE(contract): an agent stored without a tenant prunes graphs and favorites of every
        // tenant (the cleanup filters on `tenantId` only when the deleted agent has one), while
        // an agent of a tenant prunes only its own tenant's.
        await seedAgent({
          id: 'tenant-graph',
          tenantId: 'tenant-a',
          edges: [{ from: 'tenant-graph', to: 'target', edgeType: 'handoff' }],
        });
        const fan = await seedUser({ favorites: [{ agentId: 'target' }] });
        const tenantFan = await seedUser({
          tenantId: 'tenant-a',
          favorites: [{ agentId: 'target' }],
        });
        expect(await agents().deleteAgent({ id: 'target' })).not.toBeNull();
        expect((await rawAgent('graph')).edges).toEqual([]);
        expect((await rawAgent('tenant-graph')).edges).toEqual([]);
        expect((await readRawWhere(harness, 'users', { _id: fan }))[0].favorites).toEqual([]);
        expect((await readRawWhere(harness, 'users', { _id: tenantFan }))[0].favorites).toEqual([]);
      });
    });

    describe('removeAgentFromUserFavorites', () => {
      it("removes the agent from the listed users' favorites in the agent's tenant", async () => {
        const agent = await seedAgent({ id: 'fav', tenantId: 'tenant-a' });
        const listed = await seedUser({
          tenantId: 'tenant-a',
          favorites: [{ agentId: 'fav' }, { agentId: 'other' }],
        });
        const unlisted = await seedUser({ tenantId: 'tenant-a', favorites: [{ agentId: 'fav' }] });
        const otherTenant = await seedUser({
          tenantId: 'tenant-b',
          favorites: [{ agentId: 'fav' }],
        });
        await agents().removeAgentFromUserFavorites(agent._id as string, [listed, otherTenant]);
        const favoritesOf = async (_id: string) =>
          (await readRawWhere(harness, 'users', { _id }))[0].favorites;
        expect(await favoritesOf(listed)).toEqual([{ agentId: 'other' }]);
        expect(await favoritesOf(unlisted)).toEqual([{ agentId: 'fav' }]);
        expect(await favoritesOf(otherTenant)).toEqual([{ agentId: 'fav' }]);
        await agents().removeAgentFromUserFavorites(newId(), [unlisted]);
        expect(await favoritesOf(unlisted)).toEqual([{ agentId: 'fav' }]);
      });
    });

    describe('deleteUserAgents', () => {
      it("deletes the user's sole-owned and legacy agents with their ACL entries and references", async () => {
        const user = await seedUser();
        const coOwner = newId();
        const sole = await seedAgent({ id: 'sole', author: newId(), tenantId: 'tenant-a' });
        const shared = await seedAgent({ id: 'shared' });
        await seedAgent({ id: 'legacy', author: user });
        const migrated = await seedAgent({ id: 'migrated', author: user });
        const viewer = await seedAgent({ id: 'viewer' });
        await seedAgent({
          id: 'graph',
          edges: [
            { from: 'graph', to: 'legacy', edgeType: 'handoff' },
            { from: 'graph', to: 'viewer', edgeType: 'handoff' },
          ],
        });
        await seedAgent({
          id: 'tenant-graph',
          tenantId: 'tenant-a',
          edges: [{ from: 'tenant-graph', to: 'sole', edgeType: 'handoff' }],
        });
        const fan = await seedUser({ favorites: [{ agentId: 'legacy' }, { agentId: 'shared' }] });
        await grant(PrincipalType.USER, user, sole._id as string, OWNER);
        await grant(PrincipalType.USER, user, sole._id as string, OWNER, ResourceType.REMOTE_AGENT);
        await grant(PrincipalType.USER, user, shared._id as string, OWNER);
        await grant(PrincipalType.USER, coOwner, shared._id as string, OWNER);
        await grant(PrincipalType.USER, coOwner, migrated._id as string, OWNER);
        await grant(PrincipalType.USER, user, viewer._id as string, PermissionBits.VIEW);

        await agents().deleteUserAgents(user);
        expect((await harness.readRaw('agents')).map((agent) => agent.id).sort()).toEqual([
          'graph',
          'migrated',
          'shared',
          'tenant-graph',
          'viewer',
        ]);
        expect(
          (await harness.readRaw('aclentries'))
            .map((entry) => idOf(harness, entry.resourceId))
            .sort(),
        ).toEqual([shared._id, shared._id, migrated._id, viewer._id].sort());
        expect((await rawAgent('graph')).edges).toEqual([
          { from: 'graph', to: 'viewer', edgeType: 'handoff' },
        ]);
        expect((await rawAgent('tenant-graph')).edges).toEqual([]);
        expect((await readRawWhere(harness, 'users', { _id: fan }))[0].favorites).toEqual([
          { agentId: 'shared' },
        ]);
      });

      it('removes ACL entries left by an interrupted earlier attempt', async () => {
        const user = await seedUser();
        const gone = newId();
        await grant(PrincipalType.USER, user, gone, OWNER);
        await agents().deleteUserAgents(user);
        expect(await harness.readRaw('aclentries')).toEqual([]);
        await agents().deleteUserAgents(newId());
      });
    });

    /* ------------------------------------------------------------------ tenants */

    describe('tenant scoping', () => {
      it('reads, lists and counts only the ambient tenant agents', async () => {
        const a = await seedAgent({
          id: 'same',
          tenantId: 'tenant-a',
          name: 'A',
          is_promoted: true,
        });
        const b = await seedAgent({ id: 'same', tenantId: 'tenant-b', name: 'B' });
        await seedAgent({ id: 'legacy', name: 'Legacy' });
        expect((await inTenant('tenant-a', () => agents().getAgent({ id: 'same' })))?.name).toBe(
          'A',
        );
        expect((await inTenant('tenant-b', () => agents().getAgent({ id: 'same' })))?.name).toBe(
          'B',
        );
        expect(await inTenant('tenant-a', () => agents().getAgent({ id: 'legacy' }))).toBeNull();
        expect(
          (await inTenant('tenant-b', () => agents().getAgentWithVersionCount({ id: 'same' })))
            ?.name,
        ).toBe('B');
        expect(logicalIds(await agents().getAgents({})).sort()).toEqual(['legacy', 'same', 'same']);
        expect(
          logicalIds(
            (
              await inTenant('tenant-a', () =>
                agents().getListAgentsByAccess({
                  accessibleIds: [storeId(a._id as string), storeId(b._id as string)],
                }),
              )
            ).data,
          ),
        ).toEqual(['same']);
        expect(await inTenant('tenant-b', () => agents().deleteAgent({ id: 'legacy' }))).toBeNull();
        expect(await inTenant('tenant-b', () => agents().getAgentName('same', 'tenant-b'))).toBe(
          'B',
        );
        expect(
          await inTenant('tenant-b', () => agents().getAgentName('same', 'tenant-a')),
        ).toBeUndefined();
      });
    });
  });
}
