/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ToolCallStore` contract (`~/ports/toolCall`): creation (a hydrated document with
 * MongoDB, read here only through its fields), the per-conversation read and the deletes.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { idOf, useContractHarness } from './support';

export function describeToolCallContract(harness: ContractHarness): void {
  describe(`ToolCallStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userA = harness.ids.generate();
    const userB = harness.ids.generate();
    const toolCall = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      conversationId: 'convo-1',
      messageId: 'msg-1',
      toolId: 'tool-1',
      user: userA,
      ...overrides,
    });

    describe('createToolCall', () => {
      it('stores the call with its result and attachments, and resolves it with its id', async () => {
        const created = await harness.createStores().toolCalls.createToolCall({
          conversationId: 'convo-1',
          messageId: 'msg-1',
          toolId: 'execute_code',
          user: userA,
          result: { stdout: 'ok', nested: [1, 2] },
          attachments: [{ file_id: 'file-1', filename: 'out.txt' }],
          blockIndex: 0,
          partIndex: 2,
        });
        expect(created.messageId).toBe('msg-1');
        expect(created.toolId).toBe('execute_code');
        expect(idOf(harness, created.user)).toBe(userA);
        expect(created.result).toEqual({ stdout: 'ok', nested: [1, 2] });
        const [stored] = await harness.readRaw('toolcalls');
        expect(idOf(harness, created._id)).toBe(stored._id);
        expect(stored).toMatchObject({
          conversationId: 'convo-1',
          user: userA,
          result: { stdout: 'ok', nested: [1, 2] },
          attachments: [{ file_id: 'file-1', filename: 'out.txt' }],
          blockIndex: 0,
          partIndex: 2,
        });
        expect(stored.createdAt).toBeInstanceOf(Date);
      });

      it('throws an error naming the cause when the call is invalid', async () => {
        await expect(
          harness
            .createStores()
            .toolCalls.createToolCall({ conversationId: 'convo-1', user: userA }),
        ).rejects.toThrow(/^Error creating tool call: /);
        expect(await harness.readRaw('toolcalls')).toEqual([]);
      });
    });

    describe('getToolCallsByConvo', () => {
      it("returns the user's calls in the conversation as plain records with their ids", async () => {
        const first = toolCall({ toolId: 'a' });
        const second = toolCall({ toolId: 'b', messageId: 'msg-2' });
        await harness.seedRaw('toolcalls', [
          first,
          second,
          toolCall({ conversationId: 'convo-2' }),
          toolCall({ user: userB }),
        ]);
        const found = await harness.createStores().toolCalls.getToolCallsByConvo('convo-1', userA);
        expect(found.map((item) => idOf(harness, item._id)).sort()).toEqual(
          [first._id, second._id].sort(),
        );
        expect(found.map((item) => item.toolId).sort()).toEqual(['a', 'b']);
        expect(Object.getPrototypeOf(found[0])).toBe(Object.prototype);
      });

      it('returns an empty list when there are none', async () => {
        expect(
          await harness.createStores().toolCalls.getToolCallsByConvo('convo-1', userA),
        ).toEqual([]);
      });
    });

    describe('deleteToolCalls', () => {
      it("deletes the user's calls of one conversation when given", async () => {
        await harness.seedRaw('toolcalls', [
          toolCall(),
          toolCall({ conversationId: 'convo-2' }),
          toolCall({ user: userB }),
        ]);
        const result = await harness.createStores().toolCalls.deleteToolCalls(userA, 'convo-1');
        expect(result.deletedCount).toBe(1);
        const remaining = await harness.readRaw('toolcalls');
        expect(remaining.map(({ conversationId, user }) => ({ conversationId, user }))).toEqual(
          expect.arrayContaining([
            { conversationId: 'convo-2', user: userA },
            { conversationId: 'convo-1', user: userB },
          ]),
        );
        expect(remaining).toHaveLength(2);
      });

      it('deletes every call of the user without a conversation, and counts them', async () => {
        await harness.seedRaw('toolcalls', [
          toolCall(),
          toolCall({ conversationId: 'convo-2' }),
          toolCall({ user: userB }),
        ]);
        const result = await harness.createStores().toolCalls.deleteToolCalls(userA);
        expect(result.deletedCount).toBe(2);
        expect(await harness.readRaw('toolcalls')).toHaveLength(1);
      });
    });
  });
}
