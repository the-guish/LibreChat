/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SharedLinkStore` contract (`~/ports/share`), ported from `methods/share.test.ts` and
 * `methods/share.records.spec.ts`: links publish the owner's messages of a conversation (all of
 * them stored, the branch up to a target's level shown), one active link per conversation and
 * target, the keyset-paged owner list (repeated and missing titles included), republishing with a
 * target that advances to its branch's newest turn, the anonymized public view and its preflight,
 * the `fileSnapshots` array (built from the owner's streamable files, rewritten to the share route,
 * absent on links that predate it and backfilled on their first read without counting as a
 * republish, removed when a link opts out), and the record-level reads and writes of the ACL
 * layer, with the legacy `isPublic` flag seeded raw and cleared outside the schema.
 *
 * The public view reads the link's messages by reference (`populate`): a message edited or deleted
 * after publishing is shown edited or not at all (pinned below with `NOTE(contract)`).
 *
 * Left in the method specs: error logging and the database-error mapping (stubbed models), the
 * custom schemas of `share.test.ts`, the search engine stub and its filter syntax, the pure
 * `anonymizeSharedContent` helper (not on the port), and the steer-part and MCP-UI sanitization
 * details. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { Constants } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { SharedFileSnapshot, SharedLinkContentSnapshot } from '~/types';
import { idOf, timeOf, useContractHarness } from './support';

const ROOT = Constants.NO_PARENT;
const day = 24 * 60 * 60 * 1000;

export function describeSharedLinkContract(harness: ContractHarness): void {
  describe(`SharedLinkStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().sharedLinks;
    const newId = () => harness.ids.generate();
    let sequence = 0;

    /** The owner's conversation, and its messages in creation order (each `[id, record]`). */
    const seedConversation = async (
      user: string,
      conversationId: string,
      messages: Array<[string, RawRecord]> = [],
      title: string | undefined = 'Shared Conversation',
    ) => {
      await harness.seedRaw('conversations', [
        { _id: newId(), conversationId, user, endpoint: 'openAI', ...(title ? { title } : {}) },
      ]);
      await seedMessages(user, conversationId, messages);
    };
    const seedMessages = (
      user: string,
      conversationId: string,
      messages: Array<[string, RawRecord]>,
    ) =>
      harness.seedRaw(
        'messages',
        messages.map(([messageId, record]) => {
          const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ++sequence));
          return {
            _id: newId(),
            messageId,
            conversationId,
            user,
            parentMessageId: ROOT,
            isCreatedByUser: true,
            text: messageId,
            createdAt: at,
            updatedAt: at,
            ...record,
          };
        }),
      );
    const seedFile = async (user: string, record: RawRecord = {}): Promise<string> => {
      const fileId = `file_${newId()}`;
      await harness.seedRaw('files', [
        {
          _id: newId(),
          user,
          file_id: fileId,
          filename: 'report.pdf',
          filepath: `/uploads/${user}/${fileId}`,
          type: 'application/pdf',
          bytes: 1024,
          source: 'local',
          ...record,
        },
      ]);
      return fileId;
    };
    /** A link stored as it was before file snapshots and grants existed (no `fileSnapshots`). */
    const seedLegacyLink = async (record: RawRecord): Promise<string> => {
      const _id = newId();
      await harness.seedRaw('sharedlinks', [
        {
          _id,
          shareId: `share_${_id}`,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...record,
        },
      ]);
      return _id;
    };
    const messageIdsOf = async (conversationId: string) =>
      (await harness.readRaw('messages'))
        .filter((record) => record.conversationId === conversationId)
        .map((record) => record._id as string);
    const linkOf = async (shareId: string) =>
      (await harness.readRaw('sharedlinks')).find((record) => record.shareId === shareId);
    const texts = async (shareId: string) =>
      (await stores().getSharedMessages(shareId))?.messages.map(({ text }) => text);
    const codeOf = async (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: { code?: string }) => error.code,
      );

    describe('createSharedLink', () => {
      it("publishes the owner's messages of the conversation under a new share id", async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['m1', { text: 'Hello' }],
          ['m2', { text: 'World', isCreatedByUser: false, parentMessageId: 'm1' }],
        ]);
        await seedMessages(newId(), 'c1', [['intruder', { text: 'Not the owner’s' }]]);
        const ownIds = (await harness.readRaw('messages'))
          .filter((record) => record.user === user)
          .map((record) => record._id);

        const result = await stores().createSharedLink(user, 'c1');
        expect(result).toEqual({
          _id: expect.any(String),
          shareId: expect.any(String),
          conversationId: 'c1',
          targetMessageId: undefined,
        });
        const stored = await linkOf(result.shareId);
        expect(idOf(harness, stored?._id)).toBe(result._id);
        expect(stored).toMatchObject({
          user,
          conversationId: 'c1',
          title: 'Shared Conversation',
          snapshotFiles: true,
          fileSnapshots: [],
        });
        expect(stored?.messages).toEqual(ownIds);
        expect(await texts(result.shareId)).toEqual(['Hello', 'World']);
      });

      it('keeps one active link per conversation and target, ignoring expired ones', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['m1', {}],
          ['m2', { parentMessageId: 'm1' }],
        ]);
        await seedLegacyLink({
          shareId: 'expired-share',
          conversationId: 'c1',
          user,
          messages: await messageIdsOf('c1'),
          expiredAt: new Date(Date.now() - 3_600_000),
        });
        const first = await stores().createSharedLink(user, 'c1');
        expect(first.shareId).not.toBe('expired-share');
        expect(await codeOf(stores().createSharedLink(user, 'c1'))).toBe('SHARE_EXISTS');
        const targeted = await stores().createSharedLink(user, 'c1', 'm1');
        expect(targeted.targetMessageId).toBe('m1');
        expect(await codeOf(stores().createSharedLink(user, 'c1', 'm1'))).toBe('SHARE_EXISTS');
        expect(await harness.readRaw('sharedlinks')).toHaveLength(3);
      });

      it('leaves exactly one link when creates race', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', {}]]);
        const results = await Promise.allSettled([
          stores().createSharedLink(user, 'c1'),
          stores().createSharedLink(user, 'c1'),
          stores().createSharedLink(user, 'c1'),
        ]);
        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1);
        const rejections = results.flatMap((result) =>
          result.status === 'rejected' ? [(result.reason as { code?: string }).code] : [],
        );
        expect(rejections).toEqual(['SHARE_EXISTS', 'SHARE_EXISTS']);
        const stored = await harness.readRaw('sharedlinks');
        expect(stored).toHaveLength(1);
        expect(stored[0].shareId).toBe(
          (fulfilled[0] as PromiseFulfilledResult<{ shareId: string }>).value.shareId,
        );
      });

      it('stores the expiry and rejects with a code what it cannot publish', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', {}]]);
        await seedConversation(user, 'empty');
        await seedConversation(newId(), 'theirs', [['t1', {}]]);
        const expiredAt = new Date(Date.now() + day);
        const { shareId } = await stores().createSharedLink(user, 'c1', undefined, expiredAt);
        expect(timeOf((await linkOf(shareId))?.expiredAt)).toBe(expiredAt.getTime());
        expect(await codeOf(stores().createSharedLink('', 'c1'))).toBe('INVALID_PARAMS');
        expect(await codeOf(stores().createSharedLink(user, ''))).toBe('INVALID_PARAMS');
        expect(await codeOf(stores().createSharedLink(user, 'theirs'))).toBe(
          'CONVERSATION_NOT_FOUND',
        );
        expect(await codeOf(stores().createSharedLink(user, 'empty'))).toBe('NO_MESSAGES');
        expect(await codeOf(stores().createSharedLink(user, 'c1', 'missing'))).toBe(
          'TARGET_MESSAGE_NOT_FOUND',
        );
        expect(await harness.readRaw('sharedlinks')).toHaveLength(1);
      });

      it('preflights the branch up to the target’s level and stores nothing when it throws', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['root', { text: 'Root prompt' }],
          ['target', { text: 'Selected answer', isCreatedByUser: false, parentMessageId: 'root' }],
          ['sibling', { text: 'Sibling answer', isCreatedByUser: false, parentMessageId: 'root' }],
          ['tail', { text: 'Unselected tail', parentMessageId: 'sibling' }],
        ]);
        const seen: SharedLinkContentSnapshot[] = [];
        const result = await stores().createSharedLink(
          user,
          'c1',
          'target',
          undefined,
          true,
          (snapshot) => {
            seen.push(snapshot);
          },
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].title).toBe('Shared Conversation');
        expect(seen[0].messages.map(({ text }) => text).sort()).toEqual(
          ['Root prompt', 'Selected answer', 'Sibling answer'].sort(),
        );
        expect((await linkOf(result.shareId))?.messages).toHaveLength(4);
        expect((await texts(result.shareId))?.sort()).toEqual(
          ['Root prompt', 'Selected answer', 'Sibling answer'].sort(),
        );

        await seedConversation(user, 'c2', [['m', {}]], undefined);
        const rejection = new Error('blocked by policy');
        await expect(
          stores().createSharedLink(user, 'c2', undefined, undefined, true, () => {
            throw rejection;
          }),
        ).rejects.toBe(rejection);
        expect(await harness.readRaw('sharedlinks')).toHaveLength(1);
      });
    });

    describe('getSharedLink', () => {
      it("reads the user's most recently updated active link for the conversation", async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', {}]]);
        const older = await seedLegacyLink({
          shareId: 'older',
          conversationId: 'c1',
          user,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        await seedLegacyLink({
          shareId: 'newer',
          conversationId: 'c1',
          user,
          targetMessageId: 'm1',
          snapshotFiles: false,
          updatedAt: new Date('2026-02-01T00:00:00.000Z'),
        });
        await seedLegacyLink({
          shareId: 'expired',
          conversationId: 'c1',
          user,
          updatedAt: new Date('2026-03-01T00:00:00.000Z'),
          expiredAt: new Date(Date.now() - 1000),
        });
        expect(older).toEqual(expect.any(String));
        const link = await stores().getSharedLink(user, 'c1');
        expect(link).toMatchObject({
          success: true,
          shareId: 'newer',
          targetMessageId: 'm1',
          snapshotFiles: false,
        });
        expect(link._id).toEqual(expect.any(String));
        expect(await stores().getSharedLink(newId(), 'c1')).toEqual({
          shareId: null,
          success: false,
        });
        expect(await stores().getSharedLink(user, 'c2')).toEqual({
          shareId: null,
          success: false,
        });
        expect(await codeOf(stores().getSharedLink('', 'c1'))).toBe('INVALID_PARAMS');
      });
    });

    describe('getSharedLinks', () => {
      const pageAll = async (
        user: string,
        sortBy: string,
        sortDirection: string,
        pageSize = 2,
      ): Promise<string[]> => {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await stores().getSharedLinks(
            user,
            cursor,
            pageSize,
            sortBy,
            sortDirection,
          );
          seen.push(...result.links.map(({ shareId }) => shareId));
          if (!result.hasNextPage) {
            expect(result.nextCursor).toBeUndefined();
            break;
          }
          cursor = result.nextCursor as string;
        }
        return seen;
      };

      it("pages the user's active links, newest first by default", async () => {
        const user = newId();
        for (let index = 0; index < 5; index++) {
          await seedLegacyLink({
            shareId: `s${index}`,
            conversationId: `c${index}`,
            user,
            title: `Title ${index}`,
            createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
          });
        }
        await seedLegacyLink({
          shareId: 'expired',
          conversationId: 'cx',
          user,
          expiredAt: new Date(0),
        });
        await seedLegacyLink({ shareId: 'theirs', conversationId: 'cy', user: newId() });

        const first = await stores().getSharedLinks(user);
        expect(first.hasNextPage).toBe(false);
        expect(first.links.map(({ shareId }) => shareId)).toEqual(['s4', 's3', 's2', 's1', 's0']);
        expect(first.links[0]).toEqual({
          shareId: 's4',
          title: 'Title 4',
          conversationId: 'c4',
          createdAt: expect.any(Date),
        });
        expect(timeOf(first.links[0].createdAt)).toBe(Date.UTC(2026, 0, 5));
        expect(await pageAll(user, 'createdAt', 'desc')).toEqual(['s4', 's3', 's2', 's1', 's0']);
        expect(await pageAll(user, 'createdAt', 'asc')).toEqual(['s0', 's1', 's2', 's3', 's4']);
        expect(await stores().getSharedLinks(newId())).toEqual({
          links: [],
          nextCursor: undefined,
          hasNextPage: false,
        });
      });

      it('pages through repeated and missing titles without skipping or repeating a link', async () => {
        const user = newId();
        const createdAt = new Date('2026-05-01T00:00:00.000Z');
        for (let index = 0; index < 3; index++) {
          await seedLegacyLink({
            shareId: `untitled_${index}`,
            conversationId: `u${index}`,
            user,
            createdAt,
          });
          await seedLegacyLink({
            shareId: `same_${index}`,
            conversationId: `s${index}`,
            user,
            title: 'Same',
            createdAt,
          });
          await seedLegacyLink({
            shareId: `titled_${index}`,
            conversationId: `t${index}`,
            user,
            title: `Title ${index}`,
            createdAt,
          });
        }
        for (const direction of ['asc', 'desc']) {
          const seen = await pageAll(user, 'title', direction);
          expect(seen).toHaveLength(9);
          expect(new Set(seen).size).toBe(9);
          const untitled = seen.filter((shareId) => shareId.startsWith('untitled'));
          /** Links without a title order before every title, and list as "Untitled". */
          expect(direction === 'asc' ? seen.slice(0, 3) : seen.slice(6)).toEqual(
            expect.arrayContaining(untitled),
          );
        }
        const { links } = await stores().getSharedLinks(user, undefined, 20, 'title', 'asc');
        expect(links.find(({ shareId }) => shareId === 'untitled_0')?.title).toBe('Untitled');
      });

      it('reads a search as an empty page when the conversation search is unavailable', async () => {
        const user = newId();
        await seedLegacyLink({ shareId: 's1', conversationId: 'c1', user, title: 'Needle' });
        expect(
          await stores().getSharedLinks(user, undefined, 10, 'createdAt', 'desc', 'Needle'),
        ).toEqual({
          links: [],
          nextCursor: undefined,
          hasNextPage: false,
        });
        expect(
          (await stores().getSharedLinks(user, undefined, 10, 'createdAt', 'desc', '  ')).links,
        ).toHaveLength(1);
      });
    });

    describe('updateSharedLink', () => {
      it('republishes the conversation’s current messages under the same share id', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', { text: 'Before' }]]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        await seedMessages(user, 'c1', [['m2', { text: 'After', parentMessageId: 'm1' }]]);
        expect(await texts(shareId)).toEqual(['Before']);

        const updated = await stores().updateSharedLink(user, shareId);
        expect(updated).toMatchObject({ shareId, conversationId: 'c1' });
        expect(updated._id).toBe(idOf(harness, (await linkOf(shareId))?._id));
        expect(await texts(shareId)).toEqual(['Before', 'After']);
        expect((await linkOf(shareId))?.messages).toEqual(await messageIdsOf('c1'));
      });

      it('keeps, sets or clears the expiry and updates an expired link', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', {}]]);
        const expiredAt = new Date(Date.now() - day);
        await seedLegacyLink({
          shareId: 'stale',
          conversationId: 'c1',
          user,
          messages: await messageIdsOf('c1'),
          expiredAt,
        });
        await stores().updateSharedLink(user, 'stale');
        expect(timeOf((await linkOf('stale'))?.expiredAt)).toBe(expiredAt.getTime());
        expect(await stores().getSharedMessages('stale')).toBeNull();
        await stores().updateSharedLink(user, 'stale', undefined, null);
        expect((await linkOf('stale'))?.expiredAt == null).toBe(true);
        expect(await texts('stale')).toEqual(['m1']);
        const later = new Date(Date.now() + day);
        await stores().updateSharedLink(user, 'stale', undefined, later);
        expect(timeOf((await linkOf('stale'))?.expiredAt)).toBe(later.getTime());
      });

      it('advances a stored target to its branch’s newest turn, or takes a new one', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['q1', { text: 'First question' }],
          ['a1', { text: 'First answer', isCreatedByUser: false, parentMessageId: 'q1' }],
        ]);
        const { shareId } = await stores().createSharedLink(user, 'c1', 'a1');
        await seedMessages(user, 'c1', [
          ['q2', { text: 'Follow-up question', parentMessageId: 'a1' }],
          ['a2', { text: 'Follow-up answer', isCreatedByUser: false, parentMessageId: 'q2' }],
        ]);
        const advanced = await stores().updateSharedLink(user, shareId);
        expect(advanced.targetMessageId).toBe('a2');
        expect(await texts(shareId)).toEqual([
          'First question',
          'First answer',
          'Follow-up question',
          'Follow-up answer',
        ]);
        const pinned = await stores().updateSharedLink(user, shareId, 'a1');
        expect(pinned.targetMessageId).toBe('a1');
        expect(await texts(shareId)).toEqual(['First question', 'First answer']);
      });

      it('rejects with a code what it cannot republish, never another user’s link', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', {}]]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        expect(await codeOf(stores().updateSharedLink(newId(), shareId))).toBe('SHARE_NOT_FOUND');
        expect(await codeOf(stores().updateSharedLink(user, 'missing'))).toBe('SHARE_NOT_FOUND');
        expect(await codeOf(stores().updateSharedLink(user, ''))).toBe('INVALID_PARAMS');
        expect(await codeOf(stores().updateSharedLink(user, shareId, 'missing'))).toBe(
          'TARGET_MESSAGE_NOT_FOUND',
        );
        await harness.createStores().messages.deleteMessages({ user, conversationId: 'c1' });
        expect(await codeOf(stores().updateSharedLink(user, shareId))).toBe('NO_MESSAGES');
      });

      it('runs the preflight, then the before-publish step, then writes', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [['m1', { text: 'Before' }]]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        await seedMessages(user, 'c1', [['m2', { text: 'After' }]]);
        const order: string[] = [];
        const rejection = new Error('blocked');
        await expect(
          stores().updateSharedLink(
            user,
            shareId,
            undefined,
            undefined,
            true,
            () => {
              order.push('preflight');
              throw rejection;
            },
            () => {
              order.push('beforePublish');
            },
          ),
        ).rejects.toBe(rejection);
        expect(order).toEqual(['preflight']);
        expect(await texts(shareId)).toEqual(['Before']);
        await stores().updateSharedLink(
          user,
          shareId,
          undefined,
          undefined,
          true,
          (snapshot) => {
            order.push(`preflight:${snapshot.messages.length}`);
          },
          async () => {
            order.push(`beforePublish:${(await texts(shareId))?.length}`);
          },
        );
        expect(order).toEqual(['preflight', 'preflight:2', 'beforePublish:1']);
        expect(await texts(shareId)).toEqual(['Before', 'After']);
      });
    });

    describe('deleteSharedLink, deleteAllSharedLinks and deleteConvoSharedLink', () => {
      it("deletes the user's link, expired or not, and nobody else's", async () => {
        const user = newId();
        const _id = await seedLegacyLink({
          shareId: 'mine',
          conversationId: 'c1',
          user,
          expiredAt: new Date(Date.now() - 1000),
        });
        await seedLegacyLink({ shareId: 'theirs', conversationId: 'c1', user: newId() });
        expect(await stores().deleteSharedLink(user, 'theirs')).toBeNull();
        expect(await stores().deleteSharedLink(user, 'missing')).toBeNull();
        expect(await stores().deleteSharedLink(user, 'mine')).toEqual({
          _id,
          success: true,
          shareId: 'mine',
          message: expect.any(String),
        });
        expect((await harness.readRaw('sharedlinks')).map(({ shareId }) => shareId)).toEqual([
          'theirs',
        ]);
        expect(await codeOf(stores().deleteSharedLink(user, ''))).toBe('INVALID_PARAMS');
      });

      it('deletes every link of the user, or of one conversation, resolving their ids', async () => {
        const user = newId();
        const other = newId();
        const a1 = await seedLegacyLink({ shareId: 'a1', conversationId: 'a', user });
        const a2 = await seedLegacyLink({
          shareId: 'a2',
          conversationId: 'a',
          user,
          expiredAt: new Date(Date.now() - 1000),
        });
        const b1 = await seedLegacyLink({ shareId: 'b1', conversationId: 'b', user });
        await seedLegacyLink({ shareId: 'o1', conversationId: 'a', user: other });

        const convo = await stores().deleteConvoSharedLink(user, 'a');
        expect(convo).toMatchObject({ deletedCount: 2 });
        expect([...convo.deletedIds].sort()).toEqual([a1, a2].sort());
        expect(await stores().deleteConvoSharedLink(user, 'a')).toMatchObject({
          deletedCount: 0,
          deletedIds: [],
        });
        expect(await codeOf(stores().deleteConvoSharedLink('', 'a'))).toBe('INVALID_PARAMS');
        expect(await codeOf(stores().deleteConvoSharedLink(user, ''))).toBe('INVALID_PARAMS');

        const all = await stores().deleteAllSharedLinks(user);
        expect(all).toMatchObject({ deletedCount: 1, deletedIds: [b1] });
        expect(await stores().deleteAllSharedLinks(user)).toMatchObject({
          deletedCount: 0,
          deletedIds: [],
        });
        expect((await harness.readRaw('sharedlinks')).map(({ shareId }) => shareId)).toEqual([
          'o1',
        ]);
      });
    });

    describe('getSharedMessages', () => {
      it('anonymizes the view consistently and leaves out internal fields', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['m1', { text: 'Hello', iconURL: 'https://icons.example.test/a.png' }],
          [
            'm2',
            {
              text: 'World',
              isCreatedByUser: false,
              parentMessageId: 'm1',
              model: 'gpt-4',
              sender: 'GPT-4',
              endpoint: 'openAI',
              isUserSubmitted: true,
              userSubmittedPaths: ['/text'],
              userSubmittedMessageFieldPaths: [
                { path: '/content/0/tool_call/output', field: 'decision_reason' },
              ],
              conversationSignature: 'private-signature',
              clientId: 'private-client',
              tokenCount: 12,
            },
          ],
          [
            'm3',
            {
              text: 'Assistant',
              isCreatedByUser: false,
              parentMessageId: 'm2',
              model: 'asst_secret',
            },
          ],
        ]);
        const { shareId, _id } = await stores().createSharedLink(user, 'c1');
        const result = await stores().getSharedMessages(shareId);
        expect(result).toMatchObject({ shareId, title: 'Shared Conversation' });
        expect(result?.createdAt).toBeInstanceOf(Date);
        expect(result?.conversationId).toMatch(/^convo_/);
        const [hello, world, assistant] = result?.messages ?? [];
        for (const message of result?.messages ?? []) {
          expect(message.messageId).toMatch(/^msg_/);
          expect(message.conversationId).toBe(result?.conversationId);
          expect(message).not.toHaveProperty('user');
          expect(message).not.toHaveProperty('endpoint');
          expect(message).not.toHaveProperty('conversationSignature');
          expect(message).not.toHaveProperty('clientId');
          expect(message).not.toHaveProperty('_id');
        }
        expect(hello).toMatchObject({
          text: 'Hello',
          parentMessageId: ROOT,
          isCreatedByUser: true,
        });
        expect(hello.iconURL).toBe('https://icons.example.test/a.png');
        expect(hello).not.toHaveProperty('isUserSubmitted');
        expect(world).toMatchObject({
          text: 'World',
          parentMessageId: hello.messageId,
          sender: 'GPT-4',
          tokenCount: 12,
          isUserSubmitted: true,
          userSubmittedPaths: ['/text'],
          userSubmittedMessageFieldPaths: [
            expect.objectContaining({
              path: '/content/0/tool_call/output',
              field: 'decision_reason',
            }),
          ],
        });
        expect(world).not.toHaveProperty('model');
        expect(assistant.parentMessageId).toBe(world.messageId);
        expect(assistant.model).toMatch(/^a_/);

        const byRecordId = await stores().getSharedMessages('ignored', _id);
        expect(byRecordId?.messages.map(({ text }) => text)).toEqual([
          'Hello',
          'World',
          'Assistant',
        ]);
        expect(byRecordId?.shareId).toBe(shareId);
        /** Ids are anonymized afresh on every read, so two links never correlate. */
        expect(byRecordId?.conversationId).not.toBe(result?.conversationId);
      });

      it('reads a missing or expired link as absent', async () => {
        const user = newId();
        await seedLegacyLink({
          shareId: 'expired',
          conversationId: 'c1',
          user,
          expiredAt: new Date(Date.now() - 3_600_000),
        });
        expect(await stores().getSharedMessages('missing')).toBeNull();
        expect(await stores().getSharedMessages('expired')).toBeNull();
      });

      it('shows nothing when the stored target is gone or cut off from the roots', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['root', { text: 'Private root turn' }],
          ['orphan', { text: 'Orphan branch', isCreatedByUser: false, parentMessageId: 'gone' }],
        ]);
        const messages = await messageIdsOf('c1');
        await seedLegacyLink({
          shareId: 'missing-target',
          conversationId: 'c1',
          user,
          messages,
          targetMessageId: 'missing',
        });
        await seedLegacyLink({
          shareId: 'orphan-target',
          conversationId: 'c1',
          user,
          messages,
          targetMessageId: 'orphan',
        });
        expect(await texts('missing-target')).toEqual([]);
        expect(await texts('orphan-target')).toEqual([]);
      });

      it('reads the published messages by reference, as they are now', async () => {
        const user = newId();
        await seedConversation(user, 'c1', [
          ['m1', { text: 'First' }],
          ['m2', { text: 'Second', parentMessageId: 'm1' }],
          ['m3', { text: 'Third', parentMessageId: 'm2' }],
        ]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        const messages = harness.createStores().messages;
        await messages.updateMessage(user, { messageId: 'm1', text: 'First, edited' });
        await messages.deleteMessages({ user, messageId: 'm3' });
        // NOTE(contract): a link stores references to its messages, not copies: an edit made
        // after publishing shows in the public view, and a deleted message drops out of it,
        // until the link is republished. Pinned as today's behavior.
        expect(await texts(shareId)).toEqual(['First, edited', 'Second']);
        expect((await linkOf(shareId))?.messages).toHaveLength(3);
      });

      it('rewrites snapshotted files to the share route and removes the URLs of the others', async () => {
        const user = newId();
        const docId = await seedFile(user);
        const remoteId = await seedFile(user, { source: 'openai' });
        const urls = (fileId: string) => ({
          filepath: `/uploads/${user}/${fileId}`,
          preview: `/previews/${user}/${fileId}`,
          uri: `https://files.example.test/${user}/${fileId}`,
          url: `https://cdn.example.test/${user}/${fileId}`,
        });
        await seedConversation(user, 'c1', [
          [
            'm1',
            {
              text: 'doc',
              files: [
                { file_id: docId, type: 'application/pdf', ...urls(docId) },
                { file_id: remoteId, type: 'application/pdf', ...urls(remoteId) },
              ],
            },
          ],
          [
            'm2',
            {
              text: 'attachment',
              isCreatedByUser: false,
              parentMessageId: 'm1',
              attachments: [
                { file_id: docId, type: 'application/pdf', filepath: urls(docId).filepath },
              ],
            },
          ],
        ]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        const result = await stores().getSharedMessages(shareId);
        const route = `/api/share/${shareId}/files/${docId}`;
        const [doc, remote] = (result?.messages[0].files ?? []) as Array<Record<string, unknown>>;
        expect(doc).toMatchObject({
          file_id: docId,
          filepath: route,
          preview: route,
          uri: route,
          url: route,
        });
        expect(remote.file_id).toBe(remoteId);
        for (const key of ['filepath', 'preview', 'uri', 'url']) {
          expect(remote).not.toHaveProperty(key);
        }
        expect((result?.messages[1].attachments?.[0] as Record<string, unknown>).filepath).toBe(
          route,
        );
        expect(JSON.stringify(result?.messages)).not.toContain(user);

        const withoutFiles = await stores().getSharedMessages(shareId, undefined, {
          snapshotFiles: false,
        });
        expect(withoutFiles?.messages[0]).not.toHaveProperty('files');
        expect(withoutFiles?.messages[1]).not.toHaveProperty('attachments');
      });

      it('backfills a legacy link’s snapshot on its first read without republishing it', async () => {
        const user = newId();
        const docId = await seedFile(user);
        await seedConversation(user, 'c1', [
          [
            'm1',
            { text: 'doc', files: [{ file_id: docId, filepath: `/uploads/${user}/${docId}` }] },
          ],
        ]);
        const updatedAt = new Date('2026-01-02T00:00:00.000Z');
        await seedLegacyLink({
          shareId: 'legacy',
          conversationId: 'c1',
          user,
          messages: await messageIdsOf('c1'),
          updatedAt,
        });
        const rejected = new Error('policy');
        await expect(
          stores().getSharedMessages('legacy', undefined, {
            preflight: () => {
              throw rejected;
            },
          }),
        ).rejects.toBe(rejected);
        expect((await linkOf('legacy'))?.fileSnapshots == null).toBe(true);

        const result = await stores().getSharedMessages('legacy');
        expect((result?.messages[0].files?.[0] as Record<string, unknown>).filepath).toBe(
          `/api/share/legacy/files/${docId}`,
        );
        const stored = await linkOf('legacy');
        expect(
          (stored?.fileSnapshots as SharedFileSnapshot[]).map(({ file_id }) => file_id),
        ).toEqual([docId]);
        expect(timeOf(stored?.updatedAt)).toBe(updatedAt.getTime());
        expect(timeOf(result?.updatedAt)).toBe(updatedAt.getTime());
      });
    });

    describe('fileSnapshots, getSharedLinkFile and backfillSharedLinkFiles', () => {
      it("snapshots the owner's streamable files referenced by the messages", async () => {
        const user = newId();
        const imageId = await seedFile(user, {
          type: 'image/png',
          filename: 'pic.png',
          filepath: `/images/${user}/pic.png`,
          width: 100,
          height: 80,
        });
        const docId = await seedFile(user, { metadata: { sourceDispatchedAt: 1_725_000_000_000 } });
        const remoteId = await seedFile(user, { source: 'openai' });
        const foreignId = await seedFile(newId());
        await seedConversation(user, 'c1', [
          [
            'm1',
            { files: [{ file_id: imageId }, { file_id: remoteId }, { file_id: 'file_ghost' }] },
          ],
          [
            'm2',
            { isCreatedByUser: false, attachments: [{ file_id: docId }, { file_id: foreignId }] },
          ],
        ]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        const snapshots = (await linkOf(shareId))?.fileSnapshots as SharedFileSnapshot[];
        expect(snapshots.map(({ file_id }) => file_id).sort()).toEqual([docId, imageId].sort());
        const image = snapshots.find(({ file_id }) => file_id === imageId);
        expect(image).toMatchObject({
          source: 'local',
          filename: 'pic.png',
          filepath: `/images/${user}/pic.png`,
          type: 'image/png',
          width: 100,
          height: 80,
          llmDeliveryPath: 'provider',
        });
        expect(image?.storageKey == null).toBe(true);
        expect(snapshots.find(({ file_id }) => file_id === docId)).toMatchObject({
          filename: 'report.pdf',
          bytes: 1024,
          sourceDispatchedAt: 1_725_000_000_000,
        });

        const found = await stores().getSharedLinkFile(shareId, docId);
        expect(found).toMatchObject({ hasSnapshots: true, optedOut: false });
        expect(found.file).toMatchObject({ file_id: docId, filename: 'report.pdf' });
        expect(await stores().getSharedLinkFile(shareId, foreignId)).toEqual({
          file: null,
          hasSnapshots: true,
          optedOut: false,
        });
        expect(await stores().getSharedLinkFile('missing', docId)).toEqual({
          file: null,
          hasSnapshots: false,
          optedOut: false,
        });
      });

      it('keeps no snapshot for a link that opts out, and removes it on such an update', async () => {
        const user = newId();
        const docId = await seedFile(user);
        await seedConversation(user, 'c1', [['m1', { files: [{ file_id: docId }] }]]);
        await seedConversation(user, 'c2', [['m2', { files: [{ file_id: docId }] }]]);
        const optedOut = await stores().createSharedLink(user, 'c1', undefined, undefined, false);
        expect((await linkOf(optedOut.shareId))?.fileSnapshots == null).toBe(true);
        expect(await stores().getSharedLinkFile(optedOut.shareId, docId)).toEqual({
          file: null,
          hasSnapshots: false,
          optedOut: true,
        });
        expect((await stores().getSharedLink(user, 'c1')).snapshotFiles).toBe(false);
        expect(
          (await stores().getSharedMessages(optedOut.shareId))?.messages[0],
        ).not.toHaveProperty('files');
        expect(await stores().backfillSharedLinkFiles(optedOut.shareId)).toEqual([]);
        expect((await linkOf(optedOut.shareId))?.fileSnapshots == null).toBe(true);

        const shared = await stores().createSharedLink(user, 'c2');
        expect((await stores().getSharedLinkFile(shared.shareId, docId)).file?.file_id).toBe(docId);
        await stores().updateSharedLink(user, shared.shareId, undefined, undefined, false);
        expect((await linkOf(shared.shareId))?.fileSnapshots == null).toBe(true);
        expect(await stores().getSharedLinkFile(shared.shareId, docId)).toEqual({
          file: null,
          hasSnapshots: false,
          optedOut: true,
        });
      });

      it('recomputes the snapshot from the current messages on update', async () => {
        const user = newId();
        const first = await seedFile(user);
        const second = await seedFile(user);
        await seedConversation(user, 'c1', [['m1', { files: [{ file_id: first }] }]]);
        const { shareId } = await stores().createSharedLink(user, 'c1');
        await seedMessages(user, 'c1', [['m2', { files: [{ file_id: second }] }]]);
        await stores().updateSharedLink(user, shareId);
        const snapshots = (await linkOf(shareId))?.fileSnapshots as SharedFileSnapshot[];
        expect(snapshots.map(({ file_id }) => file_id).sort()).toEqual([first, second].sort());
      });

      it('backfills a legacy link once, resolving the entry or the whole snapshot', async () => {
        const user = newId();
        const docId = await seedFile(user);
        await seedConversation(user, 'c1', [['m1', { files: [{ file_id: docId }] }]]);
        const messages = await messageIdsOf('c1');
        await seedLegacyLink({ shareId: 'legacy', conversationId: 'c1', user, messages });
        await seedLegacyLink({ shareId: 'legacy-2', conversationId: 'c1', user, messages });

        expect(await stores().getSharedLinkFile('legacy', docId)).toEqual({
          file: null,
          hasSnapshots: false,
          optedOut: false,
        });
        const entry = (await stores().backfillSharedLinkFiles(
          'legacy',
          docId,
        )) as SharedFileSnapshot;
        expect(entry.file_id).toBe(docId);
        expect((await stores().getSharedLinkFile('legacy', docId)).hasSnapshots).toBe(true);
        expect(await stores().backfillSharedLinkFiles('legacy', 'other')).toBeNull();

        const whole = (await stores().backfillSharedLinkFiles('legacy-2')) as SharedFileSnapshot[];
        expect(whole.map(({ file_id }) => file_id)).toEqual([docId]);
        expect(await stores().backfillSharedLinkFiles('missing')).toBeNull();
      });

      it('keeps a snapshot stored meanwhile instead of rebuilding it', async () => {
        const user = newId();
        const docId = await seedFile(user);
        await seedConversation(user, 'c1', [['m1', { files: [{ file_id: docId }] }]]);
        await seedLegacyLink({
          shareId: 'published',
          conversationId: 'c1',
          user,
          messages: await messageIdsOf('c1'),
          fileSnapshots: [],
        });
        expect(await stores().backfillSharedLinkFiles('published')).toEqual([]);
        expect(await stores().backfillSharedLinkFiles('published', docId)).toBeNull();
        expect((await linkOf('published'))?.fileSnapshots).toEqual([]);
      });
    });

    describe('record-level reads and writes', () => {
      const user = newId();
      const otherUser = newId();
      const link = (record: RawRecord = {}) =>
        seedLegacyLink({ conversationId: 'convo-a', user, messages: [], ...record });

      it('finds an active link by share id as stored, legacy flag included', async () => {
        const active = await link({
          shareId: 'active',
          isPublic: false,
          expiredAt: new Date(Date.now() + 60_000),
        });
        await link({ shareId: 'expired', expiredAt: new Date(Date.now() - 60_000) });
        const record = await stores().findActiveSharedLinkRecord('active');
        expect(idOf(harness, record?._id)).toBe(active);
        expect(record).toMatchObject({ isPublic: false, conversationId: 'convo-a', user });
        expect(await stores().findActiveSharedLinkRecord('expired')).toBeNull();
        expect(await stores().findActiveSharedLinkRecord('missing')).toBeNull();
      });

      it('reads a link by record id, expired or not, as stored', async () => {
        const id = await link({
          shareId: 'old',
          isPublic: true,
          expiredAt: new Date(Date.now() - 60_000),
        });
        const byString = await stores().getSharedLinkRecord(id);
        const byStoreId = await stores().getSharedLinkRecord(harness.ids.toStoreId(id));
        expect(byString).toMatchObject({ isPublic: true, shareId: 'old' });
        expect(idOf(harness, byStoreId?._id)).toBe(id);
        expect(await stores().getSharedLinkRecord(newId())).toBeNull();
      });

      it('reads only the owner of a link and rejects an id the store could not have made', async () => {
        const id = await link({ shareId: 'owned' });
        const owner = await stores().getSharedLinkOwner(id);
        expect(owner?.user).toBe(user);
        expect(idOf(harness, owner?._id)).toBe(id);
        expect(Object.keys(owner ?? {}).sort()).toEqual(['_id', 'user']);
        expect(await stores().getSharedLinkOwner(newId())).toBeNull();
        await expect(stores().getSharedLinkOwner('not-an-id')).rejects.toThrow();
      });

      it("reads the conversation of the user's own link, expired or not", async () => {
        const id = await link({ shareId: 'mine', expiredAt: new Date(Date.now() - 60_000) });
        const found = await stores().getOwnSharedLinkConversation(user, 'mine');
        expect(found?.conversationId).toBe('convo-a');
        expect(idOf(harness, found?._id)).toBe(id);
        expect(Object.keys(found ?? {}).sort()).toEqual(['_id', 'conversationId']);
        expect(await stores().getOwnSharedLinkConversation(otherUser, 'mine')).toBeNull();
      });

      it("lists and deletes the owner's links, all of them or one conversation's", async () => {
        const a1 = await link({ shareId: 'a1' });
        const a2 = await link({ shareId: 'a2', expiredAt: new Date(Date.now() - 60_000) });
        const b1 = await link({ shareId: 'b1', conversationId: 'convo-b' });
        await link({ shareId: 'o1', user: otherUser });
        const ids = async (criteria: { user: string; conversationId?: string }) =>
          (await stores().listSharedLinkRecordIds(criteria)).map((id) => idOf(harness, id)).sort();
        expect(await ids({ user, conversationId: 'convo-a' })).toEqual([a1, a2].sort());
        expect(await ids({ user })).toEqual([a1, a2, b1].sort());
        expect(
          await stores().deleteSharedLinkRecords({ user, conversationId: 'convo-a' }),
        ).toMatchObject({
          deletedCount: 2,
        });
        expect(await stores().deleteSharedLinkRecords({ user })).toMatchObject({ deletedCount: 1 });
        expect((await harness.readRaw('sharedlinks')).map(({ shareId }) => shareId)).toEqual([
          'o1',
        ]);
      });

      it("takes the user's link by share id and deletes a link by record id", async () => {
        const taken = await link({ shareId: 'taken' });
        const deleted = await link({ shareId: 'deleted' });
        expect(await stores().takeOwnSharedLinkRecord(otherUser, 'taken')).toBeNull();
        const record = await stores().takeOwnSharedLinkRecord(user, 'taken');
        expect(idOf(harness, record?._id)).toBe(taken);
        expect(record?.shareId).toBe('taken');
        expect(await stores().deleteSharedLinkRecord(deleted)).toMatchObject({ deletedCount: 1 });
        expect(await stores().deleteSharedLinkRecord(deleted)).toMatchObject({ deletedCount: 0 });
        expect(await harness.readRaw('sharedlinks')).toEqual([]);
      });

      it('clears the legacy flag by the id the store handed out, keeping the other fields', async () => {
        await link({ shareId: 'flagged', isPublic: true, title: 'Kept' });
        await link({ shareId: 'other', isPublic: true });
        const [id] = await stores()
          .listSharedLinkRecordIds({ user, conversationId: 'convo-a' })
          .then(async (all) => {
            const flagged = await stores().findActiveSharedLinkRecord('flagged');
            return all.filter(
              (candidate) => idOf(harness, candidate) === idOf(harness, flagged?._id),
            );
          });
        await stores().clearLegacySharedLinkVisibility(id);
        const raw = await linkOf('flagged');
        expect(raw).not.toHaveProperty('isPublic');
        expect(raw).toMatchObject({ shareId: 'flagged', user, title: 'Kept' });
        expect((await linkOf('other'))?.isPublic).toBe(true);
      });
    });
  });
}
