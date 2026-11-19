/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `CredentialMarkerStore` contract (`~/ports/credentialMarker`), ported from
 * `adapters/mongo/credentialMarker.spec.ts`: the marker a backend serves through
 * `DataStoreBackend.getCredentialMarkerStore`, on every backend. Where the marker is kept is each
 * backend's own business; `readMarker` may return backend fields besides the stated ones, so the
 * cases compare those. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { CredentialMarkerStore } from '~/ports/credentialMarker';
import type { InfrastructureContractHarness } from './infrastructure';
import { CREDENTIAL_MARKER_STORE_METHODS } from '~/ports/credentialMarker';
import { useInfrastructureHarness } from './infrastructure';

export function describeCredentialMarkerContract(harness: InfrastructureContractHarness): void {
  describe(`CredentialMarkerStore contract: ${harness.name}`, () => {
    useInfrastructureHarness(harness);

    const markers = (): CredentialMarkerStore => {
      const store = harness.backend().getCredentialMarkerStore();
      if (!store) {
        throw new Error('The connected backend served no credential marker store');
      }
      return store;
    };
    const stated = (marker: object | null) =>
      marker && {
        fingerprints: (marker as { fingerprints?: unknown }).fingerprints,
        createdAt: (marker as { createdAt?: unknown }).createdAt,
      };

    it('has every port method, each listed once', () => {
      expect(Object.keys(markers()).sort()).toEqual([...CREDENTIAL_MARKER_STORE_METHODS].sort());
      expect(new Set(CREDENTIAL_MARKER_STORE_METHODS).size).toBe(
        CREDENTIAL_MARKER_STORE_METHODS.length,
      );
    });

    it('is null while the database is not connected', () => {
      expect(harness.disconnectedBackend().getCredentialMarkerStore()).toBeNull();
    });

    it('says whether users exist', async () => {
      expect(await markers().hasUsers()).toBe(false);
      await harness.seedUser();
      expect(await markers().hasUsers()).toBe(true);
      await harness.seedUser();
      expect(await markers().hasUsers()).toBe(true);
    });

    it('reads no marker before one is recorded', async () => {
      expect(await markers().readMarker()).toBeNull();
    });

    it('records the marker once and never overwrites it', async () => {
      const store = markers();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      expect(await store.recordMarkerIfAbsent({ fingerprints: { A: 'one' }, createdAt })).toBe(
        true,
      );
      expect(
        await store.recordMarkerIfAbsent({ fingerprints: { A: 'two' }, createdAt: new Date() }),
      ).toBe(false);
      expect(stated(await store.readMarker())).toEqual({ fingerprints: { A: 'one' }, createdAt });
    });

    it('keeps every fingerprint and the exact creation time', async () => {
      const fingerprints = {
        CREDS_KEY: 'a'.repeat(64),
        CREDS_IV: 'b1c2d3',
        JWT_SECRET: 'sha256:Zm9v/YmFy+==',
        JWT_REFRESH_SECRET: 'é✓',
      };
      const createdAt = new Date('2025-06-30T12:34:56.789Z');
      await markers().recordMarkerIfAbsent({ fingerprints, createdAt });
      const marker = await markers().readMarker();
      expect(stated(marker)).toEqual({ fingerprints, createdAt });
      expect((marker?.createdAt as Date).getTime()).toBe(createdAt.getTime());
    });

    it('records an empty set of fingerprints', async () => {
      const createdAt = new Date('2026-02-02T00:00:00Z');
      expect(await markers().recordMarkerIfAbsent({ fingerprints: {}, createdAt })).toBe(true);
      expect(stated(await markers().readMarker())).toEqual({ fingerprints: {}, createdAt });
    });

    it('records exactly one marker when several startups race', async () => {
      const createdAt = new Date('2026-03-03T00:00:00Z');
      const results = await Promise.all(
        ['one', 'two', 'three', 'four', 'five'].map((value) =>
          markers().recordMarkerIfAbsent({ fingerprints: { A: value }, createdAt }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = ['one', 'two', 'three', 'four', 'five'][results.indexOf(true)];
      expect(stated(await markers().readMarker())).toEqual({
        fingerprints: { A: winner },
        createdAt,
      });
    });

    it('serves the same marker through every store it hands out', async () => {
      const createdAt = new Date('2026-04-04T00:00:00Z');
      await markers().recordMarkerIfAbsent({ fingerprints: { A: 'shared' }, createdAt });
      expect(stated(await markers().readMarker())).toEqual({
        fingerprints: { A: 'shared' },
        createdAt,
      });
    });
  });
}
