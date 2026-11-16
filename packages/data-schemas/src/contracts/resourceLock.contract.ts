/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ResourceLockStore` contract (`~/ports/resourceLock`), ported from
 * `methods/resourceLock.spec.ts`: one live lease per key, takeover of an expired lease, renewal
 * only for the live holder (never moving the expiry backwards), release only by the holder, and
 * exclusivity under concurrent acquisition. The index-readiness wait (`readyWaitMs`) is a
 * MongoDB concern and stays in the method spec. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { readRawWhere, timeOf, useContractHarness } from './support';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeResourceLockContract(harness: ContractHarness): void {
  describe(`ResourceLockStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().resourceLocks;
    const expiryOf = async (key: string) =>
      timeOf((await readRawWhere(harness, 'resourcelocks', { key }))[0]?.expiresAt);

    describe('acquireResourceLock', () => {
      it('grants the lease to one owner at a time, per key', async () => {
        const locks = stores();
        const key = 'acl:agent:1';
        expect(await locks.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 })).toBe(true);
        expect(await locks.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(false);
        expect(
          await locks.acquireResourceLock({ key: 'acl:agent:2', ownerId: 'b', ttlMs: 30_000 }),
        ).toBe(true);
        const stored = await readRawWhere(harness, 'resourcelocks', { key });
        expect(stored).toHaveLength(1);
        expect(stored[0].ownerId).toBe('a');
      });

      it('refuses the holder itself a second acquisition of a live lease', async () => {
        const locks = stores();
        const key = 'acl:agent:1';
        await locks.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 });
        expect(await locks.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 })).toBe(false);
      });

      it('stores the expiry ttlMs after the call', async () => {
        const before = Date.now();
        await stores().acquireResourceLock({ key: 'k', ownerId: 'a', ttlMs: 60_000 });
        const expiry = await expiryOf('k');
        expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
        expect(expiry).toBeLessThanOrEqual(Date.now() + 60_000);
      });

      it('lets another owner take over a lease its holder left to expire', async () => {
        const locks = stores();
        const key = 'acl:agent:1';
        await locks.acquireResourceLock({ key, ownerId: 'crashed', ttlMs: 1 });
        await sleep(20);

        expect(await locks.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(true);
        expect(await locks.releaseResourceLock({ key, ownerId: 'crashed' })).toBe(false);
        const stored = await readRawWhere(harness, 'resourcelocks', { key });
        expect(stored).toHaveLength(1);
        expect(stored[0].ownerId).toBe('b');
      });

      it('takes over an expired lease seeded raw', async () => {
        await harness.seedRaw('resourcelocks', [
          {
            _id: harness.ids.generate(),
            key: 'stale',
            ownerId: 'gone',
            expiresAt: new Date(Date.now() - 60_000),
          },
        ]);
        expect(
          await stores().acquireResourceLock({ key: 'stale', ownerId: 'b', ttlMs: 30_000 }),
        ).toBe(true);
        expect((await readRawWhere(harness, 'resourcelocks', { key: 'stale' }))[0].ownerId).toBe(
          'b',
        );
      });

      it('grants a contended lease to exactly one of many concurrent owners', async () => {
        const locks = stores();
        const owners = Array.from({ length: 8 }, (_, index) => `owner-${index}`);
        const results = await Promise.all(
          owners.map((ownerId) =>
            locks.acquireResourceLock({ key: 'hot', ownerId, ttlMs: 30_000 }),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = owners[results.indexOf(true)];
        const stored = await readRawWhere(harness, 'resourcelocks', { key: 'hot' });
        expect(stored).toHaveLength(1);
        expect(stored[0].ownerId).toBe(winner);
      });

      it('lets exactly one of many concurrent owners take over an expired lease', async () => {
        await harness.seedRaw('resourcelocks', [
          {
            _id: harness.ids.generate(),
            key: 'hot',
            ownerId: 'gone',
            expiresAt: new Date(Date.now() - 60_000),
          },
        ]);
        const locks = stores();
        const owners = Array.from({ length: 8 }, (_, index) => `owner-${index}`);
        const results = await Promise.all(
          owners.map((ownerId) =>
            locks.acquireResourceLock({ key: 'hot', ownerId, ttlMs: 30_000 }),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const stored = await readRawWhere(harness, 'resourcelocks', { key: 'hot' });
        expect(stored[0].ownerId).toBe(owners[results.indexOf(true)]);
      });
    });

    describe('renewResourceLock', () => {
      it('renews only for the live holder', async () => {
        const locks = stores();
        const key = 'acl:agent:1';
        await locks.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 });
        expect(await locks.renewResourceLock({ key, ownerId: 'a', ttlMs: 30_000 })).toBe(true);
        expect(await locks.renewResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(false);
        await locks.acquireResourceLock({ key: 'acl:agent:2', ownerId: 'c', ttlMs: 1 });
        await sleep(5);
        expect(
          await locks.renewResourceLock({ key: 'acl:agent:2', ownerId: 'c', ttlMs: 30_000 }),
        ).toBe(false);
      });

      it('is false for a key nobody holds, and creates nothing', async () => {
        expect(await stores().renewResourceLock({ key: 'none', ownerId: 'a', ttlMs: 30_000 })).toBe(
          false,
        );
        expect(await harness.readRaw('resourcelocks')).toEqual([]);
      });

      it('extends the expiry', async () => {
        const locks = stores();
        await locks.acquireResourceLock({ key: 'k', ownerId: 'a', ttlMs: 1_000 });
        const before = await expiryOf('k');
        expect(await locks.renewResourceLock({ key: 'k', ownerId: 'a', ttlMs: 60_000 })).toBe(true);
        expect(await expiryOf('k')).toBeGreaterThan(before + 50_000);
      });

      it('never moves the expiry backwards on an overlapping renewal', async () => {
        const locks = stores();
        const key = 'acl:agent:3';
        await locks.acquireResourceLock({ key, ownerId: 'a', ttlMs: 60_000 });
        const before = await expiryOf(key);
        expect(await locks.renewResourceLock({ key, ownerId: 'a', ttlMs: 1_000 })).toBe(true);
        expect(await expiryOf(key)).toBeGreaterThanOrEqual(before);
      });
    });

    describe('releaseResourceLock', () => {
      it('ignores a release from a non-owner and frees the lease for the owner', async () => {
        const locks = stores();
        const key = 'acl:agent:1';
        await locks.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 });

        expect(await locks.releaseResourceLock({ key, ownerId: 'b' })).toBe(false);
        expect(await locks.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(false);
        expect(await locks.releaseResourceLock({ key, ownerId: 'a' })).toBe(true);
        expect(await harness.readRaw('resourcelocks')).toEqual([]);
        expect(await locks.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(true);
      });

      it('is false for a key nobody holds, and a second release is false', async () => {
        const locks = stores();
        expect(await locks.releaseResourceLock({ key: 'none', ownerId: 'a' })).toBe(false);
        await locks.acquireResourceLock({ key: 'k', ownerId: 'a', ttlMs: 30_000 });
        expect(await locks.releaseResourceLock({ key: 'k', ownerId: 'a' })).toBe(true);
        expect(await locks.releaseResourceLock({ key: 'k', ownerId: 'a' })).toBe(false);
      });

      it('releases an expired lease for its owner', async () => {
        /** The release matches the key and the owner, not the expiry. */
        const locks = stores();
        await locks.acquireResourceLock({ key: 'k', ownerId: 'a', ttlMs: 1 });
        await sleep(10);
        expect(await locks.releaseResourceLock({ key: 'k', ownerId: 'a' })).toBe(true);
      });
    });
  });
}
