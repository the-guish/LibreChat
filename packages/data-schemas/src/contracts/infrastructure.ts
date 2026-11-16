/**
 * The contract harness of the backend members that are not `DataStore` stores
 * (docs/postgres-port/PHASE4.md §7, §8 I1): the key-value stores
 * (`DataStoreBackend.createKeyValueStore`) and the credential marker
 * (`DataStoreBackend.getCredentialMarkerStore`). Their suites
 * (`keyValueStore.contract.ts`, `credentialMarker.contract.ts`) run on both backends: a
 * `<suite>.mongo.spec.ts` with `adapters/mongo/infrastructureContractHarness.ts` and a
 * `<suite>.postgres.spec.ts` with `adapters/postgres/infrastructureContractHarness.ts`.
 *
 * It is separate from `ContractHarness` (`./harness`) because these members are opened on the
 * backend, not built by `createMethods`, and need a backend that was never connected; the suites
 * reach the database only through the members under test and `seedUser`. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import type { DataStoreBackend } from '~/ports/connection';

/** The backend members the infrastructure suites exercise. */
export type InfrastructureBackend = Pick<
  DataStoreBackend,
  'name' | 'createKeyValueStore' | 'getCredentialMarkerStore'
>;

export interface InfrastructureContractHarness {
  /** The backend's name (`mongo`, `postgres`), shown in the suite titles. */
  readonly name: string;
  /** Starts or connects to the database; the suite's `beforeAll`. */
  setup(): Promise<void>;
  /** Disconnects and releases the database; the suite's `afterAll`. */
  teardown(): Promise<void>;
  /** Removes every key-value entry, the credential marker and every user, bypassing the stores. */
  reset(): Promise<void>;
  /** The backend on the harness's connected database. */
  backend(): InfrastructureBackend;
  /** A backend of the same kind whose database was never connected. */
  disconnectedBackend(): InfrastructureBackend;
  /** Inserts one user record, bypassing the stores. */
  seedUser(): Promise<void>;
}

/** Registers the harness lifecycle: set up once, reset before each case, tear down once. */
export function useInfrastructureHarness(harness: InfrastructureContractHarness): void {
  beforeAll(() => harness.setup(), 120_000);
  afterAll(() => harness.teardown());
  beforeEach(() => harness.reset());
}
