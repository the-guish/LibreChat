/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `BannerStore` contract (`~/ports/banner`): the current banner by display window, type and
 * visibility, the one-record write and the delete. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ContractHarness } from './harness';
import type { IUser } from '~/types';
import { idOf, useContractHarness } from './support';

const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');

export function describeBannerContract(harness: ContractHarness): void {
  describe(`BannerStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const banner = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      bannerId: 'banner-1',
      message: 'Hello',
      displayFrom: PAST,
      displayTo: FUTURE,
      type: 'banner',
      isPublic: true,
      persistable: false,
      ...overrides,
    });
    const user = { _id: harness.ids.generate() } as unknown as IUser;

    describe('getBanner', () => {
      it('returns the public banner whose display window holds now', async () => {
        const record = banner();
        await harness.seedRaw('banners', [record]);
        const found = await harness.createStores().banners.getBanner();
        expect(found).toMatchObject({ bannerId: 'banner-1', message: 'Hello', isPublic: true });
        expect(idOf(harness, found?._id)).toBe(record._id);
      });

      it('treats a null display end as open', async () => {
        await harness.seedRaw('banners', [banner({ displayTo: null })]);
        expect(await harness.createStores().banners.getBanner()).toMatchObject({
          bannerId: 'banner-1',
        });
      });

      it('returns null when no window holds now (not started, or ended)', async () => {
        await harness.seedRaw('banners', [
          banner({ bannerId: 'later', displayFrom: FUTURE, displayTo: null }),
          banner({ bannerId: 'ended', displayTo: new Date('2021-01-01T00:00:00.000Z') }),
        ]);
        expect(await harness.createStores().banners.getBanner()).toBeNull();
        expect(await harness.createStores().banners.getBanner(user)).toBeNull();
      });

      it('ignores records of another type (popups)', async () => {
        await harness.seedRaw('banners', [banner({ type: 'popup' })]);
        expect(await harness.createStores().banners.getBanner(user)).toBeNull();
      });

      it('hides a banner that is not public unless a user is given', async () => {
        await harness.seedRaw('banners', [banner({ isPublic: false })]);
        const { banners } = harness.createStores();
        expect(await banners.getBanner()).toBeNull();
        expect(await banners.getBanner(null)).toBeNull();
        expect(await banners.getBanner(user)).toMatchObject({ bannerId: 'banner-1' });
      });

      it('returns null when there is no banner', async () => {
        expect(await harness.createStores().banners.getBanner(user)).toBeNull();
      });
    });

    describe('getCurrentBannerRecord', () => {
      it('returns the current record whatever its type and visibility', async () => {
        const record = banner({ type: 'popup', isPublic: false, displayTo: null });
        await harness.seedRaw('banners', [record]);
        const found = await harness.createStores().banners.getCurrentBannerRecord();
        expect(found).toMatchObject({ type: 'popup', isPublic: false });
        expect(idOf(harness, found?._id)).toBe(record._id);
      });

      it('returns null when no window holds now', async () => {
        await harness.seedRaw('banners', [banner({ displayFrom: FUTURE })]);
        expect(await harness.createStores().banners.getCurrentBannerRecord()).toBeNull();
      });
    });

    describe('deleteBannerRecord', () => {
      it('deletes the record with the id and leaves the others', async () => {
        const first = banner();
        const second = banner({ bannerId: 'banner-2' });
        await harness.seedRaw('banners', [first, second]);
        await harness.createStores().banners.deleteBannerRecord(first._id);
        const remaining = await harness.readRaw('banners');
        expect(remaining.map((record) => record._id)).toEqual([second._id]);
      });

      it('is a no-op for an id that is gone', async () => {
        await harness.seedRaw('banners', [banner()]);
        await expect(
          harness.createStores().banners.deleteBannerRecord(harness.ids.generate()),
        ).resolves.toBeUndefined();
        expect(await harness.readRaw('banners')).toHaveLength(1);
      });
    });

    describe('saveBanner', () => {
      const fields = {
        bannerId: 'saved',
        message: 'Saved banner',
        displayFrom: PAST,
        displayTo: null,
        isPublic: true,
        persistable: true,
      };

      it('creates the banner record when there is none, with the default type', async () => {
        const saved = await harness.createStores().banners.saveBanner(fields);
        expect(saved).toMatchObject({ bannerId: 'saved', message: 'Saved banner', type: 'banner' });
        const records = await harness.readRaw('banners');
        expect(records).toHaveLength(1);
        expect(idOf(harness, saved?._id)).toBe(records[0]._id);
        expect(records[0]).toMatchObject({ bannerId: 'saved', persistable: true });
      });

      it('replaces the one existing record instead of adding one', async () => {
        const existing = banner();
        await harness.seedRaw('banners', [existing]);
        const saved = await harness.createStores().banners.saveBanner({
          ...fields,
          displayTo: FUTURE,
        });
        expect(idOf(harness, saved?._id)).toBe(existing._id);
        expect(saved).toMatchObject({ bannerId: 'saved', message: 'Saved banner' });
        const records = await harness.readRaw('banners');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          _id: existing._id,
          bannerId: 'saved',
          displayTo: FUTURE,
          persistable: true,
        });
      });

      it('makes the written banner the current one', async () => {
        const { banners } = harness.createStores();
        await banners.saveBanner(fields);
        expect(await banners.getBanner()).toMatchObject({ bannerId: 'saved' });
      });
    });
  });
}
