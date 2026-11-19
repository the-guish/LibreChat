/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AuditLogStore` contract (`~/ports/auditLog`), ported from `methods/auditLog.spec.ts`: the
 * per-tenant hash chain the appends build, the paged, filtered and streamed reads, chain
 * verification (tampering is simulated by rewriting the stored records through `seedRaw`) and
 * the retention purge with its checkpoint. `recordAuditEntry` resolves a hydrated document with
 * MongoDB; the cases read it through its fields only. The model-level append-only hooks of the
 * MongoDB spec are not part of the port. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { RecordAuditEntryInput } from '~/types';
import type { AuditLogStoreEntryInput } from '~/ports/auditLog';
import { AUDIT_ACTIONS, AUDIT_ACTION_CATEGORY } from '~/types/admin';
import { idOf, useContractHarness } from './support';

/** The hash every chain starts from (`GENESIS_HASH` of `schema/auditLog.ts`). */
const GENESIS_HASH = '0'.repeat(64);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeAuditLogContract(harness: ContractHarness): void {
  describe(`AuditLogStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const actorId = harness.ids.generate();
    const baseInput = (over: Partial<RecordAuditEntryInput> = {}): AuditLogStoreEntryInput => ({
      action: 'grant.assigned',
      actor: { type: 'user', id: actorId, name: 'Alice Admin' },
      target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
      metadata: { capability: 'manage:users' },
      tenantId: 'tenant-a',
      ...over,
    });
    const record = async (count: number, over: Partial<RecordAuditEntryInput> = {}) => {
      const { auditLogs } = harness.createStores();
      for (let index = 0; index < count; index++) {
        await auditLogs.recordAuditEntry(
          baseInput({ metadata: { capability: `cap:${index}` }, ...over }),
          { failClosed: true },
        );
      }
    };
    /** Appends `count` entries with strictly increasing creation times. */
    const recordSpaced = async (count: number) => {
      const { auditLogs } = harness.createStores();
      for (let index = 0; index < count; index++) {
        await auditLogs.recordAuditEntry(baseInput(), { failClosed: true });
        await sleep(5);
      }
    };
    /** The stored entries of tenant-a's chain, by seq. */
    const chainA = async () =>
      (await harness.readRaw('auditlogs'))
        .filter((entry) => entry.tenantId === 'tenant-a')
        .sort((a, b) => (a.seq as number) - (b.seq as number));
    /** Rewrites the stored audit log as `edit` returns it, bypassing the store. */
    const rewrite = async (edit: (records: RawRecord[]) => RawRecord[]) => {
      const records = edit(await harness.readRaw('auditlogs'));
      await harness.reset();
      await harness.seedRaw('auditlogs', records);
    };
    const whereSeq = (seq: number) => (entry: RawRecord) =>
      entry.tenantId === 'tenant-a' && entry.seq === seq;

    describe('recordAuditEntry', () => {
      it('stores a tenant entry with its denormalized and derived fields', async () => {
        const entry = await harness.createStores().auditLogs.recordAuditEntry(baseInput());
        expect(entry).not.toBeNull();
        const [stored] = await harness.readRaw('auditlogs');
        expect(stored).toMatchObject({
          schemaVersion: 1,
          category: 'grant',
          action: 'grant.assigned',
          outcome: 'success',
          severity: 'info',
          actor: { type: 'user', id: actorId, name: 'Alice Admin' },
          target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
          metadata: { capability: 'manage:users' },
          tenantId: 'tenant-a',
          seq: 1,
          prevHash: GENESIS_HASH,
        });
        expect(stored.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(stored.createdAt).toBeInstanceOf(Date);
        expect(idOf(harness, entry?._id)).toBe(stored._id);
        expect(entry?.seq).toBe(1);
        expect(entry?.hash).toBe(stored.hash);
      });

      it('accepts every registered action and derives its category', async () => {
        const { auditLogs } = harness.createStores();
        for (const action of AUDIT_ACTIONS) {
          await auditLogs.recordAuditEntry(baseInput({ action }), { failClosed: true });
        }
        const stored = await chainA();
        expect(stored.map((entry) => entry.action)).toEqual([...AUDIT_ACTIONS]);
        for (const entry of stored) {
          expect(entry.category).toBe(
            AUDIT_ACTION_CATEGORY[entry.action as keyof typeof AUDIT_ACTION_CATEGORY],
          );
        }
      });

      it('derives a warning severity for non-success outcomes', async () => {
        await harness.createStores().auditLogs.recordAuditEntry(baseInput({ outcome: 'denied' }));
        expect((await chainA())[0]).toMatchObject({ outcome: 'denied', severity: 'warning' });
      });

      it('starts each chain at the genesis hash and links each entry to the last', async () => {
        const { auditLogs } = harness.createStores();
        const first = await auditLogs.recordAuditEntry(baseInput());
        const second = await auditLogs.recordAuditEntry(baseInput());
        expect(first).toMatchObject({ seq: 1, prevHash: GENESIS_HASH });
        expect(second).toMatchObject({ seq: 2, prevHash: first?.hash });
      });

      it('keeps tenant and platform chains independent; a blank tenant is the platform', async () => {
        const { auditLogs } = harness.createStores();
        await auditLogs.recordAuditEntry(baseInput({ tenantId: 'tenant-a' }));
        await auditLogs.recordAuditEntry(baseInput({ tenantId: 'tenant-b' }));
        await auditLogs.recordAuditEntry(baseInput({ tenantId: undefined }));
        await auditLogs.recordAuditEntry(baseInput({ tenantId: '   ' }));
        const stored = await harness.readRaw('auditlogs');
        expect(stored.map((entry) => [entry.tenantId ?? null, entry.seq])).toEqual([
          ['tenant-a', 1],
          ['tenant-b', 1],
          [null, 1],
          [null, 2],
        ]);
        expect(stored.some((entry) => entry.tenantId === '')).toBe(false);
        expect((await auditLogs.listAuditLogPage(undefined, {})).total).toBe(2);
        expect((await auditLogs.listAuditLogPage('  ', {})).total).toBe(2);
      });

      it('leaves out empty metadata and context, and stores given context', async () => {
        const { auditLogs } = harness.createStores();
        await auditLogs.recordAuditEntry(
          baseInput({ metadata: {}, context: { ip: '', userAgent: undefined } }),
        );
        await auditLogs.recordAuditEntry(
          baseInput({ context: { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-1' } }),
        );
        const [bare, withContext] = await chainA();
        expect(bare.metadata).toBeUndefined();
        expect(bare.context).toBeUndefined();
        expect(withContext.context).toMatchObject({
          ip: '10.0.0.1',
          userAgent: 'jest',
          requestId: 'req-1',
        });
      });

      it('serializes concurrent appends into one contiguous, verifiable chain', async () => {
        const { auditLogs } = harness.createStores();
        const peer = harness.createStores().auditLogs;
        await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            (index % 2 ? peer : auditLogs).recordAuditEntry(baseInput(), { failClosed: true }),
          ),
        );
        expect((await chainA()).map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(await auditLogs.verifyAuditChain('tenant-a')).toMatchObject({
          ok: true,
          checked: 6,
        });
      });

      it('resolves null on a failed write, and throws with failClosed', async () => {
        const invalid = baseInput({
          actor: { type: 'robot' as never, name: 'Nobody' },
        });
        const { auditLogs } = harness.createStores();
        await expect(auditLogs.recordAuditEntry(invalid)).resolves.toBeNull();
        await expect(auditLogs.recordAuditEntry(invalid, { failClosed: true })).rejects.toThrow();
        expect(await harness.readRaw('auditlogs')).toEqual([]);
      });
    });

    describe('listAuditLogPage', () => {
      it('returns newest-first entries with the total and the next cursor', async () => {
        await record(3);
        const page = await harness.createStores().auditLogs.listAuditLogPage('tenant-a', {
          limit: 2,
        });
        expect(page.total).toBe(3);
        expect(page.entries.map((entry) => entry.integrity.seq)).toEqual([3, 2]);
        expect(page.nextCursor).toBe(2);
        const [newest] = page.entries;
        expect(newest).toMatchObject({
          schemaVersion: 1,
          category: 'grant',
          action: 'grant.assigned',
          actor: { type: 'user', id: actorId, name: 'Alice Admin' },
          target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
          metadata: { capability: 'cap:2' },
          tenantId: 'tenant-a',
        });
        expect(newest.id).toMatch(/^[0-9a-f]{24}$/);
        expect(new Date(newest.timestamp).toISOString()).toBe(newest.timestamp);
      });

      it('pages by keyset cursor without repeating rows under concurrent appends', async () => {
        await record(4);
        const { auditLogs } = harness.createStores();
        const first = await auditLogs.listAuditLogPage('tenant-a', { limit: 2 });
        await auditLogs.recordAuditEntry(baseInput());
        const second = await auditLogs.listAuditLogPage('tenant-a', {
          limit: 2,
          cursor: first.nextCursor ?? undefined,
        });
        const seen = new Set(first.entries.map((entry) => entry.id));
        expect(second.entries.some((entry) => seen.has(entry.id))).toBe(false);
        expect(second.entries.map((entry) => entry.integrity.seq)).toEqual([2, 1]);
        expect(second.nextCursor).toBeNull();
      });

      it('supports offset paging', async () => {
        await record(3);
        const page = await harness
          .createStores()
          .auditLogs.listAuditLogPage('tenant-a', { limit: 1, offset: 1 });
        expect(page.entries.map((entry) => entry.integrity.seq)).toEqual([2]);
        expect(page.total).toBe(3);
      });

      it('isolates tenants', async () => {
        const { auditLogs } = harness.createStores();
        await auditLogs.recordAuditEntry(baseInput({ tenantId: 'tenant-a' }));
        await auditLogs.recordAuditEntry(baseInput({ tenantId: 'tenant-b' }));
        const page = await auditLogs.listAuditLogPage('tenant-a', {});
        expect(page.total).toBe(1);
        expect(page.entries[0].tenantId).toBe('tenant-a');
      });

      it('filters by category, action, outcome, severity, actor and target type', async () => {
        const { auditLogs } = harness.createStores();
        await auditLogs.recordAuditEntry(baseInput({ action: 'grant.assigned' }));
        await auditLogs.recordAuditEntry(baseInput({ action: 'grant.removed', outcome: 'denied' }));
        const total = async (filters: Parameters<typeof auditLogs.listAuditLogPage>[1]) =>
          (await auditLogs.listAuditLogPage('tenant-a', filters)).total;
        expect(await total({ action: ['grant.removed'] })).toBe(1);
        expect(await total({ action: ['grant.removed', 'grant.assigned'] })).toBe(2);
        expect(await total({ category: ['grant'] })).toBe(2);
        expect(await total({ outcome: ['denied'] })).toBe(1);
        expect(await total({ severity: ['warning'] })).toBe(1);
        expect(await total({ actorType: 'user' })).toBe(2);
        expect(await total({ actorType: 'agent' })).toBe(0);
        expect(await total({ targetType: 'role' })).toBe(2);
        expect(await total({ targetType: 'user' })).toBe(0);
      });

      it('matches actor, target, capability and search substrings case-insensitively', async () => {
        const { auditLogs } = harness.createStores();
        await auditLogs.recordAuditEntry(baseInput());
        const total = async (filters: Parameters<typeof auditLogs.listAuditLogPage>[1]) =>
          (await auditLogs.listAuditLogPage('tenant-a', filters)).total;
        expect(await total({ actorQuery: 'alice' })).toBe(1);
        expect(await total({ targetQuery: 'admin' })).toBe(1);
        expect(await total({ capability: 'MANAGE' })).toBe(1);
        expect(await total({ actorQuery: 'zzz' })).toBe(0);
        expect(await total({ search: 'GRANT.ASS' })).toBe(1);
        expect(await total({ search: 'users' })).toBe(1);
        expect(await total({ search: 'nothing-like-this' })).toBe(0);
        expect(await total({ actorQuery: 'a.i' })).toBe(0);
        expect(await total({ search: '(' })).toBe(0);
      });

      it('filters by a date window', async () => {
        await record(2);
        const { auditLogs } = harness.createStores();
        const future = new Date(Date.now() + 60_000);
        const past = new Date(Date.now() - 60_000);
        expect(
          (await auditLogs.listAuditLogPage('tenant-a', { from: past, to: future })).total,
        ).toBe(2);
        expect((await auditLogs.listAuditLogPage('tenant-a', { from: future })).total).toBe(0);
        expect((await auditLogs.listAuditLogPage('tenant-a', { to: past })).total).toBe(0);
      });
    });

    describe('findAuditLogEntry', () => {
      it("returns the chain's entry by id, scoped to its tenant", async () => {
        const entry = await harness.createStores().auditLogs.recordAuditEntry(baseInput());
        const id = idOf(harness, entry?._id);
        const { auditLogs } = harness.createStores();
        const found = await auditLogs.findAuditLogEntry('tenant-a', id);
        expect(found).toMatchObject({ id, action: 'grant.assigned', integrity: { seq: 1 } });
        expect(await auditLogs.findAuditLogEntry('tenant-b', id)).toBeNull();
        expect(await auditLogs.findAuditLogEntry(undefined, id)).toBeNull();
      });

      it('returns null for an id that is not an id, or is unknown', async () => {
        const { auditLogs } = harness.createStores();
        expect(await auditLogs.findAuditLogEntry('tenant-a', 'not-an-id')).toBeNull();
        expect(await auditLogs.findAuditLogEntry('tenant-a', harness.ids.generate())).toBeNull();
      });
    });

    describe('streamAuditLogEntries', () => {
      it('hands every matching entry to the callback, newest first', async () => {
        await record(3);
        await record(1, { action: 'grant.removed' });
        const seen: number[] = [];
        const result = await harness
          .createStores()
          .auditLogs.streamAuditLogEntries('tenant-a', { action: ['grant.assigned'] }, (entry) => {
            seen.push(entry.integrity.seq);
          });
        expect(result).toEqual({ count: 3, truncated: false });
        expect(seen).toEqual([3, 2, 1]);
      });

      it('awaits an asynchronous callback before the next entry', async () => {
        await record(3);
        const seen: number[] = [];
        let inFlight = 0;
        await harness
          .createStores()
          .auditLogs.streamAuditLogEntries('tenant-a', {}, async (entry) => {
            inFlight++;
            expect(inFlight).toBe(1);
            await sleep(1);
            seen.push(entry.integrity.seq);
            inFlight--;
          });
        expect(seen).toEqual([3, 2, 1]);
      });

      it('stops when cancelled, and reports truncation only when the cap cuts rows off', async () => {
        await record(5);
        const { auditLogs } = harness.createStores();
        const cancelled = await auditLogs.streamAuditLogEntries('tenant-a', {}, () => undefined, {
          isCancelled: () => true,
        });
        expect(cancelled.count).toBe(0);
        expect(
          await auditLogs.streamAuditLogEntries('tenant-a', {}, () => undefined, { maxRows: 2 }),
        ).toEqual({ count: 2, truncated: true });
        expect(
          await auditLogs.streamAuditLogEntries('tenant-a', {}, () => undefined, { maxRows: 5 }),
        ).toEqual({ count: 5, truncated: false });
      });
    });

    describe('verifyAuditChain', () => {
      it('verifies an intact chain, and an empty one', async () => {
        await record(4);
        const { auditLogs } = harness.createStores();
        expect(await auditLogs.verifyAuditChain('tenant-a')).toMatchObject({
          ok: true,
          checked: 4,
          range: { firstSeq: 1, lastSeq: 4 },
        });
        expect(await auditLogs.verifyAuditChain('tenant-b')).toMatchObject({
          ok: true,
          checked: 0,
        });
      });

      it('stops when the caller cancels', async () => {
        await record(3);
        expect(
          await harness
            .createStores()
            .auditLogs.verifyAuditChain('tenant-a', { isCancelled: () => true }),
        ).toMatchObject({ ok: false, checked: 0, reason: 'verification cancelled' });
      });

      it('bounds verification at maxRows, and completes at an exact cap', async () => {
        await record(3);
        const { auditLogs } = harness.createStores();
        const capped = await auditLogs.verifyAuditChain('tenant-a', { maxRows: 2 });
        expect(capped).toMatchObject({ ok: false, checked: 2, brokenAt: 3 });
        expect(capped.reason).toMatch(/row limit exceeded/);
        expect(await auditLogs.verifyAuditChain('tenant-a', { maxRows: 3 })).toMatchObject({
          ok: true,
          checked: 3,
        });
      });

      it('detects a tampered field as a hash mismatch', async () => {
        await record(3);
        await rewrite((records) =>
          records.map((entry) =>
            whereSeq(2)(entry)
              ? { ...entry, actor: { ...(entry.actor as RawRecord), name: 'Mallory' } }
              : entry,
          ),
        );
        expect(await harness.createStores().auditLogs.verifyAuditChain('tenant-a')).toMatchObject({
          ok: false,
          brokenAt: 2,
          reason: 'hash mismatch',
        });
      });

      it('detects a deleted entry as a sequence gap', async () => {
        await record(3);
        await rewrite((records) => records.filter((entry) => !whereSeq(2)(entry)));
        const result = await harness.createStores().auditLogs.verifyAuditChain('tenant-a');
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/sequence gap/);
      });

      it('detects a forged hash', async () => {
        await record(3);
        await rewrite((records) =>
          records.map((entry) => (whereSeq(2)(entry) ? { ...entry, hash: 'f'.repeat(64) } : entry)),
        );
        expect(await harness.createStores().auditLogs.verifyAuditChain('tenant-a')).toMatchObject({
          ok: false,
          brokenAt: 2,
        });
      });

      it('does not trust a deleted prefix without a matching checkpoint', async () => {
        await record(3);
        await rewrite((records) => records.filter((entry) => !whereSeq(1)(entry)));
        const { auditLogs } = harness.createStores();
        const unverified = await auditLogs.verifyAuditChain('tenant-a');
        expect(unverified).toMatchObject({ ok: false, brokenAt: 2 });
        expect(unverified.reason).toMatch(/non-genesis|prefix/);
        const mismatched = await auditLogs.verifyAuditChain('tenant-a', {
          trustedCheckpoint: { throughSeq: 1, prevHash: 'f'.repeat(64) },
        });
        expect(mismatched.ok).toBe(false);
        expect(mismatched.reason).toMatch(/checkpoint mismatch/);
      });
    });

    describe('purgeAuditLogEntries', () => {
      it('is a no-op unless confirmed', async () => {
        await record(2);
        expect(
          await harness.createStores().auditLogs.purgeAuditLogEntries('tenant-a', {
            before: new Date(Date.now() + 60_000),
            confirm: false,
          }),
        ).toEqual({ deletedCount: 0 });
        expect(await chainA()).toHaveLength(2);
      });

      it('throws on an invalid cutoff', async () => {
        await expect(
          harness.createStores().auditLogs.purgeAuditLogEntries('tenant-a', {
            before: new Date('nope'),
            confirm: true,
          }),
        ).rejects.toThrow('`before` must be a valid Date');
      });

      it('purges a prefix, audits the purge, and verifies from the checkpoint', async () => {
        await recordSpaced(4);
        await record(1, { tenantId: 'tenant-b' });
        const third = (await chainA())[2];
        const { auditLogs } = harness.createStores();
        const result = await auditLogs.purgeAuditLogEntries('tenant-a', {
          before: third.createdAt as Date,
          confirm: true,
        });
        expect(result).toEqual({
          deletedCount: 2,
          checkpoint: { throughSeq: 2, prevHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        });
        const remaining = await chainA();
        expect(remaining.map((entry) => entry.seq)).toEqual([3, 4, 5]);
        expect(remaining[2]).toMatchObject({
          action: 'audit.purged',
          category: 'audit',
          severity: 'critical',
          actor: { type: 'system', name: 'audit-retention' },
          target: { type: 'audit_log' },
          metadata: { deletedCount: 2, throughSeq: 2 },
        });
        expect((await auditLogs.verifyAuditChain('tenant-a')).ok).toBe(false);
        expect(
          await auditLogs.verifyAuditChain('tenant-a', { trustedCheckpoint: result.checkpoint }),
        ).toMatchObject({ ok: true, range: { firstSeq: 3, lastSeq: 5 } });
        expect((await auditLogs.listAuditLogPage('tenant-b', {})).total).toBe(1);
      });

      it('purges only a contiguous prefix under clock skew', async () => {
        await recordSpaced(4);
        const fourth = (await chainA())[3];
        const skewed = new Date((fourth.createdAt as Date).getTime() + 60_000);
        await rewrite((records) =>
          records.map((entry) => (whereSeq(1)(entry) ? { ...entry, createdAt: skewed } : entry)),
        );
        const result = await harness.createStores().auditLogs.purgeAuditLogEntries('tenant-a', {
          before: fourth.createdAt as Date,
          confirm: true,
        });
        expect(result.deletedCount).toBe(0);
        expect((await chainA()).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
      });

      it('mints no checkpoint and audits nothing when a confirmed purge removed nothing', async () => {
        await record(2);
        const result = await harness.createStores().auditLogs.purgeAuditLogEntries('tenant-a', {
          before: new Date(Date.now() - 60_000),
          confirm: true,
        });
        expect(result).toEqual({ deletedCount: 0 });
        expect((await chainA()).some((entry) => entry.action === 'audit.purged')).toBe(false);
      });

      it('purges the whole chain when every entry predates the cutoff', async () => {
        // NOTE(contract): a purge that empties the chain mints no checkpoint, and its own
        // `audit.purged` entry restarts the chain at seq 1 from the genesis hash, so the result
        // verifies without a checkpoint like a fresh chain. Pinned as today's behavior.
        await record(2);
        const result = await harness.createStores().auditLogs.purgeAuditLogEntries('tenant-a', {
          before: new Date(Date.now() + 60_000),
          confirm: true,
        });
        expect(result.deletedCount).toBe(2);
        const remaining = await chainA();
        expect(remaining.map((entry) => entry.action)).toEqual(['audit.purged']);
        expect(remaining[0].seq).toBe(1);
        expect(result.checkpoint).toBeUndefined();
      });
    });
  });
}
