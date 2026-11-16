/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The contract harness's own smoke contract: proves that a backend's `ContractHarness` works
 * (stores built, raw seeding and reading in canonical form, reset), before any store contract
 * relies on it. It uses the banner store as the one store read through, because it is small and
 * has no dependencies. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { DATA_STORE_METHODS } from '~/ports';

export function describeContractHarnessSmoke(harness: ContractHarness): void {
  describe(`contract harness: ${harness.name}`, () => {
    beforeAll(() => harness.setup(), 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const banner = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      bannerId: 'banner-1',
      message: 'Hello',
      displayFrom: new Date('2020-01-01T00:00:00.000Z'),
      type: 'banner',
      isPublic: true,
      persistable: false,
      ...overrides,
    });

    it('builds every store of the DataStore', () => {
      const stores = harness.createStores();
      expect(Object.keys(stores).sort()).toEqual(Object.keys(DATA_STORE_METHODS).sort());
      for (const [store, methods] of Object.entries(DATA_STORE_METHODS)) {
        for (const method of methods as string[]) {
          expect(
            typeof (stores as unknown as Record<string, Record<string, unknown>>)[store][method],
          ).toBe('function');
        }
      }
    });

    it('generates ids of its own format', () => {
      const id = harness.ids.generate();
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      expect(harness.ids.isValid(id)).toBe(true);
      expect(harness.ids.toCanonicalString(id.toUpperCase())).toBe(id);
    });

    it('seeds raw records and reads them back in canonical form, oldest id first', async () => {
      const first = banner();
      const second = banner({ bannerId: 'banner-2' });
      await harness.seedRaw(
        'banners',
        [second, first].sort((a, b) => (a._id < b._id ? 1 : -1)),
      );
      const records = await harness.readRaw('banners');
      expect(records).toEqual([first, second]);
      expect(records[0].displayFrom).toBeInstanceOf(Date);
    });

    it('casts declared values and keeps undeclared fields as given', async () => {
      const record = banner({ displayFrom: '2021-02-03T04:05:06.007Z', legacyField: { a: 1 } });
      await harness.seedRaw('banners', [record]);
      const [stored] = await harness.readRaw('banners');
      expect(stored.displayFrom).toEqual(new Date('2021-02-03T04:05:06.007Z'));
      expect(stored.legacyField).toEqual({ a: 1 });
      /** No defaults in raw mode. */
      expect(stored).not.toHaveProperty('createdAt');
    });

    it('serves seeded records through the stores', async () => {
      const record = banner({ displayTo: new Date('2999-01-01T00:00:00.000Z') });
      await harness.seedRaw('banners', [record]);
      const current = await harness.createStores().banners.getCurrentBannerRecord();
      expect(current).toMatchObject({ bannerId: 'banner-1', message: 'Hello' });
      expect(harness.ids.toCanonicalString(current?._id)).toBe(record._id);
    });

    it('sees what the stores write', async () => {
      const stores = harness.createStores();
      await stores.banners.saveBanner({
        bannerId: 'written',
        message: 'Written by the store',
        displayFrom: new Date('2020-01-01T00:00:00.000Z'),
        displayTo: null,
        isPublic: false,
        persistable: false,
      });
      const records = await harness.readRaw('banners');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ bannerId: 'written', message: 'Written by the store' });
      expect(harness.ids.isValid(records[0]._id)).toBe(true);
    });

    it('resets every collection', async () => {
      await harness.seedRaw('banners', [banner()]);
      await harness.reset();
      expect(await harness.readRaw('banners')).toEqual([]);
    });
  });
}
