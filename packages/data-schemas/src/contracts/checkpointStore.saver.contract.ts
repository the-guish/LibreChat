/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The contract of the durable LangGraph saver a checkpoint store builds
 * (`CheckpointStore.createSaver`, `~/ports/checkpointStore`), on every backend: the storage rules
 * the port's header states (lazy persistence of anchored checkpoints only, the generation
 * namespace mapping, owner isolation with the one named legacy read, descriptors) and the
 * LangGraph saver behavior the agents runtime relies on (a resume reads the interrupted
 * checkpoint, its channel values and its pending writes back from a fresh saver; a direct `put`
 * without `newVersions` keeps the channel values). The storage descriptors' recording is in
 * `checkpointStore.contract.ts`. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import type { CheckpointSaver } from '~/ports/checkpointStore';
import type { CheckpointContractHarness } from './checkpoint';
import {
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
} from '~/ports/checkpointStore';
import { useCheckpointHarness } from './checkpoint';

const STORAGE = {
  checkpointCollectionName: 'cp',
  checkpointWritesCollectionName: 'cp_writes',
};
const SETTINGS = { ttlSeconds: 60, ...STORAGE };
const OWNER = `lcg:v2:${'a'.repeat(64)}:`;
const OTHER = `lcg:v2:${'b'.repeat(64)}:`;

type Configurable = Record<string, unknown>;

/** A checkpoint with `values` as its channel values, each at version 1 unless given. */
function checkpointOf(
  id: string,
  values: Record<string, unknown> = {},
  versions: Record<string, number> = {},
): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id,
    channel_values: values,
    channel_versions: Object.fromEntries(
      Object.keys(values).map((channel) => [channel, versions[channel] ?? 1]),
    ),
  };
}

function metadataOf(step: number): CheckpointMetadata {
  return { source: 'loop', step, parents: {} };
}

