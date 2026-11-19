/**
 * A {@link TestDataStore} over a contract harness (`~/contracts/harness`) that is set up on the
 * process's backend. Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { CreateMethodsDeps, DataMethods } from '~/compose/types';
import type { ContractHarness } from '~/contracts/harness';
import type { TestDataStore } from './types';

/** Sets `harness` up (tearing it down again if that fails) and wraps it as a test data store. */
export async function openTestDataStore(
  backend: TestDataStore['backend'],
  harness: ContractHarness,
  createMethods: (deps?: CreateMethodsDeps) => DataMethods,
  deps?: CreateMethodsDeps,
): Promise<TestDataStore> {
  try {
    await harness.setup();
  } catch (error) {
    await harness.teardown().catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    backend,
    methods: createMethods(deps),
    ids: harness.ids,
    errors: harness.errors,
    seed: (collection, records) => harness.seedRaw(collection, records),
    read: (collection) => harness.readRaw(collection),
    reset: () => harness.reset(),
    async close() {
      if (!closed) {
        closed = true;
        await harness.teardown();
      }
    },
  };
}
