/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `BrowserSetupBackendStore` contract (`~/ports/browserSetup`), ported from
 * `methods/browserSetup.integration.spec.ts`: the backend's four members (the setup session
 * store it builds, the code environment setup index build, the user read the setup policy checks,
 * the connection state) and, through `createStore`, the setup session store over the raw
 * `browser_setup_sessions`, `browser_setup_budget` and `browser_setup_requests` collections:
 * idempotent starts converging on the first session, the allocation budget singleton (global and
 * per-peer bounds, its allocation snapshots restored by reconciliation when a session insert was
 * lost, released only after terminal cleanup), the request budget singleton with its per-peer
 * counters and window, the revision compare-and-set and write-once fields of `update`, the
 * exclusive leases, the nonces (shared, bounded, replay-safe, pruned when expired, operation
 * counts kept) and the reconciliation listing with its order and the TTL date it arms
 * (`deleteAfter`, asserted as stored; the sweep itself is the backend's). The store is built by
 * `createMethods` like every other (`DataStore` `browserSetup`, on the code environment store's
 * instance); each case builds a new one, as a process would.
 *
 * Not here (they stay in the method spec): the index-build spies and a database outage. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import type { BrowserSetupSession, BrowserSetupStore } from '~/types/browserSetup';
import type { ContractHarness, RawRecord } from './harness';
import { tenantStorage } from '~/config/tenantContext';
import { useContractHarness } from './support';

const SESSIONS = 'browser_setup_sessions';
const BUDGET = 'browser_setup_budget';
const REQUESTS = 'browser_setup_requests';
const now = Date.parse('2026-10-22T10:00:00.000Z');
const limits = { global: 4, perIp: 2, windowMs: 60_000 };
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const ipHash = hash('trusted-request-ip');

function session(attemptId: string): BrowserSetupSession {
  const requestCanonical = JSON.stringify({ attemptId, machineName: 'Machine' });
  return {
    attemptId,
    requestCanonical,
    requestHash: hash(requestCanonical),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    verificationCode: 'ABCD-1234',
    workerId: `worker-${attemptId}`,
    status: 'pending',
    revision: 0,
  };
}

export function describeBrowserSetupContract(harness: ContractHarness): void {
  describe(`BrowserSetupBackendStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const backend = () => harness.createStores().browserSetup;
    let store: BrowserSetupStore;
    beforeEach(() => {
      store = backend().createStore();
    });

    const rawWhere = async (collection: string, id: string): Promise<RawRecord | undefined> =>
      (await harness.readRaw(collection)).find((row) => row._id === id);
    const persisted = (attemptId: string) => rawWhere(SESSIONS, attemptId);
    const allocations = async () =>
      ((await rawWhere(BUDGET, 'global'))?.allocations ?? []) as RawRecord[];
    const start = (attemptId: string, peer = ipHash, at = now) =>
      store.start({ session: session(attemptId), ipHash: peer, now: at, limits });
    const keyOf = (original: BrowserSetupSession) => ({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
    });

    /* ------------------------------------------------------------------ backend */

    describe('backend', () => {
      it('isConnected reports the connected database', () => {
        expect(backend().isConnected()).toBe(true);
      });

      it('ensureRegistration builds the code environment setup indexes, again on every call', async () => {
        await expect(backend().ensureRegistration()).resolves.toBeUndefined();
        await expect(backend().ensureRegistration()).resolves.toBeUndefined();
      });

      it('getUser reads the fields the setup policy checks, ids as strings', async () => {
        const id = harness.ids.generate();
        const expiresAt = new Date('2027-01-01T00:00:00.000Z');
        await harness.seedRaw('users', [
          {
            _id: id,
            email: 'setup@example.com',
            password: 'hashed-secret',
            tenantId: 'tenant-a',
            role: 'USER',
            idOnTheSource: 'source-7',
            provider: 'openid',
            emailVerified: true,
            twoFactorEnabled: false,
            termsAccepted: true,
            expiresAt,
          },
        ]);
        const user = await backend().getUser(id);
        expect(user).toEqual({
          id,
          tenantId: 'tenant-a',
          role: 'USER',
          idOnTheSource: 'source-7',
          provider: 'openid',
          emailVerified: true,
          twoFactorEnabled: false,
          termsAccepted: true,
          expiresAt,
          agentTriggerDeletionStartedAt: undefined,
        });
        expect(JSON.stringify(user)).not.toContain('hashed-secret');
      });

      it('getUser gives a missing source id as null, and null for an unknown user', async () => {
        const id = harness.ids.generate();
        await harness.seedRaw('users', [
          { _id: id, email: 'local@example.com', provider: 'local' },
        ]);
        expect(await backend().getUser(id)).toMatchObject({ id, idOnTheSource: null });
        await expect(backend().getUser(harness.ids.generate())).resolves.toBeNull();
      });

      it('getUser reads in the ambient tenant only', async () => {
        const id = harness.ids.generate();
        await harness.seedRaw('users', [
          { _id: id, email: 'scoped@example.com', provider: 'local', tenantId: 'tenant-a' },
        ]);
        await expect(
          tenantStorage.run({ tenantId: 'tenant-b' }, () => backend().getUser(id)),
        ).resolves.toBeNull();
        await expect(
          tenantStorage.run({ tenantId: 'tenant-a' }, () => backend().getUser(id)),
        ).resolves.toMatchObject({ id });
      });

      it('createStore creates the budget singletons on first use, not when built', async () => {
        const fresh = backend().createStore();
        expect(await harness.readRaw(BUDGET)).toEqual([]);
        await expect(fresh.get('missing')).resolves.toBeNull();
        expect(await harness.readRaw(BUDGET)).toEqual([{ _id: 'global', allocations: [] }]);
        expect(await harness.readRaw(REQUESTS)).toEqual([
          { _id: 'global', expiresAt: 0, count: 0, peers: {} },
        ]);
        await backend().createStore().get('missing');
        expect(await harness.readRaw(BUDGET)).toHaveLength(1);
        expect(await harness.readRaw(REQUESTS)).toHaveLength(1);
      });
    });

    /* ------------------------------------------------------------------ start and get */

    describe('start and get', () => {
      it('creates the session with its allocation snapshot, and stores its child data empty', async () => {
        const original = session('attempt');
        await expect(start('attempt')).resolves.toEqual({ status: 'created', session: original });
        expect(await store.get('attempt')).toEqual(original);
        expect(await persisted('attempt')).toEqual({
          _id: 'attempt',
          ...original,
          nonces: [],
          operations: 0,
        });
        expect(await allocations()).toEqual([
          { attemptId: 'attempt', ipHash, expiresAt: now + limits.windowMs, session: original },
        ]);
        await expect(store.get('missing')).resolves.toBeNull();
      });

      it('converges concurrent starts on the first session, also for a new store', async () => {
        const original = session('attempt');
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            store.start({
              session: { ...original, verificationCode: `code-${index}` },
              ipHash,
              now,
              limits,
            }),
          ),
        );
        expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
        const stored = await backend().createStore().get(original.attemptId);
        expect(stored).toMatchObject({ ...original, verificationCode: expect.any(String) });
        expect(results.map((result) => result.status).sort()).toEqual(
          ['created', ...Array.from({ length: 11 }, () => 'replay')].sort(),
        );
        expect(results.map((result) => ('session' in result ? result.session : null))).toEqual(
          results.map(() => stored),
        );
        expect(await allocations()).toHaveLength(1);
      });

      it('reports a conflict for another request under the same attempt id', async () => {
        await start('attempt');
        const altered = {
          ...session('attempt'),
          requestCanonical: '{"different":true}',
          requestHash: hash('{"different":true}'),
        };
        await expect(store.start({ session: altered, ipHash, now, limits })).resolves.toEqual({
          status: 'conflict',
        });
      });

      it('rejects an invalid allocation before writing', async () => {
        const invalid = [
          { ...session('bad'), requestHash: hash('other') },
          { ...session('bad'), status: 'approved' as const },
          { ...session('bad'), revision: 1 },
          { ...session('bad'), ownerId: 'owner' },
          { ...session('bad attempt') },
        ];
        for (const candidate of invalid) {
          await expect(store.start({ session: candidate, ipHash, now, limits })).rejects.toThrow(
            'Invalid browser setup allocation',
          );
        }
        await expect(
          store.start({ session: session('bad'), ipHash: 'not-a-hash', now, limits }),
        ).rejects.toThrow('Invalid browser setup allocation');
        expect(await harness.readRaw(SESSIONS)).toEqual([]);
      });

      it('bounds allocations globally and per peer, atomically under racing starts', async () => {
        const samePeer = await Promise.all(
          Array.from({ length: 6 }, (_, index) => start(`same-${index}`)),
        );
        expect(samePeer.filter((result) => result.status === 'created')).toHaveLength(limits.perIp);
        expect(samePeer.filter((result) => result.status === 'limited')).toHaveLength(
          6 - limits.perIp,
        );
        const others = await Promise.all(
          Array.from({ length: 10 }, (_, index) => start(`other-${index}`, hash(`peer-${index}`))),
        );
        expect(others.filter((result) => result.status === 'created')).toHaveLength(
          limits.global - limits.perIp,
        );
        expect(await allocations()).toHaveLength(limits.global);
        expect(await harness.readRaw(SESSIONS)).toHaveLength(limits.global);
      });

      it('reuses the allocation snapshot when the session insert was lost', async () => {
        const original = session('insert-loss');
        await start('insert-loss');
        // A lost insert: the allocation is reserved, the session record is not there.
        await harness.reset();
        await harness.seedRaw(BUDGET, [
          {
            _id: 'global',
            allocations: [
              {
                attemptId: 'insert-loss',
                ipHash,
                expiresAt: now + limits.windowMs,
                session: original,
              },
            ],
          },
        ]);
        const recovered = await backend()
          .createStore()
          .start({ session: { ...original, verificationCode: 'new-code' }, ipHash, now, limits });
        expect(recovered).toEqual({ status: 'created', session: original });
        expect(await allocations()).toHaveLength(1);
      });
    });

    /* ------------------------------------------------------------------ update */

    describe('update', () => {
      it('compare-and-sets on the revision, so one of two racing owners wins', async () => {
        const original = session('cas');
        await start('cas');
        const race = await Promise.all(
          ['owner-one', 'owner-two'].map((ownerId) =>
            store.update({
              ...keyOf(original),
              revision: 0,
              patch: { ownerId, tenantId: 'tenant-a', status: 'provisioning' },
            }),
          ),
        );
        expect(race.filter(Boolean)).toHaveLength(1);
        const won = race.find((entry) => entry != null)!;
        expect(won).toMatchObject({ revision: 1, status: 'provisioning', tenantId: 'tenant-a' });
        expect(await persisted('cas')).toMatchObject({ revision: 1, ownerId: won.ownerId });
        await expect(
          store.update({ ...keyOf(original), revision: 0, patch: { status: 'approved' } }),
        ).resolves.toBeNull();
        await expect(
          store.update({
            ...keyOf(original),
            requestHash: hash('other'),
            revision: 1,
            patch: { status: 'approved' },
          }),
        ).resolves.toBeNull();
      });

      it('keeps the frozen fields write-once and rejects unknown or cleared ones', async () => {
        const original = session('frozen');
        await start('frozen');
        const frozen = await store.update({
          ...keyOf(original),
          revision: 0,
          patch: { ownerId: 'owner', tenantId: 'tenant-a' },
        });
        await expect(
          store.update({
            ...keyOf(original),
            revision: frozen!.revision,
            patch: { tenantId: 'tenant-b' },
          }),
        ).resolves.toBeNull();
        await expect(
          store.update({
            ...keyOf(original),
            revision: frozen!.revision,
            patch: { tenantId: 'tenant-a', status: 'provisioning' },
          }),
        ).resolves.toMatchObject({ status: 'provisioning' });
        await expect(
          store.update({
            ...keyOf(original),
            revision: frozen!.revision + 1,
            patch: { ownerId: undefined },
          }),
        ).rejects.toThrow('Invalid frozen');
        await expect(
          store.update({
            ...keyOf(original),
            revision: frozen!.revision + 1,
            patch: { workerId: 'replacement' } as never,
          }),
        ).rejects.toThrow('Invalid browser setup update');
        await expect(
          store.update({
            ...keyOf(original),
            revision: frozen!.revision + 1,
            patch: { failureCode: 'lower-case' },
          }),
        ).rejects.toThrow('Invalid browser setup failure code');
      });

      it('merges progress flags and never unsets one', async () => {
        const original = session('progress');
        await start('progress');
        const first = await store.update({
          ...keyOf(original),
          revision: 0,
          patch: { progress: { registryReserved: true } },
        });
        const second = await store.update({
          ...keyOf(original),
          revision: first!.revision,
          patch: { progress: { issued: true } },
        });
        expect(second?.progress).toEqual({ registryReserved: true, issued: true });
        expect((await persisted('progress'))?.progress).toEqual({
          registryReserved: true,
          issued: true,
        });
        await expect(
          store.update({
            ...keyOf(original),
            revision: second!.revision,
            patch: { progress: { issued: false } },
          }),
        ).resolves.toBeNull();
      });

      it('arms the TTL date only once a terminal, cleaned-up session releases its allocation', async () => {
        const original = session('terminal');
        await start('terminal');
        await store.update({
          ...keyOf(original),
          revision: 0,
          patch: { ownerId: 'owner', status: 'provisioning' },
        });
        await expect(
          store.update({
            ...keyOf(original),
            revision: 1,
            patch: { purgeAt: new Date(now).toISOString() },
          }),
        ).rejects.toThrow('Unresolved');
        expect((await persisted('terminal'))?.deleteAfter).toBeUndefined();
        expect(await allocations()).toHaveLength(1);

        const purgeAt = new Date(now + 1000);
        const cancelled = await store.update({
          ...keyOf(original),
          revision: 1,
          patch: {
            status: 'cancelled',
            progress: { cleanup: true },
            purgeAt: purgeAt.toISOString(),
          },
        });
        expect(cancelled).toMatchObject({ status: 'cancelled', purgeAt: purgeAt.toISOString() });
        expect(cancelled).not.toHaveProperty('deleteAfter');
        const stored = await persisted('terminal');
        expect(stored?.deleteAfter).toEqual(purgeAt);
        expect(stored?.allocationReleased).toBe(true);
        expect(await allocations()).toEqual([]);
        // Terminal: no other status any more.
        await expect(
          store.update({ ...keyOf(original), revision: 2, patch: { status: 'approved' } }),
        ).resolves.toBeNull();
      });

      it('a completed withdrawal disarms the TTL until compensation finishes, and cannot reopen', async () => {
        const original = session('withdrawal');
        const clock = Date.now();
        await start('withdrawal');
        const completed = await store.update({
          ...keyOf(original),
          revision: 0,
          patch: {
            status: 'completed',
            tenantId: '',
            stopReason: 'expired',
            progress: { cleanup: true },
            purgeAt: new Date(clock + 60_000).toISOString(),
          },
        });
        expect(completed?.tenantId).toBe('');
        expect((await persisted('withdrawal'))?.deleteAfter).toEqual(new Date(clock + 60_000));
        const claimed = await store.claim({
          ...keyOf(original),
          revision: completed!.revision,
          leaseId: 'withdrawal',
          now: clock,
          leaseMs: 60_000,
        });
        const withdrawn = await store.update({
          ...keyOf(original),
          revision: claimed!.revision,
          leaseId: 'withdrawal',
          patch: { stopReason: 'withdrawn' },
        });
        expect(withdrawn?.progress?.cleanup).toBe(false);
        expect((await persisted('withdrawal'))?.deleteAfter).toBeUndefined();
        for (const patch of [
          { status: 'approved' as const },
          { stopReason: 'cancelled' as const },
        ]) {
          await expect(
            store.update({
              ...keyOf(original),
              revision: withdrawn!.revision,
              leaseId: 'withdrawal',
              patch,
            }),
          ).resolves.toBeNull();
        }
        const failed = await store.update({
          ...keyOf(original),
          revision: withdrawn!.revision,
          leaseId: 'withdrawal',
          patch: {
            status: 'failed',
            progress: { cleanup: true },
            purgeAt: new Date(clock + 120_000).toISOString(),
          },
        });
        await store.release({
          ...keyOf(original),
          revision: failed!.revision,
          leaseId: 'withdrawal',
        });
        expect((await persisted('withdrawal'))?.deleteAfter).toEqual(new Date(clock + 120_000));
      });

      it('resolves null for an unknown attempt', async () => {
        await expect(
          store.update({
            attemptId: 'missing',
            requestHash: hash('x'),
            revision: 0,
            patch: { status: 'approved' },
          }),
        ).resolves.toBeNull();
      });
    });

    /* ------------------------------------------------------------------ leases */

    describe('claim and release', () => {
      it('leases exclusively, fenced by the revision, and lets a successor take an expired lease', async () => {
        const original = session('lease');
        await start('lease');
        const claims = await Promise.all(
          ['lease-a', 'lease-b'].map((leaseId) =>
            store.claim({ ...keyOf(original), revision: 0, leaseId, now, leaseMs: 60_000 }),
          ),
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        const claimed = claims.find((entry) => entry != null)!;
        expect(claimed).toMatchObject({ revision: 1, leaseExpiresAt: now + 60_000 });
        expect(claimed).not.toHaveProperty('reconciledAt');
        expect(await persisted('lease')).toMatchObject({
          leaseId: claimed.leaseId,
          leaseExpiresAt: now + 60_000,
          reconciledAt: now,
        });
        expect(await store.listReconcile(10, now)).toEqual([]);
        // An update without the lease is refused while it is held.
        await expect(
          store.update({
            ...keyOf(original),
            revision: claimed.revision,
            patch: { status: 'provisioning' },
          }),
        ).resolves.toBeNull();
        const next = await backend()
          .createStore()
          .claim({
            ...keyOf(original),
            revision: claimed.revision,
            leaseId: 'successor',
            now: now + 60_001,
            leaseMs: 60_000,
          });
        expect(next?.revision).toBe(claimed.revision + 1);
        await expect(
          store.release({
            ...keyOf(original),
            revision: claimed.revision,
            leaseId: claimed.leaseId!,
          }),
        ).resolves.toBeNull();
        const released = await store.release({
          ...keyOf(original),
          revision: next!.revision,
          leaseId: 'successor',
        });
        expect(released).toMatchObject({ revision: next!.revision + 1 });
        expect(released).not.toHaveProperty('leaseId');
        expect(await store.listReconcile(1, now + 60_002)).toHaveLength(0);
        expect(await store.listReconcile(1, now + 600_002)).toHaveLength(1);
      });

      it('an expired lease holder cannot save, even before a successor takes the lease', async () => {
        const original = session('expired-holder');
        await start('expired-holder');
        const claimed = await store.claim({
          ...keyOf(original),
          revision: 0,
          leaseId: 'expired',
          now,
          leaseMs: 1,
        });
        await expect(
          store.update({
            ...keyOf(original),
            revision: claimed!.revision,
            leaseId: 'expired',
            patch: { status: 'provisioning' },
          }),
        ).resolves.toBeNull();
      });

      it('rejects an invalid lease', async () => {
        const original = session('bad-lease');
        await start('bad-lease');
        await expect(
          store.claim({ ...keyOf(original), revision: 0, leaseId: 'bad lease', now, leaseMs: 1 }),
        ).rejects.toThrow('Invalid browser setup lease');
        await expect(
          store.claim({ ...keyOf(original), revision: 0, leaseId: 'ok', now, leaseMs: 300_001 }),
        ).rejects.toThrow('Invalid browser setup lease');
      });
    });

    /* ------------------------------------------------------------------ nonces */

    describe('claimNonce', () => {
      it('claims shared, bounded, replay-safe nonces and keeps the operation count when pruning', async () => {
        const original = session('nonce');
        await start('nonce');
        const input = {
          ...keyOf(original),
          nonce: 'nonce-a',
          now,
          expiresAt: now + 1000,
          maxNonces: 1,
          maxOperations: 2,
        };
        const results = await Promise.all([
          store.claimNonce(input),
          backend().createStore().claimNonce(input),
        ]);
        expect(results.sort()).toEqual(['claimed', 'replay']);
        await expect(store.claimNonce({ ...input, nonce: 'nonce-b' })).resolves.toBe('limited');
        await expect(
          store.claimNonce({ ...input, nonce: 'nonce-b', now: now + 1001, expiresAt: now + 2000 }),
        ).resolves.toBe('claimed');
        await expect(
          store.claimNonce({ ...input, nonce: 'nonce-c', now: now + 2001, expiresAt: now + 3000 }),
        ).resolves.toBe('limited');
        await expect(store.claimNonce({ ...input, requestHash: hash('wrong') })).resolves.toBe(
          'missing',
        );
        const stored = await persisted('nonce');
        expect(stored?.nonces).toEqual([{ nonce: 'nonce-b', expiresAt: now + 2000 }]);
        expect(stored?.operations).toBe(2);
      });

      it('keeps several live nonces in claim order', async () => {
        const original = session('nonces');
        await start('nonces');
        for (const nonce of ['n1', 'n2', 'n3']) {
          await expect(
            store.claimNonce({
              ...keyOf(original),
              nonce,
              now,
              expiresAt: now + 5000,
              maxNonces: 5,
              maxOperations: 10,
            }),
          ).resolves.toBe('claimed');
        }
        expect(((await persisted('nonces'))?.nonces as RawRecord[]).map((n) => n.nonce)).toEqual([
          'n1',
          'n2',
          'n3',
        ]);
      });

      it('rejects an invalid nonce', async () => {
        await expect(
          store.claimNonce({
            attemptId: 'x',
            requestHash: hash('x'),
            nonce: 'n',
            now,
            expiresAt: now,
            maxNonces: 1,
            maxOperations: 1,
          }),
        ).rejects.toThrow('Invalid browser setup nonce');
      });
    });

    /* ------------------------------------------------------------------ request budget */

    describe('consumeRequest', () => {
      it('bounds requests globally and per peer, atomically, in one singleton', async () => {
        const samePeer = await Promise.all(
          Array.from({ length: 12 }, () => store.consumeRequest({ ipHash, now, limits })),
        );
        expect(samePeer.filter(Boolean)).toHaveLength(limits.perIp);
        const diverse = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            store.consumeRequest({ ipHash: hash(`untrusted-${index}`), now, limits }),
          ),
        );
        expect(diverse.filter(Boolean)).toHaveLength(limits.global - limits.perIp);
        const budgets = await harness.readRaw(REQUESTS);
        expect(budgets).toHaveLength(1);
        expect(budgets[0]).toMatchObject({
          _id: 'global',
          count: limits.global,
          expiresAt: now + limits.windowMs,
        });
        expect((budgets[0].peers as Record<string, number>)[ipHash]).toBe(limits.perIp);
        expect(Object.keys(budgets[0].peers as object).length).toBeLessThanOrEqual(limits.global);
      });

      it('starts a new window once the current one expired', async () => {
        await store.consumeRequest({ ipHash, now, limits });
        await store.consumeRequest({ ipHash, now, limits });
        await expect(store.consumeRequest({ ipHash, now, limits })).resolves.toBe(false);
        await expect(
          backend()
            .createStore()
            .consumeRequest({ ipHash, now: now + limits.windowMs, limits }),
        ).resolves.toBe(true);
        expect(await harness.readRaw(REQUESTS)).toEqual([
          {
            _id: 'global',
            expiresAt: now + 2 * limits.windowMs,
            count: 1,
            peers: { [ipHash]: 1 },
          },
        ]);
      });

      it('rejects an invalid budget input', async () => {
        await expect(store.consumeRequest({ ipHash: 'nope', now, limits })).rejects.toThrow(
          'Invalid browser setup request budget',
        );
        await expect(
          store.consumeRequest({ ipHash, now, limits: { ...limits, global: 0 } }),
        ).rejects.toThrow('Invalid browser setup request budget');
      });
    });

    /* ------------------------------------------------------------------ reconciliation */

    describe('listReconcile', () => {
      it('lists unresolved, unleased sessions, live pending ones only once expired', async () => {
        const records = ['pending-a', 'provision-a', 'done'].map(session);
        for (let index = 0; index < records.length; index++) {
          await start(records[index].attemptId, hash(`peer-${index}`));
        }
        await store.update({
          ...keyOf(records[1]),
          revision: 0,
          patch: { ownerId: 'owner', status: 'provisioning' },
        });
        await store.update({
          ...keyOf(records[2]),
          revision: 0,
          patch: { status: 'denied', progress: { cleanup: true } },
        });
        expect((await store.listReconcile(10, now)).map((s) => s.attemptId)).toEqual([
          'provision-a',
        ]);
        expect(
          (await store.listReconcile(10, now + 600_000)).map((s) => s.attemptId).sort(),
        ).toEqual(['pending-a', 'provision-a']);
      });

      it('rotates a reconciled session behind the others', async () => {
        const records = ['pending-a', 'pending-b', 'provision-a', 'provision-b'].map(session);
        for (let index = 0; index < records.length; index++) {
          await start(records[index].attemptId, hash(`fair-${index}`));
        }
        for (const original of records.slice(2)) {
          await store.update({
            ...keyOf(original),
            revision: 0,
            patch: { ownerId: 'owner', status: 'provisioning' },
          });
        }
        const first = (await store.listReconcile(1, now))[0];
        expect(first.attemptId.startsWith('provision-')).toBe(true);
        const claimed = await store.claim({
          ...keyOf(first),
          revision: first.revision,
          leaseId: 'fairness',
          now,
          leaseMs: 60_000,
        });
        await store.release({ ...keyOf(first), revision: claimed!.revision, leaseId: 'fairness' });
        const second = (await store.listReconcile(1, now + 1))[0];
        expect(second.attemptId.startsWith('provision-')).toBe(true);
        expect(second.attemptId).not.toBe(first.attemptId);
      });

      it('restores the session of an abandoned allocation snapshot (anti-join), then releases it', async () => {
        const original = session('abandoned');
        await start('abandoned');
        const budget = await rawWhere(BUDGET, 'global');
        await harness.reset();
        await harness.seedRaw(BUDGET, [budget!]);
        const recovered = await backend()
          .createStore()
          .listReconcile(1, now + 600_001);
        expect(recovered).toEqual([original]);
        expect(await persisted('abandoned')).toMatchObject({ nonces: [], operations: 0 });
        await store.update({
          ...keyOf(original),
          revision: 0,
          patch: { status: 'expired', progress: { cleanup: true } },
        });
        expect(await allocations()).toEqual([]);
        expect((await persisted('abandoned'))?.allocationReleased).toBe(true);
      });

      it('arms a missing TTL date for a resolved session it lists', async () => {
        const purgeAt = new Date(now + 5000).toISOString();
        await harness.seedRaw(BUDGET, [{ _id: 'global', allocations: [] }]);
        await harness.seedRaw(SESSIONS, [
          {
            _id: 'resolved',
            ...session('resolved'),
            status: 'failed',
            revision: 3,
            progress: { cleanup: true },
            purgeAt,
            allocationReleased: true,
            nonces: [],
            operations: 0,
          },
        ]);
        expect((await store.listReconcile(5, now)).map((s) => s.attemptId)).toEqual(['resolved']);
        expect((await persisted('resolved'))?.deleteAfter).toEqual(new Date(purgeAt));
        expect(await store.listReconcile(5, now)).toEqual([]);
      });

      it('rejects an invalid limit', async () => {
        await expect(store.listReconcile(0, now)).rejects.toThrow('Invalid browser setup');
        await expect(store.listReconcile(513, now)).rejects.toThrow('Invalid browser setup');
      });
    });
  });
}
