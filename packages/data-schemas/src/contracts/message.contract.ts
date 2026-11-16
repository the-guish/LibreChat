/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `MessageStore` contract (`~/ports/message`), ported from `methods/message.spec.ts`,
 * `message.privateText.spec.ts`, `message.pageSearch.spec.ts`, `message.reasoning.spec.ts` and
 * `message.traces.spec.ts`. It pins what the PostgreSQL store will find hard:
 * - `content` as a `json` value: a tool call patched in place by its part (`$[part]`), matched by
 *   predicates over the parts (`$elemMatch`, an array `$type` guard for legacy rows), with the
 *   other parts, their order and the key order inside each part kept;
 * - the `__v` compare-and-set behind every save: the stored version advances once per write,
 *   and concurrent writers (first saves, edits, tool-call settlements) never lose each other;
 * - the MCP App budget (a bound App's HTML is dropped, never canonical text or other attachments);
 * - `CLIENT_MESSAGE_SELECT`, which also leaves out nested server-only fields;
 * - the keyset page (`getMessagesPage`: every sort field, both orders, ties by id, a missing or
 *   `null` sort value first, opaque cursors and the bare legacy cursor), the thread view and the
 *   bounded task lists, the trace references and their opaque positions;
 * - the claims on background tool results and subagent task results, the control receipts, the
 *   private originals of protected text, and retention.
 *
 * Left in the method specs: cases that observe driver calls or count queries through spies,
 * failures injected at the collection boundary (rejected update arrays, lost acknowledgements,
 * exhausted retries, paused writers), index declarations, logging, the BSON sizes of the large App
 * budget cases (the budget is pinned here with a small deployment budget instead), the search
 * engine stub, the `getMessagesByCursor` and `searchMessages` methods (not on the port), and the
 * many claim and receipt variants of the background-result protocol beyond one case per rule. No
 * method spec stores U+0000 in message text, so neither does this contract. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { randomUUID } from 'node:crypto';
import { Constants, MCP_APP_MIME_TYPE, Tools } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { MessageStore } from '~/ports/message';
import type { IMessage } from '~/types';
import { CLIENT_MESSAGE_SELECT } from '~/ports/message';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

const USER = 'user123';
const ROOT = Constants.NO_PARENT;
const hour = 60 * 60 * 1000;

/**
 * A value read back from a stored record; the assertions walk nested JSON (content parts, task
 * state) without restating its many shapes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed stored JSON
type Stored = any;

type Params = Parameters<MessageStore['saveMessage']>[1];

export function describeMessageContract(harness: ContractHarness): void {
  describe(`MessageStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().messages;
    const newId = () => harness.ids.generate();
    const uuid = () => randomUUID();
    const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
      tenantStorage.run({ tenantId }, run);

    const save = (
      params: Record<string, unknown>,
      ctx: Record<string, unknown> = {},
      metadata?: Parameters<MessageStore['saveMessage']>[2],
    ) => stores().saveMessage({ userId: USER, ...ctx }, params as Params, metadata);
    const seedMessages = (records: RawRecord[]) =>
      harness.seedRaw(
        'messages',
        records.map((record) => ({ _id: newId(), user: USER, isCreatedByUser: false, ...record })),
      );
    const rawOf = async (messageId: string, user = USER) =>
      (await readRawWhere(harness, 'messages', { messageId, user }))[0];
    const contentOf = async (messageId: string) =>
      (await rawOf(messageId))?.content as Array<Record<string, Stored>>;

    const toolCallContent = () => [
      { type: 'text', text: 'intro' },
      {
        type: 'tool_call',
        tool_call: {
          id: 'call_bg',
          name: 'execute_code',
          args: '{"lang":"py","code":"print(1)"}',
          output: '{"background_task_id":"task-1"}',
          progress: 1,
        },
      },
      {
        type: 'tool_call',
        tool_call: { id: 'call_other', name: 'execute_code', args: '{}', output: 'untouched' },
      },
    ];
    const terminalPart = (id: string, taskId: string, output: string, extra: RawRecord = {}) => ({
      type: 'tool_call',
      agentId: 'agent-a',
      tool_call: {
        id,
        name: 'slow_tool',
        output,
        backgroundTask: {
          version: 1,
          taskId,
          toolName: 'slow_tool',
          status: 'completed',
          settledAt: new Date('2026-09-22T09:00:00.000Z'),
          completionWakeup: true,
          ...extra,
        },
      },
    });

    /* ----------------------------------------------------------------- saveMessage */

    describe('saveMessage', () => {
      it("saves the user's message and resolves it as stored", async () => {
        const conversationId = uuid();
        const saved = await save({ messageId: 'msg123', conversationId, text: 'Hello, world!' });
        expect(saved).toMatchObject({
          messageId: 'msg123',
          conversationId,
          user: USER,
          text: 'Hello, world!',
        });
        expect(saved?.createdAt).toBeInstanceOf(Date);
        expect(saved).not.toHaveProperty('privateText');
        const stored = await rawOf('msg123');
        expect(stored).toMatchObject({ text: 'Hello, world!', conversationId });
        expect(stored.isUserSubmitted == null).toBe(true);
      });

      it('rejects without a user and resolves undefined for a conversation id that is not a UUID', async () => {
        await expect(
          stores().saveMessage({ userId: '' }, {
            messageId: 'm',
            conversationId: uuid(),
          } as Params),
        ).rejects.toThrow('User not authenticated');
        expect(
          await save({ messageId: 'm', conversationId: 'invalid-id', text: 'x' }),
        ).toBeUndefined();
        expect(await harness.readRaw('messages')).toEqual([]);
      });

      it('updates the one stored message, advancing its stored version once per save', async () => {
        const conversationId = uuid();
        await save({ messageId: 'm1', conversationId, text: 'first' });
        const v1 = Number((await rawOf('m1')).__v);
        await save({ messageId: 'm1', conversationId, text: 'second' });
        await save({ messageId: 'm1', conversationId, text: 'third' });
        const rows = await readRawWhere(harness, 'messages', { messageId: 'm1' });
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe('third');
        expect(Number(rows[0].__v)).toBe(v1 + 2);
      });

      it('renames to newMessageId, and only creates with insertOnly', async () => {
        const conversationId = uuid();
        await save({ messageId: 'old', conversationId, text: 'renamed', newMessageId: 'new' });
        expect(await rawOf('old')).toBeUndefined();
        expect((await rawOf('new'))?.text).toBe('renamed');
        const inserted = await save(
          { messageId: 'once', conversationId, text: 'first' },
          {},
          { insertOnly: true },
        );
        expect(inserted?.text).toBe('first');
        const retried = await save(
          { messageId: 'once', conversationId, text: 'second' },
          {},
          { insertOnly: true },
        );
        expect(retried?.text).toBe('first');
        expect((await rawOf('once')).text).toBe('first');
      });

      it('unsets a stored context meta with null and keeps it when omitted', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          contextMeta: { calibrationRatio: 1.2, encoding: 'claude' },
        });
        await save({ messageId: 'm1', conversationId, text: 'partial' });
        expect((await rawOf('m1')).contextMeta).toEqual({
          calibrationRatio: 1.2,
          encoding: 'claude',
        });
        const completed = await save({
          messageId: 'm1',
          conversationId,
          text: 'Completed',
          contextMeta: null,
        });
        expect(completed?.contextMeta == null).toBe(true);
        expect((await rawOf('m1')).contextMeta == null).toBe(true);
      });

      it('stores content exactly: part order, key order, nested unknown data and dollar-prefixed text', async () => {
        const conversationId = uuid();
        const contextUsage = {
          runId: 'run-context-rich',
          breakdown: { toolMessageTokens: 0, sdkExtension: { nested: { labels: ['retained'] } } },
        };
        const content = [
          { type: 'text', text: '$CONTENT', zeta: 1, alpha: 2 },
          { type: 'tool_call', tool_call: { output: 'o', id: 'call', name: 'n' } },
          { type: 'steer', steer: 'User direction' },
        ];
        await save({
          messageId: 'm1',
          conversationId,
          text: '$PATH',
          content,
          metadata: { contextUsage },
        });
        const stored = await rawOf('m1');
        expect(stored.text).toBe('$PATH');
        expect(stored.content).toEqual(content);
        const parts = stored.content as Array<Record<string, unknown>>;
        expect(Object.keys(parts[0])).toEqual(['type', 'text', 'zeta', 'alpha']);
        expect(Object.keys(parts[1].tool_call as object)).toEqual(['output', 'id', 'name']);
        expect((stored.metadata as Record<string, unknown>).contextUsage).toEqual(contextUsage);
        const [read] = await stores().getMessages({ messageId: 'm1' });
        expect(read.content).toEqual(content);
      });

      it('stamps model output as not user-submitted without overriding explicit provenance', async () => {
        const conversationId = uuid();
        expect(
          (await save({ messageId: 'model', conversationId, isCreatedByUser: false }))
            ?.isUserSubmitted,
        ).toBe(false);
        expect(
          (
            await save({
              messageId: 'explicit',
              conversationId,
              isCreatedByUser: false,
              isUserSubmitted: true,
            })
          )?.isUserSubmitted,
        ).toBe(true);
        const scoped = await save({
          messageId: 'paths',
          conversationId,
          isCreatedByUser: false,
          userSubmittedPaths: ['not-a-pointer', '/content/0/text'],
        });
        expect(scoped).toMatchObject({
          isUserSubmitted: false,
          userSubmittedPaths: ['/content/0/text'],
        });
        const steer = await save({
          messageId: 'paths',
          conversationId,
          isCreatedByUser: false,
          content: [
            { type: 'text', text: 'Model response' },
            { type: 'steer', steer: 'User direction' },
          ],
        });
        expect([...(steer?.userSubmittedPaths ?? [])].sort()).toEqual([
          '/content/0/text',
          '/content/1',
        ]);
      });

      it('merges the provenance of concurrent first saves into one message', async () => {
        const conversationId = uuid();
        await Promise.all([
          save({
            messageId: 'm1',
            conversationId,
            isCreatedByUser: false,
            text: 'First writer',
            userSubmittedPaths: ['/text'],
          }),
          save({
            messageId: 'm1',
            conversationId,
            isCreatedByUser: false,
            content: [{ type: 'text', text: 'Second writer' }],
            userSubmittedPaths: ['/content/0/text'],
          }),
        ]);
        const rows = await readRawWhere(harness, 'messages', { messageId: 'm1' });
        expect(rows).toHaveLength(1);
        expect([...(rows[0].userSubmittedPaths as string[])].sort()).toEqual([
          '/content/0/text',
          '/text',
        ]);
      });

      it('writes the active tenant, never one the caller supplies', async () => {
        const conversationId = uuid();
        const saved = await inTenant('real-tenant', () =>
          save({
            messageId: 'm1',
            conversationId,
            tenantId: 'evil-tenant',
            userSubmittedPaths: ['/text'],
          }),
        );
        expect(saved?.tenantId).toBe('real-tenant');
        expect((await rawOf('m1')).tenantId).toBe('real-tenant');
      });

      it('drops only an oversized bound App’s HTML to fit the App budget', async () => {
        const conversationId = uuid();
        const legacy = { uri: 'ui://legacy', mimeType: 'text/html', text: '<p>legacy</p>' };
        const bound = {
          uri: 'ui://app/1',
          mimeType: MCP_APP_MIME_TYPE,
          serverName: 'server',
          serverBinding: 'authenticated-binding',
          resourceId: 'resource-1',
          toolName: 'show_app',
          content: [{ type: 'text', text: 'canonical' }],
          text: 'x'.repeat(100_000),
        };
        const budgeted = harness.createStores({
          getMCPAppMessageBudget: async () => 80_000,
        }).messages;
        const canonical = 'ordinary output '.repeat(1_000);
        await budgeted.saveMessage({ userId: USER }, {
          messageId: 'apps',
          conversationId,
          text: canonical,
          content: [{ type: 'text', text: canonical }],
          attachments: [
            {
              type: Tools.ui_resources,
              file_id: 'app-1',
              toolCallId: 'call',
              [Tools.ui_resources]: [bound, legacy],
            },
            { file_id: 'ordinary-file' },
          ],
        } as Params);
        const stored = await rawOf('apps');
        expect(stored.text).toBe(canonical);
        expect(stored.content).toEqual([{ type: 'text', text: canonical }]);
        const { text: _html, ...boundWithoutHtml } = bound;
        expect(stored.attachments).toEqual([
          expect.objectContaining({ [Tools.ui_resources]: [boundWithoutHtml, legacy] }),
          { file_id: 'ordinary-file' },
        ]);
        expect(JSON.stringify(stored).length).toBeLessThanOrEqual(80_000);

        await budgeted.saveMessage({ userId: USER }, {
          messageId: 'small',
          conversationId,
          attachments: [
            {
              type: Tools.ui_resources,
              file_id: 'app-2',
              toolCallId: 'call',
              [Tools.ui_resources]: [{ ...bound, text: 'small' }],
            },
          ],
        } as Params);
        expect((await rawOf('small')).attachments).toEqual([
          expect.objectContaining({
            [Tools.ui_resources]: [expect.objectContaining({ text: 'small' })],
          }),
        ]);
      });

      describe('retention', () => {
        it('sets a deadline from the retention period for a temporary message', async () => {
          const before = Date.now();
          const saved = await save(
            { messageId: 'm1', conversationId: uuid() },
            { isTemporary: true, interfaceConfig: { temporaryChatRetention: 48 } },
          );
          expect(saved?.isTemporary).toBe(true);
          const deadline = timeOf(saved?.expiredAt);
          expect(deadline).toBeGreaterThanOrEqual(before + 48 * hour - 1000);
          expect(deadline).toBeLessThanOrEqual(Date.now() + 48 * hour + 1000);
          expect(timeOf((await rawOf('m1')).expiredAt)).toBe(deadline);
        });

        it('keeps an inherited deadline and ignores caller-supplied retention fields', async () => {
          const inherited = new Date('2026-08-22T03:04:05.000Z');
          const saved = await save(
            { messageId: 'm1', conversationId: uuid() },
            {
              isTemporary: true,
              expiredAt: inherited,
              interfaceConfig: { temporaryChatRetention: 48 },
            },
          );
          expect(timeOf(saved?.expiredAt)).toBe(inherited.getTime());
          const forged = await save({
            messageId: 'm2',
            conversationId: uuid(),
            expiredAt: new Date('2099-01-01T00:00:00.000Z'),
            isTemporary: true,
          });
          expect(forged?.expiredAt == null).toBe(true);
        });

        it('keeps no deadline for an ordinary message and keeps a temporary one on later saves', async () => {
          const conversationId = uuid();
          expect((await save({ messageId: 'plain', conversationId }))?.expiredAt == null).toBe(
            true,
          );
          expect(
            (await save({ messageId: 'kept', conversationId }, { isTemporary: false }))
              ?.expiredAt == null,
          ).toBe(true);
          const first = await save({ messageId: 'temp', conversationId }, { isTemporary: true });
          const later = await save({ messageId: 'temp', conversationId, text: 'later' });
          expect(later?.isTemporary).toBe(true);
          expect(timeOf(later?.expiredAt)).toBe(timeOf(first?.expiredAt));
        });
      });
    });

    /* ----------------------------------------------------------------- private text */

    describe('getPrivateMessageTexts, hasPersistedPrivateText and getPersistedPrivateTextId', () => {
      const protectedSave = (conversationId: string, messageId: string) =>
        save(
          { messageId, conversationId, text: '[EMAIL_1_turn]', isCreatedByUser: true },
          {},
          { privateText: { envelope: 'v1:ciphertext', revision: 'turn' } },
        );

      it('stores both views and returns the original only to its owner in its tenant', async () => {
        const conversationId = uuid();
        const messageId = uuid();
        await inTenant('tenant-a', async () => {
          const saved = await protectedSave(conversationId, messageId);
          expect(saved?.privacyRevision).toBe('turn');
          expect(saved).not.toHaveProperty('privateText');
          for (const select of [undefined, CLIENT_MESSAGE_SELECT]) {
            const [row] = await stores().getMessages({ conversationId, user: USER }, select);
            expect(row.text).toBe('[EMAIL_1_turn]');
            expect(row).not.toHaveProperty('privateText');
          }
          const read = {
            userId: USER,
            tenantId: 'tenant-a',
            conversationId,
            messageIds: [messageId],
          };
          const [own] = await stores().getPrivateMessageTexts(read);
          expect(own).toMatchObject({
            messageId,
            privateText: 'v1:ciphertext',
            privacyRevision: 'turn',
            text: '[EMAIL_1_turn]',
          });
          const row = {
            userId: USER,
            tenantId: 'tenant-a',
            conversationId,
            messageId,
            text: '[EMAIL_1_turn]',
            privacyRevision: 'turn',
          };
          expect(await stores().hasPersistedPrivateText(row)).toBe(true);
          expect(await stores().getPersistedPrivateTextId(row)).toBe(idOf(harness, saved?._id));
          for (const mismatch of [
            { userId: 'other' },
            { tenantId: 'tenant-b' },
            { conversationId: uuid() },
            { conversationId: 'not-a-uuid' },
            { messageId: uuid() },
            { text: 'changed text' },
            { privacyRevision: 'wrong' },
          ]) {
            expect(await stores().hasPersistedPrivateText({ ...row, ...mismatch })).toBe(false);
            expect(await stores().getPersistedPrivateTextId({ ...row, ...mismatch })).toBeNull();
          }
          expect(await stores().getPrivateMessageTexts({ ...read, userId: 'other' })).toEqual([]);
          expect(await stores().getPrivateMessageTexts({ ...read, tenantId: 'tenant-b' })).toEqual(
            [],
          );
        });
        expect(
          await inTenant('tenant-b', () =>
            stores().getPrivateMessageTexts({
              userId: USER,
              tenantId: 'tenant-b',
              conversationId,
              messageIds: [messageId],
            }),
          ),
        ).toEqual([]);
      });

      it('bounds the read to 50 ids of a UUID conversation', async () => {
        const read = {
          userId: USER,
          conversationId: uuid(),
          messageIds: Array.from({ length: 51 }, () => uuid()),
        };
        await expect(stores().getPrivateMessageTexts(read)).rejects.toThrow();
        await expect(
          stores().getPrivateMessageTexts({
            ...read,
            conversationId: 'not-a-uuid',
            messageIds: [],
          }),
        ).rejects.toThrow();
      });

      it('drops the original when the canonical text is rewritten, or when it expires', async () => {
        const conversationId = uuid();
        await inTenant('tenant-a', async () => {
          await protectedSave(conversationId, 'edited');
          const updated = await stores().updateMessage(USER, {
            messageId: 'edited',
            text: 'clean edited',
          });
          expect(updated).not.toHaveProperty('privacyRevision');
          await save(
            { messageId: 'expired', conversationId, text: '[EMAIL_1]', isCreatedByUser: true },
            { expiredAt: new Date(0), isTemporary: true },
            { privateText: { envelope: 'v1:ciphertext', revision: 'turn' } },
          );
          expect(
            await stores().getPrivateMessageTexts({
              userId: USER,
              tenantId: 'tenant-a',
              conversationId,
              messageIds: ['edited', 'expired'],
            }),
          ).toEqual([]);
        });
        const stored = await rawOf('edited');
        expect(stored.text).toBe('clean edited');
        expect(stored.privateText == null).toBe(true);
        expect(stored.privacyRevision == null).toBe(true);
      });

      it('never takes private fields from message parameters, edits or bulk copies', async () => {
        const conversationId = uuid();
        await inTenant('tenant-a', async () => {
          const saved = await save({
            messageId: 'm1',
            conversationId,
            isCreatedByUser: true,
            text: 'clean',
            privateText: 'untrusted',
            privacyRevision: 'untrusted',
          });
          expect(saved).not.toHaveProperty('privacyRevision');
          await stores().updateMessage(USER, {
            messageId: 'm1',
            privateText: 'forged',
            privacyRevision: 'forged',
          } as never);
          await stores().bulkSaveMessages([
            {
              user: USER,
              conversationId,
              messageId: 'm2',
              text: 'copied',
              isCreatedByUser: true,
              privateText: 'forged',
              privacyRevision: 'forged',
            } as never,
          ]);
          expect(
            await stores().getPrivateMessageTexts({
              userId: USER,
              tenantId: 'tenant-a',
              conversationId,
              messageIds: ['m1', 'm2'],
            }),
          ).toEqual([]);
        });
        for (const row of await harness.readRaw('messages')) {
          expect(row.privateText == null).toBe(true);
          expect(row.privacyRevision == null).toBe(true);
        }
      });
    });

    /* ----------------------------------------------------------------- bulkSaveMessages */

    describe('bulkSaveMessages', () => {
      it('upserts by message id and user, keeping the records’ timestamps when asked', async () => {
        const conversationId = uuid();
        const createdAt = new Date('2020-01-01T00:00:00.000Z');
        const messages = [
          {
            user: USER,
            conversationId,
            messageId: 'a',
            text: 'a',
            createdAt,
            updatedAt: createdAt,
          },
          {
            user: USER,
            conversationId,
            messageId: 'b',
            text: 'b',
            createdAt,
            updatedAt: createdAt,
          },
        ];
        await stores().bulkSaveMessages(messages, true);
        await stores().bulkSaveMessages(
          messages.map((message) => ({ ...message, text: `${message.text}2` })),
          true,
        );
        const rows = await readRawWhere(harness, 'messages', { conversationId });
        expect(rows.map(({ messageId, text }) => [messageId, text])).toEqual([
          ['a', 'a2'],
          ['b', 'b2'],
        ]);
        expect(rows.every((row) => timeOf(row.createdAt) === createdAt.getTime())).toBe(true);
        await stores().bulkSaveMessages([
          { user: USER, conversationId, messageId: 'c', text: 'c', createdAt },
        ]);
        expect(timeOf((await rawOf('c')).updatedAt)).toBeGreaterThan(createdAt.getTime());
      });

      it('keeps unknown provenance unknown and takes copy tokens only from provenance', async () => {
        const conversationId = uuid();
        const token = `[EMAIL_1_${'a'.repeat(32)}]`;
        await stores().bulkSaveMessages([
          { user: USER, conversationId, messageId: 'unmarked', isCreatedByUser: false },
          {
            user: USER,
            conversationId,
            messageId: 'submitted',
            isCreatedByUser: false,
            isUserSubmitted: true,
          },
          {
            user: USER,
            conversationId,
            messageId: 'tokens',
            text: token,
            isCreatedByUser: true,
            privateTextTokens: [token],
          },
        ]);
        expect((await rawOf('unmarked')).isUserSubmitted == null).toBe(true);
        expect((await rawOf('submitted')).isUserSubmitted).toBe(true);
        const tokens = async () =>
          (await stores().getMessages({ messageId: 'tokens', user: USER }, '+privateTextTokens'))[0]
            .privateTextTokens;
        expect(await tokens()).toBeUndefined();
        await stores().bulkSaveMessages(
          [{ user: USER, conversationId, messageId: 'tokens', text: token, isCreatedByUser: true }],
          true,
          { privateTextTokens: new Map([['tokens', [token, '[EMAIL_2_forged]']]]) },
        );
        expect(await tokens()).toEqual([token]);
        expect(
          (await stores().getMessages({ messageId: 'tokens', user: USER }))[0],
        ).not.toHaveProperty('privateTextTokens');
        await stores().updateMessage(USER, { messageId: 'tokens', text: 'Clean edit' });
        expect(await tokens()).toBeUndefined();
      });
    });

    /* ----------------------------------------------------------------- updateMessage */

    describe('updateMessage', () => {
      it("updates the user's message and resolves its fields", async () => {
        const conversationId = uuid();
        await save({ messageId: 'm1', conversationId, text: 'Original' });
        const updated = await stores().updateMessage(USER, {
          messageId: 'm1',
          text: 'Updated text',
        });
        expect(updated).toMatchObject({ messageId: 'm1', text: 'Updated text' });
        expect((await rawOf('m1')).text).toBe('Updated text');
      });

      it("throws for a missing message or another user's, changing nothing", async () => {
        const conversationId = uuid();
        await stores().saveMessage({ userId: 'victim' }, {
          messageId: 'victim-msg',
          conversationId,
          text: 'Victim message',
        } as Params);
        await expect(
          stores().updateMessage('attacker', {
            messageId: 'victim-msg',
            conversationId,
            text: 'Hacked',
          }),
        ).rejects.toThrow('Message not found or user not authorized.');
        await expect(
          stores().updateMessage(USER, { messageId: 'nonexistent', text: 'x' }),
        ).rejects.toThrow('Message not found or user not authorized.');
        expect((await rawOf('victim-msg', 'victim')).text).toBe('Victim message');
      });

      it('resolves the trace routing and the temporary flag with a feedback update', async () => {
        const conversationId = uuid();
        await save(
          {
            messageId: 'm1',
            conversationId,
            langfuseSampled: true,
            langfuseDestinationIds: ['destination-1'],
            langfuseRunId: 'run-1',
          },
          { isTemporary: true },
        );
        const result = await stores().updateMessage(USER, {
          messageId: 'm1',
          feedback: { rating: 'thumbsUp', tag: undefined },
        });
        expect(result).toMatchObject({
          langfuseSampled: true,
          langfuseDestinationIds: ['destination-1'],
          langfuseRunId: 'run-1',
          isTemporary: true,
        });
        expect((await rawOf('m1')).feedback).toMatchObject({ rating: 'thumbsUp' });
      });

      it('reads a legacy row that has only a deadline as temporary', async () => {
        const conversationId = uuid();
        const expiredAt = new Date(Date.now() + hour);
        await seedMessages([
          { messageId: 'legacy', conversationId, expiredAt },
          { messageId: 'permanent', conversationId, isTemporary: false, expiredAt },
        ]);
        const feedback = { feedback: { rating: 'thumbsDown' as const, tag: undefined } };
        expect(
          (await stores().updateMessage(USER, { messageId: 'legacy', ...feedback }))?.isTemporary,
        ).toBe(true);
        expect(
          (await stores().updateMessage(USER, { messageId: 'permanent', ...feedback }))
            ?.isTemporary,
        ).toBe(false);
      });

      it('merges the provenance of concurrent edits to distinct fields', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          isCreatedByUser: false,
          content: [{ type: 'text', text: 'Model content' }],
        });
        await Promise.all([
          stores().updateMessage(USER, {
            messageId: 'm1',
            text: 'Edited text',
            userSubmittedPaths: ['/text'],
          }),
          stores().updateMessage(USER, {
            messageId: 'm1',
            userSubmittedMessageFieldPaths: [
              { path: '/content/0/tool_call/output', field: 'answer' },
            ],
          }),
        ]);
        const stored = await rawOf('m1');
        expect(stored.text).toBe('Edited text');
        expect(stored.userSubmittedPaths).toEqual(['/text']);
        expect(stored.userSubmittedMessageFieldPaths).toEqual([
          expect.objectContaining({ path: '/content/0/tool_call/output', field: 'answer' }),
        ]);
      });
    });

    /* ----------------------------------------------------------------- updateToolCallResult */

    describe('updateToolCallResult', () => {
      const patch = (conversationId: string, extra: Record<string, unknown> = {}) => ({
        userId: USER,
        messageId: 'm1',
        conversationId,
        toolCallId: 'call_bg',
        ...extra,
      });

      it('patches only the matching part in place and appends attachments once', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: toolCallContent(),
          attachments: [{ file_id: 'existing' }],
        });
        const update = patch(conversationId, {
          output: 'stdout:\nhello',
          attachments: [
            { file_id: 'f1', toolCallId: 'call_bg' },
            {
              filepath: '/api/files/code/download/sess-1/f1',
              filename: 'big.zip',
              toolCallId: 'call_bg',
            },
          ],
        });
        expect(await stores().updateToolCallResult(update)).toEqual({
          matched: true,
          unfinished: false,
        });
        expect(await stores().updateToolCallResult(update)).toEqual({
          matched: true,
          unfinished: false,
        });
        const content = await contentOf('m1');
        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({ type: 'text', text: 'intro' });
        expect(content[1].tool_call).toEqual({
          id: 'call_bg',
          name: 'execute_code',
          args: '{"lang":"py","code":"print(1)"}',
          output: 'stdout:\nhello',
          progress: 1,
        });
        expect(Object.keys(content[1].tool_call)).toEqual([
          'id',
          'name',
          'args',
          'output',
          'progress',
        ]);
        expect(content[2].tool_call.output).toBe('untouched');
        expect((await rawOf('m1')).attachments).toEqual([
          { file_id: 'existing' },
          { file_id: 'f1', toolCallId: 'call_bg' },
          {
            filepath: '/api/files/code/download/sess-1/f1',
            filename: 'big.zip',
            toolCallId: 'call_bg',
          },
        ]);
      });

      it('scopes the part by agent and run step, and reports an absent part or row unmatched', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: [
            {
              type: 'tool_call',
              agentId: 'agent_a',
              tool_call: { id: 'call_0', stepId: 'step-1', output: 'handle-a1' },
            },
            {
              type: 'tool_call',
              agentId: 'agent_a',
              tool_call: { id: 'call_0', stepId: 'step-2', output: 'handle-a2' },
            },
            {
              type: 'tool_call',
              agentId: 'agent_b',
              tool_call: { id: 'call_0', stepId: 'step-1', output: 'handle-b' },
            },
          ],
        });
        expect(
          await stores().updateToolCallResult(
            patch(conversationId, {
              toolCallId: 'call_0',
              stepId: 'step-2',
              agentId: 'agent_a',
              output: 'terminal-a2',
              backgroundTask: {
                taskId: 'task-2',
                toolName: 'slow_tool',
                status: 'completed',
                settledAt: new Date(),
              },
            }),
          ),
        ).toEqual({ matched: true, unfinished: false });
        expect(
          await stores().updateToolCallResult(
            patch(conversationId, {
              toolCallId: 'call_0',
              stepId: 'step-1',
              agentId: 'agent_b',
              output: 'terminal-b',
            }),
          ),
        ).toEqual({ matched: true, unfinished: false });
        const content = await contentOf('m1');
        expect(content.map((part) => part.tool_call.output)).toEqual([
          'handle-a1',
          'terminal-a2',
          'terminal-b',
        ]);
        expect(content[0].tool_call.backgroundTask).toBeUndefined();
        expect(content[1].tool_call.backgroundTask).toMatchObject({
          taskId: 'task-2',
          status: 'completed',
          version: 1,
        });

        expect(
          await stores().updateToolCallResult(
            patch(conversationId, { toolCallId: 'call_0', stepId: 'missing-step', output: 'x' }),
          ),
        ).toEqual({ matched: false, unfinished: false });
        expect(
          (
            await stores().updateToolCallResult(
              patch(conversationId, { messageId: 'missing', output: 'x' }),
            )
          ).matched,
        ).toBe(false);
        expect(
          (
            await stores().updateToolCallResult({
              ...patch(conversationId, { output: 'x' }),
              userId: 'other',
            })
          ).matched,
        ).toBe(false);
      });

      it('flags an unfinished row, where the patch still lands', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: toolCallContent(),
          unfinished: true,
        });
        expect(
          await stores().updateToolCallResult(patch(conversationId, { output: 'stdout' })),
        ).toEqual({
          matched: true,
          unfinished: true,
        });
        expect((await contentOf('m1'))[1].tool_call.output).toBe('stdout');
      });

      it('loses no settlement when two parts settle concurrently', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: [
            { type: 'tool_call', tool_call: { id: 'call_a', output: 'pending' } },
            { type: 'tool_call', tool_call: { id: 'call_b', output: 'pending' } },
          ],
        });
        const before = Number((await rawOf('m1')).__v);
        const results = await Promise.all(
          ['call_a', 'call_b'].map((toolCallId) =>
            stores().updateToolCallResult(
              patch(conversationId, {
                toolCallId,
                output: `done ${toolCallId}`,
                attachments: [{ file_id: `file-${toolCallId}`, toolCallId }],
              }),
            ),
          ),
        );
        expect(results.every(({ matched }) => matched)).toBe(true);
        const stored = await rawOf('m1');
        expect(
          (stored.content as Array<Record<string, Stored>>).map((part) => part.tool_call.output),
        ).toEqual(['done call_a', 'done call_b']);
        expect(
          (stored.attachments as Array<{ file_id: string }>).map(({ file_id }) => file_id).sort(),
        ).toEqual(['file-call_a', 'file-call_b']);
        expect(Number(stored.__v)).toBeGreaterThanOrEqual(before + 2);
      });

      it('keeps an existing claim and disarms a wakeup the new receipt omits', async () => {
        const conversationId = uuid();
        const claim = {
          kind: 'manual',
          claimId: 'existing',
          claimedAt: new Date('2026-08-30T12:00:00.000Z'),
        };
        await save({
          messageId: 'm1',
          conversationId,
          content: [terminalPart('call_bg', 'task-1', 'handle', { resultClaim: claim })],
        });
        await stores().updateToolCallResult(
          patch(conversationId, {
            output: 'settled',
            backgroundTask: {
              taskId: 'task-1',
              toolName: 'slow_tool',
              status: 'completed',
              settledAt: new Date('2026-08-30T12:01:00.000Z'),
              resultClaim: { kind: 'wakeup', claimId: 'replacement', claimedAt: new Date() },
            },
          }),
        );
        const task = (await contentOf('m1'))[0].tool_call.backgroundTask;
        expect(task.resultClaim).toMatchObject({ kind: 'manual', claimId: 'existing' });
        expect(task.completionWakeup).toBeUndefined();
        expect(timeOf(task.settledAt)).toBe(new Date('2026-08-30T12:01:00.000Z').getTime());
      });
    });

    /* --------------------------------------------- background tool result claims */

    describe('claimBackgroundToolResults, confirmBackgroundToolResultClaim and releaseBackgroundToolResultClaims', () => {
      const claim = (conversationId: string, extra: Record<string, unknown>) =>
        stores().claimBackgroundToolResults({
          userId: USER,
          conversationId,
          messageId: 'm1',
          taskId: 'task-1',
          kind: 'manual',
          claimId: 'poll-1',
          ...extra,
        } as Parameters<MessageStore['claimBackgroundToolResults']>[0]);
      const release = (conversationId: string, extra: Record<string, unknown>) =>
        stores().releaseBackgroundToolResultClaims({
          userId: USER,
          conversationId,
          messageId: 'm1',
          kind: 'manual',
          claimId: 'poll-1',
          ...extra,
        } as Parameters<MessageStore['releaseBackgroundToolResultClaims']>[0]);

      it('elects one consumer and batches the settled siblings for a wakeup', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: [
            terminalPart('call-1', 'task-1', 'one'),
            terminalPart('call-2', 'task-2', 'two'),
          ],
        });
        const wakeup = await claim(conversationId, { kind: 'wakeup', claimId: 'delivery-1' });
        expect(wakeup).toEqual({
          status: 'acquired',
          results: [
            {
              taskId: 'task-1',
              toolCallId: 'call-1',
              toolName: 'slow_tool',
              status: 'completed',
              output: 'one',
              agentId: 'agent-a',
              settledAt: expect.any(Date),
            },
            {
              taskId: 'task-2',
              toolCallId: 'call-2',
              toolName: 'slow_tool',
              status: 'completed',
              output: 'two',
              agentId: 'agent-a',
              settledAt: expect.any(Date),
            },
          ],
        });
        expect(await claim(conversationId, { kind: 'wakeup', claimId: 'delivery-1' })).toEqual(
          wakeup,
        );
        expect(await claim(conversationId, { taskId: 'task-2' })).toEqual({
          status: 'claimed',
          claim: { kind: 'wakeup', claimId: 'delivery-1' },
        });
        const stored = await contentOf('m1');
        expect(stored.map((part) => part.tool_call.backgroundTask.resultClaim.claimId)).toEqual([
          'delivery-1',
          'delivery-1',
        ]);
      });

      it('makes a manual poll wait for an unfinished row unless it may take it over', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          unfinished: true,
          content: [terminalPart('call-1', 'task-1', 'settled')],
        });
        expect(await claim(conversationId, { kind: 'wakeup', claimId: 'automatic' })).toEqual({
          status: 'not_ready',
        });
        expect(await claim(conversationId, {})).toEqual({ status: 'not_ready' });
        expect(await claim(conversationId, { allowUnfinished: true })).toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'task-1', output: 'settled' }],
        });
      });

      it('tells a missing row, a task not on the row yet and an unsettled launch handle apart', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: [terminalPart('call-1', 'task-1', 'one')],
        });
        await save({
          messageId: 'm2',
          conversationId,
          content: [
            {
              type: 'tool_call',
              agentId: 'agent-a',
              tool_call: {
                id: 'call-lost',
                name: 'mutating_tool',
                output: JSON.stringify({
                  background_task_id: 'task-lost',
                  tool: 'mutating_tool',
                  status: 'running',
                }),
              },
            },
          ],
        });
        expect(await claim(conversationId, { messageId: 'missing' })).toEqual({
          status: 'not_found',
        });
        expect(await claim(conversationId, { userId: 'other' })).toEqual({ status: 'not_found' });
        expect(await claim(conversationId, { taskId: 'task-unknown' })).toEqual({
          status: 'not_ready',
        });
        expect(
          await claim(conversationId, { messageId: undefined, taskId: 'task-unknown' }),
        ).toEqual({
          status: 'not_found',
        });
        /** Found by task id alone, through the launch handle a tool call's output holds. */
        expect(
          await claim(conversationId, { messageId: undefined, taskId: 'task-1' }),
        ).toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'task-1', output: 'one' }],
        });
        expect(
          await claim(conversationId, {
            messageId: undefined,
            taskId: 'task-lost',
            agentId: 'agent-a',
          }),
        ).toEqual({ status: 'outcome_unknown', toolName: 'mutating_tool' });
        expect(
          await claim(conversationId, {
            messageId: undefined,
            taskId: 'task-lost',
            agentId: 'agent-b',
          }),
        ).toEqual({ status: 'not_found' });
      });

      it('confirms only the exact manual claim and keeps a confirmed claim on a guarded rollback', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'm1',
          conversationId,
          content: [terminalPart('call-1', 'task-1', 'one', { completionWakeup: undefined })],
        });
        expect((await claim(conversationId, {})).status).toBe('acquired');
        const confirm = (claimId: string) =>
          stores().confirmBackgroundToolResultClaim({
            userId: USER,
            conversationId,
            messageId: 'm1',
            taskId: 'task-1',
            claimId,
          });
        expect(await confirm('another-poll')).toBe(false);
        expect(await confirm('poll-1')).toBe(true);
        expect((await contentOf('m1'))[0].tool_call.backgroundTask.resultClaim).toMatchObject({
          kind: 'manual',
          claimId: 'poll-1',
          receiptReconciled: true,
        });
        expect(await release(conversationId, { onlyIfUnreconciled: true })).toBe(false);
        expect((await contentOf('m1'))[0].tool_call.backgroundTask.resultClaim).toBeDefined();
        await expect(
          release(conversationId, { kind: 'wakeup', onlyIfUnreconciled: true }),
        ).rejects.toThrow(TypeError);
        expect(await release(conversationId, {})).toBe(true);
        expect((await contentOf('m1'))[0].tool_call.backgroundTask.resultClaim).toBeUndefined();
      });

      it("releases only the exact claimant's claims", async () => {
        const conversationId = uuid();
        const wakeup = { kind: 'wakeup', claimId: 'delivery-1', claimedAt: new Date() };
        await save({
          messageId: 'm1',
          conversationId,
          content: [
            terminalPart('call-1', 'task-1', 'one', { resultClaim: wakeup }),
            terminalPart('call-2', 'task-2', 'two', {
              resultClaim: { kind: 'manual', claimId: 'poll-1', claimedAt: new Date() },
            }),
            terminalPart('call-3', 'task-3', 'three', { resultClaim: wakeup }),
          ],
        });
        expect(
          await release(conversationId, { kind: 'wakeup', claimId: 'delivery-1', taskIds: [] }),
        ).toBe(true);
        expect(
          await release(conversationId, {
            kind: 'wakeup',
            claimId: 'delivery-1',
            taskIds: ['task-1'],
          }),
        ).toBe(true);
        expect(
          (await contentOf('m1')).map((part) => part.tool_call.backgroundTask.resultClaim?.claimId),
        ).toEqual([undefined, 'poll-1', 'delivery-1']);
        expect(await release(conversationId, { kind: 'wakeup', claimId: 'delivery-1' })).toBe(true);
        expect(await claim(conversationId, { taskId: 'task-3', claimId: 'poll-3' })).toMatchObject({
          status: 'acquired',
        });
        expect(
          await claim(conversationId, { taskId: 'task-2', kind: 'wakeup', claimId: 'delivery-2' }),
        ).toEqual({
          status: 'claimed',
          claim: { kind: 'manual', claimId: 'poll-1' },
        });
      });

      it('treats a row without a content array as holding no claims, and a missing one by opt-in', async () => {
        const conversationId = uuid();
        await seedMessages([
          { messageId: 'm1', conversationId, text: 'legacy row without content' },
        ]);
        expect(await release(conversationId, {})).toBe(true);
        expect(await release(conversationId, { messageId: 'missing', kind: 'wakeup' })).toBe(false);
        expect(
          await release(conversationId, {
            messageId: 'missing',
            kind: 'wakeup',
            allowMissingMessage: true,
          }),
        ).toBe(true);
        expect((await rawOf('m1')).content == null).toBe(true);
      });
    });

    /* ----------------------------------------------------------------- subagent tasks */

    describe('subagent task receipts and results', () => {
      const createTaskInput = (conversationId: string, taskId = 'task-1', extra: RawRecord = {}) =>
        seedMessages([
          {
            conversationId,
            messageId: `${taskId}:user`,
            parentMessageId: ROOT,
            sender: 'User',
            text: 'Do the work',
            endpoint: 'agents',
            isCreatedByUser: true,
            subagentTask: { attemptKey: `attempt-${taskId}`, status: 'running' },
            createdAt: new Date('2026-08-24T11:00:00.000Z'),
            updatedAt: new Date('2026-08-24T11:00:00.000Z'),
            ...extra,
          },
        ]);
      const accepted = {
        invocationId: 'invocation-1',
        fingerprint: 'fingerprint-1',
        controlId: 'control-1',
        action: 'steer' as const,
        status: 'accepted' as const,
        createdAt: new Date('2026-08-24T12:00:00.000Z'),
        updatedAt: new Date('2026-08-24T12:00:00.000Z'),
        message: 'Use the primary source.',
      };
      const record = (conversationId: string, receipt: Record<string, unknown>, userId = USER) =>
        stores().recordSubagentTaskControlReceipt({
          userId,
          conversationId,
          taskId: 'task-1',
          receipt: receipt as never,
        });
      const receiptOf = (conversationId: string, extra: Record<string, unknown> = {}) =>
        stores().getSubagentTaskControlReceipt({
          userId: USER,
          conversationId,
          taskId: 'task-1',
          invocationId: 'invocation-1',
          ...extra,
        });

      it('advances one invocation monotonically, owned by the task’s user', async () => {
        const conversationId = uuid();
        await createTaskInput(conversationId);
        expect(
          await record(conversationId, { ...accepted, controlId: undefined, status: 'reserved' }),
        ).toBe(true);
        /** A reservation fences other owners but is not public evidence of acceptance. */
        expect(await receiptOf(conversationId)).toBeNull();
        expect(await record(conversationId, accepted)).toBe(true);
        expect(
          await record(conversationId, {
            ...accepted,
            status: 'applied',
            boundary: 'tool',
            updatedAt: new Date('2026-08-24T12:00:01.000Z'),
          }),
        ).toBe(true);
        expect(await record(conversationId, accepted)).toBe('unchanged');
        expect(await record(conversationId, accepted, 'another-user')).toBe(false);
        expect(await record(conversationId, { ...accepted, fingerprint: 'different' })).toBe(
          'conflict',
        );
        expect(await receiptOf(conversationId)).toMatchObject({
          invocationId: 'invocation-1',
          fingerprint: 'fingerprint-1',
          action: 'steer',
          status: 'applied',
          boundary: 'tool',
        });
        expect(
          await stores().getSubagentTaskControlReceipt({
            userId: 'another-user',
            conversationId,
            taskId: 'task-1',
            invocationId: 'invocation-1',
          }),
        ).toBeNull();
        const stored = (await rawOf('task-1:user')).subagentTask as Record<string, Stored>;
        expect(stored.status).toBe('running');
        expect(stored.controlReceipts).toEqual([
          expect.objectContaining({
            invocationId: 'invocation-1',
            status: 'applied',
            boundary: 'tool',
          }),
        ]);
      });

      it('records nothing for an ordinary message with a colliding id', async () => {
        const conversationId = uuid();
        await seedMessages([
          { conversationId, messageId: 'task-1:user', isCreatedByUser: true, text: 'Ordinary' },
        ]);
        expect(await record(conversationId, accepted)).toBe(false);
        expect((await rawOf('task-1:user')).subagentTask == null).toBe(true);
      });

      it('hides a receipt of an expired task from active reads only', async () => {
        const conversationId = uuid();
        await createTaskInput(conversationId, 'task-1', { expiredAt: new Date(Date.now() - 1000) });
        await record(conversationId, accepted);
        expect(await receiptOf(conversationId, { activeOnly: true })).toBeNull();
        expect(await receiptOf(conversationId)).toMatchObject({ invocationId: 'invocation-1' });
      });

      it('replays a receipt with its task summary through the parent conversation', async () => {
        const conversationId = uuid();
        await createTaskInput(conversationId);
        await harness.seedRaw('conversations', [
          {
            _id: newId(),
            user: USER,
            conversationId,
            title: 'Child thread',
            endpoint: 'agents',
            subagentThread: {
              rootConversationId: 'parent-conversation',
              parentConversationId: 'parent-conversation',
              parentMessageId: 'parent-message',
              parentToolCallId: 'parent-tool',
              subagentType: 'researcher',
              subagentKind: 'agent',
              depth: 1,
            },
          },
        ]);
        await seedMessages([
          {
            conversationId,
            messageId: 'task-1:assistant',
            parentMessageId: 'task-1:user',
            text: 'Done.',
            subagentTask: {
              attemptKey: 'task-1-attempt',
              status: 'completed',
              resultClaim: {
                kind: 'manual',
                claimId: 'poll-1',
                claimedAt: new Date('2026-08-24T12:00:02.000Z'),
              },
            },
          },
        ]);
        const rejected = {
          ...accepted,
          invocationId: 'terminal',
          action: 'cancel',
          status: 'rejected',
          reason: 'task_not_running',
          message: undefined,
          controlId: undefined,
        };
        expect(await record(conversationId, rejected)).toBe(true);
        const replay = (parentConversationId: string, userId = USER) =>
          stores().getSubagentTaskControlReplay({
            userId,
            parentConversationId,
            taskId: 'task-1',
            invocationId: 'terminal',
          });
        expect(await replay('parent-conversation')).toEqual({
          receipt: expect.objectContaining({
            invocationId: 'terminal',
            status: 'rejected',
            reason: 'task_not_running',
          }),
          task: expect.objectContaining({
            taskId: 'task-1',
            threadId: conversationId,
            subagentType: 'researcher',
            status: 'completed',
            resultAvailable: true,
            resultClaimed: true,
          }),
        });
        expect(await replay('different-parent')).toBeNull();
        expect(await replay('parent-conversation', 'another-user')).toBeNull();
      });

      it('hands a terminal result to one consumer, idempotently for that consumer', async () => {
        const conversationId = uuid();
        const terminal = (taskId: string, status: string) =>
          save({
            messageId: `${taskId}:assistant`,
            conversationId,
            text: 'child result',
            subagentTask: { attemptKey: `${taskId}:attempt`, status },
          });
        await terminal('manual-task', 'completed');
        await terminal('wakeup-task', 'completed');
        await terminal('running-task', 'running');
        const claimTask = (
          taskId: string,
          kind: 'manual' | 'wakeup',
          claimId: string,
          userId = USER,
        ) => stores().claimSubagentTaskResult({ userId, conversationId, taskId, kind, claimId });

        const first = await claimTask('manual-task', 'manual', 'poll-1');
        expect(first.status).toBe('acquired');
        expect(first.status === 'acquired' && first.message.text).toBe('child result');
        expect((await claimTask('manual-task', 'manual', 'poll-1')).status).toBe('acquired');
        expect((await claimTask('manual-task', 'manual', 'poll-2')).status).toBe('claimed');
        expect((await claimTask('manual-task', 'wakeup', 'delivery-1')).status).toBe('claimed');

        expect((await claimTask('wakeup-task', 'wakeup', 'delivery-2')).status).toBe('acquired');
        expect((await claimTask('wakeup-task', 'wakeup', 'delivery-2')).status).toBe('acquired');
        expect((await claimTask('wakeup-task', 'wakeup', 'delivery-3')).status).toBe('claimed');

        expect(await claimTask('running-task', 'manual', 'poll-1')).toEqual({
          status: 'not_found',
        });
        expect(await claimTask('missing-task', 'manual', 'poll-1')).toEqual({
          status: 'not_found',
        });
        expect(await claimTask('manual-task', 'manual', 'poll-1', 'other-user')).toEqual({
          status: 'not_found',
        });
      });

      it('releases only the exact claim so another consumer can take over', async () => {
        const conversationId = uuid();
        await save({
          messageId: 'task-1:assistant',
          conversationId,
          text: 'r',
          subagentTask: { attemptKey: 'a', status: 'completed' },
        });
        const wakeup = {
          userId: USER,
          conversationId,
          taskId: 'task-1',
          kind: 'wakeup' as const,
          claimId: 'delivery-1',
        };
        expect((await stores().claimSubagentTaskResult(wakeup)).status).toBe('acquired');
        expect(
          await stores().releaseSubagentTaskResultClaim({ ...wakeup, claimId: 'another' }),
        ).toBe(false);
        expect(await stores().releaseSubagentTaskResultClaim(wakeup)).toBe(true);
        expect(
          (await stores().claimSubagentTaskResult({ ...wakeup, kind: 'manual', claimId: 'poll' }))
            .status,
        ).toBe('acquired');
      });
    });

    /* ----------------------------------------------------------------- thread view and tasks */

    describe('getMessagesForSubagentThreadView', () => {
      it('projects the public fields newest first, bounding text by code points', async () => {
        const conversationId = uuid();
        await seedMessages([
          {
            conversationId,
            messageId: 'captured-none:user',
            text: 'Input',
            isCreatedByUser: true,
            createdAt: new Date(Date.UTC(2026, 7, 21, 12, 0)),
          },
          {
            conversationId,
            messageId: 'captured:user',
            text: 'Input',
            isCreatedByUser: true,
            subagentContent: { version: 1, throughSequence: 12 },
            createdAt: new Date(Date.UTC(2026, 7, 21, 12, 1)),
          },
          {
            conversationId,
            messageId: 'deleted:user',
            text: 'Input',
            isCreatedByUser: true,
            subagentContent: { version: 1, throughSequence: 12, deleted: true },
            createdAt: new Date(Date.UTC(2026, 7, 21, 12, 2)),
          },
          {
            conversationId,
            messageId: 'long:assistant',
            text: '🧵'.repeat(20),
            createdAt: new Date(Date.UTC(2026, 7, 21, 12, 3)),
          },
        ]);
        await seedMessages([
          { conversationId, messageId: 'theirs:user', user: 'other', text: 'x' },
        ]);
        const view = await stores().getMessagesForSubagentThreadView({
          user: USER,
          conversationId,
          limit: 10,
          textCodePointLimit: 5,
        });
        expect(view.map(({ messageId }) => messageId)).toEqual([
          'long:assistant',
          'deleted:user',
          'captured:user',
          'captured-none:user',
        ]);
        expect(Array.from(view[0].text ?? '')).toHaveLength(5);
        expect(view[0].textProjectionTruncated).toBe(true);
        expect(view[1].contentRecoveryAvailable).toBe(false);
        expect(view[2].contentRecoveryAvailable).toBe(true);
        expect(view[3].contentRecoveryAvailable).toBe(false);
        for (const message of view) {
          expect(message).not.toHaveProperty('_id');
          expect(message).not.toHaveProperty('user');
          expect(message).not.toHaveProperty('conversationId');
        }
        expect(JSON.stringify(view)).not.toContain('throughSequence');
        expect(timeOf(view[0].createdAt)).toBe(Date.UTC(2026, 7, 21, 12, 3));
      });

      it('anchors older pages at a message of the thread, and an unknown anchor reads empty', async () => {
        const conversationId = uuid();
        await seedMessages(
          [0, 1, 2, 3].map((index) => ({
            conversationId,
            messageId: `task-${index}:assistant`,
            text: `Answer ${index}`,
            createdAt: new Date(Date.UTC(2026, 7, 21, 12, index)),
          })),
        );
        await seedMessages([
          { conversationId: uuid(), messageId: 'foreign:user', text: 'Foreign anchor' },
        ]);
        const page = (beforeMessageId: string) =>
          stores().getMessagesForSubagentThreadView({
            user: USER,
            conversationId,
            beforeMessageId,
            limit: 2,
            textCodePointLimit: 100,
          });
        expect((await page('task-2:assistant')).map(({ messageId }) => messageId)).toEqual([
          'task-2:assistant',
          'task-1:assistant',
        ]);
        expect(await page('foreign:user')).toEqual([]);
      });
    });

    describe('listSubagentTasksForThreads', () => {
      it('lists the newest task outcomes per thread, deriving ordinary rows’ status', async () => {
        const first = uuid();
        const second = uuid();
        const derived = uuid();
        const at = (minute: number) => new Date(Date.UTC(2026, 7, 21, 10, minute));
        await seedMessages([
          {
            conversationId: first,
            messageId: 'task-old:user',
            isCreatedByUser: true,
            subagentTask: { attemptKey: 'old', status: 'running' },
            createdAt: at(0),
          },
          {
            conversationId: first,
            messageId: 'task-old:assistant',
            subagentTask: { attemptKey: 'old', status: 'completed' },
            createdAt: at(1),
          },
          {
            conversationId: first,
            messageId: 'task-new:user',
            isCreatedByUser: true,
            subagentTask: { attemptKey: 'new', status: 'running' },
            createdAt: at(2),
          },
          { conversationId: first, messageId: 'not-a-task', createdAt: at(3) },
          {
            conversationId: second,
            messageId: 'task-other:assistant',
            subagentTask: { attemptKey: 'other', status: 'cancelled' },
            createdAt: at(4),
          },
          {
            conversationId: derived,
            messageId: 'delivery-running:user',
            isCreatedByUser: true,
            createdAt: at(5),
          },
          { conversationId: derived, messageId: 'delivery-complete:assistant', createdAt: at(6) },
          {
            conversationId: derived,
            messageId: 'delivery-error:assistant',
            error: true,
            createdAt: at(7),
          },
          {
            conversationId: first,
            messageId: 'theirs:assistant',
            user: 'other',
            subagentTask: { attemptKey: 'x', status: 'completed' },
            createdAt: at(8),
          },
        ]);
        const records = await stores().listSubagentTasksForThreads({
          user: USER,
          conversationIds: [first, second, derived, uuid()],
          limitPerThread: 2,
        });
        expect(records.map(({ conversationId }) => conversationId)).toEqual(
          [first, second, derived].sort(),
        );
        const tasksOf = (conversationId: string) =>
          records
            .find((record) => record.conversationId === conversationId)
            ?.tasks.map(({ messageId, status, statusDerived }) => [
              messageId,
              status,
              statusDerived === true,
            ]);
        expect(tasksOf(first)).toEqual([
          ['task-new:user', 'running', false],
          ['task-old:assistant', 'completed', false],
        ]);
        expect(tasksOf(second)).toEqual([['task-other:assistant', 'cancelled', false]]);
        expect(tasksOf(derived)).toEqual([
          ['delivery-error:assistant', 'error', true],
          ['delivery-complete:assistant', 'completed', true],
        ]);
        expect(records.every((record) => record.sourceTruncated !== true)).toBe(true);
        expect(
          await stores().listSubagentTasksForThreads({
            user: USER,
            conversationIds: [],
            limitPerThread: 2,
          }),
        ).toEqual([]);
      });
    });

    /* ----------------------------------------------------------------- traces */

    describe('getConversationTraceRefs and hasSampledTraceMessage', () => {
      const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
      const sampled = (messageId: string, extra: RawRecord = {}): RawRecord => ({
        messageId,
        conversationId: 'convo',
        createdAt: at(1),
        langfuseSampled: true,
        ...extra,
      });

      it('returns the first message time and the sampled responses oldest first', async () => {
        await seedMessages([
          { messageId: 'user-1', conversationId: 'convo', createdAt: at(1), isCreatedByUser: true },
          sampled('response-2', { createdAt: at(4) }),
          sampled('response-1', { createdAt: at(2), langfuseDestinationIds: ['destination-a'] }),
          sampled('unsampled', { createdAt: at(3), langfuseSampled: false }),
          sampled('user-5_', { createdAt: at(5), error: true, langfuseRunId: 'run-5' }),
          sampled('forged', { createdAt: at(6), isUserSubmitted: true }),
        ]);
        await seedMessages([sampled('victim', { user: 'victim', createdAt: at(0) })]);
        const refs = await stores().getConversationTraceRefs({
          user: USER,
          conversationId: 'convo',
        });
        expect(timeOf(refs.firstMessageAt)).toBe(at(1).getTime());
        expect(refs.sampledMessages).toEqual([
          {
            messageId: 'response-1',
            createdAt: expect.any(Date),
            orderKey: expect.any(String),
            langfuseDestinationIds: ['destination-a'],
          },
          { messageId: 'response-2', createdAt: expect.any(Date), orderKey: expect.any(String) },
          {
            messageId: 'user-5_',
            createdAt: expect.any(Date),
            orderKey: expect.any(String),
            langfuseRunId: 'run-5',
          },
        ]);
        expect(
          await stores().getConversationTraceRefs({ user: 'nobody', conversationId: 'convo' }),
        ).toEqual({ sampledMessages: [] });
      });

      it('orders responses of the same millisecond by id and pages back from an opaque position', async () => {
        const [earlier, later] = [newId(), newId()].sort();
        await seedMessages([
          sampled('second', { _id: later, createdAt: at(2) }),
          sampled('first', { _id: earlier, createdAt: at(2) }),
          ...[3, 4, 5].map((index) => sampled(`response-${index}`, { createdAt: at(index) })),
        ]);
        const read = (input: Record<string, unknown>) =>
          stores().getConversationTraceRefs({ user: USER, conversationId: 'convo', ...input });
        const ids = (refs: { sampledMessages: Array<{ messageId: string }> }) =>
          refs.sampledMessages.map(({ messageId }) => messageId);
        const all = await read({});
        expect(ids(all)).toEqual(['first', 'second', 'response-3', 'response-4', 'response-5']);
        expect(ids(await read({ limit: 2 }))).toEqual(['response-4', 'response-5']);
        const third = all.sampledMessages[2];
        const through = { messageId: third.messageId, orderKey: third.orderKey };
        expect(ids(await read({ through, limit: 2 }))).toEqual(['second', 'response-3']);
        expect(ids(await read({ through: { ...through, messageId: 'first' }, limit: 2 }))).toEqual(
          [],
        );
        expect(ids(await read({ through: { ...through, orderKey: 'forged' }, limit: 2 }))).toEqual(
          [],
        );
        expect(ids(await read({ messageId: 'response-4' }))).toEqual(['response-4']);
        expect(ids(await read({ messageId: 'missing' }))).toEqual([]);
      });

      it('scopes to the given tenant, records without one when none is given', async () => {
        await seedMessages([sampled('tenantless'), sampled('tenant-a', { tenantId: 'tenant-a' })]);
        const ids = async (tenantId?: string) =>
          (
            await stores().getConversationTraceRefs({
              user: USER,
              conversationId: 'convo',
              tenantId,
            })
          ).sampledMessages.map(({ messageId }) => messageId);
        expect(await ids()).toEqual(['tenantless']);
        expect(await ids('tenant-a')).toEqual(['tenant-a']);
        expect(await inTenant('tenant-a', () => ids('tenant-a'))).toEqual(['tenant-a']);
        expect(
          await stores().hasSampledTraceMessage({
            user: USER,
            conversationId: 'convo',
            destinationIds: [],
          }),
        ).toBe(true);
      });

      it('finds a sampled response a destination can hold; one with no record counts for every one', async () => {
        await seedMessages([
          sampled('old', { createdAt: at(1), langfuseDestinationIds: ['retired'] }),
          sampled('new', { createdAt: at(9), langfuseDestinationIds: ['current'] }),
        ]);
        const has = (destinationIds: string[], conversationId = 'convo') =>
          stores().hasSampledTraceMessage({ user: USER, conversationId, destinationIds });
        expect(await has(['current'])).toBe(true);
        expect(await has(['elsewhere'])).toBe(false);
        await seedMessages([sampled('unrecorded', { conversationId: 'other' })]);
        expect(await has([], 'other')).toBe(true);
        expect(await has(['anything'], 'other')).toBe(true);
      });

      it('ignores unsampled responses, an empty destination record, other users and client rows', async () => {
        await seedMessages([
          sampled('unsampled', { langfuseSampled: false }),
          sampled('recorded-none', { langfuseDestinationIds: [] }),
          sampled('someone-else', { user: 'victim' }),
          sampled('forged-by-client', { isUserSubmitted: true }),
          sampled('user-turn', { isCreatedByUser: true }),
        ]);
        expect(
          await stores().hasSampledTraceMessage({
            user: USER,
            conversationId: 'convo',
            destinationIds: ['current'],
          }),
        ).toBe(false);
      });
    });

    /* ----------------------------------------------------------------- reads */

    describe('getMessages', () => {
      it('reads the matches in creation order by default, ordered, limited or unordered on request', async () => {
        const conversationId = uuid();
        await seedMessages(
          ['first', 'second', 'third'].map((text, index) => ({
            conversationId,
            messageId: `m${index}`,
            text,
            createdAt: new Date(Date.UTC(2026, 0, 3 - index)),
          })),
        );
        await seedMessages([{ conversationId: uuid(), messageId: 'elsewhere', text: 'other' }]);
        const texts = (rows: IMessage[]) => rows.map(({ text }) => text);
        expect(texts(await stores().getMessages({ conversationId }))).toEqual([
          'third',
          'second',
          'first',
        ]);
        expect(
          texts(await stores().getMessages({ conversationId }, undefined, { limit: 2 })),
        ).toEqual(['third', 'second']);
        expect(
          texts(await stores().getMessages({ conversationId }, undefined, { limit: 0 })),
        ).toHaveLength(3);
        expect(
          texts(
            await stores().getMessages({ conversationId }, undefined, { sort: { messageId: -1 } }),
          ),
        ).toEqual(['third', 'second', 'first']);
        expect(
          texts(await stores().getMessages({ conversationId }, undefined, { sort: false })).sort(),
        ).toEqual(['first', 'second', 'third']);
        expect(
          texts(
            await stores().getMessages({
              conversationId,
              $or: [{ messageId: 'm0' }, { text: { $in: ['third'] } }],
            }),
          ),
        ).toEqual(['third', 'first']);
        expect(
          await stores().getMessages({ conversationId, missingField: { $exists: true } }),
        ).toEqual([]);
        expect(texts(await stores().getMessages({ user: USER }))).toHaveLength(4);
      });

      it('selects fields with a projection string', async () => {
        const conversationId = uuid();
        await seedMessages([
          { conversationId, messageId: 'm1', text: 'hello', sender: 'User', tokenCount: 3 },
        ]);
        const [included] = await stores().getMessages({ conversationId }, 'messageId text');
        expect(Object.keys(included).sort()).toEqual(['_id', 'messageId', 'text']);
        const [withoutId] = await stores().getMessages({ conversationId }, '-_id messageId');
        expect(Object.keys(withoutId)).toEqual(['messageId']);
        const [excluded] = await stores().getMessages({ conversationId }, '-text -sender');
        expect(excluded).toMatchObject({ messageId: 'm1', tokenCount: 3 });
        expect(excluded).not.toHaveProperty('text');
        expect(excluded).not.toHaveProperty('sender');
      });

      it('leaves out server-only fields, nested ones included, with CLIENT_MESSAGE_SELECT', async () => {
        const conversationId = uuid();
        await seedMessages([
          {
            conversationId,
            messageId: 'projected',
            sender: 'Agent',
            text: 'visible text',
            content: [
              { type: 'text', text: 'part text' },
              {
                type: 'tool_call',
                tool_call: {
                  id: 'call-background',
                  backgroundTask: {
                    version: 1,
                    taskId: 'task-visible',
                    toolName: 'slow_tool',
                    status: 'completed',
                    completionWakeup: true,
                    resultClaim: { kind: 'wakeup', claimId: 'private', claimedAt: new Date() },
                  },
                },
              },
            ],
            tokenCount: 42,
            conversationSignature: 'sig',
            clientId: 'client-1',
            invocationId: 7,
            summary: 'legacy summary',
            summaryTokenCount: 11,
            contextMeta: { calibrationRatio: 1 },
            langfuseSampled: true,
            langfuseDestinationIds: ['lf-1'],
            langfuseRunId: 'run-1',
            metadata: { usage: { input: 10, output: 20 }, thoughtSignatures: { tool_1: 'opaque' } },
            subagentTask: {
              attemptKey: 'private-attempt',
              requestFingerprint: 'private',
              status: 'running',
            },
            attachments: [
              {
                type: 'web_search',
                toolCallId: 'tool_1',
                web_search: {
                  turn: 0,
                  organic: [
                    {
                      title: 'Result',
                      link: 'https://example.com',
                      snippet: 'snippet',
                      sitelinks: [{ title: 'sub' }],
                      highlights: ['raw'],
                    },
                  ],
                  topStories: [
                    { title: 'Story', link: 'https://example.com/s', highlights: ['x'] },
                  ],
                  references: [{ link: 'https://example.com', title: 'Result', type: 'link' }],
                  images: [{ imageUrl: 'https://example.com/i.png' }],
                  answerBox: { answer: '42' },
                  knowledgeGraph: { title: 'KG' },
                  peopleAlsoAsk: [{ question: 'q' }],
                  relatedSearches: ['related'],
                  news: [{ title: 'n' }],
                  videos: [{ title: 'v' }],
                  places: [{ title: 'p' }],
                  shopping: [{ title: 's' }],
                },
              },
            ],
          },
        ]);
        const [message] = await stores().getMessages(
          { conversationId, user: USER },
          CLIENT_MESSAGE_SELECT,
        );
        const record = message as unknown as Record<string, Stored>;
        expect(record).toMatchObject({
          messageId: 'projected',
          text: 'visible text',
          sender: 'Agent',
          tokenCount: 42,
        });
        expect(record.content).toHaveLength(2);
        expect(record.content[0]).toEqual({ type: 'text', text: 'part text' });
        expect(record.content[1].tool_call.backgroundTask).toEqual({
          version: 1,
          taskId: 'task-visible',
          toolName: 'slow_tool',
          status: 'completed',
        });
        expect(record.metadata).toEqual({ usage: { input: 10, output: 20 } });
        for (const field of [
          '_id',
          '__v',
          'user',
          'conversationSignature',
          'clientId',
          'invocationId',
          'summary',
          'summaryTokenCount',
          'contextMeta',
          'langfuseSampled',
          'langfuseDestinationIds',
          'langfuseRunId',
          'subagentTask',
          'privateText',
        ]) {
          expect(record).not.toHaveProperty(field);
        }
        const webSearch = record.attachments[0].web_search;
        expect(record.attachments[0]).toMatchObject({ type: 'web_search', toolCallId: 'tool_1' });
        expect(webSearch.organic).toEqual([
          { title: 'Result', link: 'https://example.com', snippet: 'snippet' },
        ]);
        expect(webSearch.topStories).toEqual([{ title: 'Story', link: 'https://example.com/s' }]);
        expect(webSearch).toMatchObject({
          turn: 0,
          references: [{ link: 'https://example.com', title: 'Result', type: 'link' }],
          images: [{ imageUrl: 'https://example.com/i.png' }],
          answerBox: { answer: '42' },
          videos: [{ title: 'v' }],
        });
        for (const vertical of [
          'knowledgeGraph',
          'peopleAlsoAsk',
          'relatedSearches',
          'news',
          'places',
          'shopping',
        ]) {
          expect(webSearch).not.toHaveProperty(vertical);
        }
      });
    });

    describe('getMessagesPage', () => {
      const conversationId = uuid();
      const tied = new Date('2026-01-01T00:00:00.123Z');
      const later = new Date('2026-01-02T00:00:00.456Z');
      const endpoints = [undefined, '', 'agents', 'agents', null, 'openAI', undefined, 'agents'];
      let rows: RawRecord[] = [];

      beforeEach(async () => {
        rows = endpoints.map((endpoint, index) => ({
          _id: newId(),
          messageId: `page-${index}`,
          conversationId,
          user: USER,
          text: `message ${index}`,
          isCreatedByUser: index % 2 === 0,
          contextMeta: { calibrationRatio: 1 },
          createdAt: index < 5 ? tied : later,
          ...(index === 6 ? {} : { updatedAt: index % 3 === 0 ? tied : later }),
          ...(endpoint === undefined ? {} : { endpoint }),
        }));
        await harness.seedRaw('messages', rows);
        await seedMessages([
          { messageId: 'other-user', conversationId, user: 'user-other', createdAt: tied },
          { messageId: 'other-convo', conversationId: uuid(), createdAt: tied },
        ]);
      });

      /** The total order a page read promises: the field (missing or null first), then the id. */
      const expectedOrder = (field: string, order: 1 | -1) =>
        [...rows]
          .sort((a, b) => {
            const rank = (value: unknown) => (value == null ? 0 : 1);
            const key = (value: unknown) => (value instanceof Date ? value.getTime() : value);
            const [x, y] = [a[field], b[field]];
            const compare = (left: unknown, right: unknown) => {
              if (left === right) {
                return 0;
              }
              return (left as string) < (right as string) ? -1 : 1;
            };
            const byValue = rank(x) - rank(y) || (rank(x) === 0 ? 0 : compare(key(x), key(y)));
            return (byValue || String(a._id).localeCompare(String(b._id))) * order;
          })
          .map((row) => row.messageId);

      it.each([
        ['createdAt', 1],
        ['createdAt', -1],
        ['updatedAt', 1],
        ['updatedAt', -1],
        ['endpoint', 1],
        ['endpoint', -1],
      ] as Array<['createdAt' | 'updatedAt' | 'endpoint', 1 | -1]>)(
        'pages by %s (%i) in a total order, never skipping or repeating a row',
        async (field, order) => {
          for (const limit of [1, 3, 25]) {
            const seen: string[] = [];
            let after: string | null = null;
            for (let pages = 0; pages < 20; pages++) {
              const page = await stores().getMessagesPage(
                { conversationId, user: USER },
                { sort: { field, order }, limit, after },
              );
              expect(page.messages.length).toBeLessThanOrEqual(limit);
              seen.push(...page.messages.map(({ messageId }) => messageId));
              if (page.nextCursor == null) {
                break;
              }
              expect(typeof page.nextCursor).toBe('string');
              after = page.nextCursor;
            }
            expect(seen).toEqual(expectedOrder(field, order));
          }
        },
      );

      it('projects with CLIENT_MESSAGE_SELECT or an inclusion that keeps the sort field', async () => {
        const client = await stores().getMessagesPage(
          { conversationId, user: USER },
          { sort: { field: 'createdAt', order: 1 }, limit: 2, select: CLIENT_MESSAGE_SELECT },
        );
        expect(client.messages).toHaveLength(2);
        for (const message of client.messages) {
          expect(message).not.toHaveProperty('_id');
          expect(message).not.toHaveProperty('user');
          expect(message).not.toHaveProperty('contextMeta');
        }
        const seen: string[] = [];
        let after: string | null = null;
        for (let pages = 0; pages < 10; pages++) {
          const page = await stores().getMessagesPage(
            { conversationId, user: USER },
            {
              sort: { field: 'updatedAt', order: -1 },
              limit: 3,
              after,
              select: 'messageId text updatedAt',
            },
          );
          for (const message of page.messages) {
            /** `updatedAt` too, but for the row stored without one. */
            const keys = Object.keys(message).filter((key) => key !== 'updatedAt');
            expect(keys.sort()).toEqual(['_id', 'messageId', 'text']);
          }
          seen.push(...page.messages.map(({ messageId }) => messageId));
          if (page.nextCursor == null) {
            break;
          }
          after = page.nextCursor;
        }
        expect(seen).toEqual(expectedOrder('updatedAt', -1));
      });

      it('accepts a bare sort value as a cursor, starting strictly after it', async () => {
        const page = await stores().getMessagesPage(
          { conversationId, user: USER },
          { sort: { field: 'createdAt', order: 1 }, limit: 25, after: tied.toISOString() },
        );
        expect(page.messages.map(({ messageId }) => messageId)).toEqual([
          'page-5',
          'page-6',
          'page-7',
        ]);
        expect(page.nextCursor).toBeNull();
        const absent = await stores().getMessagesPage(
          { conversationId, user: USER },
          { sort: { field: 'updatedAt', order: -1 }, limit: 4 },
        );
        const explicitNull = await stores().getMessagesPage(
          { conversationId, user: USER },
          { sort: { field: 'updatedAt', order: -1 }, limit: 4, after: null },
        );
        expect(explicitNull).toEqual(absent);
      });
    });

    describe('searchUserMessages', () => {
      it('rejects when the store has no search index', async () => {
        await expect(
          stores().searchUserMessages({ user: USER, text: 'needle', limit: 5 }),
        ).rejects.toThrow();
      });
    });

    describe('getMessage', () => {
      it("reads the user's message by id, and another user's as absent", async () => {
        await seedMessages([
          { conversationId: 'c', messageId: 'm1', text: 'mine' },
          { conversationId: 'c', messageId: 'm2', text: 'theirs', user: 'other' },
        ]);
        expect(await stores().getMessage({ user: USER, messageId: 'm1' })).toMatchObject({
          messageId: 'm1',
          text: 'mine',
        });
        expect(await stores().getMessage({ user: USER, messageId: 'm2' })).toBeNull();
      });
    });

    describe('getBranchReasoningOverride', () => {
      const high = { key: 'reasoning_effort', value: 'high' };
      const low = { key: 'reasoning_effort', value: 'low' };
      const turn = (
        messageId: string,
        parentMessageId: string,
        isCreatedByUser: boolean,
        reasoningOverride?: object,
        user = USER,
      ) => ({
        messageId,
        parentMessageId,
        conversationId: 'convo-1',
        user,
        isCreatedByUser,
        text: messageId,
        ...(reasoningOverride != null && { reasoningOverride }),
      });
      const read = (parentMessageId: string) =>
        stores().getBranchReasoningOverride({
          user: USER,
          conversationId: 'convo-1',
          parentMessageId,
        });

      it('takes the nearest user message on the branch that carries a level', async () => {
        await seedMessages([
          turn('u1', ROOT, true, high),
          turn('a1', 'u1', false),
          turn('u2', 'a1', true, low),
          turn('a2', 'u2', false),
          turn('u2b', 'a1', true),
          turn('a2b', 'u2b', false),
        ]);
        expect(await read('a2')).toEqual(low);
        expect(await read('a2b')).toEqual(high);
        expect(await read('u1')).toEqual(high);
      });

      it("resolves null when no user message on the branch carries one, or for another user's", async () => {
        await seedMessages([
          turn('u1', ROOT, true),
          turn('a1', 'u1', false),
          turn('x1', ROOT, true, high, 'other'),
        ]);
        expect(await read('a1')).toBeNull();
        expect(await read('x1')).toBeNull();
      });
    });

    /* ----------------------------------------------------------------- deletes and scripts */

    describe('deleteMessages', () => {
      it('deletes the matches, counting them', async () => {
        await save({ messageId: 'm1', conversationId: uuid(), text: 'mine' });
        await save({ messageId: 'm2', conversationId: uuid(), text: 'mine too' });
        await stores().saveMessage({ userId: 'user456' }, {
          messageId: 'm3',
          conversationId: uuid(),
          text: 'theirs',
        } as Params);
        expect(await stores().deleteMessages({ user: USER, messageId: 'm1' })).toMatchObject({
          deletedCount: 1,
        });
        expect(await stores().deleteMessages({ user: USER })).toMatchObject({ deletedCount: 1 });
        expect((await harness.readRaw('messages')).map(({ user }) => user)).toEqual(['user456']);
      });

      it('deletes the subagent content of the tasks it deletes first', async () => {
        const run = {
          user: USER,
          parentConversationId: 'parent',
          conversationId: 'child',
          taskId: 'task',
        };
        await seedMessages([
          {
            conversationId: 'child',
            messageId: 'task:user',
            isCreatedByUser: true,
            subagentContent: { version: 1 },
          },
          { conversationId: 'child', messageId: 'task:assistant', subagentContent: { version: 1 } },
          { conversationId: 'child', messageId: 'ordinary', text: 'kept' },
        ]);
        await harness.seedRaw('conversations', [
          { _id: newId(), user: USER, conversationId: 'parent', endpoint: 'agents' },
          {
            _id: newId(),
            user: USER,
            conversationId: 'child',
            endpoint: 'agents',
            subagentThread: {
              rootConversationId: 'parent',
              parentConversationId: 'parent',
              parentMessageId: 'p',
              parentToolCallId: 't',
              subagentType: 'r',
              subagentKind: 'agent',
              depth: 1,
            },
            subagentThreadLease: {
              token: 'lease',
              taskId: 'task',
              expiresAt: new Date(Date.now() + hour),
            },
          },
        ]);
        const content = harness.createStores().subagentContent;
        expect(
          await content.appendSubagentContentBatch({
            ...run,
            revision: 1,
            fromSequence: 0,
            throughSequence: 1,
            eventsJson: '[]',
          }),
        ).toEqual({ ok: true });
        expect(await content.getSubagentContentHead(run)).toEqual({
          revision: 1,
          throughSequence: 1,
        });

        expect(
          await stores().deleteMessages({
            user: USER,
            conversationId: 'child',
            messageId: 'task:assistant',
          }),
        ).toMatchObject({
          deletedCount: 1,
        });
        expect(await content.getSubagentContentHead(run)).toBeNull();
        expect((await rawOf('task:user')).subagentContent).toMatchObject({ deleted: true });
        expect((await rawOf('ordinary')).text).toBe('kept');
        expect(
          await stores().deleteMessages({ user: USER, conversationId: 'child' }),
        ).toMatchObject({ deletedCount: 2 });
        expect(await harness.readRaw('subagentcontents')).toEqual([]);
      });
    });

    describe('countMessagesByUser and insertMessageRecords', () => {
      it('counts the messages of each owner, null for messages without one', async () => {
        await seedMessages([
          { conversationId: 'c', messageId: 'a1' },
          { conversationId: 'c', messageId: 'a2' },
          { conversationId: 'c', messageId: 'b1', user: 'user-b' },
          { conversationId: 'c', messageId: 'n1', user: null },
        ]);
        const counts = await stores().countMessagesByUser();
        expect([...counts].sort((x, y) => String(x.user).localeCompare(String(y.user)))).toEqual([
          { user: null, count: 1 },
          { user: 'user-b', count: 1 },
          { user: USER, count: 2 },
        ]);
      });

      it('inserts the records with their own timestamps, rejecting one that cannot be stored', async () => {
        const createdAt = new Date('2020-01-01T00:00:00.000Z');
        const updatedAt = new Date('2020-01-02T00:00:00.000Z');
        await stores().insertMessageRecords([
          {
            messageId: 'seed-1',
            conversationId: 'c',
            user: USER,
            text: 'seeded',
            createdAt,
            updatedAt,
          },
          {
            messageId: 'seed-2',
            conversationId: 'c',
            user: USER,
            text: 'seeded too',
            createdAt,
            updatedAt,
          },
        ]);
        const stored = await rawOf('seed-1');
        expect(stored).toMatchObject({ text: 'seeded' });
        expect(timeOf(stored.createdAt)).toBe(createdAt.getTime());
        expect(timeOf(stored.updatedAt)).toBe(updatedAt.getTime());
        await expect(
          stores().insertMessageRecords([
            { messageId: 'seed-1', conversationId: 'c', user: USER, text: 'duplicate' },
          ]),
        ).rejects.toThrow();
        expect((await rawOf('seed-1')).text).toBe('seeded');
      });
    });
  });
}
