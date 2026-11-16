/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ConversationImportStore` contract (`~/ports/conversationImport`), ported from
 * `methods/import.spec.ts`: the cleanup of a failed import removes only the scope's user, tenant
 * and conversation ids (a scope without a tenant only the records stored without one), whatever
 * tenant the caller runs in, with the subagent content of those conversations, and refreshes the
 * stats of the chat projects the removed conversations were in.
 *
 * The case that counts the chunked cleanup queries through stub models stays in the method spec
 * (it observes driver calls). Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, useContractHarness } from './support';

export function describeConversationImportContract(harness: ContractHarness): void {
  describe(`ConversationImportStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores();
    const newId = () => harness.ids.generate();
    const conversation = (record: RawRecord): RawRecord => ({
      _id: newId(),
      endpoint: 'openAI',
      title: record.conversationId,
      ...record,
    });
    const message = (record: RawRecord, index: number): RawRecord => ({
      _id: newId(),
      messageId: `message-${index}`,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: String(record.conversationId),
      ...record,
    });
    const keyOf = (record: RawRecord) =>
      `${record.user}|${record.tenantId ?? '-'}|${record.conversationId}`;

    describe('deleteImportedMessages and deleteImportedConversations', () => {
      it('remove only the scope owner, tenant and conversation ids, and refresh the projects', async () => {
        const project = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
          stores().chatProjects.createChatProject('owner-a', { name: 'Imported chats' }),
        );
        const chatProjectId = idOf(harness, project._id);
        const target = {
          user: 'owner-a',
          conversationId: 'generated-target',
          tenantId: 'tenant-a',
          chatProjectId,
        };
        const records = [
          target,
          { ...target, conversationId: 'untouched-id' },
          { ...target, user: 'owner-b' },
          { ...target, tenantId: 'tenant-b' },
        ];
        await harness.seedRaw(
          'conversations',
          records.map((record) => {
            const at = new Date(
              record.conversationId === target.conversationId
                ? '2026-02-01T00:00:00.000Z'
                : '2026-01-01T00:00:00.000Z',
            );
            return conversation({ ...record, createdAt: at, updatedAt: at });
          }),
        );
        await harness.seedRaw('messages', records.map(message));
        await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
          stores().chatProjects.assignConversationToProject(
            'owner-a',
            'generated-target',
            chatProjectId,
          ),
        );
        const before = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          stores().chatProjects.getChatProject('owner-a', chatProjectId),
        );
        expect(before).toMatchObject({
          conversationCount: 2,
          lastConversationId: 'generated-target',
        });

        const scope = {
          user: target.user,
          conversationIds: [target.conversationId],
          tenantId: target.tenantId,
        };
        await tenantStorage.run({ tenantId: target.tenantId, userId: target.user }, async () => {
          await stores().conversationImports.deleteImportedMessages(scope);
          await stores().conversationImports.deleteImportedConversations(scope);
        });

        const remainingConversations = (await harness.readRaw('conversations')).map(keyOf);
        const remainingMessages = (await harness.readRaw('messages')).map(keyOf);
        const removed = keyOf(target);
        expect(remainingConversations).toHaveLength(3);
        expect(remainingMessages).toHaveLength(3);
        expect(remainingConversations).not.toContain(removed);
        expect(remainingMessages).not.toContain(removed);
        const [storedProject] = await harness.readRaw('chatprojects');
        expect(storedProject).toMatchObject({
          conversationCount: 1,
          lastConversationId: 'untouched-id',
        });
      });

      it('match only the records stored without a tenant for a tenantless scope', async () => {
        const base = { user: 'owner-a', conversationId: 'generated-target' };
        await harness.seedRaw('conversations', [
          conversation({ ...base, title: 'tenantless' }),
          conversation({ ...base, tenantId: 'tenant-a', title: 'tenant' }),
        ]);
        await harness.seedRaw('messages', [
          message({ ...base, messageId: 'tenantless-message' }, 0),
          message({ ...base, tenantId: 'tenant-a', messageId: 'tenant-message' }, 1),
        ]);

        const scope = { user: base.user, conversationIds: [base.conversationId] };
        await stores().conversationImports.deleteImportedMessages(scope);
        await stores().conversationImports.deleteImportedConversations(scope);

        const conversations = await harness.readRaw('conversations');
        const messages = await harness.readRaw('messages');
        expect(conversations.map((record) => record.tenantId)).toEqual(['tenant-a']);
        expect(messages.map((record) => record.tenantId)).toEqual(['tenant-a']);
      });

      it('remove the subagent content of the removed conversations and nothing for no ids', async () => {
        const base = { user: 'owner-a', conversationId: 'child-thread' };
        const chunk = (conversationId: string, revision: number): RawRecord => ({
          _id: `${conversationId}-${revision}`,
          user: 'owner-a',
          parentConversationId: 'parent',
          conversationId,
          taskId: 'task',
          revision,
          fragment: -1,
          fragments: 0,
          fromSequence: 0,
          throughSequence: 0,
          digest: 'digest',
        });
        await harness.seedRaw('conversations', [conversation(base)]);
        await harness.seedRaw('messages', [message(base, 0)]);
        await harness.seedRaw('subagentcontents', [
          chunk('child-thread', 1),
          chunk('other-thread', 1),
        ]);

        await stores().conversationImports.deleteImportedMessages({
          user: 'owner-a',
          conversationIds: [],
        });
        await stores().conversationImports.deleteImportedConversations({
          user: 'owner-a',
          conversationIds: [],
        });
        expect(await harness.readRaw('messages')).toHaveLength(1);
        expect(await harness.readRaw('conversations')).toHaveLength(1);
        expect(await harness.readRaw('subagentcontents')).toHaveLength(2);

        await stores().conversationImports.deleteImportedMessages({
          user: 'owner-a',
          conversationIds: ['child-thread'],
        });
        expect(await harness.readRaw('messages')).toEqual([]);
        expect(
          (await harness.readRaw('subagentcontents')).map((record) => record.conversationId),
        ).toEqual(['other-thread']);
      });
    });
  });
}
