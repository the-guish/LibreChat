/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ScheduleStore` contract (`~/ports/schedule`), first part: the schedule records. Ported from
 * `methods/schedule.methods.spec.ts`, which stays unchanged: the stored record and its defaults
 * (cadence validation included), the per-owner slot allocator (lowest free slot, the cap under
 * concurrent creates, legacy slotless rows counted, slots freed by a soft delete, the create
 * replay through the `clientRequestId` partial unique index, which spans rows being deleted), the
 * guarded create rollback, the owner edit (claim-token rotation, the config revision and its
 * fence, the `$unset` record, the paused card it drops), the owner reads (rows being deleted
 * hidden, the lease fields left out of the listing, its update-time order), the engine's leases
 * and claims (exactly one winner, the clock-skew margin on takeovers, `nextRunAt` order, the
 * manual and resume leases with their unique holders), the claim-token, `nextRunAt` and revision
 * fences of every worker write, the arming CAS, and deletion: the soft delete, the reversible
 * account-deletion suspension, the erasure sweep windows and their rotation, the drained erase
 * with its idempotency tombstone, and the account cascade. The runs and their bookkeeping are in
 * `schedule.runs.contract.ts`.
 *
 * Not here (they stay in the method spec): the restore retry after a write made to fail by a
 * driver spy, and the auto-disable `counterGuard`, which the port leaves out. Fixtures go through
 * the store's own methods (`createSchedule` stores a record as given, so states such as `deleting`
 * or a projected card are created directly) or raw. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import type { ISchedule } from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import type { ScheduleStoreData, ScheduleRunStoreData } from '~/ports/schedule';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

/** The schedule fields an erasure tombstone keeps. */
const TOMBSTONE_FIELDS = [
  '_id',
  '__v',
  'id',
  'user',
  'tenantId',
  'clientRequestId',
  'clientRequestDigest',
  'deleting',
  'erased',
  'erasedAt',
  'enabled',
  'createdAt',
  'updatedAt',
];

/** The error a store method rejected with, or a failure when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

/** Whether a field reads as unset (absent, or `null` where a backend stores no value). */
const unset = (value: unknown) => value === undefined || value === null;

export function describeScheduleContract(harness: ContractHarness): void {
  describe(`ScheduleStore contract (schedules): ${harness.name}`, () => {
    useContractHarness(harness);

    const schedules = () => harness.createStores().schedules;
    const newId = () => harness.ids.generate();
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    let counter = 0;

    /** A schedule due a minute ago, `overrides` over it. */
    const scheduleData = (overrides: ScheduleStoreData = {}): ScheduleStoreData => ({
      id: `sched-${++counter}`,
      user: newId(),
      name: 'Morning digest',
      prompt: 'Summarize my inbox',
      agent_id: 'agent-test',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000),
      ...overrides,
    });
    const create = (overrides: ScheduleStoreData = {}) =>
      schedules().createSchedule(scheduleData(overrides));
    /** A schedule with no next run (a create whose arming failed). */
    const createUnarmed = (overrides: ScheduleStoreData = {}) => {
      const data = scheduleData(overrides);
      delete data.nextRunAt;
      return schedules().createSchedule(data);
    };
    const runData = (
      schedule: { id: string; user: unknown },
      overrides: ScheduleRunStoreData = {},
    ): ScheduleRunStoreData => ({
      scheduleId: schedule.id,
      user: idOf(harness, schedule.user),
      scheduledFor: new Date('2026-07-20T12:00:00.000Z'),
      status: 'started',
      firedAt: new Date(),
      ...overrides,
    });
    /** The schedule `id` as stored, also while it is being deleted; `undefined` once gone. */
    const stored = async (id: string): Promise<RawRecord | undefined> =>
      (await readRawWhere(harness, 'schedules', { id }))[0];
    /** The schedule `id` through the owner read, failing when it is hidden or gone. */
    const live = async (id: string): Promise<ISchedule> => {
      const schedule = await schedules().getScheduleById(id);
      if (schedule == null) {
        throw new Error(`schedule ${id} not found`);
      }
      return schedule;
    };
    const runsOf = async (scheduleId: string) =>
      readRawWhere(harness, 'scheduleruns', { scheduleId });
    const ownerOf = (schedule: ISchedule) => idOf(harness, schedule.user);

    /* ------------------------------------------------------------ setup */

    describe('ensureScheduleIndexes', () => {
      it('resolves when called again and keeps one schedule per id and tenant', async () => {
        await schedules().ensureScheduleIndexes();
        await schedules().ensureScheduleIndexes();
        await create({ id: 'shared-id', tenantId: 'tenant-a' });
        await create({ id: 'shared-id', tenantId: 'tenant-b' });
        const rejection = await rejectionOf(create({ id: 'shared-id', tenantId: 'tenant-a' }));
        expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
        expect((await harness.readRaw('schedules')).map((row) => row.tenantId)).toEqual([
          'tenant-a',
          'tenant-b',
        ]);
      });
    });

    /* ------------------------------------------------------------ owner: schedules */

    describe('createSchedule', () => {
      it('stores the schedule as given, with its defaults and timestamps', async () => {
        const user = newId();
        const before = Date.now();
        const created = await create({ id: 'sched-a', user, file_ids: ['file-1'] });
        expect(created).toMatchObject({
          id: 'sched-a',
          name: 'Morning digest',
          prompt: 'Summarize my inbox',
          agent_id: 'agent-test',
          cadence: { frequency: 'daily', hour: 8, minute: 0 },
          timezone: 'America/New_York',
          target: 'new',
          enabled: true,
          file_ids: ['file-1'],
          configRevision: 0,
          deleting: false,
          runCount: 0,
          failureCount: 0,
          balanceSkipCount: 0,
        });
        expect(ownerOf(created)).toBe(user);
        expect(timeOf(created.createdAt)).toBeGreaterThanOrEqual(before);
        expect(unset(created.claimToken)).toBe(true);
        const [row] = await harness.readRaw('schedules');
        expect(row).toMatchObject({ id: 'sched-a', user, deleting: false, configRevision: 0 });
      });

      it('keeps a cron cadence without an hour or a minute', async () => {
        const created = await create({
          cadence: { frequency: 'cron', expression: '0 9,17 * * 1-5' },
        });
        const read = await live(created.id);
        expect(read.cadence).toMatchObject({ frequency: 'cron', expression: '0 9,17 * * 1-5' });
        expect(unset((read.cadence as { hour?: number }).hour)).toBe(true);
        expect(unset((read.cadence as { minute?: number }).minute)).toBe(true);
      });

      it('refuses a cron cadence with no expression and a structured one with no hour', async () => {
        await expect(
          create({ cadence: { frequency: 'cron' } as ISchedule['cadence'] }),
        ).rejects.toThrow(/expression/);
        await expect(
          create({ cadence: { frequency: 'daily' } as ISchedule['cadence'] }),
        ).rejects.toThrow(/hour/);
        expect(await harness.readRaw('schedules')).toEqual([]);
      });

      it('keeps one create idempotency key per owner (a duplicate key rejects)', async () => {
        const user = newId();
        await create({ user, clientRequestId: 'intent-1' });
        await create({ user: newId(), clientRequestId: 'intent-1' });
        const rejection = await rejectionOf(create({ user, clientRequestId: 'intent-1' }));
        expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
        expect(await harness.readRaw('schedules')).toHaveLength(2);
      });

      it('stamps the tenant in context and scopes the owner reads to it', async () => {
        const user = newId();
        const created = await inTenant('tenant-a', () => create({ user }));
        expect(created.tenantId).toBe('tenant-a');
        await inTenant('tenant-b', () => create({ user }));
        expect(
          (await inTenant('tenant-a', () => schedules().getSchedulesByUser(user))).map(
            (row) => row.tenantId,
          ),
        ).toEqual(['tenant-a']);
        expect(await inTenant('tenant-b', () => schedules().countSchedulesByUser(user))).toBe(1);
        expect(
          await inTenant('tenant-b', () => schedules().getScheduleById(created.id, user)),
        ).toBeNull();
      });
    });

    describe('createScheduleWithSlot', () => {
      it('allows exactly maxPerUser under concurrency, on distinct slots', async () => {
        const user = newId();
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            schedules().createScheduleWithSlot(scheduleData({ user }), 3),
          ),
        );
        const created = results.filter((result): result is ISchedule => result !== 'limit');
        expect(created).toHaveLength(3);
        expect(results.filter((result) => result === 'limit')).toHaveLength(5);
        expect(created.map((schedule) => schedule.slot).sort()).toEqual([0, 1, 2]);
        expect(created.every((schedule) => schedule.deleting === false)).toBe(true);
        expect(await schedules().countSchedulesByUser(user)).toBe(3);
      });

      it('takes the lowest free slot, and a soft delete frees its slot at once', async () => {
        const user = newId();
        const first = (await schedules().createScheduleWithSlot(
          scheduleData({ user }),
          2,
        )) as ISchedule;
        const second = (await schedules().createScheduleWithSlot(
          scheduleData({ user }),
          2,
        )) as ISchedule;
        expect([first.slot, second.slot]).toEqual([0, 1]);
        expect(await schedules().createScheduleWithSlot(scheduleData({ user }), 2)).toBe('limit');
        await schedules().markScheduleDeleting(first.id, user);
        const replacement = (await schedules().createScheduleWithSlot(
          scheduleData({ user }),
          2,
        )) as ISchedule;
        expect(replacement.slot).toBe(0);
        expect(await schedules().countSchedulesByUser(user)).toBe(2);
      });

      it('counts live schedules without a slot against the cap', async () => {
        const user = newId();
        await create({ user });
        await create({ user });
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            schedules().createScheduleWithSlot(scheduleData({ user }), 3),
          ),
        );
        expect(results.filter((result) => result !== 'limit')).toHaveLength(1);
        expect(await schedules().countSchedulesByUser(user)).toBe(3);
      });

      it('resolves a retry of a committed create to the stored row, also while it is being deleted', async () => {
        const user = newId();
        const first = (await schedules().createScheduleWithSlot(
          scheduleData({ user, clientRequestId: 'intent-1', name: 'first attempt' }),
          5,
        )) as ISchedule;
        const retry = (await schedules().createScheduleWithSlot(
          scheduleData({ user, clientRequestId: 'intent-1', name: 'retry' }),
          5,
        )) as ISchedule;
        expect(idOf(harness, retry._id)).toBe(idOf(harness, first._id));
        expect(retry.name).toBe('first attempt');

        await schedules().markScheduleDeleting(first.id, user);
        const late = (await schedules().createScheduleWithSlot(
          scheduleData({ user, clientRequestId: 'intent-1', name: 'late retry' }),
          5,
        )) as ISchedule;
        expect(idOf(harness, late._id)).toBe(idOf(harness, first._id));
        expect(late.deleting).toBe(true);
        expect(await harness.readRaw('schedules')).toHaveLength(1);
      });
    });

    describe('deleteUnarmedSchedule', () => {
      it('erases a drained unarmed schedule and its settled runs', async () => {
        const schedule = await createUnarmed();
        await schedules().insertScheduleRun(runData(schedule, { status: 'success' }));
        expect(await schedules().deleteUnarmedSchedule(schedule.id, ownerOf(schedule))).toBe(
          'deleted',
        );
        expect(await stored(schedule.id)).toBeUndefined();
        expect(await runsOf(schedule.id)).toEqual([]);
      });

      it('soft-deletes and defers to the drain while a run is active', async () => {
        const schedule = await createUnarmed();
        await schedules().insertScheduleRun(runData(schedule, { status: 'started' }));
        expect(await schedules().deleteUnarmedSchedule(schedule.id, ownerOf(schedule))).toBe(
          'draining',
        );
        expect(await stored(schedule.id)).toMatchObject({ deleting: true, enabled: false });
        expect(await runsOf(schedule.id)).toHaveLength(1);
        expect(await schedules().deleteUnarmedSchedule(schedule.id, ownerOf(schedule))).toBe(
          'draining',
        );
      });

      it('keeps an armed schedule, and one an edit moved past the expected revision', async () => {
        const armed = await create();
        expect(await schedules().deleteUnarmedSchedule(armed.id, ownerOf(armed))).toBe('kept');
        const edited = await createUnarmed();
        await schedules().updateScheduleById(edited.id, ownerOf(edited), { enabled: false });
        expect(await schedules().deleteUnarmedSchedule(edited.id, ownerOf(edited), 0)).toBe('kept');
        expect(await stored(armed.id)).toMatchObject({ deleting: false });
        expect(await stored(edited.id)).toMatchObject({ deleting: false, configRevision: 1 });
      });

      it('reports a missing schedule, and another owner’s as missing', async () => {
        expect(await schedules().deleteUnarmedSchedule('sched-gone', newId())).toBe('missing');
        const schedule = await createUnarmed();
        expect(await schedules().deleteUnarmedSchedule(schedule.id, newId())).toBe('missing');
        expect(await stored(schedule.id)).toMatchObject({ deleting: false });
      });
    });

    describe('updateScheduleById', () => {
      it('sets the fields, rotates the claim token and bumps the config revision', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        const edited = await schedules().updateScheduleById(schedule.id, ownerOf(schedule), {
          name: 'renamed',
        });
        expect(edited).toMatchObject({ name: 'renamed', configRevision: 1 });
        expect(edited?.claimToken).toEqual(expect.any(String));
        expect(edited?.claimToken).not.toBe(claim?.claimToken);
        // The in-flight holder's lease fields are left for it to release by holder.
        expect(edited?.leaseBy).toBe('w1');
        const again = await schedules().updateScheduleById(schedule.id, ownerOf(schedule), {
          prompt: 'Changed',
        });
        expect(again?.configRevision).toBe(2);
        expect(again?.claimToken).not.toBe(edited?.claimToken);
      });

      it('removes the fields the unset record names', async () => {
        const schedule = await create({
          chatProjectId: 'project-1',
          disabledReason: 'insufficient_balance',
        });
        const edited = await schedules().updateScheduleById(
          schedule.id,
          ownerOf(schedule),
          { enabled: true },
          { disabledReason: 1, chatProjectId: 1 },
        );
        expect(unset(edited?.disabledReason)).toBe(true);
        expect(unset(edited?.chatProjectId)).toBe(true);
        expect(await stored(schedule.id)).not.toHaveProperty('chatProjectId');
      });

      it('applies an edit at the current revision and refuses one from a superseded revision', async () => {
        const schedule = await create();
        const current = await schedules().updateScheduleById(
          schedule.id,
          ownerOf(schedule),
          { name: 'winner' },
          undefined,
          { expectedConfigRevision: 0 },
        );
        expect(current?.name).toBe('winner');
        const loser = await schedules().updateScheduleById(
          schedule.id,
          ownerOf(schedule),
          { name: 'loser' },
          undefined,
          { expectedConfigRevision: 0 },
        );
        expect(loser).toBeNull();
        expect((await live(schedule.id)).name).toBe('winner');
      });

      it('refuses another owner and a schedule being deleted', async () => {
        const schedule = await create();
        expect(
          await schedules().updateScheduleById(schedule.id, newId(), { name: 'stolen' }),
        ).toBeNull();
        await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect(
          await schedules().updateScheduleById(schedule.id, ownerOf(schedule), {
            enabled: true,
            nextRunAt: new Date(Date.now() - 60_000),
          }),
        ).toBeNull();
        expect(await stored(schedule.id)).toMatchObject({ enabled: false, deleting: true });
        expect(
          await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 }),
        ).toBeNull();
      });

      it('drops a paused card in the same write and keeps a settled one', async () => {
        const paused = await create({
          lastRun: { status: 'requires_action', firedAt: new Date(), conversationId: 'c-paused' },
        });
        const editedPause = await schedules().updateScheduleById(paused.id, ownerOf(paused), {
          enabled: false,
        });
        expect(editedPause).toMatchObject({ enabled: false, configRevision: 1 });
        expect(unset(editedPause?.lastRun)).toBe(true);

        const settled = await create({
          lastRun: { status: 'success', firedAt: new Date(), conversationId: 'c-ok' },
        });
        const editedSettled = await schedules().updateScheduleById(settled.id, ownerOf(settled), {
          name: 'renamed',
        });
        expect(editedSettled?.lastRun).toMatchObject({ status: 'success', conversationId: 'c-ok' });
      });

      it('limits a consent-preserving edit to the activation state, at an expected revision', async () => {
        const schedule = await create();
        await expect(
          schedules().updateScheduleById(
            schedule.id,
            ownerOf(schedule),
            { prompt: 'Write now' },
            undefined,
            { expectedConfigRevision: 0, preserveMCPConsentRevision: 'grant-1' },
          ),
        ).rejects.toThrow('Consent continuity is limited to activation state');
        await expect(
          schedules().updateScheduleById(
            schedule.id,
            ownerOf(schedule),
            { enabled: false },
            { chatProjectId: 1 },
            { expectedConfigRevision: 0, preserveMCPConsentRevision: 'grant-1' },
          ),
        ).rejects.toThrow('Consent continuity is limited to activation state');
        await expect(
          schedules().updateScheduleById(
            schedule.id,
            ownerOf(schedule),
            { enabled: false },
            {},
            {
              preserveMCPConsentRevision: 'grant-1',
            },
          ),
        ).rejects.toThrow('Consent continuity is limited to activation state');
        // Without a stored consent at that revision the edit matches nothing.
        expect(
          await schedules().updateScheduleById(
            schedule.id,
            ownerOf(schedule),
            { enabled: false },
            undefined,
            { expectedConfigRevision: 0, preserveMCPConsentRevision: 'grant-1' },
          ),
        ).toBeNull();
        expect(await stored(schedule.id)).toMatchObject({ enabled: true, configRevision: 0 });
      });
    });

    describe('getScheduleById', () => {
      it('reads the schedule, of its owner when given, unless it is being deleted', async () => {
        const schedule = await create();
        expect((await schedules().getScheduleById(schedule.id))?.id).toBe(schedule.id);
        expect((await schedules().getScheduleById(schedule.id, ownerOf(schedule)))?.id).toBe(
          schedule.id,
        );
        expect(await schedules().getScheduleById(schedule.id, newId())).toBeNull();
        expect(await schedules().getScheduleById('sched-missing')).toBeNull();
        await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect(await schedules().getScheduleById(schedule.id)).toBeNull();
        expect(await schedules().getScheduleById(schedule.id, ownerOf(schedule))).toBeNull();
      });
    });

    describe('getSchedulesByUser and countSchedulesByUser', () => {
      it('lists the owner’s live schedules, most recently updated first, without the lease fields', async () => {
        const user = newId();
        const base = Date.parse('2026-06-01T00:00:00.000Z');
        const raw = (id: string, minutes: number, extra: RawRecord = {}): RawRecord => ({
          _id: newId(),
          id,
          user,
          name: id,
          prompt: 'Summarize',
          agent_id: 'agent-test',
          cadence: { frequency: 'daily', hour: 8, minute: 0 },
          timezone: 'UTC',
          target: 'new',
          enabled: true,
          deleting: false,
          leaseUntil: new Date(base + 3_600_000),
          leaseBy: 'w1',
          claimToken: `token-${id}`,
          createdAt: new Date(base),
          updatedAt: new Date(base + minutes * 60_000),
          ...extra,
        });
        await harness.seedRaw('schedules', [
          raw('older', 1),
          raw('newest', 3),
          raw('middle', 2),
          raw('deleting', 4, { deleting: true }),
          raw('other-owner', 5, { user: newId() }),
        ]);
        const listed = await schedules().getSchedulesByUser(user);
        expect(listed.map((schedule) => schedule.id)).toEqual(['newest', 'middle', 'older']);
        for (const schedule of listed) {
          expect(schedule).not.toHaveProperty('leaseUntil');
          expect(schedule).not.toHaveProperty('leaseBy');
          expect(schedule).not.toHaveProperty('claimToken');
          expect(ownerOf(schedule)).toBe(user);
        }
        expect(await schedules().countSchedulesByUser(user)).toBe(3);
        expect(await schedules().countSchedulesByUser(newId())).toBe(0);
      });
    });

    describe('getScheduleByClientRequestId', () => {
      it('resolves the owner’s key, also on a schedule being deleted', async () => {
        const user = newId();
        const schedule = await create({ user, deleting: true, clientRequestId: 'intent-9' });
        expect((await schedules().getScheduleByClientRequestId(user, 'intent-9'))?.id).toBe(
          schedule.id,
        );
        expect(await schedules().getScheduleByClientRequestId(newId(), 'intent-9')).toBeNull();
        expect(await schedules().getScheduleByClientRequestId(user, 'intent-0')).toBeNull();
      });
    });

    describe('markScheduleDeleting', () => {
      it('disables, hides and unarms the schedule, keeping a live lease', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        const marked = await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect(marked).toMatchObject({ deleting: true, enabled: false, leaseBy: 'w1' });
        expect(unset(marked?.nextRunAt)).toBe(true);
        expect(marked?.claimToken).not.toBe(claim?.claimToken);
        expect(await schedules().getSchedulesByUser(ownerOf(schedule))).toEqual([]);
        expect(await schedules().countSchedulesByUser(ownerOf(schedule))).toBe(0);
      });

      it('marks again (rotating the token once more) so teardown can be re-driven', async () => {
        const schedule = await create();
        const first = await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        const retry = await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect(retry).toMatchObject({ deleting: true, enabled: false });
        expect(retry?.claimToken).not.toBe(first?.claimToken);
      });

      it('refuses another owner', async () => {
        const schedule = await create();
        expect(await schedules().markScheduleDeleting(schedule.id, newId())).toBeNull();
        expect(await stored(schedule.id)).toMatchObject({ deleting: false, enabled: true });
      });
    });

    /* ------------------------------------------------------------ engine: leases and claims */

    describe('claimDueSchedule', () => {
      it('grants exactly one winner across 8 concurrent claims, with a fresh claim token', async () => {
        const schedule = await create();
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            schedules().claimDueSchedule({ instanceId: `inst-${index}`, leaseMs: 60_000 }),
          ),
        );
        const winners = results.filter((result) => result != null);
        expect(winners).toHaveLength(1);
        expect(winners[0]?.id).toBe(schedule.id);
        expect(winners[0]?.leaseBy).toMatch(/^inst-\d$/);
        expect(timeOf(winners[0]?.leaseUntil)).toBeGreaterThan(Date.now() + 50_000);
        expect(winners[0]?.claimToken).toEqual(expect.any(String));
        expect((await stored(schedule.id))?.claimToken).toBe(winners[0]?.claimToken);
      });

      it('blocks a second claim while the lease is live', async () => {
        const schedule = await create();
        expect((await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: 60_000 }))?.id).toBe(
          schedule.id,
        );
        expect(await schedules().claimDueSchedule({ instanceId: 'b', leaseMs: 60_000 })).toBeNull();
      });

      it('takes over a lease expired past the 30 s skew margin, not one expired just now', async () => {
        const stale = await create();
        await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: -31_000 });
        const takeover = await schedules().claimDueSchedule({ instanceId: 'b', leaseMs: 60_000 });
        expect(takeover).toMatchObject({ id: stale.id, leaseBy: 'b' });
        await schedules().markScheduleDeleting(stale.id, ownerOf(stale));

        await create();
        expect(
          await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: -1_000 }),
        ).not.toBeNull();
        expect(await schedules().claimDueSchedule({ instanceId: 'b', leaseMs: 60_000 })).toBeNull();
      });

      it('claims due schedules oldest next run first', async () => {
        const now = Date.now();
        const later = await create({ nextRunAt: new Date(now - 60_000) });
        const earlier = await create({ nextRunAt: new Date(now - 120_000) });
        const first = await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: 60_000 });
        const second = await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: 60_000 });
        expect([first?.id, second?.id]).toEqual([earlier.id, later.id]);
        expect(await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: 60_000 })).toBeNull();
      });

      it('never claims disabled, future, unarmed or deleting schedules', async () => {
        const now = Date.now();
        await create({ enabled: false, nextRunAt: new Date(now - 60_000) });
        await create({ nextRunAt: new Date(now + 3_600_000) });
        await createUnarmed();
        await create({ deleting: true });
        expect(await schedules().claimDueSchedule({ instanceId: 'a', leaseMs: 60_000 })).toBeNull();
      });
    });

    describe('acquireManualRunLease', () => {
      it('serializes concurrent run-now attempts and is released without advancing', async () => {
        const nextRunAt = new Date('2030-08-01T12:00:00.000Z');
        const schedule = await create({ nextRunAt });
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            schedules().acquireManualRunLease(schedule.id, ownerOf(schedule), 60_000),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await schedules().releaseLease(schedule.id)).toBe(true);
        const released = await live(schedule.id);
        expect(unset(released.leaseUntil)).toBe(true);
        expect(unset(released.leaseBy)).toBe(true);
        expect(timeOf(released.nextRunAt)).toBe(nextRunAt.getTime());
        expect(
          await schedules().acquireManualRunLease(schedule.id, ownerOf(schedule), 60_000),
        ).not.toBeNull();
      });

      it('resolves to the fresh row, an edit included, under a unique manual holder', async () => {
        const schedule = await create({ name: 'original' });
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'edited' });
        const leased = await schedules().acquireManualRunLease(
          schedule.id,
          ownerOf(schedule),
          60_000,
        );
        expect(leased?.name).toBe('edited');
        expect(leased?.leaseBy).toBe(`manual:${leased?.claimToken}`);
      });

      it('blocks against a held engine lease and refuses another owner or a deleting schedule', async () => {
        const schedule = await create();
        await schedules().claimDueSchedule({ instanceId: 'engine-1', leaseMs: 60_000 });
        expect(
          await schedules().acquireManualRunLease(schedule.id, ownerOf(schedule), 60_000),
        ).toBeNull();
        const other = await create({ nextRunAt: new Date(Date.now() + 3_600_000) });
        expect(await schedules().acquireManualRunLease(other.id, newId(), 60_000)).toBeNull();
        await schedules().markScheduleDeleting(other.id, ownerOf(other));
        expect(
          await schedules().acquireManualRunLease(other.id, ownerOf(other), 60_000),
        ).toBeNull();
      });
    });

    describe('releaseLease and releaseLeaseByHolder', () => {
      it('releases only under the expected claim token, when one is given', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        expect(await schedules().releaseLease(schedule.id, 'stale-token')).toBe(false);
        expect((await live(schedule.id)).leaseBy).toBe('w1');
        expect(await schedules().releaseLease(schedule.id, claim?.claimToken)).toBe(true);
        expect(unset((await live(schedule.id)).leaseBy)).toBe(true);
        expect(await schedules().releaseLease('sched-missing')).toBe(false);
      });

      it('releases by holder, so a stale run-now cannot strip a replacement lease', async () => {
        const schedule = await create();
        const first = await schedules().acquireManualRunLease(
          schedule.id,
          ownerOf(schedule),
          60_000,
        );
        await schedules().releaseLease(schedule.id);
        const second = await schedules().acquireManualRunLease(
          schedule.id,
          ownerOf(schedule),
          60_000,
        );
        expect(second?.leaseBy).not.toBe(first?.leaseBy);
        await schedules().releaseLeaseByHolder(schedule.id, first!.leaseBy!);
        expect((await live(schedule.id)).leaseBy).toBe(second?.leaseBy);
        await schedules().releaseLeaseByHolder(schedule.id, second!.leaseBy!);
        const cleared = await live(schedule.id);
        expect(unset(cleared.leaseBy)).toBe(true);
        expect(unset(cleared.leaseUntil)).toBe(true);
      });
    });

    describe('acquireResumeLease and consumeResumeLease', () => {
      it('consumes the lease taken at the same live revision and releases it', async () => {
        const schedule = await create();
        const fence = await schedules().acquireResumeLease(schedule.id, 0, true, 60_000);
        expect(fence?.leaseBy).toBe(`resume:${fence?.claimToken}`);
        expect(
          await schedules().consumeResumeLease(
            schedule.id,
            fence!.claimToken!,
            fence!.leaseBy!,
            true,
            0,
          ),
        ).toBe(true);
        const consumed = await live(schedule.id);
        expect(unset(consumed.leaseUntil)).toBe(true);
        expect(unset(consumed.leaseBy)).toBe(true);
        // Consumed once: the fence is gone.
        expect(
          await schedules().consumeResumeLease(
            schedule.id,
            fence!.claimToken!,
            fence!.leaseBy!,
            true,
            0,
          ),
        ).toBe(false);
      });

      it('refuses the consume after an owner edit, which leaves the holder to release it', async () => {
        const schedule = await create();
        const fence = await schedules().acquireResumeLease(schedule.id, 0, true, 60_000);
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'after' });
        expect(
          await schedules().consumeResumeLease(
            schedule.id,
            fence!.claimToken!,
            fence!.leaseBy!,
            true,
            0,
          ),
        ).toBe(false);
        expect((await live(schedule.id)).leaseBy).toBe(fence?.leaseBy);
        await schedules().releaseLeaseByHolder(schedule.id, fence!.leaseBy!);
        expect(unset((await live(schedule.id)).leaseBy)).toBe(true);
      });

      it('takes the lease only at the expected revision, enabled when required, and not over a live lease', async () => {
        const schedule = await create({ enabled: false });
        expect(await schedules().acquireResumeLease(schedule.id, 1, false, 60_000)).toBeNull();
        expect(await schedules().acquireResumeLease(schedule.id, 0, true, 60_000)).toBeNull();
        const fence = await schedules().acquireResumeLease(schedule.id, undefined, false, 60_000);
        expect(fence).not.toBeNull();
        expect(await schedules().acquireResumeLease(schedule.id, 0, false, 60_000)).toBeNull();
        // Consuming with `requireEnabled` refuses the disabled schedule.
        expect(
          await schedules().consumeResumeLease(
            schedule.id,
            fence!.claimToken!,
            fence!.leaseBy!,
            true,
          ),
        ).toBe(false);
        expect(
          await schedules().consumeResumeLease(
            schedule.id,
            fence!.claimToken!,
            fence!.leaseBy!,
            false,
          ),
        ).toBe(true);
      });

      it('refuses to consume an expired lease', async () => {
        const schedule = await create();
        const fence = await schedules().acquireResumeLease(schedule.id, 0, true, -1);
        expect(
          await schedules().consumeResumeLease(
            schedule.id,
            fence!.claimToken!,
            fence!.leaseBy!,
            true,
            0,
          ),
        ).toBe(false);
      });
    });

    describe('revalidateClaim', () => {
      it('holds until an owner edit rotates the token', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        expect(await schedules().revalidateClaim(schedule.id, claim!.claimToken!)).toBe(true);
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'renamed' });
        expect(await schedules().revalidateClaim(schedule.id, claim!.claimToken!)).toBe(false);
      });

      it('fails once the lease expires, after a release, and for a deleting schedule', async () => {
        const expired = await create();
        const expiredClaim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: -1 });
        expect(await schedules().revalidateClaim(expired.id, expiredClaim!.claimToken!)).toBe(
          false,
        );
        await schedules().markScheduleDeleting(expired.id, ownerOf(expired));

        const manual = await create({ nextRunAt: new Date(Date.now() + 3_600_000) });
        const lease = await schedules().acquireManualRunLease(manual.id, ownerOf(manual), 60_000);
        expect(await schedules().revalidateClaim(manual.id, lease!.claimToken!)).toBe(true);
        await schedules().releaseLease(manual.id, lease!.claimToken);
        expect(await schedules().revalidateClaim(manual.id, lease!.claimToken!)).toBe(false);

        const deleting = await create();
        const deletingClaim = await schedules().claimDueSchedule({
          instanceId: 'w1',
          leaseMs: 60_000,
        });
        await schedules().markScheduleDeleting(deleting.id, ownerOf(deleting));
        expect(await schedules().revalidateClaim(deleting.id, deletingClaim!.claimToken!)).toBe(
          false,
        );
      });

      it('checks enabled only when required (a manual run of a disabled schedule)', async () => {
        const schedule = await create({ enabled: false });
        const lease = await schedules().acquireManualRunLease(
          schedule.id,
          ownerOf(schedule),
          60_000,
        );
        expect(await schedules().revalidateClaim(schedule.id, lease!.claimToken!)).toBe(false);
        expect(await schedules().revalidateClaim(schedule.id, lease!.claimToken!, false)).toBe(
          true,
        );
      });
    });

    describe('advanceSchedule', () => {
      it('moves to the next run and releases the lease while it sits on the claimed occurrence', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        const next = new Date('2030-01-01T00:00:00.000Z');
        expect(
          await schedules().advanceSchedule(
            schedule.id,
            next,
            new Date('2000-01-01T00:00:00.000Z'),
            claim!.claimToken,
          ),
        ).toBe(false);
        expect(
          await schedules().advanceSchedule(schedule.id, next, claim!.nextRunAt, 'stale-token'),
        ).toBe(false);
        expect(timeOf((await live(schedule.id)).nextRunAt)).toBe(timeOf(claim!.nextRunAt));
        expect(
          await schedules().advanceSchedule(schedule.id, next, claim!.nextRunAt, claim!.claimToken),
        ).toBe(true);
        const advanced = await live(schedule.id);
        expect(timeOf(advanced.nextRunAt)).toBe(next.getTime());
        expect(unset(advanced.leaseUntil)).toBe(true);
        expect(unset(advanced.leaseBy)).toBe(true);
        expect(advanced.configRevision).toBe(0);
      });

      it('unarms the schedule for a null next run, unfenced when nothing is expected', async () => {
        const schedule = await create();
        expect(await schedules().advanceSchedule(schedule.id, null)).toBe(true);
        expect(unset((await live(schedule.id)).nextRunAt)).toBe(true);
        expect(await schedules().advanceSchedule('sched-missing', null)).toBe(false);
      });

      it('no-ops a stale worker after an owner edit rotated the token', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'renamed' });
        await schedules().disableSchedule(schedule.id, 'too_many_failures', claim!.claimToken);
        expect(
          await schedules().advanceSchedule(
            schedule.id,
            new Date('2030-01-01T00:00:00.000Z'),
            claim!.nextRunAt,
            claim!.claimToken,
          ),
        ).toBe(false);
        const after = await live(schedule.id);
        expect(after.enabled).toBe(true);
        expect(unset(after.disabledReason)).toBe(true);
        expect(timeOf(after.nextRunAt)).toBe(timeOf(claim!.nextRunAt));
      });
    });

    describe('disableSchedule', () => {
      it('disables with the reason and releases the lease, fenced on token and revision', async () => {
        const schedule = await create();
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        await schedules().disableSchedule(schedule.id, 'agent_deleted', claim!.claimToken, 1);
        expect((await live(schedule.id)).enabled).toBe(true);
        await schedules().disableSchedule(schedule.id, 'agent_deleted', claim!.claimToken, 0);
        const disabled = await live(schedule.id);
        expect(disabled).toMatchObject({ enabled: false, disabledReason: 'agent_deleted' });
        expect(unset(disabled.leaseUntil)).toBe(true);
        expect(unset(disabled.leaseBy)).toBe(true);
        expect(disabled.configRevision).toBe(0);
        expect(disabled.claimToken).toBe(claim?.claimToken);
      });

      it('disables unfenced when nothing is expected', async () => {
        const schedule = await create();
        await schedules().disableSchedule(schedule.id, 'invalid_schedule');
        expect(await live(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: 'invalid_schedule',
        });
      });
    });

    describe('persistResolvedProject', () => {
      it('stores and clears the resolved project under the claim token, without an edit', async () => {
        const schedule = await create({ chatProjectId: 'project-old' });
        const claim = await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        await schedules().persistResolvedProject(schedule.id, 'project-stale', 'stale-token');
        expect((await live(schedule.id)).chatProjectId).toBe('project-old');
        await schedules().persistResolvedProject(schedule.id, 'project-pinned', claim!.claimToken);
        const pinned = await live(schedule.id);
        expect(pinned.chatProjectId).toBe('project-pinned');
        expect(pinned.configRevision).toBe(0);
        expect(pinned.claimToken).toBe(claim?.claimToken);
        await schedules().persistResolvedProject(schedule.id, undefined);
        expect(await stored(schedule.id)).not.toHaveProperty('chatProjectId');
      });
    });

    describe('getUnarmedSchedules and armSchedule', () => {
      it('finds enabled live schedules with no next run and arms them once', async () => {
        const unarmed = await createUnarmed({ claimToken: 'ct-live' });
        const disabled = await createUnarmed({ enabled: false });
        const deleting = await createUnarmed();
        await schedules().markScheduleDeleting(deleting.id, ownerOf(deleting));
        await create();
        expect((await schedules().getUnarmedSchedules(10)).map((row) => row.id)).toEqual([
          unarmed.id,
        ]);

        const when = new Date('2030-06-01T00:00:00.000Z');
        expect(await schedules().armSchedule(unarmed.id, when, 0)).toBe(true);
        expect(
          await schedules().armSchedule(unarmed.id, new Date('2030-01-01T00:00:00.000Z')),
        ).toBe(false);
        const armed = await live(unarmed.id);
        expect(timeOf(armed.nextRunAt)).toBe(when.getTime());
        expect(armed).toMatchObject({ claimToken: 'ct-live', configRevision: 0 });
        expect(await schedules().getUnarmedSchedules(10)).toEqual([]);
        expect(await schedules().armSchedule(disabled.id, when)).toBe(false);
        expect(await schedules().armSchedule(deleting.id, when)).toBe(false);
      });

      it('honors the limit, and the revision fence after a concurrent edit', async () => {
        await createUnarmed();
        await createUnarmed();
        const edited = await createUnarmed();
        expect(await schedules().getUnarmedSchedules(2)).toHaveLength(2);
        await schedules().updateScheduleById(edited.id, ownerOf(edited), { name: 'edited' });
        expect(await schedules().armSchedule(edited.id, new Date(Date.now() + 60_000), 0)).toBe(
          false,
        );
        expect(await schedules().armSchedule(edited.id, new Date(Date.now() + 60_000), 1)).toBe(
          true,
        );
      });
    });

    /* ------------------------------------------------------------ deletion and erasure */

    describe('suspendUserSchedulesForDeletion and restoreUserSchedulesFromDeletion', () => {
      const armedAt = new Date('2030-01-01T00:00:00.000Z');

      it('suspends under a token, fencing firing and snapshotting the prior state', async () => {
        const schedule = await create({ nextRunAt: armedAt, claimToken: 'ct-before' });
        await schedules().suspendUserSchedulesForDeletion(ownerOf(schedule), 'attempt-1');
        const after = await live(schedule.id);
        expect(after.enabled).toBe(false);
        expect(unset(after.nextRunAt)).toBe(true);
        expect(after.claimToken).not.toBe('ct-before');
        expect(after.deleting).toBe(false);
        expect(after.deletionSuspension).toMatchObject({ token: 'attempt-1', enabled: true });
        expect(timeOf(after.deletionSuspension?.nextRunAt)).toBe(armedAt.getTime());
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(false);
      });

      it('restores enabled and the next run, and clears the suspension', async () => {
        const schedule = await create({ nextRunAt: armedAt });
        await schedules().suspendUserSchedulesForDeletion(ownerOf(schedule), 'attempt-1');
        await schedules().restoreUserSchedulesFromDeletion(ownerOf(schedule), 'attempt-1');
        const restored = await live(schedule.id);
        expect(restored.enabled).toBe(true);
        expect(timeOf(restored.nextRunAt)).toBe(armedAt.getTime());
        expect(unset(restored.deletionSuspension)).toBe(true);
      });

      it('restores a disabled, unarmed schedule as it was', async () => {
        const schedule = await createUnarmed({ enabled: false });
        await schedules().suspendUserSchedulesForDeletion(ownerOf(schedule), 'attempt-1');
        await schedules().restoreUserSchedulesFromDeletion(ownerOf(schedule), 'attempt-1');
        const restored = await live(schedule.id);
        expect(restored.enabled).toBe(false);
        expect(unset(restored.nextRunAt)).toBe(true);
        expect(unset(restored.deletionSuspension)).toBe(true);
      });

      it('restores only the exact attempt’s token, and never a schedule deleted meanwhile', async () => {
        const user = newId();
        const kept = await create({ user });
        const deleted = await create({ user });
        await schedules().suspendUserSchedulesForDeletion(user, 'attempt-1');
        await schedules().restoreUserSchedulesFromDeletion(user, 'attempt-2');
        expect((await live(kept.id)).deletionSuspension?.token).toBe('attempt-1');
        await schedules().markScheduleDeleting(deleted.id, user);
        await schedules().restoreUserSchedulesFromDeletion(user, 'attempt-1');
        expect((await live(kept.id)).enabled).toBe(true);
        expect(await stored(deleted.id)).toMatchObject({ deleting: true, enabled: false });
      });

      it('keeps the snapshot on a retry, and a later attempt adopts an abandoned one', async () => {
        const schedule = await create({ nextRunAt: armedAt });
        await schedules().suspendUserSchedulesForDeletion(ownerOf(schedule), 'attempt-1');
        await schedules().suspendUserSchedulesForDeletion(ownerOf(schedule), 'attempt-1');
        expect((await live(schedule.id)).deletionSuspension).toMatchObject({
          token: 'attempt-1',
          enabled: true,
        });
        await schedules().suspendUserSchedulesForDeletion(ownerOf(schedule), 'attempt-2');
        const adopted = await live(schedule.id);
        expect(adopted.deletionSuspension).toMatchObject({ token: 'attempt-2', enabled: true });
        expect(timeOf(adopted.deletionSuspension?.nextRunAt)).toBe(armedAt.getTime());
        await schedules().restoreUserSchedulesFromDeletion(ownerOf(schedule), 'attempt-2');
        const restored = await live(schedule.id);
        expect(restored.enabled).toBe(true);
        expect(timeOf(restored.nextRunAt)).toBe(armedAt.getTime());
      });

      it('suspends every live schedule of the owner and no one else’s', async () => {
        const user = newId();
        const first = await create({ user });
        const second = await create({ user });
        const other = await create();
        await schedules().suspendUserSchedulesForDeletion(user, 'attempt-1');
        for (const id of [first.id, second.id]) {
          expect((await live(id)).deletionSuspension?.token).toBe('attempt-1');
        }
        expect(unset((await live(other.id)).deletionSuspension)).toBe(true);
        expect((await live(other.id)).enabled).toBe(true);
        await schedules().restoreUserSchedulesFromDeletion(user, 'attempt-1');
        for (const id of [first.id, second.id]) {
          expect(await live(id)).toMatchObject({ enabled: true });
        }
      });

      it('resolves with nothing to suspend or restore', async () => {
        await expect(
          schedules().suspendUserSchedulesForDeletion(newId(), 'attempt-1'),
        ).resolves.toBeUndefined();
        await expect(
          schedules().restoreUserSchedulesFromDeletion(newId(), 'attempt-1'),
        ).resolves.toBeUndefined();
      });

      it('is erased with its snapshot by the account cascade', async () => {
        const user = newId();
        const schedule = await create({ user });
        await schedules().suspendUserSchedulesForDeletion(user, 'attempt-1');
        await schedules().deleteSchedulesByUser(user);
        expect(await stored(schedule.id)).toBeUndefined();
      });
    });

    describe('getDeletingSchedules, getDeletingScheduleIds and markEraseAttempted', () => {
      it('rotates the deleting window least recently attempted first, without touching updatedAt', async () => {
        const user = newId();
        const first = await createUnarmed({ user, deleting: true });
        const second = await createUnarmed({ user, deleting: true });
        await create({ user });
        const window = await schedules().getDeletingSchedules(1);
        expect(window).toHaveLength(1);
        const before = await stored(window[0].id);
        await schedules().markEraseAttempted(window.map((row) => row.id));
        const attempted = await stored(window[0].id);
        expect(attempted?.eraseAttemptedAt).toBeInstanceOf(Date);
        expect(timeOf(attempted?.updatedAt)).toBe(timeOf(before?.updatedAt));
        const rotated = await schedules().getDeletingSchedules(1);
        expect(rotated[0].id).not.toBe(window[0].id);
        expect([first.id, second.id]).toContain(rotated[0].id);
        expect((await schedules().getDeletingSchedules(10)).map((row) => row.id).sort()).toEqual(
          [first.id, second.id].sort(),
        );
      });

      it('rotates the owner’s deletion-retry ids the same way', async () => {
        const user = newId();
        const first = await createUnarmed({ user, deleting: true });
        const second = await createUnarmed({ user, deleting: true });
        await createUnarmed({ deleting: true });
        const window = await schedules().getDeletingScheduleIds(user, 1);
        expect(window).toHaveLength(1);
        await schedules().markEraseAttempted(window);
        const rotated = await schedules().getDeletingScheduleIds(user, 1);
        expect(rotated[0]).not.toBe(window[0]);
        expect((await schedules().getDeletingScheduleIds(user, 10)).sort()).toEqual(
          [first.id, second.id].sort(),
        );
      });

      it('stamps only schedules being deleted and accepts an empty list', async () => {
        const schedule = await create();
        await schedules().markEraseAttempted([]);
        await schedules().markEraseAttempted([schedule.id]);
        expect(await stored(schedule.id)).not.toHaveProperty('eraseAttemptedAt');
      });
    });

    describe('eraseScheduleIfDrained', () => {
      it('waits for the active runs to drain, then erases the schedule and its runs', async () => {
        const schedule = (await schedules().createScheduleWithSlot(
          scheduleData(),
          10,
        )) as ISchedule;
        const when = new Date('2026-07-20T12:00:00.000Z');
        await schedules().reserveStartedRun(runData(schedule, { scheduledFor: when }));
        await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect(
          await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 }),
        ).toBeNull();
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(false);
        expect(await stored(schedule.id)).toBeDefined();

        await schedules().recordRunOutcome({
          scheduleId: schedule.id,
          scheduledFor: when,
          status: 'interrupted',
          autoDisableAfterFailures: 3,
        });
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(true);
        expect(await stored(schedule.id)).toBeUndefined();
        expect(await runsOf(schedule.id)).toEqual([]);
        expect(
          await schedules().createScheduleWithSlot(scheduleData({ user: ownerOf(schedule) }), 10),
        ).not.toBe('limit');
      });

      it('waits for a live lease (a worker mid-claim) to be released', async () => {
        const schedule = await create();
        await schedules().claimDueSchedule({ instanceId: 'w1', leaseMs: 60_000 });
        await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(false);
        await schedules().releaseLeaseByHolder(schedule.id, 'w1');
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(true);
        expect(await stored(schedule.id)).toBeUndefined();
      });

      it('leaves a content-free tombstone for a schedule created under an idempotency key', async () => {
        const user = newId();
        const schedule = await createUnarmed({
          user,
          deleting: true,
          tenantId: 'tenant-a',
          clientRequestId: 'late-retry-key',
          clientRequestDigest: 'digest-1',
          file_ids: ['file-1'],
          tools: ['tool-1'],
          chatProjectId: 'project-1',
          slot: 0,
          failureCount: 2,
        });
        const before = await stored(schedule.id);
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(true);
        const tombstone = await schedules().getScheduleByClientRequestId(user, 'late-retry-key');
        expect(tombstone).toMatchObject({
          id: schedule.id,
          erased: true,
          deleting: true,
          enabled: false,
          tenantId: 'tenant-a',
          clientRequestId: 'late-retry-key',
          clientRequestDigest: 'digest-1',
        });
        expect(tombstone?.erasedAt).toBeInstanceOf(Date);
        expect(
          Object.keys(tombstone ?? {}).filter(
            (key) => !TOMBSTONE_FIELDS.includes(key) && tombstone?.[key as keyof ISchedule] != null,
          ),
        ).toEqual([]);
        const raw = await stored(schedule.id);
        expect(
          Object.keys(raw ?? {}).filter(
            (key) => !TOMBSTONE_FIELDS.includes(key) && raw?.[key] != null,
          ),
        ).toEqual([]);
        expect(timeOf(raw?.updatedAt)).toBe(timeOf(before?.updatedAt));
        expect(await schedules().getDeletingSchedules(50)).toEqual([]);
        expect(await schedules().getDeletingScheduleIds(user, 50)).toEqual([]);
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(true);
        expect(await stored(schedule.id)).toBeDefined();
      });

      it('hard-deletes a schedule that never carried a key', async () => {
        const schedule = await createUnarmed({ deleting: true });
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(true);
        expect(await stored(schedule.id)).toBeUndefined();
      });

      it('acknowledges a schedule already gone without touching its orphan runs, and keeps a live one', async () => {
        const orphan = { id: 'sched-erased-by-peer', user: newId() };
        await schedules().insertScheduleRun(runData(orphan, { status: 'success' }));
        expect(await schedules().eraseScheduleIfDrained(orphan.id)).toBe(true);
        expect(await runsOf(orphan.id)).toHaveLength(1);

        const live = await create();
        await schedules().insertScheduleRun(runData(live, { status: 'success' }));
        expect(await schedules().eraseScheduleIfDrained(live.id)).toBe(false);
        expect(await stored(live.id)).toBeDefined();
        expect(await runsOf(live.id)).toHaveLength(1);
      });
    });

    describe('deleteSchedulesByUser', () => {
      it('removes the owner’s schedules (deleting ones too) and their runs, no one else’s', async () => {
        const user = newId();
        const a = await create({ user });
        const b = await create({ user, deleting: true });
        const other = await create();
        await schedules().insertScheduleRun(runData(a));
        await schedules().insertScheduleRun(runData(b, { status: 'success' }));
        await schedules().insertScheduleRun(runData(other));

        await schedules().deleteSchedulesByUser(user);

        expect((await harness.readRaw('schedules')).map((row) => row.id)).toEqual([other.id]);
        expect(
          (await harness.readRaw('scheduleruns')).map((row) => row.scheduleId as string),
        ).toEqual([other.id]);
        await expect(schedules().deleteSchedulesByUser(user)).resolves.toBeUndefined();
      });
    });
  });
}
