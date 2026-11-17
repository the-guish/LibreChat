/**
 * The contract harness of the agent checkpoint store (`~/ports/checkpointStore`; served by
 * `DataStoreBackend.getCheckpointStore`, docs/postgres-port/PHASE4.md §8 I2). Its suites
 * (`checkpointStore.contract.ts`, `checkpointStore.saver.contract.ts`) run on both backends: a
 * `<suite>.mongo.spec.ts` with `adapters/mongo/checkpointContractHarness.ts` and a
 * `<suite>.postgres.spec.ts` with the PostgreSQL one.
 *
 * It is separate from `ContractHarness` (`./harness`) and `InfrastructureContractHarness`
 * (`./infrastructure`) because the checkpoint store is opened on the backend (not built by
 * `createMethods`) and its operations act on checkpoint storages, which are no collection of the
 * schema: the suites seed and read the identity of stored checkpoint and write rows through
 * {@link CheckpointContractHarness.seedCheckpointRows} and
 * {@link CheckpointContractHarness.readCheckpointRows}, and the other records (conversations,
 * tool calls, storage descriptors, deletion intents) through `seedRaw`/`readRaw`, as
 * `ContractHarness` defines them. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { CheckpointStore, CheckpointStorageNames } from '~/ports/checkpointStore';
import type { RawRecord } from './harness';

/** Which rows of a checkpoint storage: the checkpoints, or their pending writes. */
export type CheckpointRowKind = 'checkpoints' | 'writes';

/**
 * The identity of a stored checkpoint or write row: the stored (owner-prefixed when owned)
 * thread and namespace, the checkpoint id, and the recorded owner when the row is owned.
 */
export interface CheckpointIdentityRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  lc_owner?: string;
}

export interface CheckpointContractHarness {
  /** The backend's name (`mongo`, `postgres`), shown in the suite titles. */
  readonly name: string;
  /** Starts or connects to the database; the suite's `beforeAll`. */
  setup(): Promise<void>;
  /** Disconnects and releases the database; the suite's `afterAll`. */
  teardown(): Promise<void>;
  /**
   * Removes every stored checkpoint and write of every storage, every storage descriptor and
   * deletion intent, and every record of the other collections, bypassing the store.
   */
  reset(): Promise<void>;
  /** The checkpoint store of the backend on the harness's connected database. */
  store(): CheckpointStore;
  /** What a backend of the same kind whose database was never connected serves. */
  disconnectedStore(): CheckpointStore | null;
  /**
   * Stores `rows` as rows of `kind` in `storage`, bypassing the store and the saver, with
   * placeholder payloads (no checkpoint a saver could load): only their identity matters. Rows
   * without `lc_owner` are unowned. Write rows of one checkpoint get distinct write slots.
   */
  seedCheckpointRows(
    storage: CheckpointStorageNames,
    kind: CheckpointRowKind,
    rows: ReadonlyArray<CheckpointIdentityRow>,
  ): Promise<void>;
  /** The identity of every row of `kind` in `storage`, in no particular order. */
  readCheckpointRows(
    storage: CheckpointStorageNames,
    kind: CheckpointRowKind,
  ): Promise<CheckpointIdentityRow[]>;
  /** As `ContractHarness.seedRaw`: records inserted in raw mode, ids as 24-hex strings. */
  seedRaw(collection: string, records: ReadonlyArray<RawRecord>): Promise<void>;
  /** As `ContractHarness.readRaw`: every record of `collection`, in canonical form. */
  readRaw(collection: string): Promise<RawRecord[]>;
  /** A new id in the backend's format, as a 24-hex string. */
  generateId(): string;
}

/** Registers the harness lifecycle: set up once, reset before each case, tear down once. */
export function useCheckpointHarness(harness: CheckpointContractHarness): void {
  beforeAll(() => harness.setup(), 120_000);
  afterAll(() => harness.teardown());
  beforeEach(() => harness.reset());
}
