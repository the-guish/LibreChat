/**
 * The port contract harness (docs/postgres-port/PHASE4.md §7, "Definition of done for phase 5"):
 * what a backend supplies so the contract suites (`contracts/<store>.contract.ts`, each exporting
 * `describe<Store>Contract(harness)`) run against it. Every suite runs on both backends: a
 * `<store>.mongo.spec.ts` with the MongoDB harness (`adapters/mongo/contractHarness.ts`) and a
 * `<store>.postgres.spec.ts` with the PostgreSQL one (with the collection primitive, C1).
 *
 * The suites reach the database only through the harness: the stores for the behavior under
 * test, `seedRaw`/`readRaw` for fixtures and assertions on what is stored. So a suite states the
 * port's contract, never one backend's storage. Nothing here may import `mongoose` or the
 * MongoDB driver (the `data-layer/no-database-driver` rule applies to this directory).
 */
import type { ConversationDomainFunctions, CreateMethodsDeps } from '~/compose/types';
import type { StoreErrors } from '~/ports/storeErrors';
import type { StoreIds } from '~/ports/storeIds';
import type { DataStore } from '~/ports';

/**
 * A record as stored, in canonical form: ids as 24 lowercase hex strings, dates as `Date`,
 * binary data as `Buffer`, everything else as plain JSON values.
 */
export type RawRecord = Record<string, unknown>;

export interface ContractHarness {
  /** The backend's name (`mongo`, `postgres`), shown in the suite titles. */
  readonly name: string;
  /** The backend's id format (`DataStoreBackend.ids`), for ids the fixtures need. */
  readonly ids: StoreIds;
  /**
   * The backend's error classification (`DataStoreBackend.errors`), for the cases where a port
   * promises a duplicate-key rejection.
   */
  readonly errors: StoreErrors;
  /**
   * Starts or connects to the database; the suite's `beforeAll`. Resolves once the collections'
   * indexes (unique ones included) exist, so the cases may rely on them.
   */
  setup(): Promise<void>;
  /** Disconnects and releases the database; the suite's `afterAll`. */
  teardown(): Promise<void>;
  /**
   * The stores, built by the backend's `createMethods(deps)` on the harness's database (a new
   * set on each call, as a new composition root would build them).
   */
  createStores(deps?: CreateMethodsDeps): DataStore;
  /**
   * The conversation domain functions (`saveConvo`, `bulkSaveConvos`, `deleteConvos`,
   * `searchConversation`), which are written once on the conversation store's steps and so are
   * not on `DataStore`: composed by the backend's `createMethods(deps)` on the harness's database
   * with the stores they reach (messages, queued turns, trigger deliveries), a new set on each
   * call.
   */
  createConversationDomain(deps?: CreateMethodsDeps): ConversationDomainFunctions;
  /** Removes every record of every collection, bypassing the stores (and tenant scoping). */
  reset(): Promise<void>;
  /**
   * Inserts `records` into `collection` (the collection's name, which is also the PostgreSQL
   * table's) in raw mode, bypassing the stores, tenant scoping, defaults, validators and hooks:
   * values of declared paths are cast to their declared types (a 24-hex string to an id, an ISO
   * string to a date), as a driver insert through the schema would; undeclared fields are kept
   * as given (D7). Ids are given as 24-hex strings (`ids.generate()`).
   */
  seedRaw(collection: string, records: ReadonlyArray<RawRecord>): Promise<void>;
  /** Every record of `collection`, bypassing the stores, oldest `_id` first, in canonical form. */
  readRaw(collection: string): Promise<RawRecord[]>;
}
