/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `RefreshTokenBridgeStore` contract (`~/ports/refreshTokenBridge`), ported from
 * `methods/refreshTokenBridge.spec.ts`: the bridge from a rotated refresh token's hash to its
 * encrypted successor, keyed by old hash, user and tenant (a bridge without a tenant is its own
 * key), unexpired reads, and the versioned deletes. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ContractHarness } from './harness';
import type { RefreshTokenBridgeCreateData } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { timeOf, useContractHarness } from './support';

export function describeRefreshTokenBridgeContract(harness: ContractHarness): void {
  describe(`RefreshTokenBridgeStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().refreshTokenBridges;
    const inTenant = <T>(tenantId: string | undefined, run: () => Promise<T>) =>
      tenantId ? tenantStorage.run({ tenantId }, run) : run();
    const upsert = (data: Partial<RefreshTokenBridgeCreateData> = {}) => {
      const bridge: RefreshTokenBridgeCreateData = {
        oldRefreshTokenHash: 'old-hash',
        encryptedNewRefreshToken: 'encrypted-new',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
        ...data,
      };
      return inTenant(bridge.tenantId, () => stores().upsertRefreshTokenBridge(bridge));
    };

    describe('upsertRefreshTokenBridge', () => {
      it('creates the bridge and resolves to it', async () => {
        const stored = await upsert({
          tenantId: 'tenant-1',
          openidIssuer: 'https://issuer.example.com',
          version: 'v1',
        });
        expect(stored).toMatchObject({
          oldRefreshTokenHash: 'old-hash',
          encryptedNewRefreshToken: 'encrypted-new',
          userId: 'user-1',
          tenantId: 'tenant-1',
          openidIssuer: 'https://issuer.example.com',
          version: 'v1',
        });
        const [record] = await harness.readRaw('refreshtokenbridges');
        expect(record).toMatchObject({ oldRefreshTokenHash: 'old-hash', tenantId: 'tenant-1' });
        expect(record.createdAt).toBeInstanceOf(Date);
      });

      it('replaces the token, version, expiry and issuer of the existing bridge', async () => {
        await upsert({
          encryptedNewRefreshToken: 'encrypted-old',
          openidIssuer: 'https://issuer.example.com',
          version: 'v1',
        });
        const [first] = await harness.readRaw('refreshtokenbridges');
        const nextExpiresAt = new Date(Date.now() + 120_000);
        const stored = await upsert({
          encryptedNewRefreshToken: 'encrypted-new',
          version: 'v2',
          expiresAt: nextExpiresAt,
        });
        expect(stored).toMatchObject({ encryptedNewRefreshToken: 'encrypted-new', version: 'v2' });
        expect(stored).not.toHaveProperty('openidIssuer');
        const records = await harness.readRaw('refreshtokenbridges');
        expect(records).toHaveLength(1);
        expect(timeOf(records[0].expiresAt)).toBe(nextExpiresAt.getTime());
        expect(timeOf(records[0].createdAt)).toBe(timeOf(first.createdAt));
        expect(records[0]).not.toHaveProperty('openidIssuer');
      });

      it('keeps bridges of other users and tenants apart', async () => {
        await upsert();
        await upsert({ userId: 'user-2' });
        await upsert({ tenantId: 'tenant-1' });
        expect(await harness.readRaw('refreshtokenbridges')).toHaveLength(3);
      });
    });

    describe('findRefreshTokenBridge', () => {
      it('finds the bridge by old hash, user and tenant', async () => {
        await upsert({ tenantId: 'tenant-1', openidIssuer: 'https://issuer.example.com' });
        const found = await inTenant('tenant-1', () =>
          stores().findRefreshTokenBridge({
            oldRefreshTokenHash: 'old-hash',
            userId: 'user-1',
            tenantId: 'tenant-1',
          }),
        );
        expect(found).toMatchObject({
          encryptedNewRefreshToken: 'encrypted-new',
          openidIssuer: 'https://issuer.example.com',
        });
        expect(found?.expiresAt).toBeInstanceOf(Date);
      });

      it('keeps a bridge without a tenant apart from tenant bridges', async () => {
        await upsert({ tenantId: 'tenant-1' });
        expect(
          await stores().findRefreshTokenBridge({
            oldRefreshTokenHash: 'old-hash',
            userId: 'user-1',
          }),
        ).toBeNull();
        await upsert({ encryptedNewRefreshToken: 'tenantless' });
        expect(
          await stores().findRefreshTokenBridge({
            oldRefreshTokenHash: 'old-hash',
            userId: 'user-1',
          }),
        ).toMatchObject({ encryptedNewRefreshToken: 'tenantless' });
        expect(
          await stores().findRefreshTokenBridge({
            oldRefreshTokenHash: 'old-hash',
            userId: 'user-2',
          }),
        ).toBeNull();
      });

      it('leaves out an expired bridge before any cleanup', async () => {
        await upsert({ expiresAt: new Date(Date.now() - 1000) });
        expect(
          await stores().findRefreshTokenBridge({
            oldRefreshTokenHash: 'old-hash',
            userId: 'user-1',
          }),
        ).toBeNull();
      });
    });

    describe('deleteRefreshTokenBridges', () => {
      it("deletes only the listed hashes of the user's bridges in the tenant", async () => {
        for (const [oldRefreshTokenHash, userId, tenantId] of [
          ['hash-a', 'user-1', 'tenant-1'],
          ['hash-b', 'user-1', 'tenant-1'],
          ['hash-c', 'user-1', 'tenant-1'],
          ['hash-a', 'user-2', 'tenant-1'],
          ['hash-a', 'user-1', 'tenant-2'],
        ]) {
          await upsert({ oldRefreshTokenHash, userId, tenantId });
        }
        const result = await inTenant('tenant-1', () =>
          stores().deleteRefreshTokenBridges({
            oldRefreshTokenHashes: ['hash-a', 'hash-b'],
            userId: 'user-1',
            tenantId: 'tenant-1',
          }),
        );
        expect(result.deletedCount).toBe(2);
        expect(
          (await harness.readRaw('refreshtokenbridges'))
            .map((record) => `${record.oldRefreshTokenHash}/${record.userId}/${record.tenantId}`)
            .sort(),
        ).toEqual(['hash-a/user-1/tenant-2', 'hash-a/user-2/tenant-1', 'hash-c/user-1/tenant-1']);
      });

      it('does not let a stale version delete its replacement', async () => {
        await upsert({
          tenantId: 'tenant-1',
          version: 'owner-version',
          encryptedNewRefreshToken: 'a',
        });
        await upsert({
          tenantId: 'tenant-1',
          version: 'winner-version',
          encryptedNewRefreshToken: 'b',
        });
        const query = { userId: 'user-1', tenantId: 'tenant-1' };
        const stale = await inTenant('tenant-1', () =>
          stores().deleteRefreshTokenBridges({
            ...query,
            oldRefreshTokenHashes: ['old-hash'],
            version: 'owner-version',
          }),
        );
        expect(stale.deletedCount).toBe(0);
        expect(
          await inTenant('tenant-1', () =>
            stores().findRefreshTokenBridge({ ...query, oldRefreshTokenHash: 'old-hash' }),
          ),
        ).toMatchObject({ encryptedNewRefreshToken: 'b', version: 'winner-version' });
        const current = await inTenant('tenant-1', () =>
          stores().deleteRefreshTokenBridges({ ...query, version: 'winner-version' }),
        );
        expect(current.deletedCount).toBe(1);
      });

      it('deletes every bridge of the user in the tenant, or only the tenantless ones', async () => {
        for (const [oldRefreshTokenHash, userId, tenantId] of [
          ['hash-a', 'user-1', 'tenant-1'],
          ['hash-b', 'user-1', 'tenant-1'],
          ['hash-c', 'user-2', 'tenant-1'],
          ['hash-d', 'user-1', undefined],
        ] as const) {
          await upsert({ oldRefreshTokenHash, userId, tenantId });
        }
        const tenantResult = await inTenant('tenant-1', () =>
          stores().deleteRefreshTokenBridges({ userId: 'user-1', tenantId: 'tenant-1' }),
        );
        expect(tenantResult.deletedCount).toBe(2);
        const legacyResult = await stores().deleteRefreshTokenBridges({ userId: 'user-1' });
        expect(legacyResult.deletedCount).toBe(1);
        expect(
          (await harness.readRaw('refreshtokenbridges')).map(
            (record) => record.oldRefreshTokenHash,
          ),
        ).toEqual(['hash-c']);
      });
    });
  });
}