export function describeCheckpointSaverContract(harness: CheckpointContractHarness): void {
  describe(`CheckpointStore saver contract: ${harness.name}`, () => {
    useCheckpointHarness(harness);

    const saver = (): Promise<CheckpointSaver> => harness.store().createSaver(SETTINGS);
    const config = (configurable: Configurable) => ({
      configurable: { thread_id: 't', checkpoint_ns: '', ...configurable },
    });
    const rows = async (kind: 'checkpoints' | 'writes') =>
      (await harness.readCheckpointRows(STORAGE, kind)).sort((a, b) =>
        `${a.thread_id}/${a.checkpoint_ns}/${a.checkpoint_id}`.localeCompare(
          `${b.thread_id}/${b.checkpoint_ns}/${b.checkpoint_id}`,
        ),
      );
    const interrupt: PendingWrite = [INTERRUPT, [{ value: 'approve?', id: 'interrupt-1' }]];

    /** The anchoring write then the checkpoint, as LangGraph's exit does on a pause. */
    async function pause(
      target: CheckpointSaver,
      configurable: Configurable,
      checkpoint: Checkpoint,
      step = 1,
    ) {
      await target.putWrites(
        config({ ...configurable, checkpoint_id: checkpoint.id }),
        [interrupt],
        'task-1',
      );
      return target.put(
        config(configurable),
        checkpoint,
        metadataOf(step),
        checkpoint.channel_versions,
      );
    }

    async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
      const items: T[] = [];
      for await (const item of iterable) {
        items.push(item);
      }
      return items;
    }

    describe('lazy persistence', () => {
      it('persists an interrupted checkpoint with its writes, and a fresh saver resumes it', async () => {
        const checkpoint = checkpointOf('cp-1', { messages: ['hi'], step: 3 });
        const persisted = await pause(await saver(), {}, checkpoint);
        expect(persisted.configurable).toMatchObject({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'cp-1',
        });

        const tuple = await (await saver()).getTuple(config({}));
        expect(tuple?.config.configurable).toEqual({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'cp-1',
        });
        expect(tuple?.checkpoint).toEqual(checkpoint);
        expect(tuple?.metadata).toEqual(metadataOf(1));
        expect(tuple?.pendingWrites).toEqual([['task-1', ...interrupt]]);
        expect(tuple?.parentConfig).toBeUndefined();
        expect(await rows('checkpoints')).toEqual([
          { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'cp-1' },
        ]);
        expect(await rows('writes')).toEqual([
          { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'cp-1' },
        ]);
      });

      it('records the parent of a resumed checkpoint, and reads one checkpoint by id', async () => {
        const target = await saver();
        await pause(target, {}, checkpointOf('cp-1', { messages: ['hi'] }));
        await pause(
          target,
          { checkpoint_id: 'cp-1' },
          checkpointOf('cp-2', { messages: ['hi', 'again'] }, { messages: 2 }),
          2,
        );
        const latest = await target.getTuple(config({}));
        expect(latest?.checkpoint.id).toBe('cp-2');
        expect(latest?.checkpoint.channel_values).toEqual({ messages: ['hi', 'again'] });
        expect(latest?.parentConfig?.configurable).toEqual({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'cp-1',
        });
        const first = await target.getTuple(config({ checkpoint_id: 'cp-1' }));
        expect(first?.checkpoint.channel_values).toEqual({ messages: ['hi'] });
        expect(first?.metadata).toEqual(metadataOf(1));
        expect(await target.getTuple(config({ checkpoint_id: 'cp-9' }))).toBeUndefined();
        expect((await collect(target.list(config({})))).map((t) => t.checkpoint.id)).toEqual([
          'cp-2',
          'cp-1',
        ]);
      });

      it('discards a checkpoint without a resumable write, with its bookkeeping writes', async () => {
        const target = await saver();
        const clean = checkpointOf('clean', { messages: ['done'] });
        const returned = await target.put(config({}), clean, metadataOf(1), clean.channel_versions);
        expect(returned.configurable).toMatchObject({ thread_id: 't', checkpoint_id: 'clean' });

        const failed = checkpointOf('failed', { messages: ['oops'] });
        await target.putWrites(
          config({ checkpoint_id: 'failed' }),
          [['__error__', 'boom']],
          'task',
        );
        await target.put(config({}), failed, metadataOf(1), failed.channel_versions);

        expect(await target.getTuple(config({}))).toBeUndefined();
        expect(await rows('checkpoints')).toEqual([]);
        expect(await rows('writes')).toEqual([]);
      });

      it('keeps the bookkeeping writes of a retained checkpoint, before and after its put', async () => {
        const target = await saver();
        const checkpoint = checkpointOf('cp-1', { messages: ['hi'] });
        const writeConfig = config({ checkpoint_id: 'cp-1' });
        await target.putWrites(writeConfig, [['__no_writes__', 'sibling done']], 'sibling');
        await pause(target, {}, checkpoint);
        await target.putWrites(writeConfig, [['__resume__', 'yes']], 'task-2');

        const tuple = await target.getTuple(config({}));
        expect(tuple?.pendingWrites).toHaveLength(3);
        expect(tuple?.pendingWrites).toEqual(
          expect.arrayContaining([
            ['sibling', '__no_writes__', 'sibling done'],
            ['task-1', ...interrupt],
            ['task-2', '__resume__', 'yes'],
          ]),
        );
      });

      it('overwrites special writes of a task and keeps its first ordinary write', async () => {
        const target = await saver();
        await pause(target, {}, checkpointOf('cp-1', { messages: ['hi'] }));
        const writeConfig = config({ checkpoint_id: 'cp-1' });
        await target.putWrites(writeConfig, [[INTERRUPT, 'second']], 'task-1');
        await target.putWrites(writeConfig, [['messages', 'first']], 'task-3');
        await target.putWrites(writeConfig, [['messages', 'later']], 'task-3');
        const tuple = await target.getTuple(config({}));
        expect(tuple?.pendingWrites).toHaveLength(2);
        expect(tuple?.pendingWrites).toEqual(
          expect.arrayContaining([
            ['task-1', INTERRUPT, 'second'],
            ['task-3', 'messages', 'first'],
          ]),
        );
      });
    });

    describe('generation namespaces and event actors', () => {
      it('stores a generation under its namespace and gives the graph its own namespace back', async () => {
        const target = await saver();
        const generation = { [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen-1' };
        await pause(target, generation, checkpointOf('root', { messages: ['hi'] }));
        await pause(
          target,
          { ...generation, checkpoint_ns: 'child' },
          checkpointOf('nested', { messages: ['nested'] }),
        );
        expect(await rows('checkpoints')).toEqual([
          { thread_id: 't', checkpoint_ns: 'gen-1', checkpoint_id: 'root' },
          { thread_id: 't', checkpoint_ns: 'gen-1|child', checkpoint_id: 'nested' },
        ]);

        const root = await target.getTuple(config(generation));
        expect(root?.config.configurable).toEqual({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'root',
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen-1',
        });
        expect(root?.pendingWrites).toEqual([['task-1', ...interrupt]]);
        const nested = await target.getTuple(config({ ...generation, checkpoint_ns: 'child' }));
        expect(nested?.checkpoint.channel_values).toEqual({ messages: ['nested'] });
        expect(nested?.config.configurable?.checkpoint_ns).toBe('child');
        expect(await target.getTuple(config({}))).toBeUndefined();
        expect(
          (
            await harness.store().listGenerationCheckpointIds(STORAGE, {
              threadId: 't',
              namespace: 'gen-1',
            })
          ).sort(),
        ).toEqual(['nested', 'root']);
      });

      it('persists an event actor checkpoint put without new versions, with its channel values', async () => {
        const target = await saver();
        const actor = {
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'event-actor/x',
          [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'invocation-1',
        };
        const checkpoint = checkpointOf(
          'actor-1',
          { messages: ['a', 'b'], counter: 2, nested: { deep: [1, { x: 'y' }] } },
          { messages: 3, counter: 2, nested: 1 },
        );
        const persisted = await target.put(config(actor), checkpoint, metadataOf(4));
        expect(persisted.configurable).toMatchObject({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'actor-1',
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'event-actor/x',
        });
        const tuple = await (await saver()).getTuple(config(actor));
        expect(tuple?.checkpoint).toEqual(checkpoint);
        expect(tuple?.metadata).toEqual(metadataOf(4));
        expect(tuple?.pendingWrites).toEqual([]);

        /** An event actor's writes are kept without an anchor. */
        await target.putWrites(
          config({ ...actor, checkpoint_id: 'actor-1' }),
          [['__no_writes__', 'done']],
          'task',
        );
        expect((await target.getTuple(config(actor)))?.pendingWrites).toEqual([
          ['task', '__no_writes__', 'done'],
        ]);
        expect(await rows('checkpoints')).toEqual([
          { thread_id: 't', checkpoint_ns: 'event-actor/x', checkpoint_id: 'actor-1' },
        ]);
      });
    });

    describe('owners', () => {
      const owned = (owner: string, configurable: Configurable = {}) => ({
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen',
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
        [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'invocation',
        ...configurable,
      });

      it('stores owned rows under the owner and reads them back on the logical thread', async () => {
        const target = await saver();
        await pause(target, owned(OWNER), checkpointOf('cp-1', { messages: ['mine'] }));
        expect(await rows('checkpoints')).toEqual([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}gen`,
            checkpoint_id: 'cp-1',
            lc_owner: OWNER,
          },
        ]);
        expect(await rows('writes')).toEqual([
          {
            thread_id: `${OWNER}t`,
            checkpoint_ns: `${OWNER}gen`,
            checkpoint_id: 'cp-1',
            lc_owner: OWNER,
          },
        ]);

        const tuple = await (await saver()).getTuple(config(owned(OWNER)));
        expect(tuple?.config.configurable).toEqual({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'cp-1',
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen',
        });
        expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['mine'] });
        expect(tuple?.metadata).toEqual(metadataOf(1));
        expect(tuple?.pendingWrites).toEqual([['task-1', ...interrupt]]);

        expect(await target.getTuple(config(owned(OTHER)))).toBeUndefined();
        expect(
          await target.getTuple(config({ [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen' })),
        ).toBeUndefined();
        expect(await harness.store().listStorageDescriptors([OWNER])).toEqual([
          { type: 'mongo', ...STORAGE },
        ]);
      });

      it('keeps the parent of an owned checkpoint under the owner', async () => {
        const target = await saver();
        await pause(target, owned(OWNER), checkpointOf('cp-1', { messages: ['a'] }));
        await pause(
          target,
          owned(OWNER, { checkpoint_id: 'cp-1' }),
          checkpointOf('cp-2', { messages: ['a', 'b'] }, { messages: 2 }),
          2,
        );
        const tuple = await target.getTuple(config(owned(OWNER)));
        expect(tuple?.checkpoint.id).toBe('cp-2');
        expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['a', 'b'] });
        expect(tuple?.parentConfig?.configurable).toMatchObject({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'cp-1',
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
        });
      });

      it('lists owned checkpoints newest first, with a limit, a boundary and a metadata filter', async () => {
        const target = await saver();
        for (const step of [1, 2, 3]) {
          await pause(target, owned(OWNER), checkpointOf(`cp-${step}`, { messages: [step] }), step);
        }
        await pause(target, owned(OTHER), checkpointOf('cp-4', { messages: [4] }), 4);
        const ids = async (options?: Parameters<CheckpointSaver['list']>[1], owner = OWNER) =>
          (await collect(target.list(config(owned(owner)), options))).map((t) => t.checkpoint.id);

        expect(await ids()).toEqual(['cp-3', 'cp-2', 'cp-1']);
        expect(await ids({ limit: 1 })).toEqual(['cp-3']);
        expect(await ids({ before: config(owned(OWNER, { checkpoint_id: 'cp-3' })) })).toEqual([
          'cp-2',
          'cp-1',
        ]);
        expect(await ids({ filter: { step: 2 } })).toEqual(['cp-2']);
        expect(await ids({ filter: { source: 'input' } })).toEqual([]);
        expect(await ids(undefined, OTHER)).toEqual(['cp-4']);

        const [latest] = await collect(target.list(config(owned(OWNER)), { limit: 1 }));
        expect(latest.config.configurable).toMatchObject({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'cp-3',
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
        });
        expect(latest.pendingWrites).toEqual([['task-1', ...interrupt]]);
        await expect(
          collect(target.list(config(owned(OWNER)), { filter: { step: { $gt: 1 } } })),
        ).rejects.toThrow();
      });

      it('reads the one named legacy checkpoint for an owner, and no other unowned row', async () => {
        const target = await saver();
        const unowned = {
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen',
          [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'invocation',
        };
        await target.put(
          config(unowned),
          checkpointOf('legacy-1', { messages: ['old'] }),
          metadataOf(1),
        );
        await target.put(
          config(unowned),
          checkpointOf('legacy-2', { messages: ['older'] }),
          metadataOf(2),
        );

        const tuple = await target.getTuple(
          config(
            owned(OWNER, {
              checkpoint_id: 'legacy-1',
              [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: 'legacy-1',
            }),
          ),
        );
        expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['old'] });
        expect(tuple?.config.configurable).toEqual({
          thread_id: 't',
          checkpoint_ns: '',
          checkpoint_id: 'legacy-1',
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
          [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: 'legacy-1',
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'gen',
        });
        expect(
          await target.getTuple(config(owned(OWNER, { checkpoint_id: 'legacy-1' }))),
        ).toBeUndefined();
        expect(
          await target.getTuple(
            config(
              owned(OWNER, {
                checkpoint_id: 'legacy-2',
                [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: 'legacy-1',
              }),
            ),
          ),
        ).toBeUndefined();
        expect(await target.getTuple(config(owned(OWNER)))).toBeUndefined();
      });

      it('refuses owned writes without a checkpoint id', async () => {
        const target = await saver();
        await expect(
          target.putWrites(
            config({
              [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
              [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'invocation',
            }),
            [[INTERRUPT, 'x']],
            'task',
          ),
        ).rejects.toThrow('Owned writes require a checkpoint id');
        expect(await rows('writes')).toEqual([]);
      });
    });
  });
}
