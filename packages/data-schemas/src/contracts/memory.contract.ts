/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `MemoryStore` contract (`~/ports/memory`), ported from `methods/memory.spec.ts`: keyed
 * memories per user and partition (the shared personal pool, legacy entries without an agent,
 * agent partitions), the by-id updates and deletes, the prompt formatting and the account wipe.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, useContractHarness } from './support';

export function describeMemoryContract(harness: ContractHarness): void {
  describe(`MemoryStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const agentId = 'agent_a';
    const otherAgentId = 'agent_b';
    const entriesOf = (user: string) => readRawWhere(harness, 'memoryentries', { userId: user });

    describe('setMemory', () => {
      it('writes to the shared personal pool when agentId is omitted', async () => {
        const { memories } = harness.createStores();
        expect(
          await memories.setMemory({ userId, key: 'context', value: 'personal', tokenCount: 3 }),
        ).toEqual({ ok: true });
        const [stored] = await entriesOf(userId);
        expect(stored).toMatchObject({ key: 'context', value: 'personal', tokenCount: 3 });
        expect(stored.agentId == null).toBe(true);
        expect(stored.updated_at).toBeInstanceOf(Date);
      });

      it('replaces within a partition instead of duplicating, and isolates partitions', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'context', value: 'personal', tokenCount: 1 });
        await memories.setMemory({ userId, key: 'context', value: 'agent a', agentId });
        await memories.setMemory({ userId, key: 'context', value: 'agent a 2', agentId });
        const stored = await entriesOf(userId);
        expect(stored).toHaveLength(2);
        expect((await memories.getUserMemories({ userId, agentId }))[0]).toMatchObject({
          value: 'agent a 2',
          tokenCount: 0,
        });
        expect((await memories.getUserMemories({ userId }))[0].value).toBe('personal');
      });

      it('treats a legacy entry without an agentId as the personal pool', async () => {
        await harness.seedRaw('memoryentries', [
          {
            _id: harness.ids.generate(),
            userId,
            key: 'legacy',
            value: 'pre-partition entry',
            tokenCount: 4,
            updated_at: new Date(),
          },
        ]);
        const { memories } = harness.createStores();
        expect((await memories.getUserMemories({ userId })).map((memory) => memory.key)).toEqual([
          'legacy',
        ]);
        await memories.setMemory({ userId, key: 'legacy', value: 'updated', tokenCount: 4 });
        const stored = await entriesOf(userId);
        expect(stored).toHaveLength(1);
        expect(stored[0].value).toBe('updated');
      });

      it("refuses the key 'nothing' in any case", async () => {
        expect(
          await harness
            .createStores()
            .memories.setMemory({ userId, key: 'NOTHING', value: 'skip' }),
        ).toEqual({ ok: false });
        expect(await harness.readRaw('memoryentries')).toEqual([]);
      });

      it('stores a key the schema validator would refuse', async () => {
        // NOTE(contract): `setMemory` and `createMemory` write without validators, so a key
        // outside `^[a-z_]+$` is stored, while `setMemoryById` (validated) refuses it. Pinned
        // as today's behavior; callers validate keys before writing.
        await harness
          .createStores()
          .memories.setMemory({ userId, key: 'Not-Valid', value: 'stored anyway' });
        expect((await entriesOf(userId)).map((entry) => entry.key)).toEqual(['Not-Valid']);
      });
    });

    describe('createMemory', () => {
      it('creates the key, and throws when it exists in the same partition only', async () => {
        const { memories } = harness.createStores();
        expect(
          await memories.createMemory({ userId, key: 'context', value: 'personal', tokenCount: 1 }),
        ).toEqual({ ok: true });
        await expect(
          memories.createMemory({ userId, key: 'context', value: 'dupe', tokenCount: 1 }),
        ).rejects.toThrow('already exists');
        expect(
          await memories.createMemory({ userId, key: 'context', value: 'agent a', agentId }),
        ).toEqual({ ok: true });
        const stored = await entriesOf(userId);
        expect(stored).toHaveLength(2);
        expect(stored.find((entry) => entry.agentId === agentId)).toMatchObject({
          value: 'agent a',
          tokenCount: 0,
        });
      });

      it('never overwrites an existing entry under concurrent creates', async () => {
        const { memories } = harness.createStores();
        await memories.createMemory({ userId, key: 'context', value: 'original', tokenCount: 1 });
        const results = await Promise.allSettled([
          memories.createMemory({ userId, key: 'context', value: 'dupe 1', tokenCount: 9 }),
          memories.createMemory({ userId, key: 'context', value: 'dupe 2', tokenCount: 9 }),
        ]);
        expect(results.every((result) => result.status === 'rejected')).toBe(true);
        const stored = await entriesOf(userId);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ value: 'original', tokenCount: 1 });
      });

      it("refuses the key 'nothing'", async () => {
        expect(
          await harness
            .createStores()
            .memories.createMemory({ userId, key: 'nothing', value: 'x' }),
        ).toEqual({ ok: false });
        expect(await harness.readRaw('memoryentries')).toEqual([]);
      });
    });

    describe('deleteMemory', () => {
      it('deletes only within the targeted partition', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'context', value: 'personal', tokenCount: 1 });
        await memories.setMemory({ userId, key: 'context', value: 'agent a', agentId });
        expect(await memories.deleteMemory({ userId, key: 'context', agentId })).toEqual({
          ok: true,
        });
        expect(await memories.getUserMemories({ userId })).toHaveLength(1);
        expect(await memories.getUserMemories({ userId, agentId })).toHaveLength(0);
        expect(await memories.deleteMemory({ userId, key: 'context', agentId })).toEqual({
          ok: false,
        });
        expect(await memories.deleteMemory({ userId: otherUserId, key: 'context' })).toEqual({
          ok: false,
        });
        expect(await memories.getUserMemories({ userId })).toHaveLength(1);
      });
    });

    describe('setMemoryById', () => {
      it('updates by id only for the owning user and the selected partition', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'private_key', value: 'before', agentId });
        const [stored] = await memories.getUserMemories({ userId, agentId });
        const id = idOf(harness, stored._id);
        expect(
          await memories.setMemoryById({ userId: otherUserId, id, value: 'wrong', agentId }),
        ).toEqual({ ok: false });
        expect(
          await memories.setMemoryById({ userId, id, value: 'wrong', agentId: otherAgentId }),
        ).toEqual({ ok: false });
        expect(await memories.setMemoryById({ userId, id, value: 'wrong' })).toEqual({
          ok: false,
        });
        const result = await memories.setMemoryById({
          userId,
          id,
          value: 'after',
          tokenCount: 2,
          agentId,
        });
        expect(result).toMatchObject({
          ok: true,
          memory: { key: 'private_key', value: 'after', tokenCount: 2, agentId },
        });
        expect(idOf(harness, result.memory?._id)).toBe(id);
        expect(await memories.getUserMemories({ userId, agentId })).toHaveLength(1);
      });

      it('renames without duplicating, reporting a conflict with an existing key', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'first', value: 'one', agentId });
        await memories.setMemory({ userId, key: 'second', value: 'two', agentId });
        const first = (await memories.getUserMemories({ userId, agentId })).find(
          (memory) => memory.key === 'first',
        );
        const id = idOf(harness, first?._id);
        expect(
          await memories.setMemoryById({ userId, id, key: 'second', value: 'x', agentId }),
        ).toEqual({ ok: false, conflict: true });
        expect(
          await memories.setMemoryById({ userId, id, key: 'renamed', value: 'updated', agentId }),
        ).toMatchObject({ ok: true, memory: { key: 'renamed', value: 'updated', tokenCount: 0 } });
        const keys = (await entriesOf(userId)).map((entry) => entry.key).sort();
        expect(keys).toEqual(['renamed', 'second']);
      });

      it("resolves ok: false for an invalid id or the key 'nothing'", async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'kept', value: 'v' });
        const [stored] = await memories.getUserMemories({ userId });
        expect(await memories.setMemoryById({ userId, id: 'not-an-id', value: 'x' })).toEqual({
          ok: false,
        });
        expect(
          await memories.setMemoryById({
            userId,
            id: idOf(harness, stored._id),
            key: 'Nothing',
            value: 'x',
          }),
        ).toEqual({ ok: false });
        expect(
          await memories.setMemoryById({ userId, id: harness.ids.generate(), value: 'x' }),
        ).toEqual({ ok: false });
      });

      it('validates a renamed key and throws when it is invalid', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'kept', value: 'v' });
        const [stored] = await memories.getUserMemories({ userId });
        await expect(
          memories.setMemoryById({
            userId,
            id: idOf(harness, stored._id),
            key: 'Bad-Key',
            value: 'x',
          }),
        ).rejects.toThrow(/^Failed to update memory: /);
        expect((await entriesOf(userId))[0]).toMatchObject({ key: 'kept', value: 'v' });
      });

      it('updates only in the owning tenant', async () => {
        const { memories } = harness.createStores();
        const id = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
          await memories.setMemory({ userId, key: 'private_key', value: 'stored', agentId });
          return idOf(harness, (await memories.getUserMemories({ userId, agentId }))[0]._id);
        });
        expect(
          await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
            memories.setMemoryById({ userId, id, value: 'wrong tenant', agentId }),
          ),
        ).toEqual({ ok: false });
        expect((await entriesOf(userId))[0]).toMatchObject({
          value: 'stored',
          tenantId: 'tenant-a',
        });
      });
    });

    describe('deleteMemoryById', () => {
      it('deletes by id only for the owner, partition and tenant', async () => {
        const { memories } = harness.createStores();
        const id = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
          await memories.setMemory({ userId, key: 'private_key', value: 'stored', agentId });
          return idOf(harness, (await memories.getUserMemories({ userId, agentId }))[0]._id);
        });
        const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
          tenantStorage.run({ tenantId }, run);
        expect(
          await inTenant('tenant-b', () => memories.deleteMemoryById({ userId, id, agentId })),
        ).toEqual({ ok: false });
        expect(
          await inTenant('tenant-a', () =>
            memories.deleteMemoryById({ userId: otherUserId, id, agentId }),
          ),
        ).toEqual({ ok: false });
        expect(
          await inTenant('tenant-a', () =>
            memories.deleteMemoryById({ userId, id, agentId: otherAgentId }),
          ),
        ).toEqual({ ok: false });
        expect(await memories.deleteMemoryById({ userId, id: 'not-an-id', agentId })).toEqual({
          ok: false,
        });
        expect(await harness.readRaw('memoryentries')).toHaveLength(1);
        expect(
          await inTenant('tenant-a', () => memories.deleteMemoryById({ userId, id, agentId })),
        ).toEqual({ ok: true });
        expect(await harness.readRaw('memoryentries')).toEqual([]);
      });
    });

    describe('getUserMemories', () => {
      it("returns only the partition's memories of the user", async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'one', value: 'personal' });
        await memories.setMemory({ userId, key: 'two', value: 'agent', agentId });
        await memories.setMemory({ userId: otherUserId, key: 'three', value: 'other' });
        expect((await memories.getUserMemories({ userId })).map((memory) => memory.key)).toEqual([
          'one',
        ]);
        const agentMemories = await memories.getUserMemories({ userId, agentId });
        expect(agentMemories.map((memory) => memory.key)).toEqual(['two']);
        expect(idOf(harness, agentMemories[0].userId)).toBe(userId);
      });
    });

    describe('getAllUserMemories', () => {
      it('returns every partition of the user', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'one', value: 'personal' });
        await memories.setMemory({ userId, key: 'two', value: 'agent', agentId });
        await memories.setMemory({ userId: otherUserId, key: 'three', value: 'other' });
        const all = await memories.getAllUserMemories(userId);
        expect(all.map((memory) => memory.key).sort()).toEqual(['one', 'two']);
      });
    });

    describe('getFormattedMemories', () => {
      it('formats the partition oldest update first, with partition-scoped totals', async () => {
        await harness.seedRaw('memoryentries', [
          {
            _id: harness.ids.generate(),
            userId,
            key: 'newer',
            value: 'second value',
            tokenCount: 5,
            updated_at: new Date('2024-02-03T10:00:00.000Z'),
          },
          {
            _id: harness.ids.generate(),
            userId,
            key: 'older',
            value: 'first value',
            tokenCount: 0,
            updated_at: new Date('2024-01-02T10:00:00.000Z'),
          },
          {
            _id: harness.ids.generate(),
            userId,
            key: 'agent_only',
            value: 'agent value',
            tokenCount: 7,
            agentId,
            updated_at: new Date('2024-01-01T10:00:00.000Z'),
          },
        ]);
        const { memories } = harness.createStores();
        const personal = await memories.getFormattedMemories({ userId });
        expect(personal).toEqual({
          withKeys:
            '1. [2024-01-02]. ["key": "older"]. ["value": "first value"]\n\n' +
            '2. [2024-02-03]. ["key": "newer"] [5 tokens]. ["value": "second value"]',
          withoutKeys: '1. [2024-01-02]. first value\n\n2. [2024-02-03]. second value',
          totalTokens: 5,
          tokenCountsByKey: new Map([
            ['older', 0],
            ['newer', 5],
          ]),
        });
        const partition = await memories.getFormattedMemories({ userId, agentId });
        expect(partition.totalTokens).toBe(7);
        expect(partition.tokenCountsByKey).toEqual(new Map([['agent_only', 7]]));
        expect(partition.withKeys).not.toContain('first value');
      });

      it('formats an empty partition as empty text, not as a read failure', async () => {
        expect(await harness.createStores().memories.getFormattedMemories({ userId })).toEqual({
          withKeys: '',
          withoutKeys: '',
          totalTokens: 0,
          tokenCountsByKey: new Map(),
        });
      });

      it('signals a failed read instead of throwing', async () => {
        const result = await harness
          .createStores()
          .memories.getFormattedMemories({ userId: 'not-an-id' });
        expect(result).toEqual({
          withKeys: undefined,
          withoutKeys: undefined,
          totalTokens: 0,
          tokenCountsByKey: new Map(),
          readFailed: true,
        });
      });
    });

    describe('deleteAllUserMemories', () => {
      it('wipes every partition of the user, counts them, and keeps other users', async () => {
        const { memories } = harness.createStores();
        await memories.setMemory({ userId, key: 'one', value: 'personal' });
        await memories.setMemory({ userId, key: 'two', value: 'agent', agentId });
        await memories.setMemory({ userId: otherUserId, key: 'three', value: 'other' });
        expect(await memories.deleteAllUserMemories(userId)).toBe(2);
        expect(await memories.getAllUserMemories(userId)).toEqual([]);
        expect(await memories.getAllUserMemories(otherUserId)).toHaveLength(1);
        expect(await memories.deleteAllUserMemories(userId)).toBe(0);
      });
    });
  });
}
