/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `MCPAuthorizationFenceRetryStore` contract (`~/ports/mcpAuthorizationFenceRetry`), ported
 * from `methods/mcpAuthorizationFenceRetry.spec.ts` (which spies on the driver calls) and
 * `@librechat/api`'s retry service, its caller: the durable retries are keyed by tenant, user,
 * server and version in the raw `mcp_authorization_fence_retries` collection; an upsert of the
 * same key refreshes its update time and keeps its creation time; the delete and the deferral
 * (a compare-and-set that only moves the update time forward) touch the exact version only and
 * never create a retry; the listing reads every tenant, oldest update first, up to its limit.
 * The store is built by `createMethods` like every other store (`DataStore`
 * `mcpAuthorizationFenceRetries`). Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { timeOf, useContractHarness } from './support';

const COLLECTION = 'mcp_authorization_fence_retries';
const BASE = Date.parse('2026-06-01T00:00:00.000Z');
/** A fixed instant `seconds` after {@link BASE}. */
const at = (seconds: number) => new Date(BASE + seconds * 1000);

export function describeMCPAuthorizationFenceRetryContract(harness: ContractHarness): void {
  describe(`MCPAuthorizationFenceRetryStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const retries = () => harness.createStores().mcpAuthorizationFenceRetries;
    const scope = { userId: 'user-1', serverName: 'github' };
    /** The stored retries, without their (backend-chosen) record ids, by update time. */
    const stored = async (): Promise<RawRecord[]> =>
      (await harness.readRaw(COLLECTION))
        .map(({ _id: _ignored, ...record }) => record)
        .sort((a, b) => timeOf(a.updatedAt) - timeOf(b.updatedAt));

    describe('upsert', () => {
      it('records a retry with its scope, tenant, version and update and creation times', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(0) });
        const [record, ...rest] = await stored();
        expect(rest).toEqual([]);
        expect(record).toEqual({
          userId: 'user-1',
          serverName: 'github',
          tenantId: 'tenant-a',
          version: 'v1',
          updatedAt: at(0),
          createdAt: at(0),
        });
      });

      it('stores a missing tenant as null, the same retry as an explicit null', async () => {
        await retries().upsert({ scope, version: 'v1', now: at(0) });
        await retries().upsert({ scope, tenantId: null, version: 'v1', now: at(5) });
        const records = await stored();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ tenantId: null, updatedAt: at(5), createdAt: at(0) });
      });

      it('refreshes the update time of the same key and keeps its creation time', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(0) });
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(30) });
        const records = await stored();
        expect(records).toHaveLength(1);
        expect(timeOf(records[0].updatedAt)).toBe(at(30).getTime());
        expect(timeOf(records[0].createdAt)).toBe(at(0).getTime());
      });

      it('moves the update time backwards too: an upsert sets it as given', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(30) });
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(10) });
        const [record] = await stored();
        expect(timeOf(record.updatedAt)).toBe(at(10).getTime());
      });

      it('keeps one retry per tenant, user, server and version', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(0) });
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v2', now: at(1) });
        await retries().upsert({ scope, tenantId: 'tenant-b', version: 'v1', now: at(2) });
        await retries().upsert({
          scope: { userId: 'user-2', serverName: 'github' },
          tenantId: 'tenant-a',
          version: 'v1',
          now: at(3),
        });
        await retries().upsert({
          scope: { userId: 'user-1', serverName: 'gitlab' },
          tenantId: 'tenant-a',
          version: 'v1',
          now: at(4),
        });
        const records = await stored();
        expect(records.map((r) => [r.tenantId, r.userId, r.serverName, r.version])).toEqual([
          ['tenant-a', 'user-1', 'github', 'v1'],
          ['tenant-a', 'user-1', 'github', 'v2'],
          ['tenant-b', 'user-1', 'github', 'v1'],
          ['tenant-a', 'user-2', 'github', 'v1'],
          ['tenant-a', 'user-1', 'gitlab', 'v1'],
        ]);
      });

      it('is not scoped by the ambient tenant: the explicit tenant is stored as given', async () => {
        await tenantStorage.run({ tenantId: 'tenant-ambient' }, () =>
          retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(0) }),
        );
        const [record] = await stored();
        expect(record.tenantId).toBe('tenant-a');
      });
    });

    describe('deleteVersion', () => {
      it('removes the retry of exactly that version and keeps the others', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(0) });
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v2', now: at(1) });
        await retries().upsert({ scope, tenantId: 'tenant-b', version: 'v1', now: at(2) });

        await retries().deleteVersion({ scope, tenantId: 'tenant-a', version: 'v1' });

        const records = await stored();
        expect(records.map((r) => [r.tenantId, r.version])).toEqual([
          ['tenant-a', 'v2'],
          ['tenant-b', 'v1'],
        ]);
      });

      it('does nothing when no retry has that version', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v2', now: at(0) });
        await expect(
          retries().deleteVersion({ scope, tenantId: 'tenant-a', version: 'v1' }),
        ).resolves.toBeUndefined();
        await expect(
          retries().deleteVersion({ scope, tenantId: 'tenant-c', version: 'v2' }),
        ).resolves.toBeUndefined();
        expect(await stored()).toHaveLength(1);
      });
    });

    describe('deferVersion', () => {
      it('pushes the update time forward and never back (compare-and-set on the time)', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(10) });

        await retries().deferVersion({
          scope,
          tenantId: 'tenant-a',
          version: 'v1',
          updatedAt: at(60),
        });
        expect(timeOf((await stored())[0].updatedAt)).toBe(at(60).getTime());

        await retries().deferVersion({
          scope,
          tenantId: 'tenant-a',
          version: 'v1',
          updatedAt: at(20),
        });
        const [record] = await stored();
        expect(timeOf(record.updatedAt)).toBe(at(60).getTime());
        expect(timeOf(record.createdAt)).toBe(at(10).getTime());
      });

      it('touches the exact version only and never creates a retry', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v2', now: at(10) });

        await retries().deferVersion({
          scope,
          tenantId: 'tenant-a',
          version: 'v1',
          updatedAt: at(60),
        });
        await retries().deferVersion({
          scope,
          tenantId: 'tenant-b',
          version: 'v2',
          updatedAt: at(60),
        });

        const records = await stored();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ tenantId: 'tenant-a', version: 'v2' });
        expect(timeOf(records[0].updatedAt)).toBe(at(10).getTime());
      });
    });

    describe('list', () => {
      it('lists every tenant, oldest update first, up to the limit', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-b', version: 'v3', now: at(30) });
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(10) });
        await retries().upsert({ scope, version: 'v2', now: at(20) });

        const all = await retries().list(10);
        expect(all.map((r) => [r.tenantId, r.version])).toEqual([
          ['tenant-a', 'v1'],
          [null, 'v2'],
          ['tenant-b', 'v3'],
        ]);
        expect(all[0]).toMatchObject({
          userId: 'user-1',
          serverName: 'github',
          tenantId: 'tenant-a',
          version: 'v1',
        });
        expect(timeOf(all[0].updatedAt)).toBe(at(10).getTime());

        const firstTwo = await retries().list(2);
        expect(firstTwo.map((r) => r.version)).toEqual(['v1', 'v2']);
      });

      it('orders by the deferred update time', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(10) });
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v2', now: at(20) });
        await retries().deferVersion({
          scope,
          tenantId: 'tenant-a',
          version: 'v1',
          updatedAt: at(30),
        });
        expect((await retries().list(10)).map((r) => r.version)).toEqual(['v2', 'v1']);
      });

      it('reads across tenants from inside a tenant context or as the system', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(10) });
        await retries().upsert({ scope, tenantId: 'tenant-b', version: 'v2', now: at(20) });
        const inTenant = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          retries().list(10),
        );
        expect(inTenant.map((r) => r.tenantId)).toEqual(['tenant-a', 'tenant-b']);
        const asSystem = await runAsSystem(() => retries().list(10));
        expect(asSystem.map((r) => r.tenantId)).toEqual(['tenant-a', 'tenant-b']);
      });

      it('lists nothing when no retry is pending', async () => {
        await expect(retries().list(5)).resolves.toEqual([]);
      });

      it('no longer lists a deleted retry', async () => {
        await retries().upsert({ scope, tenantId: 'tenant-a', version: 'v1', now: at(10) });
        await retries().deleteVersion({ scope, tenantId: 'tenant-a', version: 'v1' });
        await expect(retries().list(5)).resolves.toEqual([]);
      });
    });
  });
}
