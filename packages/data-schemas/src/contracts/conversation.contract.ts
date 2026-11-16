/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ConversationStore` contract (`~/ports/conversation`), first part, ported from
 * `methods/conversation.spec.ts`: the owner-scoped reads (hidden server-written fields stay
 * hidden), the sidebar listing (`getConvosByCursor`: its facets, its sort fields and the cursor
 * paging over ties, missing titles and missing archive stamps, `updatedAt` desc then `_id` desc
 * by default), the id-list listing, the single-field writes that keep `updatedAt` (pin, message
 * reference, seen, unread, the monotonic reply stamp, archive-all, forced retention), the bounded
 * remembered tool approvals, the code-environment decision compare-and-set, the lane git state
 * with its sequence counter, workspace and attachment-epoch fences and the lane-context join to a
 * subagent thread's root, the command-line reads, and tenant scoping.
 *
 * The subagent threads and the agent event actor are in `conversation.agentEventActor.contract.ts`;
 * the store steps of `saveConvo`, `bulkSaveConvos`, `deleteConvos` and `searchConversation`, and
 * those four composed functions, in `conversation.domain.contract.ts`.
 *
 * Not here (they stay in the method spec): the title and message search (`search` needs a
 * MeiliSearch index), cases that make a query, the project refresh or the shared-link lookup
 * fail, or that count or spy on driver calls and projections, and the index declarations. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import { RetentionMode, UNSEEN_REPLY_WATERMARK } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { IConversation } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const BASE = Date.parse('2026-03-01T00:00:00.000Z');
/** A fixed instant `minutes` after {@link BASE}. */
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const HOUR = 60 * 60_000;
const inFuture = (ms = HOUR) => new Date(Date.now() + ms);
const inPast = (ms = HOUR) => new Date(Date.now() - ms);
const head = 'a'.repeat(40);
const mac = { environmentId: 'code-mac', workspaceId: 'primary' };
const team = { environmentId: 'code-team', workspaceId: 'shared' };

export function describeConversationContract(harness: ContractHarness): void {
  describe(`ConversationStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().conversations;
    const newId = () => harness.ids.generate();
    /** `count` new ids in ascending (insertion) order. */
    const ascendingIds = (count: number) =>
      Array.from({ length: count }, () => newId()).sort() as string[];
    let sequence = 0;
    const newConversationId = () => `convo-${++sequence}-${newId()}`;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);

    /**
     * Seeds one visible conversation raw (no defaults): owned by `user`, durable, not archived,
     * created and updated at `at(0)`, with `record` over it. Returns its `conversationId`.
     */
    const seedConvo = async (user: string, record: RawRecord = {}): Promise<string> => {
      const conversationId = (record.conversationId as string | undefined) ?? newConversationId();
      const seeded: RawRecord = {
        _id: newId(),
        conversationId,
        user,
        title: 'Seeded chat',
        endpoint: 'openAI',
        isTemporary: false,
        isArchived: false,
        messages: [],
        tags: [],
        createdAt: at(0),
        updatedAt: at(0),
        ...record,
      };
      /** A key given as `undefined` is left out (absent), not stored as null. */
      await harness.seedRaw('conversations', [
        Object.fromEntries(Object.entries(seeded).filter(([, value]) => value !== undefined)),
      ]);
      return conversationId;
    };
    const rawConvo = async (conversationId: string): Promise<RawRecord> => {
      const [record] = await readRawWhere(harness, 'conversations', { conversationId });
      return record;
    };
    const ids = (conversations: Array<Pick<IConversation, 'conversationId'>>) =>
      conversations.map((conversation) => conversation.conversationId);
    /** Every page of `getConvosByCursor` with `options`, until `nextCursor` is null. */
    const allPages = async (
      user: string,
      options: Parameters<ReturnType<typeof stores>['getConvosByCursor']>[1] = {},
    ): Promise<string[][]> => {
      const pages: string[][] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const result = await stores().getConvosByCursor(user, { ...options, cursor });
        pages.push(ids(result.conversations));
        cursor = result.nextCursor;
        if (cursor == null) {
          return pages;
        }
      }
      throw new Error('getConvosByCursor did not finish paging');
    };
    /** Seeds a chat project of `user` with empty statistics; returns its id. */
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

    describe('getConvo, getConvoTitle, getConvoTitleState, getConvoRetention', () => {
      it("reads the owner's conversation, and null for another user or an unknown id", async () => {
        const user = newId();
        const conversationId = await seedConvo(user, { title: 'Mine', model: 'gpt-4o' });
        const found = await stores().getConvo(user, conversationId);
        expect(found).toMatchObject({ conversationId, user, title: 'Mine', model: 'gpt-4o' });
        expect(timeOf(found?.updatedAt)).toBe(at(0).getTime());
        expect(await stores().getConvo(newId(), conversationId)).toBeNull();
        expect(await stores().getConvo(user, 'missing')).toBeNull();
      });

      it('never returns the server-written private fields', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          codeEnvironmentRevision: 4,
          laneGit: { branch: 'main', head, seq: 3 },
          laneGitSeq: 3,
          codeAttachmentEpoch: 2,
          initial_agent_id: 'agent-1',
          subagentThreadLease: { token: 'secret-token', taskId: 'task', expiresAt: inFuture() },
          agentEventBinding: { bindingId: 'binding', sourceKeyId: 'key', actorId: 'actor' },
          agentEventActorEpoch: 2,
          agentEventActorLegacyTurn: { token: 'legacy', startedAt: at(1) },
        });
        const found = (await stores().getConvo(user, conversationId)) as unknown as RawRecord;
        for (const hidden of [
          'codeEnvironmentRevision',
          'laneGit',
          'laneGitSeq',
          'codeAttachmentEpoch',
          'initial_agent_id',
          'subagentThreadLease',
          'agentEventBinding',
          'agentEventActorEpoch',
          'agentEventActorLegacyTurn',
          'agentEventActor',
          'agentEventActorReconciliations',
          'agentEventActorSuspension',
        ]) {
          expect(found).not.toHaveProperty(hidden);
        }
        expect(JSON.stringify(found)).not.toContain('secret-token');
      });

      it('reads the title, null for a chat without one, and "New Chat" for an unknown id', async () => {
        const user = newId();
        const titled = await seedConvo(user, { title: 'Named' });
        const untitled = await seedConvo(user, { title: undefined });
        expect(await stores().getConvoTitle(user, titled)).toBe('Named');
        expect(await stores().getConvoTitle(user, untitled)).toBeNull();
        expect(await stores().getConvoTitle(user, 'missing')).toBe('New Chat');
        expect(await stores().getConvoTitle(newId(), titled)).toBe('New Chat');
      });

      it('reads only the title state', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          title: 'Renamed',
          titleSetByUser: true,
          titleRevision: 3,
        });
        expect(await stores().getConvoTitleState(user, conversationId)).toEqual({
          title: 'Renamed',
          titleSetByUser: true,
          titleRevision: 3,
        });
        expect(await stores().getConvoTitleState(newId(), conversationId)).toBeNull();
      });

      it('reads only the retention fields', async () => {
        const user = newId();
        const expiredAt = inFuture();
        const conversationId = await seedConvo(user, { isTemporary: true, expiredAt });
        const retention = await stores().getConvoRetention(user, conversationId);
        expect(retention).toMatchObject({ isTemporary: true });
        expect(timeOf(retention?.expiredAt)).toBe(expiredAt.getTime());
        expect(retention).not.toHaveProperty('title');
        expect(retention).not.toHaveProperty('messages');
        expect(await stores().getConvoRetention(newId(), conversationId)).toBeNull();
      });
    });

    describe('getConvoOwnership', () => {
      const lineage = (parentConversationId: string) => ({
        rootConversationId: parentConversationId,
        parentConversationId,
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      });

      it('reads the owner, tenant and child-thread identity, without the content', async () => {
        const user = newId();
        const parent = await seedConvo(user, { messages: [newId()], tenantId: 'tenant-a' });
        const child = await seedConvo(user, {
          tenantId: 'tenant-a',
          subagentThread: lineage(parent),
        });
        const owned = await stores().getConvoOwnership(user, parent);
        expect(owned).toMatchObject({ user, tenantId: 'tenant-a' });
        expect(owned).not.toHaveProperty('messages');
        expect(owned).not.toHaveProperty('title');
        expect(owned).not.toHaveProperty('subagentThread');
        expect((await stores().getConvoOwnership(user, child))?.subagentThread).toEqual(
          lineage(parent),
        );
        expect(await stores().getConvoOwnership(newId(), parent)).toBeNull();
        expect(await stores().getConvoOwnership(user, 'missing')).toBeNull();
      });

      it('hides a retention-expired conversation before its TTL removes it', async () => {
        const user = newId();
        const expired = await seedConvo(user, { isTemporary: true, expiredAt: inPast() });
        const live = await seedConvo(user, { isTemporary: true, expiredAt: inFuture() });
        expect(await stores().getConvoOwnership(user, expired)).toBeNull();
        expect(await stores().getConvoOwnership(user, live)).toMatchObject({ user });
      });

      it('selects the exact tenant, or the tenantless one for null, when ids collide', async () => {
        const user = newId();
        const conversationId = newConversationId();
        await seedConvo(user, { conversationId, tenantId: 'tenant-a', title: 'A' });
        await seedConvo(user, { conversationId, tenantId: 'tenant-b', title: 'B' });
        await seedConvo(user, { conversationId, title: 'none' });
        expect((await stores().getConvoOwnership(user, conversationId, 'tenant-b'))?.tenantId).toBe(
          'tenant-b',
        );
        const tenantless = await stores().getConvoOwnership(user, conversationId, null);
        expect(tenantless).not.toBeNull();
        expect(tenantless?.tenantId ?? undefined).toBeUndefined();
        expect(await stores().getConvoOwnership(user, conversationId, 'tenant-c')).toBeNull();
      });
    });

    describe('getConvoFiles', () => {
      it("reads a conversation's file ids by id alone, and an empty list otherwise", async () => {
        // NOTE(contract): unlike every other read here, this one is not scoped to a user, so it
        // reads the files of another user's conversation with the same id (callers check access
        // first). Pinned as today's behavior.
        const user = newId();
        const withFiles = await seedConvo(user, { files: ['file-1', 'file-2'] });
        const without = await seedConvo(user);
        expect(await stores().getConvoFiles(withFiles)).toEqual(['file-1', 'file-2']);
        expect(await stores().getConvoFiles(without)).toEqual([]);
        expect(await stores().getConvoFiles('missing')).toEqual([]);
        const foreign = await seedConvo(newId(), { files: ['foreign-file'] });
        expect(await stores().getConvoFiles(foreign)).toEqual(['foreign-file']);
      });
    });

    describe('getConvosByCursor', () => {
      it('lists the visible conversations of the owner, most recently updated first', async () => {
        const user = newId();
        const older = await seedConvo(user, { updatedAt: at(1) });
        const newer = await seedConvo(user, { updatedAt: at(3) });
        const legacy = await seedConvo(user, { updatedAt: at(2), isTemporary: undefined });
        await seedConvo(newId(), { updatedAt: at(4) });
        await seedConvo(user, { updatedAt: at(5), isArchived: true });
        await seedConvo(user, { updatedAt: at(6), isTemporary: true, expiredAt: inFuture() });
        await seedConvo(user, { updatedAt: at(7), isTemporary: false, expiredAt: inPast() });
        await seedConvo(user, {
          updatedAt: at(8),
          subagentThread: {
            rootConversationId: older,
            parentConversationId: older,
            parentMessageId: 'm',
            parentToolCallId: 't',
            subagentType: 'researcher',
            subagentKind: 'agent',
            depth: 1,
          },
        });
        const { conversations, nextCursor } = await stores().getConvosByCursor(user);
        expect(ids(conversations)).toEqual([newer, legacy, older]);
        expect(nextCursor).toBeNull();
        /** A durable chat with a future deadline (retention mode ALL) is listed. */
        const retained = await seedConvo(user, { updatedAt: at(9), expiredAt: inFuture() });
        expect(ids((await stores().getConvosByCursor(user)).conversations)[0]).toBe(retained);
      });

      it('returns the list fields, marks the listed code decision, and leaves the rest out', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          title: 'Listed',
          model: 'gpt-4o',
          promptPrefix: 'not a list field',
          messages: [newId()],
          pinned: true,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          lastResponseAt: at(1),
          lastResponseMessageId: 'reply-1',
          lastSeenAt: at(2),
        });
        const [listed] = (await stores().getConvosByCursor(user)).conversations;
        expect(listed).toMatchObject({
          conversationId,
          title: 'Listed',
          model: 'gpt-4o',
          endpoint: 'openAI',
          isArchived: false,
          pinned: true,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          lastResponseMessageId: 'reply-1',
          codeDecisionListed: true,
          isShared: false,
        });
        expect(timeOf(listed.lastResponseAt)).toBe(at(1).getTime());
        expect(timeOf(listed.lastSeenAt)).toBe(at(2).getTime());
        expect(listed).not.toHaveProperty('messages');
        expect(listed).not.toHaveProperty('promptPrefix');
      });

      it('pages through ties on updatedAt by descending insertion order, without gaps or repeats', async () => {
        const user = newId();
        const [a, b, c, d, e] = ascendingIds(5);
        const convo = (_id: string) => seedConvo(user, { _id, conversationId: `tie-${_id}` });
        for (const _id of [c, a, e, b, d]) {
          await convo(_id);
        }
        expect(await allPages(user, { limit: 2 })).toEqual([
          [`tie-${e}`, `tie-${d}`],
          [`tie-${c}`, `tie-${b}`],
          [`tie-${a}`],
        ]);
        expect(await allPages(user, { limit: 2, sortDirection: 'asc' })).toEqual([
          [`tie-${a}`, `tie-${b}`],
          [`tie-${c}`, `tie-${d}`],
          [`tie-${e}`],
        ]);
      });

      it('includes the conversation at an exact page boundary, and no next page after a full last one', async () => {
        const user = newId();
        const expected: string[] = [];
        for (let index = 0; index < 6; index++) {
          expected.unshift(await seedConvo(user, { updatedAt: at(index) }));
        }
        expect(await allPages(user, { limit: 3 })).toEqual([
          expected.slice(0, 3),
          expected.slice(3),
        ]);
        const all = await stores().getConvosByCursor(user, { limit: 6 });
        expect(ids(all.conversations)).toEqual(expected);
        expect(all.nextCursor).toBeNull();
      });

      it('keeps paging from the cursor when an earlier row moves to the top meanwhile', async () => {
        const user = newId();
        const seeded: string[] = [];
        for (let index = 0; index < 4; index++) {
          seeded.unshift(await seedConvo(user, { updatedAt: at(index) }));
        }
        const first = await stores().getConvosByCursor(user, { limit: 2 });
        expect(ids(first.conversations)).toEqual(seeded.slice(0, 2));
        await stores().stampConvoLastResponse(user, seeded[3], 'reply');
        const second = await stores().getConvosByCursor(user, {
          limit: 2,
          cursor: first.nextCursor,
        });
        expect(ids(second.conversations)).toEqual([seeded[2]]);
      });

      it('sorts by createdAt when asked, and rejects a sort field outside the list', async () => {
        const user = newId();
        const createdFirst = await seedConvo(user, { createdAt: at(1), updatedAt: at(9) });
        const createdLast = await seedConvo(user, { createdAt: at(5), updatedAt: at(6) });
        expect(
          ids((await stores().getConvosByCursor(user, { sortBy: 'createdAt' })).conversations),
        ).toEqual([createdLast, createdFirst]);
        await expect(stores().getConvosByCursor(user, { sortBy: 'pinned' })).rejects.toThrow(
          /Invalid sortBy field/,
        );
      });

      it('pages by title through repeated titles and missing ones, both ways', async () => {
        const user = newId();
        const [n0, n1, n2, m0, m1, m2] = ascendingIds(6);
        await seedConvo(user, { _id: n0, conversationId: 'n0', title: 'Named 0' });
        await seedConvo(user, { _id: m0, conversationId: 'm0', title: undefined });
        await seedConvo(user, { _id: n1, conversationId: 'n1', title: 'Named 1' });
        await seedConvo(user, { _id: m1, conversationId: 'm1', title: undefined });
        await seedConvo(user, { _id: n2, conversationId: 'n2', title: 'Named 1' });
        await seedConvo(user, { _id: m2, conversationId: 'm2', title: undefined });
        /** A missing title sorts before every title. */
        expect(
          (await allPages(user, { sortBy: 'title', sortDirection: 'asc', limit: 2 })).flat(),
        ).toEqual(['m0', 'm1', 'm2', 'n0', 'n1', 'n2']);
        expect(
          (await allPages(user, { sortBy: 'title', sortDirection: 'desc', limit: 2 })).flat(),
        ).toEqual(['n2', 'n1', 'n0', 'm2', 'm1', 'm0']);
      });

      it('sorts archived chats by archive stamp, the unstamped ones by createdAt, both ways', async () => {
        const user = newId();
        const archived = (record: RawRecord) => seedConvo(user, { isArchived: true, ...record });
        const s0 = await archived({ archivedAt: at(10), createdAt: at(1) });
        const s1 = await archived({ archivedAt: at(20), createdAt: at(1) });
        const s2 = await archived({ archivedAt: at(30), createdAt: at(1) });
        /** Legacy rows: no stamp; `createdAt` and `updatedAt` deliberately disagree. */
        const l0 = await archived({ createdAt: at(2), updatedAt: at(9) });
        const l1 = await archived({ createdAt: at(3), updatedAt: at(8) });
        const l2 = await archived({ createdAt: at(4), updatedAt: at(7) });
        const options = { isArchived: true, sortBy: 'archivedAt', limit: 2 };
        expect((await allPages(user, { ...options, sortDirection: 'desc' })).flat()).toEqual([
          s2,
          s1,
          s0,
          l2,
          l1,
          l0,
        ]);
        expect((await allPages(user, { ...options, sortDirection: 'asc' })).flat()).toEqual([
          l0,
          l1,
          l2,
          s0,
          s1,
          s2,
        ]);
        /** The archived view lists only archived chats. */
        await seedConvo(user, { updatedAt: at(50) });
        expect(
          (await stores().getConvosByCursor(user, { isArchived: true })).conversations,
        ).toHaveLength(6);
      });

      it('clamps the page size to one at least and to one hundred at most', async () => {
        const user = newId();
        for (let index = 0; index < 102; index++) {
          await seedConvo(user, { updatedAt: at(index) });
        }
        const capped = await stores().getConvosByCursor(user, { limit: 500 });
        expect(capped.conversations).toHaveLength(100);
        const rest = await stores().getConvosByCursor(user, {
          limit: 500,
          cursor: capped.nextCursor,
        });
        expect(rest.conversations).toHaveLength(2);
        expect(rest.nextCursor).toBeNull();
        expect((await stores().getConvosByCursor(user, { limit: 0 })).conversations).toHaveLength(
          1,
        );
        expect((await stores().getConvosByCursor(user, { limit: -5 })).conversations).toHaveLength(
          1,
        );
        expect((await stores().getConvosByCursor(user)).conversations).toHaveLength(25);
      });

      it('filters on pins, tags, endpoints and the project, combining the facets', async () => {
        const user = newId();
        const project = newId();
        const pinned = await seedConvo(user, { pinned: true, tags: ['work'], updatedAt: at(1) });
        const tagged = await seedConvo(user, { tags: ['work', 'later'], updatedAt: at(2) });
        const anthropic = await seedConvo(user, { endpoint: 'anthropic', updatedAt: at(3) });
        const inProject = await seedConvo(user, { chatProjectId: project, updatedAt: at(4) });
        const nullProject = await seedConvo(user, { chatProjectId: null, updatedAt: at(5) });
        await seedConvo(user, { pinned: true, isArchived: true, updatedAt: at(6) });
        await seedConvo(newId(), { pinned: true, updatedAt: at(7) });
        const list = async (
          options: Parameters<ReturnType<typeof stores>['getConvosByCursor']>[1],
        ) => ids((await stores().getConvosByCursor(user, options)).conversations);
        expect(await list({ pinned: true })).toEqual([pinned]);
        expect(await list({ tags: ['work'] })).toEqual([tagged, pinned]);
        expect(await list({ tags: ['later', 'none'] })).toEqual([tagged]);
        expect(await list({ endpoints: ['anthropic', 'google'] })).toEqual([anthropic]);
        expect(await list({ projectId: project })).toEqual([inProject]);
        expect(await list({ projectId: 'unassigned' })).toEqual([
          nullProject,
          anthropic,
          tagged,
          pinned,
        ]);
        expect(await list({ tags: ['work'], pinned: true })).toEqual([pinned]);
        expect(await list({ tags: [], endpoints: [] })).toHaveLength(5);
      });

      it('keeps chats updated or created at or after the cutoffs, ignoring an invalid date', async () => {
        const user = newId();
        const old = await seedConvo(user, { createdAt: at(0), updatedAt: at(10) });
        const recent = await seedConvo(user, { createdAt: at(5), updatedAt: at(6) });
        const list = async (
          options: Parameters<ReturnType<typeof stores>['getConvosByCursor']>[1],
        ) => ids((await stores().getConvosByCursor(user, options)).conversations);
        expect(await list({ updatedAfter: at(10) })).toEqual([old]);
        expect(await list({ updatedAfter: at(6) })).toEqual([old, recent]);
        expect(await list({ createdAfter: at(5) })).toEqual([recent]);
        expect(await list({ createdAfter: at(1), updatedAfter: at(10) })).toEqual([]);
        expect(await list({ updatedAfter: new Date('not a date') })).toEqual([old, recent]);
      });

      it('carries the facets across a paged cursor', async () => {
        const user = newId();
        const expected: string[] = [];
        for (let index = 0; index < 5; index++) {
          expected.unshift(await seedConvo(user, { endpoint: 'anthropic', updatedAt: at(index) }));
          await seedConvo(user, { endpoint: 'openAI', updatedAt: at(index) });
        }
        expect((await allPages(user, { endpoints: ['anthropic'], limit: 2 })).flat()).toEqual(
          expected,
        );
      });

      it('keeps chats with files on the conversation or on any of its messages', async () => {
        const user = newId();
        const onConvo = await seedConvo(user, { files: ['file-1'], updatedAt: at(1) });
        await seedConvo(user, { files: [], updatedAt: at(2) });
        await seedConvo(user, { updatedAt: at(3) });
        const onMessage = await seedConvo(user, { updatedAt: at(4) });
        const onAttachment = await seedConvo(user, { updatedAt: at(5) });
        const onContent = await seedConvo(user, { updatedAt: at(6) });
        const otherUsers = await seedConvo(user, { updatedAt: at(7) });
        const messages = harness.createStores().messages;
        await messages.insertMessageRecords([
          {
            messageId: 'with-upload',
            conversationId: onMessage,
            user,
            files: [{ file_id: 'upload', filename: 'a.txt' }],
          },
          {
            messageId: 'with-attachment',
            conversationId: onAttachment,
            user,
            attachments: [{ file_id: 'tool-output', type: 'file' }],
          },
          {
            messageId: 'with-content-file',
            conversationId: onContent,
            user,
            content: [{ type: 'image_file', image_file: { file_id: 'img' } }],
          },
          {
            messageId: 'not-the-owner',
            conversationId: otherUsers,
            user: newId(),
            files: [{ file_id: 'foreign' }],
          },
          { messageId: 'plain', conversationId: otherUsers, user, text: 'no files' },
        ]);
        expect(
          ids((await stores().getConvosByCursor(user, { hasFiles: true })).conversations),
        ).toEqual([onContent, onAttachment, onMessage, onConvo]);
      });

      it('flags and filters the chats with an active shared link', async () => {
        const user = newId();
        const shared = await seedConvo(user, { updatedAt: at(1), endpoint: 'anthropic' });
        const lapsed = await seedConvo(user, { updatedAt: at(2) });
        const plain = await seedConvo(user, { updatedAt: at(3) });
        const otherShared = await seedConvo(user, { updatedAt: at(4) });
        await harness.seedRaw('sharedlinks', [
          { _id: newId(), conversationId: shared, user, shareId: 'share-1', createdAt: at(1) },
          {
            _id: newId(),
            conversationId: lapsed,
            user,
            shareId: 'share-2',
            expiredAt: inPast(),
            createdAt: at(1),
          },
          {
            _id: newId(),
            conversationId: otherShared,
            user: newId(),
            shareId: 'share-3',
            createdAt: at(1),
          },
        ]);
        const all = (await stores().getConvosByCursor(user)).conversations;
        expect(
          Object.fromEntries(all.map((convo) => [convo.conversationId, convo.isShared])),
        ).toEqual({ [shared]: true, [lapsed]: false, [plain]: false, [otherShared]: false });
        const onlyShared = (await stores().getConvosByCursor(user, { sharedOnly: true }))
          .conversations;
        expect(ids(onlyShared)).toEqual([shared]);
        expect(onlyShared[0].isShared).toBe(true);
        expect(
          (await stores().getConvosByCursor(user, { sharedOnly: true, endpoints: ['openAI'] }))
            .conversations,
        ).toEqual([]);
        await expect(stores().getConvosByCursor(newId(), { sharedOnly: true })).resolves.toEqual({
          conversations: [],
          nextCursor: null,
        });
      });

      it('lists nothing shared, and flags nothing, while sharing is switched off', async () => {
        const previous = process.env.ALLOW_SHARED_LINKS;
        process.env.ALLOW_SHARED_LINKS = 'false';
        try {
          const user = newId();
          const shared = await seedConvo(user);
          await harness.seedRaw('sharedlinks', [
            { _id: newId(), conversationId: shared, user, shareId: 'share-1' },
          ]);
          expect(
            (await stores().getConvosByCursor(user, { sharedOnly: true })).conversations,
          ).toEqual([]);
          const [listed] = (await stores().getConvosByCursor(user)).conversations;
          expect(listed.isShared).toBeUndefined();
        } finally {
          if (previous === undefined) {
            delete process.env.ALLOW_SHARED_LINKS;
          } else {
            process.env.ALLOW_SHARED_LINKS = previous;
          }
        }
      });
    });

    describe('getConvosQueried', () => {
      it('lists the named visible conversations of the owner, newest first, with a date cursor', async () => {
        const user = newId();
        const first = await seedConvo(user, { updatedAt: at(1) });
        const second = await seedConvo(user, { updatedAt: at(2) });
        const third = await seedConvo(user, { updatedAt: at(3) });
        const temporary = await seedConvo(user, { isTemporary: true, expiredAt: inFuture() });
        const foreign = await seedConvo(newId(), { updatedAt: at(4) });
        const named = [first, second, third, temporary, foreign, 'missing'].map(
          (conversationId) => ({ conversationId }),
        );
        const page = await stores().getConvosQueried(user, named, null, 2);
        expect(ids(page.conversations)).toEqual([third, second]);
        expect(page.nextCursor).toBe(at(2).toISOString());
        expect(Object.keys(page.convoMap).sort()).toEqual([second, third].sort());
        expect(page.conversations[0]).toMatchObject({ isShared: false });
        const next = await stores().getConvosQueried(user, named, page.nextCursor, 2);
        expect(ids(next.conversations)).toEqual([first]);
        expect(next.nextCursor).toBeNull();
        expect(
          ids((await stores().getConvosQueried(user, named, 'start', 5)).conversations),
        ).toEqual([third, second, first]);
      });

      it('skips the rest of a tie on updatedAt at a page boundary', async () => {
        // NOTE(contract): the cursor is the last row's `updatedAt` alone and the next page keeps
        // only strictly older rows, so rows sharing the boundary's `updatedAt` are never listed.
        // Pinned as today's behavior (`getConvosByCursor` breaks ties by id instead).
        const user = newId();
        const tied = [await seedConvo(user), await seedConvo(user), await seedConvo(user)];
        const named = tied.map((conversationId) => ({ conversationId }));
        const first = await stores().getConvosQueried(user, named, null, 1);
        expect(first.conversations).toHaveLength(1);
        expect(first.nextCursor).toBe(at(0).toISOString());
        const second = await stores().getConvosQueried(user, named, first.nextCursor, 1);
        expect(second).toMatchObject({ conversations: [], nextCursor: null });
      });

      it('answers an empty or missing id list with an empty result', async () => {
        const user = newId();
        await seedConvo(user);
        const empty = { conversations: [], nextCursor: null, convoMap: {} };
        expect(await stores().getConvosQueried(user, [])).toEqual(empty);
        expect(await stores().getConvosQueried(user, null)).toEqual(empty);
      });
    });

    describe('setConvoPinned and appendConvoMessageReference', () => {
      it('pins and unpins without touching the timestamps or the message list', async () => {
        const user = newId();
        const messageId = newId();
        const conversationId = await seedConvo(user, { messages: [messageId] });
        const pinned = await stores().setConvoPinned(user, conversationId, true);
        expect(pinned).toMatchObject({ conversationId, pinned: true });
        expect(timeOf(pinned?.updatedAt)).toBe(at(0).getTime());
        await stores().setConvoPinned(user, conversationId, false);
        const stored = await rawConvo(conversationId);
        expect(stored.pinned).toBe(false);
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        expect(stored.messages).toEqual([messageId]);
      });

      it("never inserts a conversation, nor pins another user's", async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        expect(await stores().setConvoPinned(user, 'missing', true)).toBeNull();
        expect(await stores().setConvoPinned(newId(), conversationId, true)).toBeNull();
        expect(await harness.readRaw('conversations')).toHaveLength(1);
        expect((await rawConvo(conversationId)).pinned).toBeUndefined();
      });

      it('adds a message id once, without touching updatedAt', async () => {
        const user = newId();
        const [kept, added] = ascendingIds(2);
        const conversationId = await seedConvo(user, { messages: [kept] });
        const updated = await stores().appendConvoMessageReference(user, conversationId, added);
        expect((updated?.messages ?? []).map((id) => idOf(harness, id))).toEqual([kept, added]);
        await stores().appendConvoMessageReference(user, conversationId, kept);
        const stored = await rawConvo(conversationId);
        expect(stored.messages).toEqual([kept, added]);
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
      });

      it("ignores an unusable id, an unknown conversation and another owner's", async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        expect(
          await stores().appendConvoMessageReference(user, conversationId, 'not-an-id'),
        ).toBeNull();
        expect(await stores().appendConvoMessageReference(user, 'missing', newId())).toBeNull();
        expect(
          await stores().appendConvoMessageReference(newId(), conversationId, newId()),
        ).toBeNull();
        expect((await rawConvo(conversationId)).messages).toEqual([]);
        expect(await harness.readRaw('conversations')).toHaveLength(1);
      });
    });

    describe('markConvoSeen, markConvoUnread and stampConvoLastResponse', () => {
      it('records the catch-up and clears the unread flag, without touching updatedAt', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, { isMarkedUnread: true });
        const before = Date.now();
        expect(await stores().markConvoSeen(user, conversationId)).toEqual({ modified: true });
        const stored = await rawConvo(conversationId);
        expect(timeOf(stored.lastSeenAt)).toBeGreaterThanOrEqual(before);
        expect(stored).not.toHaveProperty('isMarkedUnread');
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        /** A retried acknowledgement still reports success. */
        expect(await stores().markConvoSeen(user, conversationId)).toEqual({ modified: true });
        expect(await stores().markConvoSeen(newId(), conversationId)).toEqual({ modified: false });
        expect(await stores().markConvoSeen(user, 'missing')).toEqual({ modified: false });
      });

      it('acknowledges only the reply the client observed, never earlier than it', async () => {
        const user = newId();
        const reply = inFuture(10 * 60_000);
        const conversationId = await seedConvo(user, { lastResponseAt: reply });
        expect(await stores().markConvoSeen(user, conversationId, inFuture(60_000))).toEqual({
          modified: false,
        });
        expect((await rawConvo(conversationId)).lastSeenAt).toBeUndefined();
        expect(await stores().markConvoSeen(user, conversationId, reply)).toEqual({
          modified: true,
        });
        expect(timeOf((await rawConvo(conversationId)).lastSeenAt)).toBe(reply.getTime());
      });

      it('marks a never-replied chat unread with a manual reply marker', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          lastSeenAt: at(1),
          lastResponseMessageId: 'stale',
        });
        const result = await stores().markConvoUnread(user, conversationId);
        expect(result).toMatchObject({
          modified: true,
          lastResponseIsManual: true,
          isMarkedUnread: true,
        });
        expect(result.lastResponseMessageId).toBeUndefined();
        const stored = await rawConvo(conversationId);
        expect(timeOf(stored.lastResponseAt)).toBe(timeOf(result.lastResponseAt));
        expect(stored).not.toHaveProperty('lastSeenAt');
        expect(stored).not.toHaveProperty('lastResponseMessageId');
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
      });

      it('keeps an existing reply stamp when marking unread, and reports it', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          lastResponseAt: at(5),
          lastResponseMessageId: 'reply-1',
          lastSeenAt: at(6),
        });
        const result = await stores().markConvoUnread(user, conversationId);
        expect(result).toMatchObject({
          modified: true,
          lastResponseMessageId: 'reply-1',
          lastResponseIsManual: false,
          isMarkedUnread: true,
        });
        expect(timeOf(result.lastResponseAt)).toBe(at(5).getTime());
        const stored = await rawConvo(conversationId);
        expect(timeOf(stored.lastResponseAt)).toBe(at(5).getTime());
        expect(stored).not.toHaveProperty('lastSeenAt');
        expect(await stores().markConvoUnread(newId(), conversationId)).toEqual({
          modified: false,
        });
      });

      it('stamps a reply past the stored stamp and activity, and moves updatedAt with it', async () => {
        const user = newId();
        const future = inFuture(HOUR);
        const conversationId = await seedConvo(user, {
          lastResponseAt: future,
          lastResponseIsManual: true,
          isMarkedUnread: true,
          lastSeenAt: at(1),
        });
        const stamped = await stores().stampConvoLastResponse(user, conversationId, 'reply-2');
        expect(stamped).toMatchObject({ lastResponseMessageId: 'reply-2' });
        expect(timeOf(stamped?.lastResponseAt)).toBe(future.getTime() + 1);
        expect(timeOf(stamped?.updatedAt)).toBe(future.getTime() + 1);
        const stored = await rawConvo(conversationId);
        expect(timeOf(stored.lastResponseAt)).toBe(future.getTime() + 1);
        expect(timeOf(stored.updatedAt)).toBe(future.getTime() + 1);
        expect(stored).toMatchObject({ lastResponseMessageId: 'reply-2', isMarkedUnread: false });
        expect(timeOf(stored.lastSeenAt)).toBe(Date.parse(UNSEEN_REPLY_WATERMARK));
        expect(stored).not.toHaveProperty('lastResponseIsManual');
      });

      it('stamps a first reply after the latest activity, and each later one strictly after', async () => {
        const user = newId();
        const activity = inFuture(HOUR);
        const conversationId = await seedConvo(user, { updatedAt: activity });
        const first = await stores().stampConvoLastResponse(user, conversationId, 'reply-1');
        expect(timeOf(first?.lastResponseAt)).toBe(activity.getTime() + 1);
        const stamps = await Promise.all(
          ['a', 'b', 'c'].map((id) => stores().stampConvoLastResponse(user, conversationId, id)),
        );
        const times = stamps.map((stamp) => timeOf(stamp?.lastResponseAt)).sort();
        expect(new Set(times).size).toBe(3);
        expect(times[0]).toBeGreaterThan(timeOf(first?.lastResponseAt));
        expect(timeOf((await rawConvo(conversationId)).lastResponseAt)).toBe(times[2]);
      });

      it("never stamps a temporary chat, another user's chat or an unknown one", async () => {
        const user = newId();
        const temporary = await seedConvo(user, { isTemporary: true, expiredAt: inFuture() });
        const conversationId = await seedConvo(user);
        expect(await stores().stampConvoLastResponse(user, temporary, 'reply')).toBeNull();
        expect(await stores().stampConvoLastResponse(newId(), conversationId, 'reply')).toBeNull();
        expect(await stores().stampConvoLastResponse(user, 'missing', 'reply')).toBeNull();
        expect((await rawConvo(temporary)).lastResponseAt).toBeUndefined();
        expect((await rawConvo(conversationId)).lastResponseAt).toBeUndefined();
      });

      it("carries the project's activity pointer forward with the stamp", async () => {
        const user = newId();
        const projectId = await seedProject(user, {
          conversationCount: 1,
          lastConversationAt: at(0),
          lastConversationId: 'older',
        });
        const conversationId = await seedConvo(user, { chatProjectId: projectId });
        const stamped = await stores().stampConvoLastResponse(user, conversationId, 'reply');
        const project = await projectOf(projectId);
        expect(project.lastConversationId).toBe(conversationId);
        expect(timeOf(project.lastConversationAt)).toBe(timeOf(stamped?.updatedAt));
      });
    });

    describe('archiveAllConvos', () => {
      it('archives every visible chat of the owner, keeping updatedAt and stamping archivedAt', async () => {
        const user = newId();
        const first = await seedConvo(user, { updatedAt: at(1) });
        const second = await seedConvo(user, { updatedAt: at(2), isArchived: undefined });
        const alreadyArchived = await seedConvo(user, { isArchived: true, archivedAt: at(3) });
        const temporary = await seedConvo(user, { isTemporary: true, expiredAt: inFuture() });
        const expired = await seedConvo(user, { expiredAt: inPast() });
        const foreign = await seedConvo(newId());
        const before = Date.now();
        expect(await stores().archiveAllConvos(user)).toEqual({ archivedCount: 2 });
        const firstStored = await rawConvo(first);
        const secondStored = await rawConvo(second);
        expect(firstStored.isArchived).toBe(true);
        expect(secondStored.isArchived).toBe(true);
        expect(timeOf(firstStored.updatedAt)).toBe(at(1).getTime());
        expect(timeOf(firstStored.archivedAt)).toBeGreaterThanOrEqual(before);
        /** One stamp for the whole sweep. */
        expect(timeOf(secondStored.archivedAt)).toBe(timeOf(firstStored.archivedAt));
        expect(timeOf((await rawConvo(alreadyArchived)).archivedAt)).toBe(at(3).getTime());
        for (const untouched of [temporary, expired, foreign]) {
          expect((await rawConvo(untouched)).isArchived).toBe(false);
        }
        expect(await stores().archiveAllConvos(user)).toEqual({ archivedCount: 0 });
        expect(await stores().archiveAllConvos(newId())).toEqual({ archivedCount: 0 });
      });

      it('archives more chats than one batch holds', async () => {
        const user = newId();
        const records: RawRecord[] = Array.from({ length: 520 }, (_, index) => ({
          _id: newId(),
          conversationId: `bulk-${index}`,
          user,
          isTemporary: false,
          isArchived: false,
          createdAt: at(0),
          updatedAt: at(0),
        }));
        await harness.seedRaw('conversations', records);
        expect(await stores().archiveAllConvos(user)).toEqual({ archivedCount: 520 });
        expect(await readRawWhere(harness, 'conversations', { isArchived: false })).toEqual([]);
      });

      it('refreshes the statistics of every project the archived chats belonged to', async () => {
        const user = newId();
        const projectId = await seedProject(user, {
          conversationCount: 2,
          lastConversationAt: at(2),
          lastConversationId: 'stale',
        });
        await seedConvo(user, { chatProjectId: projectId, updatedAt: at(1) });
        await seedConvo(user, { chatProjectId: projectId, updatedAt: at(2) });
        await stores().archiveAllConvos(user);
        expect(await projectOf(projectId)).toMatchObject({
          conversationCount: 0,
          lastConversationAt: null,
          lastConversationId: null,
        });
      });
    });

    describe('stampForcedRetention', () => {
      const ephemeral = { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 24 };
      const seedTag = (user: string, tag: string, count: number) =>
        harness.seedRaw('conversationtags', [
          { _id: newId(), user, tag, count, position: 0, createdAt: at(0), updatedAt: at(0) },
        ]);
      const tagCount = async (user: string, tag: string) =>
        (await readRawWhere(harness, 'conversationtags', { user, tag }))[0]?.count;

      it('converts the chat and the named messages, releasing the bookmark counts once', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, { tags: ['saved'] });
        await seedTag(user, 'saved', 2);
        await harness.seedRaw('messages', [
          { _id: newId(), messageId: 'named', conversationId, user, isTemporary: false },
          { _id: newId(), messageId: 'other', conversationId, user, isTemporary: false },
        ]);
        const before = Date.now();
        await stores().stampForcedRetention(
          { userId: user, interfaceConfig: ephemeral },
          { conversationId, messageIds: ['named'] },
        );
        const stored = await rawConvo(conversationId);
        expect(stored).toMatchObject({ isTemporary: true, tags: [] });
        const deadline = timeOf(stored.expiredAt);
        expect(deadline).toBeGreaterThanOrEqual(before + 24 * HOUR - 60_000);
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        const [named] = await readRawWhere(harness, 'messages', { messageId: 'named' });
        expect(named.isTemporary).toBe(true);
        expect(timeOf(named.expiredAt)).toBe(deadline);
        const [other] = await readRawWhere(harness, 'messages', { messageId: 'other' });
        expect(other.isTemporary).toBe(false);
        expect(await tagCount(user, 'saved')).toBe(1);
        await stores().stampForcedRetention(
          { userId: user, interfaceConfig: ephemeral },
          { conversationId, messageIds: ['other'] },
        );
        expect(await tagCount(user, 'saved')).toBe(1);
        const [stampedLater] = await readRawWhere(harness, 'messages', { messageId: 'other' });
        expect(timeOf(stampedLater.expiredAt)).toBe(deadline);
      });

      it('keeps a stored deadline instead of opening a new window', async () => {
        const user = newId();
        const deadline = inFuture(3 * HOUR);
        const conversationId = await seedConvo(user, { expiredAt: deadline });
        await stores().stampForcedRetention(
          { userId: user, interfaceConfig: ephemeral },
          { conversationId },
        );
        const stored = await rawConvo(conversationId);
        expect(stored.isTemporary).toBe(true);
        expect(timeOf(stored.expiredAt)).toBe(deadline.getTime());
      });

      it('does nothing outside forced retention, for an unknown chat or without a user', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        await stores().stampForcedRetention(
          { userId: user, interfaceConfig: { retentionMode: RetentionMode.ALL } },
          { conversationId },
        );
        await stores().stampForcedRetention(
          { userId: '', interfaceConfig: ephemeral },
          { conversationId },
        );
        expect((await rawConvo(conversationId)).isTemporary).toBe(false);
        await stores().stampForcedRetention(
          { userId: user, interfaceConfig: ephemeral },
          { conversationId: 'missing', messageIds: ['ghost'] },
        );
        expect(await harness.readRaw('conversations')).toHaveLength(1);
        expect(await harness.readRaw('messages')).toEqual([]);
      });
    });

    describe('addConvoToolApprovalAllows', () => {
      it('stores tool names owner-scoped and idempotently', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const add = (toolNames: string[], owner = user) =>
          stores().addConvoToolApprovalAllows({ user: owner, conversationId, toolNames, max: 3 });
        expect(await add(['search', 'search', ''])).toBe(true);
        expect(await add(['search'])).toBe(true);
        expect(await add(['fetch'], newId())).toBe(false);
        expect((await rawConvo(conversationId)).toolApprovalAllows).toEqual(['search']);
        expect(timeOf((await rawConvo(conversationId)).updatedAt)).toBe(at(0).getTime());
      });

      it('refuses a write past the bound, charging only names not stored yet', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const add = (toolNames: string[]) =>
          stores().addConvoToolApprovalAllows({ user, conversationId, toolNames, max: 2 });
        expect(await add([])).toBe(false);
        expect(await add(['a', 'b', 'c'])).toBe(false);
        expect(await add(['a'])).toBe(true);
        expect(await add(['a', 'b'])).toBe(true);
        expect(await add(['c'])).toBe(false);
        expect(await add(['b', 'a'])).toBe(true);
        expect((await rawConvo(conversationId)).toolApprovalAllows).toEqual(['a', 'b']);
        expect(
          await stores().addConvoToolApprovalAllows({
            user,
            conversationId: 'missing',
            toolNames: ['a'],
            max: 2,
          }),
        ).toBe(false);
      });
    });

    describe('code environment decision', () => {
      it('reads the decision with its private revision', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          codeEnvironmentRevision: 4,
        });
        expect(await stores().getConvoCodeEnvironmentDecision(user, conversationId)).toMatchObject({
          conversationId,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          codeEnvironmentRevision: 4,
        });
        expect(await stores().getConvoCodeEnvironmentDecision(newId(), conversationId)).toBeNull();
      });

      it('advances the revision when a run is admitted and returns the decision with the epoch', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
        });
        const admitted = await stores().readAdmittedConvoCodeEnvironmentDecision(
          user,
          conversationId,
        );
        expect(admitted).toMatchObject({
          conversationId,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          codeAttachmentEpoch: 0,
        });
        expect(admitted).not.toHaveProperty('codeEnvironmentRevision');
        await stores().readAdmittedConvoCodeEnvironmentDecision(user, conversationId);
        const stored = await rawConvo(conversationId);
        expect(stored.codeEnvironmentRevision).toBe(2);
        expect(stored.codeAttachmentEpoch).toBeUndefined();
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        expect(
          await stores().readAdmittedConvoCodeEnvironmentDecision(newId(), conversationId),
        ).toBeNull();
      });

      it('replaces the decision it read, advancing revision and epoch and dropping the lane', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          codeEnvironmentRevision: 1,
          laneGit: { branch: 'main', head, seq: 2 },
          laneGitSeq: 2,
        });
        const moved = await stores().replaceConvoCodeEnvironmentDecision({
          user,
          conversationId,
          expected: {
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [mac],
            codeEnvironmentRevision: 1,
          },
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [team],
        });
        expect(moved).toMatchObject({ codeEnvironmentMode: 'attached', codeWorkspaces: [team] });
        let stored = await rawConvo(conversationId);
        expect(stored).toMatchObject({ codeEnvironmentRevision: 2, codeAttachmentEpoch: 1 });
        expect(stored).not.toHaveProperty('laneGit');
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        await stores().replaceConvoCodeEnvironmentDecision({
          user,
          conversationId,
          expected: {
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [team],
            codeEnvironmentRevision: 2,
          },
          codeEnvironmentMode: 'without_attached',
        });
        stored = await rawConvo(conversationId);
        expect(stored).toMatchObject({
          codeEnvironmentMode: 'without_attached',
          codeEnvironmentRevision: 3,
          codeAttachmentEpoch: 2,
        });
        expect(stored).not.toHaveProperty('codeWorkspaces');
      });

      it('attaches a chat stored without a decision, matching a missing mode and revision', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const attached = await stores().replaceConvoCodeEnvironmentDecision({
          user,
          conversationId,
          expected: {},
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
        });
        expect(attached).toMatchObject({ codeEnvironmentMode: 'attached', codeWorkspaces: [mac] });
        expect(await rawConvo(conversationId)).toMatchObject({
          codeEnvironmentRevision: 1,
          codeAttachmentEpoch: 1,
        });
      });

      it('replaces only the exact decision read: not a changed one, a reordered list or another owner', async () => {
        const user = newId();
        const both = [mac, team];
        const conversationId = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: both,
          codeEnvironmentRevision: 3,
        });
        const replace = (
          expected: Parameters<
            ReturnType<typeof stores>['replaceConvoCodeEnvironmentDecision']
          >[0]['expected'],
          owner = user,
        ) =>
          stores().replaceConvoCodeEnvironmentDecision({
            user: owner,
            conversationId,
            expected,
            codeEnvironmentMode: 'without_attached',
          });
        expect(
          await replace({
            codeEnvironmentMode: 'attached',
            codeWorkspaces: both,
            codeEnvironmentRevision: 2,
          }),
        ).toBeNull();
        expect(
          await replace({
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [team, mac],
            codeEnvironmentRevision: 3,
          }),
        ).toBeNull();
        expect(
          await replace(
            { codeEnvironmentMode: 'attached', codeWorkspaces: both, codeEnvironmentRevision: 3 },
            newId(),
          ),
        ).toBeNull();
        /** An element compares by value: the order of its keys does not matter. */
        expect(
          await replace({
            codeEnvironmentMode: 'attached',
            codeWorkspaces: both.map(({ environmentId, workspaceId }) => ({
              workspaceId,
              environmentId,
            })),
            codeEnvironmentRevision: 3,
          }),
        ).toMatchObject({ codeEnvironmentMode: 'without_attached' });
        const stored = await rawConvo(conversationId);
        expect(stored).toMatchObject({
          codeEnvironmentMode: 'without_attached',
          codeEnvironmentRevision: 4,
        });
        expect(stored).not.toHaveProperty('codeWorkspaces');
      });
    });

    describe('lane git', () => {
      /** A write with a sequence number drawn from the store, as the recorder draws one. */
      const record = async (
        input: Omit<Parameters<ReturnType<typeof stores>['setConvoLaneGit']>[0], 'seq'> & {
          seq?: number;
        },
      ) => {
        const seq =
          input.seq ?? (await stores().reserveConvoLaneGitSeq(input.user, input.conversationId));
        if (seq == null) {
          return false;
        }
        return stores().setConvoLaneGit({ ...input, seq });
      };

      it('issues increasing sequence numbers per conversation, distinct under concurrency', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        expect(await stores().reserveConvoLaneGitSeq(user, conversationId)).toBe(1);
        expect(await stores().reserveConvoLaneGitSeq(user, conversationId)).toBe(2);
        const concurrent = await Promise.all(
          [0, 1, 2, 3].map(() => stores().reserveConvoLaneGitSeq(user, conversationId)),
        );
        expect([...concurrent].sort()).toEqual([3, 4, 5, 6]);
        expect(await stores().reserveConvoLaneGitSeq(user, 'missing')).toBeNull();
        expect(await stores().reserveConvoLaneGitSeq(newId(), conversationId)).toBeNull();
        expect(timeOf((await rawConvo(conversationId)).updatedAt)).toBe(at(0).getTime());
      });

      it('stores and reads the lane, never exposing the sequence number', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const laneGit = { branch: 'feat/x', head };
        expect(await record({ user, conversationId, laneGit, repo: 'o/r' })).toBe(true);
        expect(await stores().getConvoLaneGit(user, conversationId)).toEqual({
          ...laneGit,
          repo: 'o/r',
        });
        expect((await rawConvo(conversationId)).laneGit).toMatchObject({ seq: 1 });
        expect(await stores().getConvoLaneGit(newId(), conversationId)).toBeNull();
        expect(await stores().getConvoLaneGit(user, 'missing')).toBeNull();
        expect(await record({ user: newId(), conversationId, laneGit, seq: 9 })).toBe(false);
        expect(await record({ user, conversationId: 'missing', laneGit, seq: 9 })).toBe(false);
      });

      it('ignores a report with a lower sequence number than the stored one', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const late = await stores().reserveConvoLaneGitSeq(user, conversationId);
        expect(await record({ user, conversationId, laneGit: { branch: 'new', head } })).toBe(true);
        expect(
          await stores().setConvoLaneGit({
            user,
            conversationId,
            laneGit: { branch: 'old', head },
            seq: late as number,
          }),
        ).toBe(false);
        expect(await stores().getConvoLaneGit(user, conversationId)).toEqual({
          branch: 'new',
          head,
        });
      });

      it('keeps a linked pull request across reports on the same branch and repository only', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const lane = { branch: 'feat/x', head };
        const read = () => stores().getConvoLaneGit(user, conversationId);
        await record({ user, conversationId, laneGit: lane, repo: 'o/r', pullRequest: 7 });
        await record({
          user,
          conversationId,
          laneGit: { ...lane, head: 'b'.repeat(40) },
          repo: 'o/r',
        });
        expect(await read()).toEqual({
          branch: 'feat/x',
          head: 'b'.repeat(40),
          repo: 'o/r',
          pullRequest: 7,
        });
        await record({ user, conversationId, laneGit: lane, repo: 'o/r', pullRequest: 8 });
        expect((await read())?.pullRequest).toBe(8);
        await record({ user, conversationId, laneGit: { branch: 'other', head }, repo: 'o/r' });
        expect(await read()).toEqual({ branch: 'other', head, repo: 'o/r' });
        await record({ user, conversationId, laneGit: lane, repo: 'o/r', pullRequest: 9 });
        await record({ user, conversationId, laneGit: lane, repo: '' });
        expect(await read()).toEqual(lane);
      });

      it('stores a branch or repository that looks like a field path as plain text', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const laneGit = { branch: '$inc.x', head: 'a.b' };
        await record({ user, conversationId, laneGit, repo: '$set.y' });
        expect(await stores().getConvoLaneGit(user, conversationId)).toEqual({
          ...laneGit,
          repo: '$set.y',
        });
      });

      it('fences a report by the workspace the chat is attached to', async () => {
        const user = newId();
        const write = (conversationId: string, workspace: Record<string, unknown>) =>
          record({
            user,
            conversationId,
            laneGit: { branch: 'feat/x', head },
            workspace: workspace as never,
          });
        const onMac = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
        });
        const onTeam = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [team],
        });
        const detached = await seedConvo(user, { codeEnvironmentMode: 'without_attached' });
        const undecided = await seedConvo(user);
        expect(await write(onMac, mac)).toBe(true);
        expect(await write(onMac, { ...mac, required: true })).toBe(true);
        expect(await write(onTeam, mac)).toBe(false);
        expect(await write(detached, mac)).toBe(false);
        expect(await write(undecided, mac)).toBe(true);
        expect(await write(undecided, { ...mac, required: true })).toBe(false);
        expect(await stores().getConvoLaneGit(user, onTeam)).toBeNull();
      });

      it('applies a report only from the attachment epoch it was captured in', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [mac],
          codeEnvironmentRevision: 1,
        });
        const write = (epoch: number) =>
          record({
            user,
            conversationId,
            laneGit: { branch: `epoch-${epoch}`, head },
            workspace: { ...mac, epoch },
          });
        expect(await write(0)).toBe(true);
        /** Move away and back: the same workspace, a later epoch. */
        for (const [from, to, revision] of [
          [mac, team, 1],
          [team, mac, 2],
        ] as const) {
          await stores().replaceConvoCodeEnvironmentDecision({
            user,
            conversationId,
            expected: {
              codeEnvironmentMode: 'attached',
              codeWorkspaces: [from],
              codeEnvironmentRevision: revision,
            },
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [to],
          });
        }
        expect(
          (await stores().getConvoLaneContext(user, conversationId))?.codeAttachmentEpoch,
        ).toBe(2);
        expect(await write(0)).toBe(false);
        expect(await write(1)).toBe(false);
        expect(await write(2)).toBe(true);
        expect((await stores().getConvoLaneGit(user, conversationId))?.branch).toBe('epoch-2');
      });

      it('treats an expired temporary chat as gone', async () => {
        const user = newId();
        const conversationId = await seedConvo(user, {
          isTemporary: true,
          expiredAt: inPast(),
          laneGit: { branch: 'main', head, seq: 1 },
          laneGitSeq: 1,
        });
        expect(await stores().reserveConvoLaneGitSeq(user, conversationId)).toBeNull();
        expect(await stores().getConvoLaneGit(user, conversationId)).toBeNull();
        expect(
          await stores().setConvoLaneGit({
            user,
            conversationId,
            laneGit: { branch: 'new', head },
            seq: 5,
          }),
        ).toBe(false);
        expect(await stores().getConvosLaneGit(user, [conversationId])).toEqual([]);
        expect(await stores().getConvoLaneContext(user, conversationId)).toBeNull();
      });

      it("reads the lanes of the owner's chats in one call, leaving out the rest alike", async () => {
        const user = newId();
        const withLane = await seedConvo(user, {
          laneGit: { branch: 'main', head, repo: 'o/r', pullRequest: 3, seq: 4 },
        });
        const detachedLane = await seedConvo(user, {
          laneGit: { branch: null, head: null, seq: 1 },
        });
        const withoutLane = await seedConvo(user);
        const foreign = await seedConvo(newId(), { laneGit: { branch: 'x', head, seq: 1 } });
        const lanes = await stores().getConvosLaneGit(user, [
          withLane,
          detachedLane,
          withoutLane,
          foreign,
          'missing',
        ]);
        expect([...lanes].sort((a, b) => a.conversationId.localeCompare(b.conversationId))).toEqual(
          [
            {
              conversationId: withLane,
              laneGit: { branch: 'main', head, repo: 'o/r', pullRequest: 3 },
            },
            { conversationId: detachedLane, laneGit: { branch: null, head: null } },
          ].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
        );
        expect(await stores().getConvoLaneGit(user, detachedLane)).toEqual({
          branch: null,
          head: null,
        });
        expect(await stores().getConvosLaneGit(user, [])).toEqual([]);
      });
    });

    describe('getConvoLaneContext', () => {
      const threadOf = (rootConversationId: string) => ({
        rootConversationId,
        parentConversationId: rootConversationId,
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      });

      it('reads epoch zero and no thread for a chat never moved, and null when not the owner', async () => {
        const user = newId();
        const conversationId = await seedConvo(user);
        const moved = await seedConvo(user, { codeAttachmentEpoch: 3 });
        expect(await stores().getConvoLaneContext(user, conversationId)).toEqual({
          subagentThread: null,
          codeAttachmentEpoch: 0,
        });
        expect((await stores().getConvoLaneContext(user, moved))?.codeAttachmentEpoch).toBe(3);
        expect(await stores().getConvoLaneContext(newId(), conversationId)).toBeNull();
        expect(await stores().getConvoLaneContext(user, 'missing')).toBeNull();
      });

      it("reads a subagent thread's route and the epoch of its visible root, not its own", async () => {
        const user = newId();
        const root = await seedConvo(user, { tenantId: 'tenant-a', codeAttachmentEpoch: 5 });
        const thread = await seedConvo(user, {
          tenantId: 'tenant-a',
          codeAttachmentEpoch: 1,
          subagentThread: threadOf(root),
        });
        expect(await stores().getConvoLaneContext(user, thread)).toEqual({
          subagentThread: threadOf(root),
          codeAttachmentEpoch: 5,
        });
      });

      it("reads zero when the root is another user's, another tenant's, expired or gone", async () => {
        const user = newId();
        const read = async (rootRecord: RawRecord | null, threadRecord: RawRecord = {}) => {
          const rootConversationId = newConversationId();
          if (rootRecord != null) {
            await seedConvo((rootRecord.user as string) ?? user, {
              conversationId: rootConversationId,
              codeAttachmentEpoch: 7,
              ...rootRecord,
            });
          }
          const thread = await seedConvo(user, {
            subagentThread: threadOf(rootConversationId),
            ...threadRecord,
          });
          return (await stores().getConvoLaneContext(user, thread))?.codeAttachmentEpoch;
        };
        expect(await read({ user: newId() })).toBe(0);
        expect(await read({ tenantId: 'tenant-b' }, { tenantId: 'tenant-a' })).toBe(0);
        expect(await read({}, { tenantId: 'tenant-a' })).toBe(0);
        expect(await read({ isTemporary: true, expiredAt: inPast() })).toBe(0);
        expect(await read(null)).toBe(0);
        expect(await read({ tenantId: 'tenant-a' }, { tenantId: 'tenant-a' })).toBe(7);
        expect(await read({})).toBe(7);
      });
    });

    describe('countConvosByUser and createConvoRecord', () => {
      it('counts the conversations of each owner, the ownerless ones under null', async () => {
        const [first, second] = [newId(), newId()];
        await seedConvo(first);
        await seedConvo(first);
        await seedConvo(second);
        await seedConvo(first, { user: undefined });
        const counts = await stores().countConvosByUser();
        expect([...counts].sort((a, b) => String(a.user).localeCompare(String(b.user)))).toEqual(
          [
            { user: first, count: 2 },
            { user: second, count: 1 },
            { user: null, count: 1 },
          ].sort((a, b) => String(a.user).localeCompare(String(b.user))),
        );
      });

      it('creates a validated record as given, with the store defaults and timestamps', async () => {
        const user = newId();
        const before = Date.now();
        await stores().createConvoRecord({
          conversationId: 'seeded',
          user,
          endpoint: 'openAI',
          title: 'Gallery',
        });
        const stored = await rawConvo('seeded');
        expect(stored).toMatchObject({
          user,
          endpoint: 'openAI',
          title: 'Gallery',
          isTemporary: false,
          tags: [],
          messages: [],
          chatProjectId: null,
        });
        expect(timeOf(stored.createdAt)).toBeGreaterThanOrEqual(before);
        expect(timeOf(stored.updatedAt)).toBe(timeOf(stored.createdAt));
        await stores().createConvoRecord({ conversationId: 'untitled', user, endpoint: 'openAI' });
        expect((await rawConvo('untitled')).title).toBe('New Chat');
        /** The store validates the record: the endpoint is required. */
        await expect(
          stores().createConvoRecord({ conversationId: 'no-endpoint', user }),
        ).rejects.toThrow();
        expect(await rawConvo('no-endpoint')).toBeUndefined();
      });
    });

    describe('tenant scoping', () => {
      it('reads, lists and writes only the conversations of the tenant in context', async () => {
        const user = newId();
        const conversationId = newConversationId();
        await seedConvo(user, { conversationId, tenantId: 'tenant-a', title: 'A' });
        await seedConvo(user, { conversationId, tenantId: 'tenant-b', title: 'B' });
        const inA = await inTenant('tenant-a', () => stores().getConvo(user, conversationId));
        expect(inA).toMatchObject({ title: 'A', tenantId: 'tenant-a' });
        const listedInB = await inTenant('tenant-b', () => stores().getConvosByCursor(user));
        expect(listedInB.conversations.map((convo) => convo.title)).toEqual(['B']);
        await inTenant('tenant-a', () => stores().setConvoPinned(user, conversationId, true));
        const [a] = await readRawWhere(harness, 'conversations', { tenantId: 'tenant-a' });
        const [b] = await readRawWhere(harness, 'conversations', { tenantId: 'tenant-b' });
        expect(a.pinned).toBe(true);
        expect(b.pinned).toBeUndefined();
        expect(await inTenant('tenant-c', () => stores().getConvoTitle(user, conversationId))).toBe(
          'New Chat',
        );
        expect(await inTenant('tenant-c', () => stores().archiveAllConvos(user))).toEqual({
          archivedCount: 0,
        });
      });

      it('counts and creates within the tenant in context', async () => {
        const user = newId();
        await seedConvo(user, { tenantId: 'tenant-a' });
        await seedConvo(user, { tenantId: 'tenant-b' });
        await seedConvo(user, { tenantId: 'tenant-b' });
        expect(await inTenant('tenant-b', () => stores().countConvosByUser())).toEqual([
          { user, count: 2 },
        ]);
        await inTenant('tenant-a', () =>
          stores().createConvoRecord({ conversationId: 'created-in-a', user, endpoint: 'openAI' }),
        );
        expect((await rawConvo('created-in-a')).tenantId).toBe('tenant-a');
      });
    });
  });
}
