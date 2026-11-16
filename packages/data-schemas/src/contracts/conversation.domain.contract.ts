/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ConversationStore` contract (`~/ports/conversation`), third part: the storage steps the
 * conversation domain functions are written on, ported from `methods/conversation.saveSteps.spec.ts`,
 * `methods/conversation.deleteSteps.spec.ts` and `methods/conversation.bulkSaveSearchSteps.spec.ts`,
 * and the four composed functions themselves (`saveConvo`, `bulkSaveConvos`, `deleteConvos`,
 * `searchConversation`, through `ContractHarness.createConversationDomain`), ported from the
 * matching cases of `methods/conversation.spec.ts`: what a save may write (server-owned read
 * state, private actor and lane fields and the tenant never), retention, the archive stamp, the
 * generated-title guard, project ownership and statistics; the bulk import's insert-only fields;
 * the deletion's walk down subagent lineage and its cascade into messages, remembered tool
 * approvals, bookmark counts, project statistics, queued turns and trigger delivery results; and
 * the cross-user lookup's projections.
 *
 * Not here (they stay in the method specs): cases that make a step, the message cleanup, a project
 * refresh, a queued-turn retirement or a receipt erasure fail or race through spies and mocks
 * (call order, partial cascades, retries), the DocumentDB update-shape checks, and the step
 * signature conformance specs. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { RetentionMode, UNSEEN_REPLY_WATERMARK } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { IConversation } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const BASE = Date.parse('2026-03-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const HOUR = 60 * 60_000;
const inFuture = (ms = HOUR) => new Date(Date.now() + ms);

export function describeConversationDomainContract(harness: ContractHarness): void {
  describe(`ConversationStore contract, domain steps and functions: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().conversations;
    const domain = () => harness.createConversationDomain();
    const newId = () => harness.ids.generate();
    let sequence = 0;
    const newConversationId = () => `convo-${++sequence}-${newId()}`;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);

    /** Seeds one visible conversation raw (no defaults); a key given as `undefined` is left out. */
    const seedConvo = async (user: string, record: RawRecord = {}): Promise<string> => {
      const conversationId = (record.conversationId as string | undefined) ?? newConversationId();
      const seeded: RawRecord = {
        _id: newId(),
        conversationId,
        user,
        title: 'A chat',
        endpoint: 'openAI',
        isTemporary: false,
        isArchived: false,
        messages: [],
        tags: [],
        createdAt: at(0),
        updatedAt: at(0),
        ...record,
      };
      await harness.seedRaw('conversations', [
        Object.fromEntries(Object.entries(seeded).filter(([, value]) => value !== undefined)),
      ]);
      return conversationId;
    };
    const rawConvo = async (conversationId: string, user?: string): Promise<RawRecord> => {
      const [record] = await readRawWhere(harness, 'conversations', {
        conversationId,
        ...(user != null && { user }),
      });
      return record;
    };
    const seedMessages = (user: string, conversationId: string, count: number) => {
      const ids = Array.from({ length: count }, () => newId()).sort();
      return harness
        .seedRaw(
          'messages',
          ids.map((_id, index) => ({
            _id,
            messageId: `${conversationId}-m${index}`,
            conversationId,
            user,
            text: `message ${index}`,
            createdAt: at(index),
            updatedAt: at(index),
          })),
        )
        .then(() => ids);
    };
    const seedProject = async (user: string, record: RawRecord = {}): Promise<string> => {
      const _id = newId();
      await harness.seedRaw('chatprojects', [
        {
          _id,
          name: 'Project',
          user,
          conversationCount: 0,
          lastConversationAt: null,
          lastConversationId: null,
          createdAt: at(0),
          updatedAt: at(0),
          ...record,
        },
      ]);
      return _id;
    };
    const projectOf = async (projectId: string): Promise<RawRecord> => {
      const [project] = await readRawWhere(harness, 'chatprojects', { _id: projectId });
      return project;
    };
    const lineage = (parentConversationId: string, rootConversationId: string, depth: number) => ({
      rootConversationId,
      parentConversationId,
      parentMessageId: `message-${depth}`,
      parentToolCallId: `tool-${depth}`,
      subagentType: 'agent-child',
      subagentKind: 'agent',
      depth,
    });

    describe('saveConvo steps', () => {
      it('writeConvo creates with upsert and reports the insert, then updates in place', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const before = Date.now();
        const created = await stores().writeConvo({
          user,
          conversationId,
          set: { title: 'First', endpoint: 'openAI' },
          setOnInsert: { initial_agent_id: 'agent-1' },
          upsert: true,
          timestamps: true,
        });
        expect(created?.inserted).toBe(true);
        expect(created?.conversation).toMatchObject({ conversationId, user, title: 'First' });
        expect(timeOf(created?.conversation.createdAt)).toBeGreaterThanOrEqual(before);
        const updated = await stores().writeConvo({
          user,
          conversationId,
          set: { title: 'Second' },
          setOnInsert: { initial_agent_id: 'agent-2' },
          upsert: true,
          timestamps: true,
        });
        expect(updated).toMatchObject({ inserted: false, conversation: { title: 'Second' } });
        const stored = await readRawWhere(harness, 'conversations', { conversationId });
        expect(stored).toHaveLength(1);
        expect(stored[0].initial_agent_id).toBe('agent-1');
        expect(updated?.conversation).not.toHaveProperty('initial_agent_id');
      });

      it('writeConvo without upsert writes only an existing conversation of the user', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const write = (owner: string, id = conversationId) =>
          stores().writeConvo({
            user: owner,
            conversationId: id,
            set: { title: 'Hijack' },
            upsert: false,
            timestamps: true,
          });
        expect(await write(newId())).toBeNull();
        expect(await write(user, 'missing')).toBeNull();
        expect((await rawConvo(conversationId)).title).toBe('A chat');
        expect(await harness.readRaw('conversations')).toHaveLength(1);
      });

      it('writeConvo applies its archive and title conditions, and refuses them with upsert', async () => {
        const user = newId();
        const archived = await seedConvo(user, { isArchived: true });
        const legacy = await seedConvo(user, { isArchived: undefined });
        const write = (conversationId: string, when: Record<string, unknown>) =>
          stores().writeConvo({
            user,
            conversationId,
            when,
            set: { title: 'Written' },
            upsert: false,
            timestamps: true,
          });
        expect(await write(archived, { isArchived: false })).toBeNull();
        expect((await write(archived, { isArchived: true }))?.conversation.title).toBe('Written');
        expect(await write(legacy, { isArchived: true })).toBeNull();
        expect((await write(legacy, { isArchived: false }))?.conversation.title).toBe('Written');
        const guard = { titleSetByUser: false, titleIn: [null, '', 'New Chat'] };
        const placeholder = await seedConvo(user, { title: 'New Chat' });
        const untitled = await seedConvo(user, { title: undefined });
        const named = await seedConvo(user, { title: 'Mine' });
        const placeholderSetByUser = await seedConvo(user, {
          title: 'New Chat',
          titleSetByUser: true,
        });
        expect(await write(placeholder, guard)).not.toBeNull();
        expect(await write(untitled, guard)).not.toBeNull();
        expect(await write(named, guard)).toBeNull();
        expect(await write(placeholderSetByUser, guard)).toBeNull();
        await expect(
          stores().writeConvo({
            user,
            conversationId: newConversationId(),
            when: { isArchived: false },
            set: {},
            upsert: true,
            timestamps: true,
          }),
        ).rejects.toThrow('cannot be combined');
      });

      it('writeConvo unsets, increments, keeps the later stamp and appends ids once', async () => {
        const user = newId();
        const later = new Date('2030-01-02T00:00:00Z');
        const conversationId = await seedConvo(user, {
          promptPrefix: 'drop me',
          lastResponseAt: later,
        });
        const [m1, m2] = [newId(), newId()].sort();
        await stores().writeConvo({
          user,
          conversationId,
          set: { notAField: 'ignored' },
          unset: ['promptPrefix'],
          increment: { titleRevision: 1 },
          max: { lastResponseAt: new Date('2030-01-01T00:00:00Z') },
          appendMessageIds: [m1, m2],
          upsert: false,
          timestamps: true,
        });
        await stores().writeConvo({
          user,
          conversationId,
          set: {},
          increment: { titleRevision: 1 },
          max: { lastResponseAt: new Date('2030-01-03T00:00:00Z') },
          appendMessageIds: [m2],
          upsert: false,
          timestamps: true,
        });
        const stored = await rawConvo(conversationId);
        expect(stored).not.toHaveProperty('promptPrefix');
        expect(stored).not.toHaveProperty('notAField');
        expect(stored.titleRevision).toBe(2);
        expect(timeOf(stored.lastResponseAt)).toBe(Date.parse('2030-01-03T00:00:00Z'));
        expect(stored.messages).toEqual([m1, m2]);
        expect(timeOf(stored.updatedAt)).toBeGreaterThan(at(0).getTime());
      });

      it('writeConvo stamps neither time when timestamps are off', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        await stores().writeConvo({
          user,
          conversationId,
          set: { pinned: true },
          upsert: false,
          timestamps: false,
        });
        const stored = await rawConvo(conversationId);
        expect(stored.pinned).toBe(true);
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        const created = newConversationId();
        await stores().writeConvo({
          user,
          conversationId: created,
          set: { endpoint: 'openAI', updatedAt: at(5) },
          setOnInsert: { createdAt: at(4) },
          upsert: true,
          timestamps: false,
        });
        const inserted = await rawConvo(created);
        expect(timeOf(inserted.createdAt)).toBe(at(4).getTime());
        expect(timeOf(inserted.updatedAt)).toBe(at(5).getTime());
      });

      it('writeConvo and convoExists are scoped to the tenant in context, which the insert carries', async () => {
        const user = newId();
        const conversationId = newConversationId();
        await inTenant('tenant-a', () =>
          stores().writeConvo({
            user,
            conversationId,
            set: { title: 'A', endpoint: 'openAI' },
            upsert: true,
            timestamps: true,
          }),
        );
        expect((await rawConvo(conversationId)).tenantId).toBe('tenant-a');
        expect(
          await inTenant('tenant-b', () =>
            stores().writeConvo({
              user,
              conversationId,
              set: { title: 'B' },
              upsert: false,
              timestamps: true,
            }),
          ),
        ).toBeNull();
        expect(await inTenant('tenant-b', () => stores().convoExists(user, conversationId))).toBe(
          false,
        );
        expect(await inTenant('tenant-a', () => stores().convoExists(user, conversationId))).toBe(
          true,
        );
        expect(await stores().convoExists(newId(), conversationId)).toBe(false);
        expect(await stores().convoExists(user, 'missing')).toBe(false);
      });

      it('getConvoMessageIds lists the stored message ids of the owner, oldest first', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const ids = await seedMessages(user, conversationId, 3);
        await seedMessages(newId(), conversationId, 1);
        expect(
          (await stores().getConvoMessageIds(user, conversationId)).map((id) => idOf(harness, id)),
        ).toEqual(ids);
        expect(await stores().getConvoMessageIds(user, 'missing')).toEqual([]);
      });

      it('isOwnedChatProject checks ownership and rejects a malformed id', async () => {
        const user = newId();
        const projectId = await seedProject(user);
        expect(await stores().isOwnedChatProject(user, projectId)).toBe(true);
        expect(await stores().isOwnedChatProject(newId(), projectId)).toBe(false);
        expect(await stores().isOwnedChatProject(user, newId())).toBe(false);
        expect(await stores().isOwnedChatProject(user, 'not-an-id')).toBe(false);
      });

      it('seedConvoCodeEnvironmentDecision writes only while no decision is held', async () => {
        const user = newId();
        const undecided = await seedConvo(user);
        const emptied = await seedConvo(user, { codeWorkspaces: [] });
        const selected = await seedConvo(user, {
          codeWorkspaces: [{ environmentId: 'code-mac', workspaceId: 'primary' }],
        });
        const seed = (
          conversationId: string,
          codeEnvironmentMode: 'attached' | 'without_attached',
        ) =>
          stores().seedConvoCodeEnvironmentDecision({
            user,
            conversationId,
            decision: { codeEnvironmentMode },
          });
        expect(await seed(undecided, 'without_attached')).toBe(true);
        expect(await seed(undecided, 'attached')).toBe(false);
        expect(await seed(emptied, 'attached')).toBe(true);
        expect(await seed(selected, 'attached')).toBe(false);
        expect((await rawConvo(undecided)).codeEnvironmentMode).toBe('without_attached');
        expect(timeOf((await rawConvo(undecided)).updatedAt)).toBe(at(0).getTime());
        expect(
          await stores().seedConvoCodeEnvironmentDecision({
            user: newId(),
            conversationId: emptied,
            decision: { codeEnvironmentMode: 'attached' },
          }),
        ).toBe(false);
      });

      it('setConvoExpiryIfUnset writes only an unset deadline whose chat type matches', async () => {
        const user = newId();
        const deadline = new Date('2031-01-01T00:00:00Z');
        const durable = await seedConvo(user);
        const legacy = await seedConvo(user, { isTemporary: undefined });
        const temporary = await seedConvo(user, { isTemporary: true });
        const set = (conversationId: string, isTemporary: boolean, expiredAt = deadline) =>
          stores().setConvoExpiryIfUnset({ user, conversationId, isTemporary, expiredAt });
        expect(await set(durable, true)).toBe(false);
        expect(await set(durable, false)).toBe(true);
        expect(await set(durable, false, new Date('2032-01-01T00:00:00Z'))).toBe(false);
        expect(timeOf((await rawConvo(durable)).expiredAt)).toBe(deadline.getTime());
        expect(await set(legacy, false)).toBe(true);
        expect(await set(temporary, false)).toBe(false);
        expect(await set(temporary, true)).toBe(true);
        expect(timeOf((await rawConvo(temporary)).updatedAt)).toBe(at(0).getTime());
      });

      it('stampConvoReply stamps monotonically, returns the read state, and skips temporary chats', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          lastResponseIsManual: true,
          isMarkedUnread: true,
        });
        const first = await stores().stampConvoReply({
          user,
          conversationId,
          responseMessageId: 'r-1',
        });
        const second = await stores().stampConvoReply({
          user,
          conversationId,
          responseMessageId: 'r-2',
        });
        expect(first?.state).toMatchObject({ lastResponseMessageId: 'r-1', isMarkedUnread: false });
        expect(first?.state).not.toHaveProperty('lastResponseIsManual');
        expect(timeOf(first?.state.lastSeenAt)).toBe(Date.parse(UNSEEN_REPLY_WATERMARK));
        expect(timeOf(first?.state.updatedAt)).toBe(first!.lastResponseAt.getTime());
        expect(second!.lastResponseAt.getTime()).toBeGreaterThan(first!.lastResponseAt.getTime());
        expect((await rawConvo(conversationId)).lastResponseMessageId).toBe('r-2');
        const temporary = await seedConvo(user, { isTemporary: true });
        expect(
          await stores().stampConvoReply({
            user,
            conversationId: temporary,
            responseMessageId: 'r',
          }),
        ).toBeNull();
        expect(
          await stores().stampConvoReply({ user: newId(), conversationId, responseMessageId: 'r' }),
        ).toBeNull();
      });

      it('backfillConvoIsTemporary writes only when no chat type is stored', async () => {
        const user = newId();
        const legacy = await seedConvo(user, { isTemporary: undefined });
        const touched = await seedConvo(user, { isTemporary: undefined });
        const kept = await seedConvo(user, { isTemporary: true });
        const backfill = (conversationId: string, touchUpdatedAt = false) =>
          stores().backfillConvoIsTemporary({ user, conversationId, touchUpdatedAt });
        expect(await backfill(legacy)).toBe(true);
        expect(await backfill(legacy)).toBe(false);
        expect(await backfill(kept)).toBe(false);
        expect(await backfill(touched, true)).toBe(true);
        expect((await rawConvo(legacy)).isTemporary).toBe(false);
        expect(timeOf((await rawConvo(legacy)).updatedAt)).toBe(at(0).getTime());
        expect(timeOf((await rawConvo(touched)).updatedAt)).toBeGreaterThan(at(0).getTime());
        expect((await rawConvo(kept)).isTemporary).toBe(true);
      });

      it('maintains the project activity pointer and recomputes its statistics', async () => {
        const user = newId();
        const projectId = await seedProject(user);
        const older = await seedConvo(user, { chatProjectId: projectId, updatedAt: at(1) });
        const newer = await seedConvo(user, { chatProjectId: projectId, updatedAt: at(2) });
        await seedConvo(user, { chatProjectId: projectId, updatedAt: at(3), isArchived: true });
        await seedConvo(user, {
          chatProjectId: projectId,
          updatedAt: at(4),
          isTemporary: true,
          expiredAt: inFuture(),
        });
        await stores().recordChatProjectLastConversation(user, projectId, {
          conversationId: newer,
          createdAt: at(0),
          updatedAt: at(2),
        });
        expect(await projectOf(projectId)).toMatchObject({ lastConversationId: newer });
        /** An older conversation never walks the pointer back. */
        await stores().recordChatProjectLastConversation(user, projectId, {
          conversationId: older,
          createdAt: at(0),
          updatedAt: at(1),
        });
        expect((await projectOf(projectId)).lastConversationId).toBe(newer);
        await stores().refreshChatProjectStats(user, projectId);
        const project = await projectOf(projectId);
        expect(project).toMatchObject({ conversationCount: 2, lastConversationId: newer });
        expect(timeOf(project.lastConversationAt)).toBe(at(2).getTime());
        /** Another user's refresh and a malformed id change nothing. */
        await stores().refreshChatProjectStats(newId(), projectId);
        await stores().refreshChatProjectStats(user, 'not-an-id');
        expect((await projectOf(projectId)).conversationCount).toBe(2);
      });
    });

    describe('deleteConvos steps', () => {
      it('lists every conversation of the user, or the listed ids, with only the deletion fields', async () => {
        const user = newId();
        const full = await seedConvo(user, {
          tenantId: 'tenant-a',
          chatProjectId: 'project-1',
          tags: ['work'],
        });
        const bare = await seedConvo(user, { tags: undefined });
        await seedConvo(newId());
        const all = await stores().listConvosForDeletion(user, { all: true });
        expect(all.map((target) => target.conversationId).sort()).toEqual([bare, full].sort());
        expect(
          await stores().listConvosForDeletion(user, { conversationIds: [full, 'missing'] }),
        ).toEqual([
          {
            conversationId: full,
            tenantId: 'tenant-a',
            chatProjectId: 'project-1',
            tags: ['work'],
          },
        ]);
        const [bareTarget] = await stores().listConvosForDeletion(user, {
          conversationIds: [bare],
        });
        expect(bareTarget.conversationId).toBe(bare);
        expect(bareTarget).not.toHaveProperty('title');
        expect(bareTarget.tags ?? undefined).toBeUndefined();
        expect(await stores().listConvosForDeletion(user, { conversationIds: [] })).toEqual([]);
        expect(await stores().listConvosForDeletion(newId(), { conversationIds: [full] })).toEqual(
          [],
        );
        expect(
          await inTenant('tenant-b', () => stores().listConvosForDeletion(user, { all: true })),
        ).toEqual([]);
      });

      it("lists the owner's subagent threads below a root at any depth, or a wave's direct children", async () => {
        const user = newId();
        const root = await seedConvo(user);
        const child = await seedConvo(user, { subagentThread: lineage(root, root, 1) });
        const grandchild = await seedConvo(user, { subagentThread: lineage(child, root, 2) });
        await seedConvo(newId(), { subagentThread: lineage(root, root, 1) });
        await seedConvo(user, { subagentThread: lineage('other', 'other', 1) });
        const ids = (targets: Array<{ conversationId: string }>) =>
          targets.map((target) => target.conversationId).sort();
        expect(ids(await stores().listSubagentDescendantsForDeletion(user, root))).toEqual(
          [child, grandchild].sort(),
        );
        expect(ids(await stores().listSubagentChildrenForDeletion(user, [root]))).toEqual([child]);
        expect(ids(await stores().listSubagentChildrenForDeletion(user, [root, child]))).toEqual(
          [child, grandchild].sort(),
        );
        expect(await stores().listSubagentChildrenForDeletion(user, [grandchild])).toEqual([]);
      });

      it("deletes only the owner's listed records in the tenant in context, counting them", async () => {
        const user = newId();
        const first = await seedConvo(user);
        const second = await seedConvo(user, { tenantId: 'tenant-a' });
        const kept = await seedConvo(user);
        const foreign = await seedConvo(newId(), { conversationId: newConversationId() });
        expect(
          await inTenant('tenant-b', () => stores().deleteConvoRecords(user, [second])),
        ).toEqual({ acknowledged: true, deletedCount: 0 });
        expect(
          await stores().deleteConvoRecords(user, [first, second, foreign, 'missing']),
        ).toEqual({ acknowledged: true, deletedCount: 2 });
        expect(
          (await harness.readRaw('conversations')).map((record) => record.conversationId).sort(),
        ).toEqual([foreign, kept].sort());
      });
    });

    describe('bulkSaveConvos steps', () => {
      it('lists the stored project of each listed conversation that exists', async () => {
        const user = newId();
        const inProject = await seedConvo(user, { chatProjectId: 'project-1' });
        const unassigned = await seedConvo(user, { chatProjectId: null });
        const legacy = await seedConvo(user);
        const assignments = await stores().listConvoProjectAssignments([
          { user, conversationId: inProject },
          { user, conversationId: unassigned },
          { user, conversationId: legacy },
          { user: newId(), conversationId: inProject },
          { user, conversationId: 'missing' },
        ]);
        const byId = Object.fromEntries(assignments.map((item) => [item.conversationId, item]));
        expect(Object.keys(byId).sort()).toEqual([inProject, legacy, unassigned].sort());
        expect(byId[inProject]).toEqual({
          user,
          conversationId: inProject,
          chatProjectId: 'project-1',
        });
        expect(byId[unassigned].chatProjectId ?? null).toBeNull();
        expect(byId[legacy].chatProjectId ?? null).toBeNull();
        expect(
          await inTenant('tenant-a', () =>
            stores().listConvoProjectAssignments([{ user, conversationId: inProject }]),
          ),
        ).toEqual([]);
      });

      it('creates with the insert-only fields and updates without them, stamping no times', async () => {
        const user = newId();
        const existing = await seedConvo(user, {
          title: 'Before',
          codeEnvironmentMode: 'without_attached',
        });
        const created = newConversationId();
        const result = await stores().bulkUpsertConvos([
          {
            user,
            conversationId: existing,
            set: { user, conversationId: existing, title: 'After' },
            setOnInsert: { initial_agent_id: null, codeEnvironmentMode: 'attached' },
          },
          {
            user,
            conversationId: created,
            set: { user, conversationId: created, title: 'New', endpoint: 'openAI' },
            setOnInsert: { initial_agent_id: null, codeEnvironmentMode: 'attached' },
          },
        ]);
        expect(result).toMatchObject({ matchedCount: 1, modifiedCount: 1, upsertedCount: 1 });
        const updated = await rawConvo(existing);
        expect(updated).toMatchObject({ title: 'After', codeEnvironmentMode: 'without_attached' });
        expect(timeOf(updated.updatedAt)).toBe(at(0).getTime());
        const inserted = await rawConvo(created);
        expect(inserted).toMatchObject({
          user,
          title: 'New',
          initial_agent_id: null,
          codeEnvironmentMode: 'attached',
        });
        expect(inserted).not.toHaveProperty('createdAt');
        expect(inserted).not.toHaveProperty('updatedAt');
      });

      it("keys each row by user, and never writes a payload tenant over the context's", async () => {
        const user = newId();
        const other = newId();
        const conversationId = await seedConvo(other, { title: 'Theirs' });
        await stores().bulkUpsertConvos([
          {
            user,
            conversationId,
            set: { user, conversationId, title: 'Mine', endpoint: 'openAI' },
            setOnInsert: {},
          },
        ]);
        expect(
          (await readRawWhere(harness, 'conversations', { conversationId }))
            .map((row) => [row.user, row.title])
            .sort(),
        ).toEqual(
          [
            [user, 'Mine'],
            [other, 'Theirs'],
          ].sort(),
        );
        const scoped = newConversationId();
        await inTenant('tenant-a', () =>
          stores().bulkUpsertConvos([
            {
              user,
              conversationId: scoped,
              set: { user, conversationId: scoped, endpoint: 'openAI', tenantId: 'forged' },
              setOnInsert: { tenantId: 'forged-too' },
            },
          ]),
        );
        expect((await rawConvo(scoped)).tenantId).toBe('tenant-a');
        expect(await stores().bulkUpsertConvos([])).toMatchObject({
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
        });
      });
    });

    describe('getConvoByIdAcrossUsers', () => {
      const seedFull = async (user: string, record: RawRecord = {}) =>
        seedConvo(user, { title: 'Stored', messages: [newId()], laneGitSeq: 4, ...record });

      it('reads the ownership fields, everything but the messages, or everything', async () => {
        const user = newId();
        const conversationId = await seedFull(user);
        const [messageId] = (await rawConvo(conversationId)).messages as string[];
        const ownership = await stores().getConvoByIdAcrossUsers(conversationId, 'ownership');
        expect(ownership).toMatchObject({ conversationId, user });
        expect(
          Object.keys(ownership ?? {})
            .filter((key) => key !== '_id')
            .sort(),
        ).toEqual(['conversationId', 'user']);
        const withoutMessages = await stores().getConvoByIdAcrossUsers(
          conversationId,
          'withoutMessages',
        );
        expect(withoutMessages).toMatchObject({ conversationId, user, title: 'Stored' });
        expect(withoutMessages).not.toHaveProperty('messages');
        const full = await stores().getConvoByIdAcrossUsers(conversationId, 'full');
        expect(full).toMatchObject({ conversationId, user, title: 'Stored' });
        expect((full?.messages ?? []).map((id) => idOf(harness, id))).toEqual([messageId]);
        for (const projection of ['ownership', 'withoutMessages', 'full'] as const) {
          expect(
            await stores().getConvoByIdAcrossUsers(conversationId, projection),
          ).not.toHaveProperty('laneGitSeq');
        }
      });

      it('finds a conversation whoever its user is, within the tenant in context', async () => {
        const other = newId();
        const conversationId = await seedFull(other, { tenantId: 'tenant-a' });
        expect(await stores().getConvoByIdAcrossUsers(conversationId, 'ownership')).toMatchObject({
          user: other,
        });
        expect(await stores().getConvoByIdAcrossUsers('missing', 'full')).toBeNull();
        expect(
          await inTenant('tenant-b', () =>
            stores().getConvoByIdAcrossUsers(conversationId, 'full'),
          ),
        ).toBeNull();
        expect(
          await inTenant('tenant-a', () =>
            stores().getConvoByIdAcrossUsers(conversationId, 'full'),
          ),
        ).toMatchObject({ conversationId });
      });
    });

    describe('saveConvo (composed)', () => {
      const ctx = (userId: string, extra: Record<string, unknown> = {}) => ({
        userId,
        interfaceConfig: { temporaryChatRetention: 24 },
        ...extra,
      });
      const save = (...args: Parameters<ReturnType<typeof domain>['saveConvo']>) =>
        domain().saveConvo(...args) as Promise<IConversation | null>;

      it('creates a conversation with the stored message ids and insert-only attribution', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const messageIds = await seedMessages(user, conversationId, 2);
        const saved = await save(
          ctx(user),
          { conversationId, title: 'Saved', endpoint: 'openAI', model: 'gpt-4o' },
          { initialAgentId: 'agent-1' },
        );
        expect(saved).toMatchObject({ conversationId, user, title: 'Saved', model: 'gpt-4o' });
        expect((saved?.messages ?? []).map((id) => idOf(harness, id))).toEqual(messageIds);
        const stored = await rawConvo(conversationId);
        expect(stored).toMatchObject({ initial_agent_id: 'agent-1', messages: messageIds });
        expect(stored.createdAt).toBeInstanceOf(Date);
        await save(ctx(user), { conversationId, title: 'Again' }, { initialAgentId: 'agent-2' });
        expect(await rawConvo(conversationId)).toMatchObject({
          title: 'Again',
          initial_agent_id: 'agent-1',
        });
        const plain = newConversationId();
        await save(ctx(user), { conversationId: plain, endpoint: 'openAI' });
        expect((await rawConvo(plain)).initial_agent_id).toBeNull();
      });

      it('never writes server-owned read state, private fields or a tenant from the payload', async () => {
        const user = newId();
        const conversationId = newConversationId();
        await save(ctx(user), {
          conversationId,
          endpoint: 'openAI',
          tenantId: 'forged',
          lastResponseAt: new Date('2030-01-01T00:00:00Z'),
          lastResponseMessageId: 'forged-reply',
          lastResponseIsManual: true,
          isMarkedUnread: true,
          titleSetByUser: true,
          titleRevision: 9,
          toolApprovalAllows: ['dangerous'],
          laneGit: { branch: 'main', head: 'x', seq: 1 },
          'laneGit.branch': 'dotted',
          laneGitSeq: 7,
          codeAttachmentEpoch: 3,
          codeEnvironmentRevision: 5,
          agentEventActor: {
            generation: 1,
            checkpoint: { threadId: 'x', checkpointId: 'y', checkpointNs: 'z' },
          },
          'agentEventActorSuspension.status': 'closed',
        });
        const stored = await rawConvo(conversationId);
        for (const field of [
          'tenantId',
          'lastResponseAt',
          'lastResponseMessageId',
          'lastResponseIsManual',
          'isMarkedUnread',
          'titleSetByUser',
          'titleRevision',
          'toolApprovalAllows',
          'laneGit',
          'laneGitSeq',
          'codeAttachmentEpoch',
          'codeEnvironmentRevision',
          'agentEventActor',
          'agentEventActorSuspension',
        ]) {
          expect(stored).not.toHaveProperty(field);
        }
        await save(ctx(user), { conversationId }, { unsetFields: { laneGitSeq: 1, title: 1 } });
        expect(await rawConvo(conversationId)).not.toHaveProperty('title');
      });

      it('renames by newConversationId, and writes an existing chat only under noUpsert', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, { title: 'Old' });
        const renamed = newConversationId();
        await save(ctx(user), { conversationId, newConversationId: renamed, title: 'Moved' });
        expect(await rawConvo(conversationId)).toBeUndefined();
        expect((await rawConvo(renamed)).title).toBe('Moved');
        const missing = newConversationId();
        expect(
          await save(
            ctx(user),
            { conversationId: missing, endpoint: 'openAI' },
            { noUpsert: true },
          ),
        ).toBeNull();
        expect(await rawConvo(missing)).toBeUndefined();
        expect(
          await save(ctx(user), { conversationId: renamed, title: 'Updated' }, { noUpsert: true }),
        ).toMatchObject({ title: 'Updated' });
      });

      it('lands a generated title only on a placeholder, and claims a manual one', async () => {
        const user = newId();
        const placeholder = await seedConvo(user, { title: 'New Chat', updatedAt: at(1) });
        const renamed = await seedConvo(user, { title: 'Mine', titleSetByUser: true });
        const generated = (conversationId: string) =>
          save(ctx(user), { conversationId, title: 'Generated' }, { titleSource: 'generated' });
        expect(await generated(placeholder)).toMatchObject({ title: 'Generated' });
        expect(await generated(renamed)).toBeNull();
        const missing = newConversationId();
        expect(await generated(missing)).toBeNull();
        expect(await rawConvo(missing)).toBeUndefined();
        await save(
          ctx(user),
          { conversationId: placeholder, title: 'Manual' },
          { titleSource: 'manual' },
        );
        await save(
          ctx(user),
          { conversationId: placeholder, title: 'Manual 2' },
          { titleSource: 'manual' },
        );
        expect(await rawConvo(placeholder)).toMatchObject({
          title: 'Manual 2',
          titleSetByUser: true,
          titleRevision: 2,
        });
        expect(await generated(placeholder)).toBeNull();
      });

      it('applies the temporary retention window, and clears it for a durable save', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const before = Date.now();
        await save(ctx(user, { isTemporary: true }), { conversationId, endpoint: 'openAI' });
        const temporary = await rawConvo(conversationId);
        expect(temporary.isTemporary).toBe(true);
        expect(timeOf(temporary.expiredAt)).toBeGreaterThanOrEqual(before + 24 * HOUR - 60_000);
        expect(timeOf(temporary.expiredAt)).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 60_000);
        await save(ctx(user, { isTemporary: false }), { conversationId });
        const durable = await rawConvo(conversationId);
        expect(durable.isTemporary).toBe(false);
        expect(durable.expiredAt ?? null).toBeNull();
        const inherited = new Date('2031-05-05T00:00:00Z');
        await save(ctx(user, { isTemporary: true, expiredAt: inherited }), { conversationId });
        expect(timeOf((await rawConvo(conversationId)).expiredAt)).toBe(inherited.getTime());
        const forced = newConversationId();
        await save(
          {
            userId: user,
            interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 1 },
          },
          { conversationId: forced, endpoint: 'openAI' },
        );
        expect(await rawConvo(forced)).toMatchObject({ isTemporary: true });
      });

      it('archives with a stamp kept across repeats, and clears it on unarchive', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, { updatedAt: at(1) });
        await save(ctx(user), { conversationId, isArchived: true }, { preserveUpdatedAt: true });
        const archived = await rawConvo(conversationId);
        expect(archived.isArchived).toBe(true);
        expect(archived.archivedAt).toBeInstanceOf(Date);
        expect(timeOf(archived.updatedAt)).toBe(at(1).getTime());
        await save(ctx(user), { conversationId, isArchived: true }, { preserveUpdatedAt: true });
        expect(timeOf((await rawConvo(conversationId)).archivedAt)).toBe(
          timeOf(archived.archivedAt),
        );
        await save(ctx(user), { conversationId, isArchived: false });
        const restored = await rawConvo(conversationId);
        expect(restored.isArchived).toBe(false);
        expect(restored.archivedAt ?? null).toBeNull();
        expect(timeOf(restored.updatedAt)).toBeGreaterThan(at(1).getTime());
      });

      it('appends message ids without reading messages, and stamps a persisted reply', async () => {
        const user = newId();
        const conversationId = newConversationId();
        await seedMessages(user, conversationId, 1);
        const [first, second] = [newId(), newId()].sort();
        const saved = await save(
          ctx(user),
          { conversationId, endpoint: 'openAI', messages: ['ignored'] },
          { appendMessageIds: [first], stampReply: true, replyMessageId: 'reply-1' },
        );
        expect((await rawConvo(conversationId)).messages).toEqual([first]);
        await save(ctx(user), { conversationId }, { appendMessageIds: [second, first] });
        expect((await rawConvo(conversationId)).messages).toEqual([first, second]);
        expect(saved).toMatchObject({ lastResponseMessageId: 'reply-1', isMarkedUnread: false });
        const stored = await rawConvo(conversationId);
        expect(timeOf(stored.lastResponseAt)).toBe(timeOf(saved?.lastResponseAt));
        expect(timeOf(stored.lastSeenAt)).toBe(Date.parse(UNSEEN_REPLY_WATERMARK));
      });

      it('assigns an owned project on insert only, and refreshes its statistics', async () => {
        const user = newId();
        const projectId = await seedProject(user);
        const foreignProject = await seedProject(newId());
        const conversationId = newConversationId();
        await save(ctx(user), { conversationId, endpoint: 'openAI', chatProjectId: projectId });
        expect((await rawConvo(conversationId)).chatProjectId).toBe(projectId);
        expect(await projectOf(projectId)).toMatchObject({
          conversationCount: 1,
          lastConversationId: conversationId,
        });
        const other = newConversationId();
        await save(ctx(user), {
          conversationId: other,
          endpoint: 'openAI',
          chatProjectId: foreignProject,
        });
        expect((await rawConvo(other)).chatProjectId ?? null).toBeNull();
        /** A turn save never moves or detaches an existing chat. */
        await save(
          ctx(user),
          { conversationId, chatProjectId: null },
          { unsetFields: { chatProjectId: 1 } },
        );
        expect((await rawConvo(conversationId)).chatProjectId).toBe(projectId);
      });

      it('seeds a code decision once, and only a whole one', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const mac = { environmentId: 'code-mac', workspaceId: 'primary' };
        await save(ctx(user), {
          conversationId,
          endpoint: 'agents',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
        });
        expect(await rawConvo(conversationId)).toMatchObject({
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
        });
        await save(ctx(user), {
          conversationId,
          codeEnvironmentMode: 'without_attached',
          codeWorkspaces: [],
        });
        expect((await rawConvo(conversationId)).codeEnvironmentMode).toBe('attached');
        const legacy = await seedConvo(user);
        await save(ctx(user), { conversationId: legacy, codeWorkspaces: [mac] });
        expect(await rawConvo(legacy)).not.toHaveProperty('codeWorkspaces');
        await save(ctx(user), { conversationId: legacy, codeEnvironmentMode: 'without_attached' });
        expect((await rawConvo(legacy)).codeEnvironmentMode).toBe('without_attached');
      });

      it('answers a value the store cannot cast with an error message rather than throwing', async () => {
        const user = newId();
        await expect(
          domain().saveConvo(ctx(user), {
            conversationId: newConversationId(),
            title: { $gt: '' },
          }),
        ).resolves.toEqual({ message: 'Error saving conversation' });
      });
    });

    describe('bulkSaveConvos (composed)', () => {
      it('imports conversations, dropping read state and private fields, seeding insert-only ones', async () => {
        const user = newId();
        const projectId = await seedProject(user);
        const foreignProject = await seedProject(newId());
        const owned = newConversationId();
        const orphan = newConversationId();
        await domain().bulkSaveConvos([
          {
            user,
            conversationId: owned,
            title: 'Imported',
            endpoint: 'openAI',
            chatProjectId: projectId,
            lastResponseAt: at(1),
            lastSeenAt: at(2),
            isMarkedUnread: true,
            initial_agent_id: 'forged',
            toolApprovalAllows: ['dangerous'],
            codeApprovalMode: 'auto',
            laneGitSeq: 3,
            agentEventActorReconciliations: [],
            codeEnvironmentMode: 'without_attached',
            tenantId: 'forged',
          },
          { user, conversationId: orphan, endpoint: 'openAI', chatProjectId: foreignProject },
        ]);
        const stored = await rawConvo(owned);
        expect(stored).toMatchObject({
          title: 'Imported',
          chatProjectId: projectId,
          initial_agent_id: null,
          codeEnvironmentMode: 'without_attached',
        });
        for (const field of [
          'lastResponseAt',
          'lastSeenAt',
          'isMarkedUnread',
          'toolApprovalAllows',
          'codeApprovalMode',
          'laneGitSeq',
          'agentEventActorReconciliations',
          'tenantId',
        ]) {
          expect(stored).not.toHaveProperty(field);
        }
        expect((await rawConvo(orphan)).chatProjectId).toBeNull();
        expect(await projectOf(projectId)).toMatchObject({
          conversationCount: 1,
          lastConversationId: owned,
        });
        /** A re-import updates in place and never replaces the insert-only decision. */
        await domain().bulkSaveConvos([
          { user, conversationId: owned, title: 'Re-imported', codeEnvironmentMode: 'attached' },
        ]);
        expect(await rawConvo(owned)).toMatchObject({
          title: 'Re-imported',
          codeEnvironmentMode: 'without_attached',
        });
      });

      it('refreshes the project a conversation leaves as well as the one it joins', async () => {
        const user = newId();
        const left = await seedProject(user, { conversationCount: 1 });
        const joined = await seedProject(user);
        const conversationId = await seedConvo(user, { chatProjectId: left });
        await domain().bulkSaveConvos([
          { user, conversationId, endpoint: 'openAI', chatProjectId: joined },
        ]);
        expect((await rawConvo(conversationId)).chatProjectId).toBe(joined);
        expect((await projectOf(left)).conversationCount).toBe(0);
        expect((await projectOf(joined)).conversationCount).toBe(1);
      });
    });

    describe('deleteConvos (composed)', () => {
      it('deletes a conversation and cascades into its messages, approvals, bookmarks and project', async () => {
        const user = newId();
        const projectId = await seedProject(user);
        const conversationId = await seedConvo(user, {
          chatProjectId: projectId,
          tags: ['saved', 'saved', 'work'],
        });
        const kept = await seedConvo(user, { chatProjectId: projectId, updatedAt: at(1) });
        await seedMessages(user, conversationId, 3);
        await seedMessages(user, kept, 1);
        await harness.seedRaw('conversationtags', [
          { _id: newId(), user, tag: 'saved', count: 2, position: 0 },
          { _id: newId(), user, tag: 'work', count: 0, position: 1 },
        ]);
        await harness.seedRaw('toolapprovalgrants', [
          { _id: newId(), user, agentId: 'agent', toolName: 'tool', conversationId },
          { _id: newId(), user, agentId: 'agent', toolName: 'tool', conversationId: kept },
        ]);
        await stores().refreshChatProjectStats(user, projectId);
        const result = await domain().deleteConvos(user, { conversationId });
        expect(result).toMatchObject({
          acknowledged: true,
          deletedCount: 1,
          messages: { deletedCount: 3 },
          conversationIds: [conversationId],
        });
        expect(await rawConvo(conversationId)).toBeUndefined();
        expect(await rawConvo(kept)).toBeDefined();
        expect(
          (await harness.readRaw('messages')).map((message) => message.conversationId),
        ).toEqual([kept]);
        expect(
          (await harness.readRaw('toolapprovalgrants')).map((grant) => grant.conversationId),
        ).toEqual([kept]);
        const tags = Object.fromEntries(
          (await harness.readRaw('conversationtags')).map((tag) => [tag.tag, tag.count]),
        );
        expect(tags).toEqual({ saved: 1, work: 0 });
        expect(await projectOf(projectId)).toMatchObject({
          conversationCount: 1,
          lastConversationId: kept,
        });
      });

      it("cascades a parent's deletion through the owner's subagent lineage, root first", async () => {
        const user = newId();
        const parent = await seedConvo(user);
        const child = await seedConvo(user, { subagentThread: lineage(parent, parent, 1) });
        const grandchild = await seedConvo(user, { subagentThread: lineage(child, parent, 2) });
        const foreignChild = await seedConvo(newId(), {
          subagentThread: lineage(parent, parent, 1),
        });
        const waves: string[][] = [];
        const result = await domain().deleteConvos(
          user,
          { conversationId: parent },
          {
            beforeDelete: async (conversationIds) => {
              waves.push(conversationIds);
            },
          },
        );
        expect(result.deletedCount).toBe(3);
        expect(result.conversationIds).toEqual([parent, child, grandchild]);
        expect(waves).toEqual([[parent], [child], [grandchild]]);
        expect(
          (await harness.readRaw('conversations')).map((record) => record.conversationId),
        ).toEqual([foreignChild]);
      });

      it('deletes every conversation of the user, or the listed ones, and rejects other filters', async () => {
        const user = newId();
        const [a, b, c] = [await seedConvo(user), await seedConvo(user), await seedConvo(user)];
        const foreign = await seedConvo(newId());
        expect(
          (
            await domain().deleteConvos(user, { conversationId: { $in: [a, b] } })
          ).conversationIds.sort(),
        ).toEqual([a, b].sort());
        await expect(domain().deleteConvos(user, { title: 'x' })).rejects.toThrow(
          /does not support the filter key/,
        );
        await expect(
          domain().deleteConvos(user, { conversationId: { $nin: [c] } }),
        ).rejects.toThrow(/does not support the filter key/);
        expect((await domain().deleteConvos(user, { user })).conversationIds).toEqual([c]);
        expect(
          (await harness.readRaw('conversations')).map((record) => record.conversationId),
        ).toEqual([foreign]);
        await expect(domain().deleteConvos(user, {})).rejects.toThrow(
          'Conversation not found or already deleted.',
        );
        expect(await domain().deleteConvos(user, {}, { allowEmpty: true })).toEqual({
          acknowledged: true,
          deletedCount: 0,
          messages: { acknowledged: true, deletedCount: 0 },
          conversationIds: [],
        });
      });

      it('resumes a partly deleted root from its lineage and its remaining messages', async () => {
        const user = newId();
        const root = newConversationId();
        const child = await seedConvo(user, { subagentThread: lineage(root, root, 1) });
        await seedMessages(user, root, 2);
        const result = await domain().deleteConvos(user, { conversationId: root });
        expect(result.conversationIds).toEqual([root, child]);
        expect(result.deletedCount).toBe(1);
        expect(result.messages.deletedCount).toBe(2);
        expect(await harness.readRaw('conversations')).toEqual([]);
        expect(await harness.readRaw('messages')).toEqual([]);
        /** Nothing left: a repeat is not found, unless the caller allows an empty sweep. */
        await expect(domain().deleteConvos(user, { conversationId: root })).rejects.toThrow(
          'Conversation not found or already deleted.',
        );
        expect(
          (await domain().deleteConvos(user, { conversationId: root }, { allowEmpty: true }))
            .conversationIds,
        ).toEqual([root]);
      });

      it('retires the queued turns and erases the trigger delivery results of the conversation', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, { endpoint: 'agents' });
        const kept = await seedConvo(user, { endpoint: 'agents' });
        const all = harness.createStores();
        for (const target of [conversationId, kept]) {
          await all.agentQueuedTurns.enqueueAgentQueuedTurn({
            user,
            conversationId: target,
            agentId: 'agent-1',
            parentMessageId: 'parent-1',
            clientRequestId: `request-${target}`,
            text: 'follow up',
          });
          await all.agentTriggerDeliveries.enqueueAgentTriggerDelivery({
            deliveryKey: `delivery-${target}`,
            fingerprint: `fingerprint-${target}`,
            orderingKey: `lane-${target}`,
            envelope: { target: { conversationId: target } },
            user,
            availableAt: new Date(),
          });
        }
        expect(await harness.readRaw('agentqueuedturns')).toHaveLength(2);
        await domain().deleteConvos(user, { conversationId });
        expect(
          (await harness.readRaw('agentqueuedturns')).map((turn) => turn.conversationId),
        ).toEqual([kept]);
        const deliveries = Object.fromEntries(
          (await harness.readRaw('agenttriggerdeliveries')).map((delivery) => [
            delivery.deliveryKey,
            delivery,
          ]),
        );
        expect(
          deliveries[`delivery-${conversationId}`].backgroundToolResultErasedAt,
        ).toBeInstanceOf(Date);
        expect(deliveries[`delivery-${kept}`]).not.toHaveProperty('backgroundToolResultErasedAt');
      });

      it('deletes within the tenant in context only', async () => {
        const user = newId();
        const conversationId = newConversationId();
        await seedConvo(user, { conversationId, tenantId: 'tenant-a' });
        await seedConvo(user, { conversationId, tenantId: 'tenant-b' });
        await inTenant('tenant-a', () => domain().deleteConvos(user, { conversationId }));
        expect((await harness.readRaw('conversations')).map((record) => record.tenantId)).toEqual([
          'tenant-b',
        ]);
      });
    });

    describe('searchConversation (composed)', () => {
      it('finds a conversation by id whoever owns it, with the projections callers pass', async () => {
        const owner = newId();
        const conversationId = await seedConvo(owner, {
          title: 'Found',
          messages: [newId()],
          tenantId: 'tenant-a',
        });
        const ownership = await domain().searchConversation(conversationId);
        expect(ownership).toMatchObject({ conversationId, user: owner });
        expect(ownership).not.toHaveProperty('title');
        const withoutMessages = await domain().searchConversation(conversationId, '-messages');
        expect(withoutMessages).toMatchObject({ title: 'Found' });
        expect(withoutMessages).not.toHaveProperty('messages');
        expect((await domain().searchConversation(conversationId, null))?.messages).toHaveLength(1);
        expect(await domain().searchConversation('missing')).toBeNull();
        expect(
          await inTenant('tenant-b', () => domain().searchConversation(conversationId)),
        ).toBeNull();
        await expect(domain().searchConversation(conversationId, 'title')).rejects.toThrow(
          /does not support the projection/,
        );
      });
    });
  });
}
