/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `CheckpointStore` contract (`~/ports/checkpointStore`), ported from
 * `adapters/mongo/checkpointStore.spec.ts`: the checkpoint store a backend serves through
 * `DataStoreBackend.getCheckpointStore`, on every backend. These cases cover the operations on
 * stored rows (generations, owners, exact references, payload probes), the storage descriptors,
 * the deletion intents and the conversation evidence; the saver `createSaver` builds has its own
 * suite (`checkpointStore.saver.contract.ts`). Where the rows are kept is each backend's own
 * business: the cases seed and read their identity through the harness. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import type { CheckpointContractHarness, CheckpointIdentityRow } from './checkpoint';
import type { CheckpointReference, OwnedCheckpointReference } from '~/ports/checkpointStore';
import {
  checkpointStorageKey,
  CHECKPOINT_STORE_METHODS,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from '~/ports/checkpointStore';
import { useCheckpointHarness } from './checkpoint';

const STORAGE = {
  checkpointCollectionName: 'cp',
  checkpointWritesCollectionName: 'cp_writes',
};
const OTHER_STORAGE = {
  checkpointCollectionName: 'cp_other',
  checkpointWritesCollectionName: 'cp_other_writes',
};
const SETTINGS = { type: 'mongo' as const, ttlSeconds: 60, ...STORAGE };
const OWNER = `lcg:v2:${'a'.repeat(64)}:`;
const OTHER = `lcg:v2:${'b'.repeat(64)}:`;
/** The storage descriptor collection and the deletion intent collection (tables on PostgreSQL). */
const DESCRIPTORS = 'agent_checkpoint_stores';
const DELETIONS = 'agent_checkpoint_deletions';

export function describeCheckpointStoreContract(harness: CheckpointContractHarness): void {
  describe(`CheckpointStore contract: ${harness.name}`, () => {
    useCheckpointHarness(harness);

    const store = () => harness.store();

    async function insertBoth(rows: CheckpointIdentityRow[], storage = STORAGE) {
      await harness.seedCheckpointRows(storage, 'checkpoints', rows);
      await harness.seedCheckpointRows(storage, 'writes', rows);
    }

    async function checkpointIds(
      kind: 'checkpoints' | 'writes' = 'checkpoints',
      storage = STORAGE,
    ) {
      const rows = await harness.readCheckpointRows(storage, kind);
      return rows.map((row) => row.checkpoint_id).sort();
    }

    async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
      const items: T[] = [];
      for await (const item of iterable) {
        items.push(item);
      }
      return items;
    }

    describe('the store', () => {
      it('has every port method, each listed once, and is connected', () => {
        expect(Object.keys(store()).sort()).toEqual([...CHECKPOINT_STORE_METHODS].sort());
        expect(new Set(CHECKPOINT_STORE_METHODS).size).toBe(CHECKPOINT_STORE_METHODS.length);
        expect(store().isConnected()).toBe(true);
      });

      it('is null while the database is not connected', () => {
        expect(harness.disconnectedStore()).toBeNull();
      });

      it('builds a saver, again on the same storage, and on another storage', async () => {
        const saver = await store().createSaver(SETTINGS);
        for (const method of ['getTuple', 'list', 'put', 'putWrites'] as const) {
          expect(typeof saver[method]).toBe('function');
        }
        await expect(store().createSaver(SETTINGS)).resolves.toBeDefined();
        await expect(
          store().createSaver({ ...OTHER_STORAGE, ttlSeconds: 60 }),
        ).resolves.toBeDefined();
      });
    });

    describe('storage descriptors', () => {
      it('records the storage descriptor of an owned write and lists and deletes it', async () => {
        const saver = await store().createSaver(SETTINGS);
        const checkpoint = emptyCheckpoint();
        const config = {
          configurable: {
            thread_id: 'thread',
            checkpoint_ns: 'event-actor/x',
            checkpoint_id: checkpoint.id,
            [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
          },
        };
        await saver.putWrites(config, [[INTERRUPT, 'approve?']], 'task');
        const key = checkpointStorageKey({ type: 'mongo', ...STORAGE });
        expect(await harness.readRaw(DESCRIPTORS)).toEqual([
          { _id: `${OWNER}${key}`, owner: OWNER, storage: { type: 'mongo', ...STORAGE } },
        ]);
        expect(await store().listStorageDescriptors([OWNER])).toEqual([
          { type: 'mongo', ...STORAGE },
        ]);
        expect(await store().listStorageDescriptors([OTHER])).toEqual([]);
        await store().deleteStorageDescriptors([`${OWNER}${key}`]);
        expect(await store().listStorageDescriptors([OWNER])).toEqual([]);
      });

      it('records one descriptor per owner and storage, from the namespace or the storage owner key', async () => {
        const saver = await store().createSaver(SETTINGS);
        const other = await store().createSaver({ ...OTHER_STORAGE, ttlSeconds: 60 });
        const write = (configurable: Record<string, unknown>, target = saver) =>
          target.putWrites(
            {
              configurable: {
                thread_id: 't',
                checkpoint_id: emptyCheckpoint().id,
                ...configurable,
              },
            },
            [[INTERRUPT, 'approve?']],
            'task',
          );
        await write({ checkpoint_ns: `${OWNER}event-actor/x` });
        await write({ checkpoint_ns: `${OWNER}event-actor/y` });
        await write({ checkpoint_ns: '', [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]: OTHER });
        await write({ checkpoint_ns: `${OWNER}event-actor/x` }, other);
        /** Neither an owner prefix nor an owner key: nothing is recorded. */
        await write({ checkpoint_ns: 'plain' });
        await write({
          checkpoint_ns: '',
          [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]: 'not-an-owner',
        });

        const ids = (await harness.readRaw(DESCRIPTORS)).map((record) => record._id).sort();
        const key = checkpointStorageKey({ type: 'mongo', ...STORAGE });
        const otherKey = checkpointStorageKey({ type: 'mongo', ...OTHER_STORAGE });
        expect(ids).toEqual([`${OWNER}${key}`, `${OWNER}${otherKey}`, `${OTHER}${key}`].sort());
        const byName = (storages: Array<{ checkpointCollectionName: string }>) =>
          [...storages].sort((a, b) =>
            a.checkpointCollectionName.localeCompare(b.checkpointCollectionName),
          );
        expect(byName(await store().listStorageDescriptors([OWNER]))).toEqual([
          { type: 'mongo', ...STORAGE },
          { type: 'mongo', ...OTHER_STORAGE },
        ]);
        expect(byName(await store().listStorageDescriptors([OWNER, OTHER]))).toHaveLength(3);

        await store().deleteStorageDescriptors([`${OWNER}${key}`, `${OTHER}${key}`]);
        expect(await store().listStorageDescriptors([OWNER, OTHER])).toEqual([
          { type: 'mongo', ...OTHER_STORAGE },
        ]);
        await store().deleteStorageDescriptors([]);
        expect(await harness.readRaw(DESCRIPTORS)).toHaveLength(1);
      });
    });

    describe('generations', () => {
      it('lists and deletes a generation by namespace prefix, or the legacy rows', async () => {
        await insertBoth([
          { thread_id: 't', checkpoint_ns: 'gen', checkpoint_id: 'root' },
          { thread_id: 't', checkpoint_ns: 'gen|child', checkpoint_id: 'nested' },
          { thread_id: 't', checkpoint_ns: 'generation', checkpoint_id: 'sibling' },
          { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'legacy' },
          { thread_id: 't', checkpoint_ns: `${OWNER}x`, checkpoint_id: 'owned-ns' },
          { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'owned', lc_owner: OWNER },
          { thread_id: 'u', checkpoint_ns: 'gen', checkpoint_id: 'other-thread' },
        ]);
        const scope = { threadId: 't', namespace: 'gen' };
        expect((await store().listGenerationCheckpointIds(STORAGE, scope)).sort()).toEqual([
          'nested',
          'root',
        ]);
        expect(
          (await store().listGenerationCheckpointIds(STORAGE, { threadId: 't' })).sort(),
        ).toEqual(['legacy', 'nested', 'root', 'sibling']);

        await store().deleteGenerationCheckpoints(STORAGE, scope, ['nested']);
        expect(await checkpointIds()).not.toContain('nested');
        expect(await checkpointIds()).toContain('root');
        await store().deleteGenerationCheckpoints(STORAGE, { threadId: 't' });
        expect(await checkpointIds()).toEqual(['other-thread', 'owned', 'owned-ns']);
        expect(await checkpointIds('writes')).toEqual(['other-thread', 'owned', 'owned-ns']);
      });

      it('takes the namespace literally, and deletes a whole generation without ids', async () => {
        await insertBoth([
          { thread_id: 't', checkpoint_ns: 'g.n', checkpoint_id: 'dot' },
          { thread_id: 't', checkpoint_ns: 'g.n|child', checkpoint_id: 'dot-child' },
          { thread_id: 't', checkpoint_ns: 'gxn', checkpoint_id: 'any-char' },
          { thread_id: 't', checkpoint_ns: 'g.nx', checkpoint_id: 'longer' },
        ]);
        expect(
          (
            await store().listGenerationCheckpointIds(STORAGE, { threadId: 't', namespace: 'g.n' })
          ).sort(),
        ).toEqual(['dot', 'dot-child']);
        await store().deleteGenerationCheckpoints(STORAGE, { threadId: 't', namespace: 'g.n' });
        expect(await checkpointIds()).toEqual(['any-char', 'longer']);
        expect(await checkpointIds('writes')).toEqual(['any-char', 'longer']);
      });

      it('lists nothing for an unknown thread or a storage never written', async () => {
        expect(await store().listGenerationCheckpointIds(STORAGE, { threadId: 'none' })).toEqual(
          [],
        );
        expect(
          await store().listGenerationCheckpointIds(OTHER_STORAGE, {
            threadId: 't',
            namespace: 'g',
          }),
        ).toEqual([]);
        await expect(
          store().deleteGenerationCheckpoints(OTHER_STORAGE, { threadId: 't' }),
        ).resolves.toBeUndefined();
      });
    });

    describe('owned rows', () => {
      it('deletes owned rows by namespace, by owner, and exact references', async () => {
        await insertBoth([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'a',
            lc_owner: OWNER,
          },
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}ns|x`,
            checkpoint_id: 'b',
            lc_owner: OWNER,
          },
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}other`,
            checkpoint_id: 'c',
            lc_owner: OWNER,
          },
          { thread_id: 't', checkpoint_ns: `${OWNER}legacy`, checkpoint_id: 'd' },
          { thread_id: 't', checkpoint_ns: 'plain', checkpoint_id: 'e' },
          { thread_id: 't', checkpoint_ns: 'plain', checkpoint_id: 'f', lc_owner: OTHER },
        ]);
        await store().deleteOwnedNamespace(STORAGE, OWNER, 't', 'ns');
        expect(await checkpointIds()).toEqual(['c', 'd', 'e', 'f']);

        await store().deleteCheckpointReference(STORAGE, {
          threadId: 't',
          checkpointNs: 'plain',
          checkpointId: 'f',
        });
        expect(await checkpointIds()).toContain('f');
        await store().deleteCheckpointReference(
          STORAGE,
          { threadId: 't', checkpointNs: 'plain', checkpointId: 'e' },
          OWNER,
        );
        expect(await checkpointIds()).toEqual(['c', 'd', 'f']);

        await store().deleteOwnerCheckpoints(STORAGE, OWNER, ['t']);
        expect(await checkpointIds()).toEqual(['f']);
        expect(await checkpointIds('writes')).toEqual(['f']);

        await store().deleteCheckpointReferences(
          STORAGE,
          [{ threadId: 't', checkpointNs: 'plain', checkpointId: 'f' }],
          OTHER,
        );
        expect(await checkpointIds()).toEqual([]);
      });

      it('deletes an owned namespace only for its owner and thread', async () => {
        await insertBoth([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'mine',
            lc_owner: OWNER,
          },
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}nsx`,
            checkpoint_id: 'longer',
            lc_owner: OWNER,
          },
          {
            thread_id: `${OWNER}u`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'thread-u',
            lc_owner: OWNER,
          },
          { thread_id: `${OWNER}t`, checkpoint_ns: `${OWNER}ns`, checkpoint_id: 'unrecorded' },
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'other',
            lc_owner: OTHER,
          },
        ]);
        await store().deleteOwnedNamespace(STORAGE, OWNER, 't', 'ns');
        expect(await checkpointIds()).toEqual(['longer', 'other', 'thread-u', 'unrecorded']);
        expect(await checkpointIds('writes')).toEqual([
          'longer',
          'other',
          'thread-u',
          'unrecorded',
        ]);
      });

      it('deletes every row of an owner across threads, by recorded owner or owned namespace', async () => {
        await insertBoth([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}a`,
            checkpoint_id: '1',
            lc_owner: OWNER,
          },
          {
            thread_id: `${OWNER}u`,
            checkpoint_ns: `${OWNER}b`,
            checkpoint_id: '2',
            lc_owner: OWNER,
          },
          { thread_id: 'v', checkpoint_ns: `${OWNER}c`, checkpoint_id: '3' },
          { thread_id: 'w', checkpoint_ns: 'plain', checkpoint_id: '4', lc_owner: OWNER },
          { thread_id: 'x', checkpoint_ns: 'plain', checkpoint_id: '5' },
          {
            thread_id: `${OTHER}t`,
            checkpoint_ns: `${OTHER}a`,
            checkpoint_id: '6',
            lc_owner: OTHER,
          },
        ]);
        await store().deleteOwnerCheckpoints(STORAGE, OWNER, ['u', 'v']);
        expect(await checkpointIds()).toEqual(['1', '4', '5', '6']);
        await store().deleteOwnerCheckpoints(STORAGE, OWNER);
        expect(await checkpointIds()).toEqual(['5', '6']);
        expect(await checkpointIds('writes')).toEqual(['5', '6']);
        await store().deleteOwnerCheckpoints(STORAGE, OTHER, []);
        expect(await checkpointIds()).toEqual(['5', '6']);
      });

      it('deletes exact references in batches, unowned or owned by the owner only', async () => {
        const references: CheckpointReference[] = [];
        const rows: CheckpointIdentityRow[] = [];
        for (let index = 0; index < 300; index += 1) {
          const checkpointId = `r${String(index).padStart(3, '0')}`;
          references.push({ threadId: 't', checkpointNs: 'ns', checkpointId });
          const owner = [undefined, OWNER, OTHER][index % 3];
          rows.push({
            thread_id: 't',
            checkpoint_ns: 'ns',
            checkpoint_id: checkpointId,
            ...(owner ? { lc_owner: owner } : {}),
          });
        }
        rows.push({ thread_id: 't', checkpoint_ns: 'ns', checkpoint_id: 'kept' });
        await insertBoth(rows);
        await store().deleteCheckpointReferences(STORAGE, references, OWNER);
        const kept = rows
          .filter((row) => row.lc_owner === OTHER || row.checkpoint_id === 'kept')
          .map((row) => row.checkpoint_id)
          .sort();
        expect(await checkpointIds()).toEqual(kept);
        expect(await checkpointIds('writes')).toEqual(kept);
        await expect(
          store().deleteCheckpointReferences(STORAGE, [], OWNER),
        ).resolves.toBeUndefined();
      });

      it('lists owned references by conversation and finds remaining payload', async () => {
        await insertBoth([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'a',
            lc_owner: OWNER,
          },
          { thread_id: 't', checkpoint_ns: `${OWNER}ns`, checkpoint_id: 'b' },
          { thread_id: 'u', checkpoint_ns: 'plain', checkpoint_id: 'c', lc_owner: OTHER },
        ]);
        const references = await collect(
          store().listOwnedCheckpointReferences(STORAGE, [OWNER], ['t']),
        );
        expect(references).toHaveLength(4);
        expect(new Set(references.map((reference) => reference.conversationId))).toEqual(
          new Set(['t']),
        );
        expect(references).toContainEqual({
          conversationId: 't',
          checkpoint: { threadId: `${OWNER}t`, checkpointNs: `${OWNER}ns`, checkpointId: 'a' },
        });

        expect(await store().hasCheckpointPayload(STORAGE, [OWNER], 't')).toBe(true);
        expect(await store().hasCheckpointPayload(STORAGE, [OWNER], 'u')).toBe(false);
        expect(
          await store().hasCheckpointPayload(STORAGE, [OTHER], 'none', {
            threadId: 'u',
            checkpointNs: 'plain',
            checkpointId: 'c',
          }),
        ).toBe(true);
      });

      it('lists every owned reference without conversations, mapping owned threads back', async () => {
        await insertBoth([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'a',
            lc_owner: OWNER,
          },
          {
            thread_id: `${OTHER}u`,
            checkpoint_ns: `${OTHER}ns`,
            checkpoint_id: 'b',
            lc_owner: OTHER,
          },
          { thread_id: 'v', checkpoint_ns: `${OWNER}ns`, checkpoint_id: 'c' },
          { thread_id: 'w', checkpoint_ns: 'plain', checkpoint_id: 'd' },
        ]);
        await harness.seedCheckpointRows(STORAGE, 'writes', [
          {
            thread_id: `${OWNER}x`,
            checkpoint_ns: `${OWNER}ns`,
            checkpoint_id: 'e',
            lc_owner: OWNER,
          },
        ]);
        const key = (reference: OwnedCheckpointReference) =>
          `${reference.conversationId}/${reference.checkpoint.checkpointId}`;
        const listed = await collect(
          store().listOwnedCheckpointReferences(STORAGE, [OWNER, OTHER]),
        );
        expect(listed.map(key).sort()).toEqual(['t/a', 't/a', 'u/b', 'u/b', 'v/c', 'v/c', 'x/e']);
        expect(
          (await collect(store().listOwnedCheckpointReferences(STORAGE, [OWNER]))).map(key).sort(),
        ).toEqual(['t/a', 't/a', 'v/c', 'v/c', 'x/e']);
        expect(
          (await collect(store().listOwnedCheckpointReferences(STORAGE, [OWNER], ['x', 'w']))).map(
            key,
          ),
        ).toEqual(['x/e']);
        expect(await collect(store().listOwnedCheckpointReferences(STORAGE, [OWNER], []))).toEqual(
          [],
        );
      });

      it('finds payload by owned thread, by owned namespace, or by an exact unowned reference', async () => {
        await harness.seedCheckpointRows(STORAGE, 'writes', [
          { thread_id: `${OWNER}t`, checkpoint_ns: 'plain', checkpoint_id: 'a', lc_owner: OWNER },
        ]);
        await harness.seedCheckpointRows(STORAGE, 'checkpoints', [
          { thread_id: 'u', checkpoint_ns: `${OTHER}ns`, checkpoint_id: 'b' },
          { thread_id: 'v', checkpoint_ns: 'plain', checkpoint_id: 'c', lc_owner: OTHER },
          { thread_id: 'w', checkpoint_ns: 'plain', checkpoint_id: 'd' },
        ]);
        expect(await store().hasCheckpointPayload(STORAGE, [OWNER], 't')).toBe(true);
        expect(await store().hasCheckpointPayload(STORAGE, [OTHER], 't')).toBe(false);
        expect(await store().hasCheckpointPayload(STORAGE, [OTHER], 'u')).toBe(true);
        expect(await store().hasCheckpointPayload(STORAGE, [OWNER, OTHER], 'u')).toBe(true);
        expect(await store().hasCheckpointPayload(STORAGE, [OWNER], 'v')).toBe(false);
        const unowned = { threadId: 'w', checkpointNs: 'plain', checkpointId: 'd' };
        expect(await store().hasCheckpointPayload(STORAGE, [OWNER], 'none', unowned)).toBe(true);
        const owned = { threadId: 'v', checkpointNs: 'plain', checkpointId: 'c' };
        expect(await store().hasCheckpointPayload(STORAGE, [OWNER], 'none', owned)).toBe(false);
        expect(await store().hasCheckpointPayload(STORAGE, [OTHER], 'none', owned)).toBe(true);
        expect(await store().hasCheckpointPayload(OTHER_STORAGE, [OWNER], 't')).toBe(false);
      });
    });

    describe('deletion intents', () => {
      it('records, finds and removes deletion intents by version', async () => {
        const intent = { id: `${OWNER}k:1`, threadId: 't', storage: SETTINGS };
        const reference = { threadId: 't', checkpointNs: 'ns', checkpointId: 'c' };
        await store().saveDeletionIntents('v1', 'user', undefined, [
          intent,
          { ...intent, id: `${OWNER}k:2`, checkpoint: reference },
          { ...intent, id: `${OTHER}k:3` },
        ]);
        const byId = (intents: Array<{ id: string }>) =>
          [...intents].sort((a, b) => a.id.localeCompare(b.id));
        expect(byId(await store().findDeletionIntents([`${OWNER}[0-9a-z]:`]))).toEqual([
          expect.objectContaining({ id: `${OWNER}k:1`, version: 'v1', userId: 'user' }),
          expect.objectContaining({ id: `${OWNER}k:2`, checkpoint: reference }),
        ]);
        expect(await store().hasDeletionIntent([OTHER])).toBe(true);
        /** Saved without a tenant: none is read back. */
        expect((await store().findDeletionIntents([OTHER]))[0].tenantId ?? null).toBeNull();

        await store().saveDeletionIntents('v2', 'user', undefined, [
          { ...intent, id: `${OWNER}k:2` },
        ]);
        const second = (await store().findDeletionIntents([OWNER])).find(
          ({ id }) => id === `${OWNER}k:2`,
        );
        expect(second).toMatchObject({ version: 'v2', checkpoint: reference });

        await store().deleteDeletionIntents([
          { id: `${OWNER}k:1`, version: 'v1' },
          { id: `${OWNER}k:2`, version: 'v1' },
        ]);
        expect((await store().findDeletionIntents([OWNER])).map(({ id }) => id)).toEqual([
          `${OWNER}k:2`,
        ]);

        const page = await store().listDeletionIntents(undefined, 1);
        expect(page.map(({ id }) => id)).toEqual([`${OWNER}k:2`]);
        expect((await store().listDeletionIntents(page[0].id, 5)).map(({ id }) => id)).toEqual([
          `${OTHER}k:3`,
        ]);
        expect(await store().deleteDeletionIntent(`${OTHER}k:3`, 'v2')).toBe(0);
        expect(await store().deleteDeletionIntent(`${OTHER}k:3`, 'v1')).toBe(1);
        expect(await harness.readRaw(DELETIONS)).toHaveLength(1);
      });

      it('reads an intent back with every recorded field, and replaces them by id', async () => {
        const reference = { threadId: 't', checkpointNs: 'ns', checkpointId: 'c' };
        await store().saveDeletionIntents('v1', 'user-1', 'tenant-1', [
          { id: `${OWNER}k`, threadId: 't', storage: SETTINGS, checkpoint: reference },
        ]);
        expect(await store().findDeletionIntents([OWNER])).toEqual([
          {
            id: `${OWNER}k`,
            version: 'v1',
            threadId: 't',
            userId: 'user-1',
            tenantId: 'tenant-1',
            storage: SETTINGS,
            checkpoint: reference,
          },
        ]);
        const storage = { ...SETTINGS, ...OTHER_STORAGE, ttlSeconds: 120 };
        await store().saveDeletionIntents('v2', 'user-2', 'tenant-2', [
          { id: `${OWNER}k`, threadId: 'u', storage },
        ]);
        expect(await store().findDeletionIntents([OWNER])).toEqual([
          {
            id: `${OWNER}k`,
            version: 'v2',
            threadId: 'u',
            userId: 'user-2',
            tenantId: 'tenant-2',
            storage,
            checkpoint: reference,
          },
        ]);
        expect(await store().listDeletionIntents(undefined, 10)).toHaveLength(1);
      });

      it('pages intents in id order', async () => {
        expect(await store().listDeletionIntents(undefined, 10)).toEqual([]);
        expect(await store().hasDeletionIntent([OWNER])).toBe(false);
        expect(await store().findDeletionIntents([OWNER])).toEqual([]);

        const ids = ['c', 'a', 'e', 'b', 'd'].map((suffix) => `${OWNER}${suffix}`);
        await store().saveDeletionIntents(
          'v1',
          'user',
          undefined,
          ids.map((id) => ({ id, threadId: 't', storage: SETTINGS })),
        );
        const first = await store().listDeletionIntents(undefined, 2);
        const second = await store().listDeletionIntents(first[1].id, 2);
        const third = await store().listDeletionIntents(second[1].id, 2);
        expect([...first, ...second, ...third].map(({ id }) => id)).toEqual([...ids].sort());
        expect(third).toHaveLength(1);
        expect(await store().listDeletionIntents(third[0].id, 2)).toEqual([]);

        expect(await store().listDeletionIntents(undefined, 10)).toHaveLength(5);
        expect(await store().deleteDeletionIntent(`${OWNER}none`, 'v1')).toBe(0);
      });
    });

    describe('conversation evidence', () => {
      it('reads conversation evidence and the actor cleanup list', async () => {
        const userId = harness.generateId();
        expect(await store().hasConversationRecords(userId, 'c')).toBe(false);
        await harness.seedRaw('toolcalls', [
          { _id: harness.generateId(), user: userId, conversationId: 'c' },
        ]);
        expect(await store().hasConversationRecords(userId, 'c')).toBe(true);
        expect(await store().hasConversation(userId, 'c')).toBe(false);

        const reference = { threadId: 'c', checkpointNs: 'event-actor/a', checkpointId: '1' };
        await harness.seedRaw('conversations', [
          {
            _id: harness.generateId(),
            user: userId,
            tenantId: null,
            conversationId: 'c',
            subagentThread: { parentConversationId: 'p' },
            agentEventActor: { checkpoint: reference },
            agentEventActorCleanup: [reference],
          },
        ]);
        expect(await store().hasConversation(userId, 'c')).toBe(true);
        expect(await store().getActorCleanup(userId, undefined, 'c')).toEqual([reference]);
        expect(await store().getActorCleanup(userId, 'tenant', 'c')).toEqual([]);

        const history = await collect(store().findActorHistory(userId, 'tenant', ['c']));
        expect(history).toEqual([
          expect.objectContaining({
            conversationId: 'c',
            agentEventActor: { checkpoint: reference },
            agentEventActorCleanup: [reference],
          }),
        ]);

        await store().pullActorCleanup(userId, undefined, 'c', reference);
        expect(await store().getActorCleanup(userId, undefined, 'c')).toEqual([]);
      });

      it('finds records of the conversation in messages, tool calls or shared links, for the user only', async () => {
        const userId = harness.generateId();
        const otherUser = harness.generateId();
        await harness.seedRaw('messages', [
          { _id: harness.generateId(), user: userId, conversationId: 'm', messageId: 'msg-1' },
        ]);
        await harness.seedRaw('sharedlinks', [
          { _id: harness.generateId(), user: userId, conversationId: 's', shareId: 'share-1' },
        ]);
        await harness.seedRaw('conversations', [
          { _id: harness.generateId(), user: otherUser, conversationId: 'o' },
        ]);
        expect(await store().hasConversationRecords(userId, 'm')).toBe(true);
        expect(await store().hasConversationRecords(userId, 's')).toBe(true);
        expect(await store().hasConversationRecords(userId, 'o')).toBe(false);
        expect(await store().hasConversationRecords(otherUser, 'o')).toBe(true);
        expect(await store().hasConversationRecords(otherUser, 'm')).toBe(false);
        expect(await store().hasConversation(userId, 'm')).toBe(false);
        expect(await store().hasConversation(otherUser, 'o')).toBe(true);
      });

      it('scopes the actor cleanup list and the history by tenant and subagent threads', async () => {
        const userId = harness.generateId();
        const reference = (checkpointId: string) => ({
          threadId: 'c',
          checkpointNs: 'event-actor/a',
          checkpointId,
        });
        await harness.seedRaw('conversations', [
          {
            _id: harness.generateId(),
            user: userId,
            tenantId: 'tenant',
            conversationId: 'tenant-thread',
            subagentThread: { parentConversationId: 'p' },
            agentEventActorCleanup: [reference('1'), reference('2')],
          },
          {
            _id: harness.generateId(),
            user: userId,
            conversationId: 'tenantless-thread',
            subagentThread: { parentConversationId: 'p' },
            agentEventActor: { previousCheckpoint: reference('3') },
          },
          {
            _id: harness.generateId(),
            user: userId,
            tenantId: 'other-tenant',
            conversationId: 'other-tenant-thread',
            subagentThread: { parentConversationId: 'p' },
          },
          {
            _id: harness.generateId(),
            user: userId,
            tenantId: 'tenant',
            conversationId: 'not-a-subagent',
            agentEventActorCleanup: [reference('4')],
          },
        ]);
        expect(await store().getActorCleanup(userId, 'tenant', 'tenant-thread')).toEqual([
          reference('1'),
          reference('2'),
        ]);
        expect(await store().getActorCleanup(userId, undefined, 'tenant-thread')).toEqual([]);
        expect(await store().getActorCleanup(userId, 'tenant', 'missing')).toEqual([]);
        await store().pullActorCleanup(userId, 'tenant', 'tenant-thread', reference('1'));
        expect(await store().getActorCleanup(userId, 'tenant', 'tenant-thread')).toEqual([
          reference('2'),
        ]);
        await store().pullActorCleanup(userId, undefined, 'tenant-thread', reference('2'));
        expect(await store().getActorCleanup(userId, 'tenant', 'tenant-thread')).toEqual([
          reference('2'),
        ]);

        const ids = async (tenantId: string | undefined, conversationIds?: string[]) =>
          (await collect(store().findActorHistory(userId, tenantId, conversationIds)))
            .map((conversation) => conversation.conversationId)
            .sort();
        expect(await ids('tenant')).toEqual(['tenant-thread', 'tenantless-thread']);
        expect(await ids(undefined)).toEqual(['tenantless-thread']);
        expect(await ids('tenant', ['tenantless-thread', 'not-a-subagent'])).toEqual([
          'tenantless-thread',
        ]);
        expect(await ids('tenant', [])).toEqual([]);
        expect(await ids('tenant', ['missing'])).toEqual([]);
        const [tenantless] = await collect(
          store().findActorHistory(userId, undefined, ['tenantless-thread']),
        );
        expect(tenantless).toMatchObject({
          conversationId: 'tenantless-thread',
          agentEventActor: { previousCheckpoint: reference('3') },
        });
      });
    });
  });
}
