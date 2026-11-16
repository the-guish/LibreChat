/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AgentStore` contract (`~/ports/agent`), second part, ported from `methods/agent.spec.ts`:
 * the writes. `createAgent` with its first version, derived MCP server names and the skill
 * allowlist self-heal; `updateAgent` with its version history (what a version snapshots, the
 * duplicate-version rule with its key-order sensitive object comparison, `forceVersion`,
 * `skipVersioning`, the `version` count of a suppressed entry, the action metadata hash) and the
 * `$push`/`$pull`/`$addToSet`/`$unset` shapes callers pass through it; the avatar write; the
 * tool-resource file writes; `revertAgentVersion`; duplicate ids through `harness.errors`; and
 * tenant stamping.
 *
 * The reads, listings and deletes are in `agent.contract.ts`. Not here (they stay in the method
 * spec): the code-environment reference leases and their restore-on-loss path (S9 stores), the
 * hash helper `generateActionMetadataHash` (not in the port), and cases that make a query fail.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const BASE = Date.parse('2026-05-01T00:00:00.000Z');
/** A fixed instant `minutes` after {@link BASE}. */
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

/** The fields a version snapshot never carries, whatever the update. */
const NEVER_IN_A_VERSION = ['_id', 'id', 'author', '__v', 'versions'];

export function describeAgentVersionsContract(harness: ContractHarness): void {
  describe(`AgentStore contract, writes and versions: ${harness.name}`, () => {
    useContractHarness(harness);

    const agents = (deps?: Parameters<ContractHarness['createStores']>[0]) =>
      harness.createStores(deps).agents;
    const newId = () => harness.ids.generate();
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const author = '0123456789abcdef0123b000';
    const editor = '0123456789abcdef0123b001';
    let sequence = 0;

    /** The data of a new agent, `agent_<n>` by `author`, with `record` over it. */
    const agentData = (record: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: `agent_${++sequence}`,
      name: 'Agent',
      provider: 'openAI',
      model: 'gpt-4o',
      author,
      ...record,
    });
    /** Creates an agent through the store; returns its logical id. */
    const create = async (record: Record<string, unknown> = {}): Promise<string> => {
      const data = agentData(record);
      await agents().createAgent(data);
      return data.id as string;
    };
    const rawAgent = async (id: string, where: RawRecord = {}): Promise<RawRecord> => {
      const [record] = await readRawWhere(harness, 'agents', { id, ...where });
      return record;
    };
    const versionsOf = async (id: string) => ((await rawAgent(id))?.versions ?? []) as RawRecord[];
    const lastVersion = async (id: string) => {
      const versions = await versionsOf(id);
      return versions[versions.length - 1];
    };
    const seedSkill = async (): Promise<string> => {
      const _id = newId();
      await harness.seedRaw('skills', [
        {
          _id,
          name: `skill-${_id}`,
          description: 'A skill',
          body: 'body',
          author,
          createdAt: at(0),
          updatedAt: at(0),
        },
      ]);
      return _id;
    };

    /* ------------------------------------------------------------------ createAgent */

    describe('createAgent', () => {
      it('creates the agent with its first version, a default category and derived server names', async () => {
        const before = Date.now();
        const created = await agents().createAgent(
          agentData({
            id: 'agent_new',
            tools: ['web_search', 'search_mcp_github', 'issue_mcp_github', 'x_action_y'],
            instructions: 'Be brief',
          }),
        );
        expect(created).toMatchObject({
          id: 'agent_new',
          name: 'Agent',
          category: 'general',
          mcpServerNames: ['github'],
          is_promoted: false,
          tools: ['web_search', 'search_mcp_github', 'issue_mcp_github', 'x_action_y'],
        });
        expect(idOf(harness, created._id)).toEqual(expect.any(String));
        expect(idOf(harness, created.author)).toBe(author);
        const stored = await rawAgent('agent_new');
        expect(timeOf(stored.createdAt)).toBeGreaterThanOrEqual(before);
        const [first, ...rest] = stored.versions as RawRecord[];
        expect(rest).toEqual([]);
        expect(first).toMatchObject({
          id: 'agent_new',
          name: 'Agent',
          provider: 'openAI',
          instructions: 'Be brief',
        });
        expect(first).not.toHaveProperty('author');
        expect(timeOf(first.createdAt)).toBe(timeOf(first.updatedAt));
      });

      it('keeps the server names and category the caller resolved', async () => {
        const created = await agents().createAgent(
          agentData({
            category: 'research',
            tools: ['search_mcp_my_mcp_server'],
            mcpServerNames: ['my_mcp_server'],
          }),
        );
        expect(created).toMatchObject({ category: 'research', mcpServerNames: ['my_mcp_server'] });
      });

      it('drops skill ids that no longer exist, and turns skills off when that empties a legacy allowlist', async () => {
        const kept = await seedSkill();
        const deleted = newId();
        const pruned = await agents().createAgent(
          agentData({
            skills: [kept.toUpperCase(), deleted, 'not-an-id', kept],
            skills_enabled: true,
          }),
        );
        expect(pruned).toMatchObject({ skills: [kept], skills_enabled: true });
        const emptied = await agents().createAgent(
          agentData({ skills: [deleted], skills_enabled: true }),
        );
        expect(emptied).toMatchObject({ skills: [], skills_enabled: false });
        const scoped = await agents().createAgent(
          agentData({ skills: [deleted], skills_enabled: true, skills_scope: 'all' }),
        );
        expect(scoped).toMatchObject({ skills: [], skills_enabled: true, skills_scope: 'all' });
        const external = await agents({ isExternalSkillId: (id) => id === deleted }).createAgent(
          agentData({ skills: [deleted], skills_enabled: true }),
        );
        expect(external).toMatchObject({ skills: [deleted], skills_enabled: true });
      });

      it('rejects a second agent with the same id in the same tenant as a duplicate key', async () => {
        await create({ id: 'agent_dup' });
        let rejection: unknown;
        try {
          await create({ id: 'agent_dup', name: 'Second' });
        } catch (error) {
          rejection = error;
        }
        expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
        expect(harness.errors.duplicateKeyFields(rejection)).toEqual(
          expect.arrayContaining(['id']),
        );
        await inTenant('tenant-a', () => create({ id: 'agent_dup', name: 'Tenanted' }));
        expect((await rawAgent('agent_dup', { tenantId: 'tenant-a' })).name).toBe('Tenanted');
        expect((await harness.readRaw('agents')).length).toBe(2);
      });
    });

    /* ------------------------------------------------------------------ updateAgent */

    describe('updateAgent', () => {
      it('records a version of the updated agent, with the editor and without the author', async () => {
        const id = await create({ description: 'Old', tools: ['web_search'] });
        const before = (await rawAgent(id)).updatedAt;
        const updated = await agents().updateAgent(
          { id },
          { name: 'Renamed', description: 'New' },
          { updatingUserId: editor },
        );
        expect(updated).toMatchObject({ id, name: 'Renamed', description: 'New' });
        expect(updated).not.toHaveProperty('version');
        expect(updated?.versions).toHaveLength(2);
        const version = await lastVersion(id);
        expect(version).toMatchObject({
          name: 'Renamed',
          description: 'New',
          tools: ['web_search'],
          provider: 'openAI',
        });
        expect(idOf(harness, version.updatedBy)).toBe(editor);
        for (const field of NEVER_IN_A_VERSION) {
          expect(version).not.toHaveProperty(field);
        }
        expect(timeOf((await rawAgent(id)).updatedAt)).toBeGreaterThanOrEqual(timeOf(before));
      });

      it('resolves null and never creates an agent when nothing matches', async () => {
        expect(await agents().updateAgent({ id: 'missing' }, { name: 'X' })).toBeNull();
        expect(await harness.readRaw('agents')).toEqual([]);
      });

      it('suppresses a version equal to the newest one, still writes, and reports the count', async () => {
        const id = await create();
        await agents().updateAgent({ id }, { name: 'Same' });
        const repeated = await agents().updateAgent({ id }, { name: 'Same' });
        expect(repeated).toMatchObject({ name: 'Same', version: 2 });
        expect(await versionsOf(id)).toHaveLength(2);
        const forced = await agents().updateAgent({ id }, { name: 'Same' }, { forceVersion: true });
        expect(forced).not.toHaveProperty('version');
        expect(await versionsOf(id)).toHaveLength(3);
        expect((await agents().getAgentWithVersionCount({ id }))?.version).toBe(3);
      });

      it('writes without a version under skipVersioning', async () => {
        const id = await create();
        await agents().updateAgent({ id }, { name: 'Baseline' });
        const updated = await agents().updateAgent(
          { id },
          { name: 'Quiet' },
          { skipVersioning: true },
        );
        expect(updated?.name).toBe('Quiet');
        expect(await versionsOf(id)).toHaveLength(2);
        /** The next change compares against the newest version, which predates the quiet write. */
        expect(await agents().updateAgent({ id }, { name: 'Baseline' })).toMatchObject({
          name: 'Baseline',
          version: 2,
        });
        await agents().updateAgent({ id }, { name: 'Loud' });
        expect(await versionsOf(id)).toHaveLength(3);
      });

      it('compares primitive arrays as sets and treats an absent field as false or empty', async () => {
        const id = await create({ tools: ['a', 'b'] });
        await agents().updateAgent({ id }, { name: 'Baseline' });
        expect(await agents().updateAgent({ id }, { tools: ['b', 'a'] })).toMatchObject({
          version: 2,
        });
        expect(
          await agents().updateAgent({ id }, { hide_sequential_outputs: false }),
        ).toMatchObject({ version: 2 });
        expect(await agents().updateAgent({ id }, { artifacts: '' })).toMatchObject({ version: 2 });
        expect(await agents().updateAgent({ id }, { tools: ['a', 'b', 'c'] })).not.toHaveProperty(
          'version',
        );
        expect(await versionsOf(id)).toHaveLength(3);
      });

      it('versions the first update after creation, whose snapshot lacks the stored defaults', async () => {
        const id = await create();
        // NOTE(contract): the version `createAgent` records is the caller's data, without the
        // schema defaults (`category`, `is_promoted`, `mcpServerNames`, ...) the stored agent
        // has, so the first update always records a version, even one that changes nothing.
        expect(await agents().updateAgent({ id }, { name: 'Agent' })).not.toHaveProperty('version');
        expect(await versionsOf(id)).toHaveLength(2);
        expect((await versionsOf(id))[0]).not.toHaveProperty('category');
        expect((await lastVersion(id)).category).toBe('general');
      });

      it('compares object fields by their serialized form, so key order makes a new version', async () => {
        const resources = {
          file_search: { file_ids: ['f1'] },
          context: { file_ids: ['f2'] },
        };
        const id = await create();
        await agents().updateAgent({ id }, { tool_resources: resources });
        expect(await agents().updateAgent({ id }, { tool_resources: resources })).toMatchObject({
          version: 2,
        });
        // The same content in another key order is a different version: the history keeps the
        // key order of each snapshot, and the comparison is the serialized object.
        const reordered = await agents().updateAgent(
          { id },
          { tool_resources: { context: { file_ids: ['f2'] }, file_search: { file_ids: ['f1'] } } },
        );
        expect(reordered).not.toHaveProperty('version');
        const versions = await versionsOf(id);
        expect(versions).toHaveLength(3);
        expect(Object.keys(versions[1].tool_resources as RawRecord)).toEqual([
          'file_search',
          'context',
        ]);
        expect(Object.keys(versions[2].tool_resources as RawRecord)).toEqual([
          'context',
          'file_search',
        ]);
        expect(Object.keys((await rawAgent(id)).tool_resources as RawRecord)).toEqual([
          'context',
          'file_search',
        ]);
      });

      it('compares object arrays regardless of element order', async () => {
        const edges = [
          { from: 'a', to: 'b', edgeType: 'handoff' },
          { from: 'a', to: 'c', edgeType: 'direct' },
        ];
        const id = await create();
        await agents().updateAgent({ id }, { edges });
        expect(await agents().updateAgent({ id }, { edges: [...edges].reverse() })).toMatchObject({
          version: 2,
        });
        expect(
          await agents().updateAgent(
            { id },
            { edges: [{ ...edges[0], edgeType: 'direct' }, edges[1]] },
          ),
        ).not.toHaveProperty('version');
      });

      it('records the hash of the action definitions, and versions a changed definition', async () => {
        const user = newId();
        await harness.seedRaw('actions', [
          {
            _id: newId(),
            user,
            action_id: 'act1',
            metadata: { domain: 'example.com', api_key: 'k' },
          },
        ]);
        const id = await create({ actions: ['example.com_action_act1'] });
        await agents().updateAgent({ id }, { name: 'With actions' });
        const hash = (await lastVersion(id)).actionsHash;
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(await agents().updateAgent({ id }, { name: 'With actions' })).toMatchObject({
          version: 2,
        });
        await harness.createStores().actions.updateAction({ actionId: 'act1' }, {
          metadata: { domain: 'changed.example.com' },
        } as never);
        const changed = await agents().updateAgent({ id }, { name: 'With actions' });
        expect(changed).not.toHaveProperty('version');
        expect((await lastVersion(id)).actionsHash).toMatch(/^[0-9a-f]{64}$/);
        expect((await lastVersion(id)).actionsHash).not.toBe(hash);
        expect(await versionsOf(id)).toHaveLength(3);
      });

      it('re-derives the MCP server names when tools change, keeping the resolved ones', async () => {
        const id = await create({
          tools: ['search_mcp_my_mcp_server'],
          mcpServerNames: ['my_mcp_server'],
        });
        const kept = await agents().updateAgent(
          { id },
          { tools: ['search_mcp_my_mcp_server', 'issue_mcp_github', 'web_search'] },
        );
        expect([...(kept?.mcpServerNames ?? [])].sort()).toEqual(['github', 'my_mcp_server']);
        const dropped = await agents().updateAgent({ id }, { tools: ['web_search'] });
        expect(dropped?.mcpServerNames).toEqual([]);
        const supplied = await agents().updateAgent(
          { id },
          { tools: ['x_mcp_a_b'], mcpServerNames: ['a_b'] },
        );
        expect(supplied?.mcpServerNames).toEqual(['a_b']);
        expect((await lastVersion(id)).mcpServerNames).toEqual(['a_b']);
        expect((await agents().updateAgent({ id }, { name: 'X' }))?.mcpServerNames).toEqual([
          'a_b',
        ]);
      });

      it('drops deleted skill ids from a written allowlist, failing closed unless scoped', async () => {
        const kept = await seedSkill();
        const deleted = newId();
        const id = await create({ skills_enabled: true });
        expect(await agents().updateAgent({ id }, { skills: [kept, deleted] })).toMatchObject({
          skills: [kept],
          skills_enabled: true,
        });
        expect(await agents().updateAgent({ id }, { skills: [deleted] })).toMatchObject({
          skills: [],
          skills_enabled: false,
        });
        await agents().updateAgent({ id }, { skills_enabled: true, skills_scope: 'selected' });
        expect(await agents().updateAgent({ id }, { skills: [deleted] })).toMatchObject({
          skills: [],
          skills_enabled: true,
        });
        expect(await agents().updateAgent({ id }, { skills: [] })).toMatchObject({ skills: [] });
      });

      describe('update operators', () => {
        it('applies $push, and the version snapshots the agent before the operator', async () => {
          const id = await create({ conversation_starters: ['one'] });
          const updated = await agents().updateAgent(
            { id },
            { $push: { conversation_starters: 'two' } },
          );
          expect(updated?.conversation_starters).toEqual(['one', 'two']);
          // NOTE(contract): an operator's change is not in the version it records: the snapshot
          // is the agent before the update plus the update's direct fields (only `$unset` paths
          // are applied to it), so the newest version lags the agent until the next write.
          expect((await lastVersion(id)).conversation_starters).toEqual(['one']);
          expect(await versionsOf(id)).toHaveLength(2);
        });

        it('applies $pull and $addToSet, each recording a version', async () => {
          const id = await create({ tools: ['a', 'b'] });
          expect((await agents().updateAgent({ id }, { $pull: { tools: 'a' } }))?.tools).toEqual([
            'b',
          ]);
          expect(
            (await agents().updateAgent({ id }, { $addToSet: { tools: { $each: ['b', 'c'] } } }))
              ?.tools,
          ).toEqual(['b', 'c']);
          // NOTE(contract): an operator-only update that changes nothing (an idempotent
          // `$addToSet` retry) still records a version: the duplicate check only runs on an
          // update with direct fields.
          await agents().updateAgent({ id }, { $addToSet: { tools: 'c' } });
          expect(await versionsOf(id)).toHaveLength(4);
        });

        it('drops a no-op operator together with a duplicate version', async () => {
          const id = await create({ tools: ['a'] });
          await agents().updateAgent({ id }, { name: 'Stable' });
          const retried = await agents().updateAgent(
            { id },
            { name: 'Stable', $addToSet: { tools: 'a' } },
          );
          expect(retried).toMatchObject({ version: 2, tools: ['a'] });
          const changing = await agents().updateAgent(
            { id },
            { name: 'Stable', $addToSet: { tools: 'b' } },
          );
          expect(changing).not.toHaveProperty('version');
          expect(changing?.tools).toEqual(['a', 'b']);
          expect(await versionsOf(id)).toHaveLength(3);
        });

        it('applies $unset, and leaves the path out of the version', async () => {
          const id = await create({ description: 'Gone soon', instructions: 'Kept' });
          const updated = await agents().updateAgent({ id }, { $unset: { description: 1 } });
          expect(updated).not.toHaveProperty('description');
          expect(updated?.instructions).toBe('Kept');
          const version = await lastVersion(id);
          expect(version).not.toHaveProperty('description');
          expect(version.instructions).toBe('Kept');
          expect(await versionsOf(id)).toHaveLength(2);
          expect(await rawAgent(id)).not.toHaveProperty('description');
        });

        it('unsets a nested tool-resource path, with direct fields beside it', async () => {
          const id = await create({
            tool_resources: { file_search: { file_ids: ['f1'] }, context: { file_ids: ['f2'] } },
          });
          const updated = await agents().updateAgent(
            { id },
            { name: 'Trimmed', $unset: { 'tool_resources.context': 1 } },
          );
          expect(updated?.tool_resources).toEqual({ file_search: { file_ids: ['f1'] } });
          expect((await lastVersion(id)).tool_resources).toEqual({
            file_search: { file_ids: ['f1'] },
          });
        });

        it('pushes into a tool-resource path and writes the whole tool resources', async () => {
          const id = await create({ tool_resources: { file_search: { file_ids: ['f1'] } } });
          expect(
            (
              await agents().updateAgent(
                { id },
                { $push: { 'tool_resources.file_search.file_ids': 'f2' } },
              )
            )?.tool_resources,
          ).toEqual({ file_search: { file_ids: ['f1', 'f2'] } });
          expect(
            (
              await agents().updateAgent(
                { id },
                { tool_resources: { execute_code: { file_ids: ['f3'] } } },
              )
            )?.tool_resources,
          ).toEqual({ execute_code: { file_ids: ['f3'] } });
        });
      });
    });

    /* ------------------------------------------------------------------ avatar */

    describe('updateAgentAvatar', () => {
      const avatar = { filepath: '/images/a.png', source: 'local' };

      it('sets the avatar without touching the update time or the history', async () => {
        const id = await create();
        const before = await rawAgent(id);
        expect(await agents().updateAgentAvatar({ id, avatar })).toBe(true);
        const after = await rawAgent(id);
        expect(after.avatar).toEqual(avatar);
        expect(timeOf(after.updatedAt)).toBe(timeOf(before.updatedAt));
        expect(after.versions).toHaveLength(1);
        expect(await agents().updateAgentAvatar({ id: 'missing', avatar })).toBe(false);
      });

      it('writes only while the stored avatar still equals the one the caller read', async () => {
        const id = await create();
        const next = { filepath: '/images/b.png', source: 's3' };
        expect(await agents().updateAgentAvatar({ id, avatar, previousAvatar: next })).toBe(false);
        expect(await agents().updateAgentAvatar({ id, avatar, previousAvatar: null })).toBe(true);
        expect(await agents().updateAgentAvatar({ id, avatar: next, previousAvatar: null })).toBe(
          false,
        );
        expect(
          await agents().updateAgentAvatar({
            id,
            avatar: next,
            previousAvatar: { ...avatar, source: 's3' },
          }),
        ).toBe(false);
        expect(await agents().updateAgentAvatar({ id, avatar: next, previousAvatar: avatar })).toBe(
          true,
        );
        expect((await rawAgent(id)).avatar).toEqual(next);
      });
    });

    /* ------------------------------------------------------------------ tool resources */

    describe('tool-resource files', () => {
      it('adds a file and its tool once, creating the resource, as a new version', async () => {
        const id = await create({ tools: ['web_search'] });
        const added = await agents().addAgentResourceFile({
          agent_id: id,
          tool_resource: 'file_search',
          file_id: 'f1',
          updatingUserId: editor,
        });
        expect(added.tools).toEqual(['web_search', 'file_search']);
        expect(added.tool_resources).toEqual({ file_search: { file_ids: ['f1'] } });
        const again = await agents().addAgentResourceFile({
          agent_id: id,
          tool_resource: 'file_search',
          file_id: 'f1',
        });
        expect(again.tool_resources).toEqual({ file_search: { file_ids: ['f1'] } });
        await agents().addAgentResourceFile({
          agent_id: id,
          tool_resource: 'context',
          file_id: 'f2',
        });
        const stored = await rawAgent(id);
        expect(stored.tool_resources).toEqual({
          file_search: { file_ids: ['f1'] },
          context: { file_ids: ['f2'] },
        });
        expect(stored.tools).toEqual(['web_search', 'file_search', 'context']);
        const versions = stored.versions as RawRecord[];
        expect(versions).toHaveLength(4);
        expect(idOf(harness, versions[1].updatedBy)).toBe(editor);
        await expect(
          agents().addAgentResourceFile({
            agent_id: 'missing',
            tool_resource: 'ocr',
            file_id: 'x',
          }),
        ).rejects.toThrow('Agent not found for adding resource file');
      });

      it('removes files from the given resources without recording a version', async () => {
        const id = await create({
          tool_resources: {
            file_search: { file_ids: ['f1', 'f2', 'f3'] },
            context: { file_ids: ['f1'] },
          },
        });
        const removed = await agents().removeAgentResourceFiles({
          agent_id: id,
          files: [
            { tool_resource: 'file_search', file_id: 'f1' },
            { tool_resource: 'file_search', file_id: 'f3' },
            { tool_resource: 'ocr', file_id: 'f9' },
          ],
        });
        expect(removed.tool_resources).toEqual({
          file_search: { file_ids: ['f2'] },
          context: { file_ids: ['f1'] },
        });
        expect(await versionsOf(id)).toHaveLength(1);
        await expect(
          agents().removeAgentResourceFiles({ agent_id: 'missing', files: [] }),
        ).rejects.toThrow('Agent not found for removing resource files');
      });

      it('removes files from every agent and every agent tool resource', async () => {
        const a = await create({
          tool_resources: { file_search: { file_ids: ['f1', 'f2'] }, ocr: { file_ids: ['f1'] } },
        });
        const b = await inTenant('tenant-a', () =>
          create({ tool_resources: { execute_code: { file_ids: ['f2', 'f3'] } } }),
        );
        const c = await create({
          tool_resources: { code_interpreter: { file_ids: ['f1'] }, context: { file_ids: ['f4'] } },
        });
        expect(
          await agents().removeAgentResourceFilesFromAllAgents({ file_ids: ['f1', 'f2'] }),
        ).toEqual({ matchedCount: 2, modifiedCount: 2 });
        expect((await rawAgent(a)).tool_resources).toEqual({
          file_search: { file_ids: [] },
          ocr: { file_ids: [] },
        });
        expect((await rawAgent(b)).tool_resources).toEqual({ execute_code: { file_ids: ['f3'] } });
        expect((await rawAgent(c)).tool_resources).toEqual({
          code_interpreter: { file_ids: ['f1'] },
          context: { file_ids: ['f4'] },
        });
        expect(await versionsOf(a)).toHaveLength(1);
        expect(await agents().removeAgentResourceFilesFromAllAgents({ file_ids: [] })).toEqual({
          matchedCount: 0,
          modifiedCount: 0,
        });
      });
    });

    /* ------------------------------------------------------------------ revert */

    describe('revertAgentVersion', () => {
      it('restores a version without recording one, removing the settings it lacks', async () => {
        const id = await create({ description: 'First', instructions: 'Be brief' });
        await agents().updateAgent(
          { id },
          {
            description: 'Second',
            repositoryInstructions: 'prefer',
            skills_scope: 'all',
            git_identity: { name: 'Bot', email: 'bot@example.com' },
          },
        );
        const reverted = await agents().revertAgentVersion({ id }, 0);
        expect(reverted).toMatchObject({ id, description: 'First', instructions: 'Be brief' });
        expect(idOf(harness, reverted.author)).toBe(author);
        const stored = await rawAgent(id);
        for (const field of ['repositoryInstructions', 'skills_scope', 'git_identity']) {
          expect(stored).not.toHaveProperty(field);
        }
        expect(stored.versions).toHaveLength(2);
        const forward = await agents().revertAgentVersion({ id }, 1);
        expect(forward).toMatchObject({
          description: 'Second',
          repositoryInstructions: 'prefer',
          git_identity: { name: 'Bot', email: 'bot@example.com' },
        });
      });

      it('drops deleted skill ids from the restored allowlist', async () => {
        const deleted = newId();
        const id = 'agent_restored';
        /** A version recorded before the skill was deleted still names it. */
        await harness.seedRaw('agents', [
          {
            _id: newId(),
            id,
            name: 'Agent',
            provider: 'openAI',
            model: 'gpt-4o',
            author,
            skills: [],
            skills_enabled: false,
            versions: [{ name: 'Agent', skills: [deleted], skills_enabled: true }],
            createdAt: at(0),
            updatedAt: at(0),
          },
        ]);
        expect(await agents().revertAgentVersion({ id }, 0)).toMatchObject({
          skills: [],
          skills_enabled: false,
        });
      });

      it('throws for a missing agent or version', async () => {
        const id = await create();
        await expect(agents().revertAgentVersion({ id }, 5)).rejects.toThrow('Version 5 not found');
        await expect(agents().revertAgentVersion({ id: 'missing' }, 0)).rejects.toThrow(
          'Agent not found',
        );
      });
    });

    /* ------------------------------------------------------------------ tenants */

    describe('tenant scoping', () => {
      it('stamps created agents with the ambient tenant and updates only its own', async () => {
        await inTenant('tenant-a', () => create({ id: 'agent_t', name: 'A' }));
        await inTenant('tenant-b', () => create({ id: 'agent_t', name: 'B' }));
        expect(
          await inTenant('tenant-a', () => agents().updateAgent({ id: 'agent_t' }, { name: 'A2' })),
        ).toMatchObject({ name: 'A2', tenantId: 'tenant-a' });
        expect((await rawAgent('agent_t', { tenantId: 'tenant-b' })).name).toBe('B');
        expect(
          await inTenant('tenant-c', () => agents().updateAgent({ id: 'agent_t' }, { name: 'C' })),
        ).toBeNull();
        await expect(
          inTenant('tenant-b', () =>
            agents().updateAgent({ id: 'agent_t' }, { name: 'B2', tenantId: 'tenant-a' }),
          ),
        ).rejects.toMatchObject({ name: 'TenantIsolationError' });
        const unchanged = await rawAgent('agent_t', { tenantId: 'tenant-b' });
        expect(unchanged.name).toBe('B');
        expect(unchanged.versions).toHaveLength(1);
      });
    });
  });
}
