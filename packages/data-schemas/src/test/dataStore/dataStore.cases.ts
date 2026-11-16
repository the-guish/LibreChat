/* eslint-disable jest/no-export -- This file is a shared test suite, not a spec: it exports the
   suite factory that each backend's own spec imports. The rule guards against accidental exports
   from spec files. */
/**
 * The cases of `createTestDataStore()` (`./index`), run on each backend by
 * `dataStore.mongo.spec.ts` and `dataStore.postgres.spec.ts`. Each spec selects its backend with
 * `DATABASE_BACKEND` before anything reads it (the process's backend is chosen once per module
 * registry, so once per spec file) and restores the variable afterwards. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { getDataStoreBackend } from '~/adapters/backend';
import type { TestDataStore } from './types';
import { createTestDataStore } from './index';

export function describeTestDataStore(backend: 'mongo' | 'postgres'): void {
  describe(`createTestDataStore on ${backend}`, () => {
    const previous = process.env.DATABASE_BACKEND;
    let store: TestDataStore;

    beforeAll(async () => {
      process.env.DATABASE_BACKEND = backend;
      store = await createTestDataStore();
    }, 180_000);

    afterEach(() => store.reset());

    afterAll(async () => {
      await store?.close();
      if (previous === undefined) {
        delete process.env.DATABASE_BACKEND;
      } else {
        process.env.DATABASE_BACKEND = previous;
      }
    }, 60_000);

    it('runs on the backend DATABASE_BACKEND selects, the process backend', () => {
      expect(store.backend).toBe(backend);
      expect(getDataStoreBackend().name).toBe(backend);
      expect(store.ids).toBe(getDataStoreBackend().ids);
      expect(Object.keys(store.methods.stores).length).toBeGreaterThan(50);
    });

    it('seeds and reads in raw mode: declared paths cast, undeclared fields kept', async () => {
      const first = store.ids.generate().toString();
      const second = store.ids.generate().toString();
      await store.seed('users', [
        { _id: first, email: 'first@example.com', createdAt: '2026-01-02T03:04:05.000Z' },
        { _id: second, email: 'second@example.com', legacyField: { kept: true } },
      ]);
      const users = await store.read('users');
      expect(users.map((user) => user._id)).toEqual([first, second]);
      expect(users[0]).toMatchObject({ email: 'first@example.com' });
      expect(users[0].createdAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
      expect(users[1]).toMatchObject({ legacyField: { kept: true } });
    });

    it('connects the process backend, which the server modules reach the database through', async () => {
      const markers = getDataStoreBackend().getCredentialMarkerStore();
      expect(markers).not.toBeNull();
      expect(await markers!.hasUsers()).toBe(false);
      await store.seed('users', [{ _id: store.ids.generate().toString(), email: 'a@example.com' }]);
      expect(await markers!.hasUsers()).toBe(true);
    });

    it('resets every collection', async () => {
      await store.seed('users', [{ _id: store.ids.generate().toString(), email: 'b@example.com' }]);
      await store.seed('banners', [{ _id: store.ids.generate().toString(), message: 'hi' }]);
      await store.reset();
      expect(await store.read('users')).toEqual([]);
      expect(await store.read('banners')).toEqual([]);
    });

    it('reports a duplicate key the way the backend classifies it', async () => {
      const _id = store.ids.generate().toString();
      await store.seed('users', [{ _id, email: 'c@example.com' }]);
      const error = await store.seed('users', [{ _id, email: 'd@example.com' }]).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(store.errors.isDuplicateKey(error)).toBe(true);
    });
  });
}
