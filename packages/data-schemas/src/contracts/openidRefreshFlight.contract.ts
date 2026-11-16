/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `OpenIDRefreshFlightStore` contract (`~/ports/openidRefreshFlight`), ported from
 * `methods/openidRefreshFlight.spec.ts`: the single-flight lock on an OpenID refresh (acquire,
 * join, reclaim), its owner-only renew, complete and fail, the delivery claim and release, and
 * the logout revocation fence. The first acquisition and a revocation without a flight resolve
 * hydrated documents with MongoDB; the cases read them through their fields only. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { OpenIDRefreshFlightCreateData } from '~/types';
import { timeOf, useContractHarness } from './support';

const later = (ms: number) => new Date(Date.now() + ms);

export function describeOpenIDRefreshFlightContract(harness: ContractHarness): void {
  describe(`OpenIDRefreshFlightStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().openidRefreshFlights;
    const acquire = (data: Partial<OpenIDRefreshFlightCreateData> = {}) =>
      stores().acquireOpenIDRefreshFlight({
        key: 'flight-key',
        ownerId: 'owner-1',
        lockExpiresAt: later(30_000),
        expiresAt: later(60_000),
        ...data,
      });
    const complete = (key = 'flight-key', encryptedResult = 'encrypted-result') =>
      stores().completeOpenIDRefreshFlight({
        key,
        ownerId: 'owner-1',
        encryptedResult,
        expiresAt: later(60_000),
      });
    const flightRecord = (overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      key: 'flight-key',
      ownerId: 'owner-1',
      status: 'pending',
      lockExpiresAt: later(30_000),
      expiresAt: later(60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
    const stored = async (key = 'flight-key') =>
      (await harness.readRaw('openidrefreshflights')).filter((record) => record.key === key);

    describe('acquireOpenIDRefreshFlight', () => {
      it('starts a pending flight, and hands the live flight to joiners', async () => {
        const first = await acquire();
        const second = await acquire({ ownerId: 'owner-2' });
        expect(first.acquired).toBe(true);
        expect(first.flight).toMatchObject({
          key: 'flight-key',
          ownerId: 'owner-1',
          status: 'pending',
        });
        expect(second.acquired).toBe(false);
        expect(second.flight).toMatchObject({ ownerId: 'owner-1', status: 'pending' });
        expect(await stored()).toHaveLength(1);
      });

      it('lets one of concurrent acquisitions win', async () => {
        const results = await Promise.all(['a', 'b', 'c'].map((ownerId) => acquire({ ownerId })));
        expect(results.filter((result) => result.acquired)).toHaveLength(1);
        expect(await stored()).toHaveLength(1);
      });

      it('takes over a pending flight whose lock lapsed, as a new generation', async () => {
        const oldCreatedAt = new Date('2020-01-01T00:00:00.000Z');
        await harness.seedRaw('openidrefreshflights', [
          flightRecord({ lockExpiresAt: later(-1000), createdAt: oldCreatedAt }),
        ]);
        const reclaimed = await acquire({ ownerId: 'owner-2' });
        expect(reclaimed.acquired).toBe(true);
        expect(reclaimed.flight?.ownerId).toBe('owner-2');
        expect(timeOf(reclaimed.flight?.createdAt)).toBeGreaterThan(oldCreatedAt.getTime());
      });

      it('takes over a failed flight at once, clearing its error', async () => {
        await acquire();
        await stores().failOpenIDRefreshFlight({
          key: 'flight-key',
          ownerId: 'owner-1',
          errorMessage: 'upstream timeout',
          expiresAt: later(60_000),
        });
        const reclaimed = await acquire({ ownerId: 'owner-2' });
        expect(reclaimed.acquired).toBe(true);
        expect(reclaimed.flight).toMatchObject({ ownerId: 'owner-2', status: 'pending' });
        expect(reclaimed.flight?.errorMessage).toBeUndefined();
      });

      it('takes over an expired flight, dropping its result', async () => {
        await harness.seedRaw('openidrefreshflights', [
          flightRecord({ status: 'completed', encryptedResult: 'old', expiresAt: later(-1000) }),
        ]);
        const reclaimed = await acquire({ ownerId: 'owner-2' });
        expect(reclaimed.acquired).toBe(true);
        expect(reclaimed.flight?.encryptedResult).toBeUndefined();
        expect((await stored())[0]).not.toHaveProperty('encryptedResult');
      });

      it('joins a live completed flight without taking it over', async () => {
        await acquire();
        await complete();
        const joined = await acquire({ ownerId: 'owner-2' });
        expect(joined).toMatchObject({
          acquired: false,
          flight: { status: 'completed', encryptedResult: 'encrypted-result', ownerId: 'owner-1' },
        });
      });
    });

    describe('renewOpenIDRefreshFlight', () => {
      it("extends only the owner's pending flight", async () => {
        await acquire();
        const lockExpiresAt = later(45_000);
        const expiresAt = later(90_000);
        expect(
          await stores().renewOpenIDRefreshFlight({
            key: 'flight-key',
            ownerId: 'owner-2',
            lockExpiresAt,
            expiresAt,
          }),
        ).toBeNull();
        const renewed = await stores().renewOpenIDRefreshFlight({
          key: 'flight-key',
          ownerId: 'owner-1',
          lockExpiresAt,
          expiresAt,
        });
        expect(renewed).toMatchObject({ ownerId: 'owner-1', status: 'pending' });
        expect(timeOf(renewed?.lockExpiresAt)).toBe(lockExpiresAt.getTime());
        expect(timeOf(renewed?.expiresAt)).toBe(expiresAt.getTime());
        await complete();
        expect(
          await stores().renewOpenIDRefreshFlight({
            key: 'flight-key',
            ownerId: 'owner-1',
            lockExpiresAt,
            expiresAt,
          }),
        ).toBeNull();
      });
    });

    describe('completeOpenIDRefreshFlight', () => {
      it("completes only the owner's pending flight, storing the result", async () => {
        await acquire();
        expect(
          await stores().completeOpenIDRefreshFlight({
            key: 'flight-key',
            ownerId: 'owner-2',
            encryptedResult: 'wrong',
            expiresAt: later(60_000),
          }),
        ).toBeNull();
        const completed = await complete();
        expect(completed).toMatchObject({
          status: 'completed',
          encryptedResult: 'encrypted-result',
        });
        expect(await complete('flight-key', 'again')).toBeNull();
        expect((await stored())[0]).toMatchObject({ encryptedResult: 'encrypted-result' });
      });
    });

    describe('failOpenIDRefreshFlight', () => {
      it("fails only the owner's pending flight, storing the error", async () => {
        await acquire();
        const fail = (ownerId: string) =>
          stores().failOpenIDRefreshFlight({
            key: 'flight-key',
            ownerId,
            errorMessage: 'upstream timeout',
            expiresAt: later(60_000),
          });
        expect(await fail('owner-2')).toBeNull();
        expect(await fail('owner-1')).toMatchObject({
          status: 'failed',
          errorMessage: 'upstream timeout',
        });
        expect(await fail('owner-1')).toBeNull();
      });
    });

    describe('findOpenIDRefreshFlight', () => {
      it('finds the unexpired flight, and ignores an expired one', async () => {
        await acquire();
        await complete();
        expect(await stores().findOpenIDRefreshFlight({ key: 'flight-key' })).toMatchObject({
          status: 'completed',
          encryptedResult: 'encrypted-result',
        });
        expect(await stores().findOpenIDRefreshFlight({ key: 'other' })).toBeNull();
        await harness.reset();
        await harness.seedRaw('openidrefreshflights', [
          flightRecord({ status: 'completed', expiresAt: later(-1000) }),
        ]);
        expect(await stores().findOpenIDRefreshFlight({ key: 'flight-key' })).toBeNull();
      });
    });

    describe('claimOpenIDRefreshFlightDelivery and releaseOpenIDRefreshFlightDelivery', () => {
      const claim = (deliveryId: string, extra: { createdAt?: Date; key?: string } = {}) =>
        stores().claimOpenIDRefreshFlightDelivery({
          key: extra.key ?? 'flight-key',
          ownerId: 'owner-1',
          deliveryId,
          deliveryExpiresAt: later(30_000),
          ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
        });
      const release = (deliveryId: string, key = 'flight-key') =>
        stores().releaseOpenIDRefreshFlightDelivery({ key, ownerId: 'owner-1', deliveryId });

      it('serializes deliveries of a completed flight, keeping its result', async () => {
        await acquire();
        await complete();
        expect(await claim('delivery-1')).toMatchObject({
          status: 'completed',
          deliveryId: 'delivery-1',
        });
        expect(await claim('delivery-2')).toBeNull();
        const released = await release('delivery-1');
        expect(released).toMatchObject({
          status: 'completed',
          encryptedResult: 'encrypted-result',
        });
        expect(released?.deliveryId).toBeUndefined();
        expect(await claim('delivery-2')).toMatchObject({ deliveryId: 'delivery-2' });
      });

      it('extends the flight to cover the delivery', async () => {
        await acquire({ expiresAt: later(10_000) });
        await stores().completeOpenIDRefreshFlight({
          key: 'flight-key',
          ownerId: 'owner-1',
          encryptedResult: 'r',
          expiresAt: later(10_000),
        });
        const deliveryExpiresAt = later(30_000);
        const claimed = await stores().claimOpenIDRefreshFlightDelivery({
          key: 'flight-key',
          ownerId: 'owner-1',
          deliveryId: 'delivery-1',
          deliveryExpiresAt,
        });
        expect(timeOf(claimed?.expiresAt)).toBe(deliveryExpiresAt.getTime());
      });

      it('refuses a pending flight, another owner, and a missing flight without createdAt', async () => {
        await acquire();
        expect(await claim('delivery-1')).toBeNull();
        await complete();
        expect(
          await stores().claimOpenIDRefreshFlightDelivery({
            key: 'flight-key',
            ownerId: 'owner-2',
            deliveryId: 'delivery-1',
            deliveryExpiresAt: later(30_000),
          }),
        ).toBeNull();
        expect(await claim('delivery-1', { key: 'missing' })).toBeNull();
        expect(await stored('missing')).toEqual([]);
      });

      it('recreates an absent generation for delivery, and removes it on release', async () => {
        const createdAt = new Date('2026-08-29T12:00:00.000Z');
        const claimed = await claim('delivery-1', { key: 'expired-generation', createdAt });
        expect(claimed).toMatchObject({
          key: 'expired-generation',
          ownerId: 'owner-1',
          status: 'completed',
          deliveryId: 'delivery-1',
        });
        expect(timeOf(claimed?.createdAt)).toBe(createdAt.getTime());
        expect(await release('delivery-1', 'expired-generation')).toBeNull();
        expect(await stored('expired-generation')).toEqual([]);
      });

      it('resolves null when releasing a delivery it does not hold', async () => {
        await acquire();
        await complete();
        await claim('delivery-1');
        expect(await release('delivery-2')).toBeNull();
        expect((await stored())[0]).toMatchObject({ deliveryId: 'delivery-1' });
      });
    });

    describe('revokeOpenIDRefreshFlight', () => {
      it('fences a pending flight so its owner cannot publish or anyone reacquire', async () => {
        await acquire();
        const expiresAt = later(3_600_000);
        const revoked = await stores().revokeOpenIDRefreshFlight({ key: 'flight-key', expiresAt });
        expect(revoked).toMatchObject({ status: 'revoked', ownerId: 'revoked' });
        expect(timeOf(revoked?.expiresAt)).toBe(expiresAt.getTime());
        expect(await complete('flight-key', 'late-result')).toBeNull();
        const reacquire = await acquire({ ownerId: 'owner-2' });
        expect(reacquire).toMatchObject({ acquired: false, flight: { status: 'revoked' } });
      });

      it('keeps a completed result when it revokes the flight', async () => {
        await acquire();
        await complete('flight-key', 'encrypted-successor');
        expect(
          await stores().revokeOpenIDRefreshFlight({
            key: 'flight-key',
            expiresAt: later(3_600_000),
          }),
        ).toMatchObject({ status: 'revoked', encryptedResult: 'encrypted-successor' });
      });

      it('records a revoked flight when there is none', async () => {
        const revoked = await stores().revokeOpenIDRefreshFlight({
          key: 'fresh',
          expiresAt: later(3_600_000),
        });
        expect(revoked).toMatchObject({ key: 'fresh', status: 'revoked', ownerId: 'revoked' });
        expect(await stored('fresh')).toHaveLength(1);
        expect((await acquire({ key: 'fresh' })).acquired).toBe(false);
      });

      it('waits for a live delivery, which applies the revocation on release', async () => {
        await acquire();
        await complete();
        await stores().claimOpenIDRefreshFlightDelivery({
          key: 'flight-key',
          ownerId: 'owner-1',
          deliveryId: 'delivery-1',
          deliveryExpiresAt: later(30_000),
        });
        let settled = false;
        const logout = stores()
          .revokeOpenIDRefreshFlight({ key: 'flight-key', expiresAt: later(3_600_000) })
          .finally(() => {
            settled = true;
          });
        let requested = false;
        for (let attempt = 0; attempt < 50 && !requested; attempt++) {
          requested = Boolean((await stored())[0]?.revocationRequestedAt);
          if (!requested) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(requested).toBe(true);
        expect(settled).toBe(false);
        expect(
          await stores().claimOpenIDRefreshFlightDelivery({
            key: 'flight-key',
            ownerId: 'owner-1',
            deliveryId: 'delivery-2',
            deliveryExpiresAt: later(30_000),
          }),
        ).toBeNull();
        const released = await stores().releaseOpenIDRefreshFlightDelivery({
          key: 'flight-key',
          ownerId: 'owner-1',
          deliveryId: 'delivery-1',
        });
        expect(released?.status).toBe('revoked');
        await expect(logout).resolves.toMatchObject({
          status: 'revoked',
          encryptedResult: 'encrypted-result',
        });
      });

      it('treats a delivery without an expiry as abandoned', async () => {
        await harness.seedRaw('openidrefreshflights', [
          flightRecord({
            status: 'completed',
            encryptedResult: 'encrypted-result',
            deliveryId: 'orphaned-delivery',
          }),
        ]);
        await expect(
          stores().revokeOpenIDRefreshFlight({ key: 'flight-key', expiresAt: later(3_600_000) }),
        ).resolves.toMatchObject({ status: 'revoked' });
      });
    });
  });
}
