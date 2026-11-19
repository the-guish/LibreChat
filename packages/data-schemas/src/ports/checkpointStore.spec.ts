import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { createMongoCheckpointStore } from '~/adapters/mongo/checkpointStore';
import type { CheckpointSaver, CheckpointStore } from './checkpointStore';
import type { LazyMongoSaver } from '~/adapters/mongo/checkpointSaver';
import type { Assert, SameSignatures, Satisfies } from './conformance';
import {
  CHECKPOINT_STORE_METHODS,
  CheckpointTooLargeError,
  checkpointStorageKey,
} from './checkpointStore';

/**
 * The MongoDB checkpoint store is typed as the port itself (`SameSignatures`), or `null` (no
 * database). Its saver is a LangGraph `BaseCheckpointSaver` that also takes the port's `put`
 * without `newVersions` (`Satisfies`).
 */
type Checks = [
  Assert<
    SameSignatures<CheckpointStore, NonNullable<ReturnType<typeof createMongoCheckpointStore>>>
  >,
  Assert<Satisfies<CheckpointSaver, LazyMongoSaver>>,
  Assert<Satisfies<BaseCheckpointSaver, CheckpointSaver>>,
];

describe('CheckpointStore port', () => {
  it('matches the MongoDB adapter at the type level', () => {
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CHECKPOINT_STORE_METHODS).size).toBe(CHECKPOINT_STORE_METHODS.length);
  });

  it('keys a storage by its type and collection names only', () => {
    const storage = {
      type: 'mongo' as const,
      checkpointCollectionName: 'agent_checkpoints',
      checkpointWritesCollectionName: 'agent_checkpoint_writes',
    };
    // The key names stored descriptors and deletion intents, so it must never change.
    expect(checkpointStorageKey(storage)).toBe(
      'c625969b45434b1da6439dc06fd28490f6ac6b11731946bcf4a4453d02fae22d',
    );
    expect(checkpointStorageKey({ ...storage, ttlSeconds: 60 } as typeof storage)).toBe(
      checkpointStorageKey(storage),
    );
    expect(checkpointStorageKey({ ...storage, type: 'memory' })).not.toBe(
      checkpointStorageKey(storage),
    );
  });

  it('reports an oversized checkpoint with a stable code', () => {
    const error = new CheckpointTooLargeError(3 * 1024 * 1024, 2 * 1024 * 1024, 'thread');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('CHECKPOINT_TOO_LARGE');
    expect(error.name).toBe('CheckpointTooLargeError');
    expect(error.message).toContain('Checkpoint state is 3.0 MB, over the 2.0 MB durable limit.');
  });
});
