import type { ContractHarness } from '~/contracts/harness';
import type { ScheduleStoreData } from '~/ports/schedule';
import type { ISchedule } from '~/types';
import type { DataStore } from '~/ports';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL schedule stores (docs/postgres-port/PHASE4.md §3.5): parallel
 * calls on separate pool clients. Due-schedule claims (one winner per schedule, takeovers only past
 * the skew margin), manual and resume leases, the worker fences on the expected next run, the
 * per-owner slot allocator, the run-slot partial unique indexes (occurrence, active run, capacity
 * slot) for reservations and resume claims, the per-occurrence counter, an MCP receipt racing a
 * settlement on the run's child table, and consent confirmations. Each case runs with the shadow
 * check off (the production single-statement path) and on (the lock-then-write path).
 */
describePostgres('PostgreSQL schedule stores under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    let stores: DataStore;

    beforeAll(async () => {
      await harness.setup();
      stores = harness.createStores();
    }, 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const newId = () => harness.ids.generate();
    let counter = 0;
    const occurrence = (hours = 0) =>
      new Date(Date.parse('2026-07-20T12:00:00.000Z') + hours * 3_600_000);
    const scheduleData = (overrides: ScheduleStoreData = {}): ScheduleStoreData => ({
      id: `sched-${++counter}`,
      user: newId(),
      name: 'Digest',
      prompt: 'Summarize',
      agent_id: 'agent-test',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'UTC',
      target: 'new',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000),
      ...overrides,
    });
    const create = (overrides: ScheduleStoreData = {}) =>
      stores.schedules.createSchedule(scheduleData(overrides));
    const runOf = async (scheduleId: string) =>
      (await harness.readRaw('scheduleruns')).filter((run) => run.scheduleId === scheduleId);
    const parallel = <T>(count: number, call: (index: number) => Promise<T>) =>
      Promise.all(Array.from({ length: count }, (_, index) => call(index)));

    it('claims each due schedule exactly once across 16 parallel claims, oldest first', async () => {
      const now = Date.now();
      const created = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          create({ nextRunAt: new Date(now - (index + 1) * 60_000) }),
        ),
      );
      const claims = await parallel(16, (index) =>
        stores.schedules.claimDueSchedule({ instanceId: `w-${index}`, leaseMs: 60_000 }),
      );
      const won = claims.filter((claim): claim is ISchedule => claim != null);
      expect(won.map((claim) => claim.id).sort()).toEqual(created.map((s) => s.id).sort());
      for (const claim of won) {
        const [row] = (await harness.readRaw('schedules')).filter((r) => r.id === claim.id);
        expect(row).toMatchObject({ claimToken: claim.claimToken, leaseBy: claim.leaseBy });
      }
      expect(
        await stores.schedules.claimDueSchedule({ instanceId: 'late', leaseMs: 60_000 }),
      ).toBeNull();
    });

    it('takes over a lease expired past the skew margin once, and never one inside it', async () => {
      const stale = await create();
      await stores.schedules.claimDueSchedule({ instanceId: 'dead', leaseMs: -31_000 });
      const takeovers = await parallel(8, (index) =>
        stores.schedules.claimDueSchedule({ instanceId: `w-${index}`, leaseMs: 60_000 }),
      );
      expect(takeovers.filter((claim) => claim?.id === stale.id)).toHaveLength(1);
      await stores.schedules.markScheduleDeleting(stale.id, String(stale.user));

      await create();
      await stores.schedules.claimDueSchedule({ instanceId: 'skewed', leaseMs: -5_000 });
      const blocked = await parallel(8, (index) =>
        stores.schedules.claimDueSchedule({ instanceId: `w-${index}`, leaseMs: 60_000 }),
      );
      expect(blocked.filter((claim) => claim != null)).toEqual([]);
    });

    it('grants one of 8 manual run leases and consumes a resume lease once', async () => {
      const schedule = await create({ nextRunAt: new Date(Date.now() + 3_600_000) });
      const owner = String(schedule.user);
      const leases = await parallel(8, () =>
        stores.schedules.acquireManualRunLease(schedule.id, owner, 60_000),
      );
      expect(leases.filter((lease) => lease != null)).toHaveLength(1);
      await stores.schedules.releaseLease(schedule.id);

      const fences = await parallel(8, () =>
        stores.schedules.acquireResumeLease(schedule.id, 0, true, 60_000),
      );
      const [fence] = fences.filter((lease): lease is ISchedule => lease != null);
      expect(fences.filter((lease) => lease != null)).toHaveLength(1);
      const consumed = await parallel(8, () =>
        stores.schedules.consumeResumeLease(
          schedule.id,
          fence.claimToken!,
          fence.leaseBy!,
          true,
          0,
        ),
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
    });

    it('advances a claimed occurrence once, and never after an owner edit rotated the token', async () => {
      const schedule = await create();
      const claim = await stores.schedules.claimDueSchedule({ instanceId: 'w', leaseMs: 60_000 });
      const advanced = await parallel(8, (index) =>
        stores.schedules.advanceSchedule(
          schedule.id,
          new Date(Date.parse('2030-01-01T00:00:00.000Z') + index * 60_000),
          claim!.nextRunAt,
          claim!.claimToken,
        ),
      );
      expect(advanced.filter(Boolean)).toHaveLength(1);

      const edited = await create();
      const editedClaim = await stores.schedules.claimDueSchedule({
        instanceId: 'w',
        leaseMs: 60_000,
      });
      const [edit, ...stale] = await Promise.all([
        stores.schedules.updateScheduleById(edited.id, String(edited.user), { name: 'edited' }),
        ...Array.from({ length: 4 }, () =>
          stores.schedules.advanceSchedule(
            edited.id,
            new Date('2030-01-01T00:00:00.000Z'),
            editedClaim!.nextRunAt,
            editedClaim!.claimToken,
          ),
        ),
      ]);
      expect(edit).not.toBeNull();
      // The edit rotated the token: at most one stale advance landed, and only before it.
      expect(stale.filter(Boolean).length).toBeLessThanOrEqual(1);
      const [row] = (await harness.readRaw('schedules')).filter((r) => r.id === edited.id);
      expect(row.configRevision).toBe(1);
      expect(row.claimToken).not.toBe(editedClaim!.claimToken);
    });

    it('allocates distinct owner slots up to the cap, a deleting row freeing its slot', async () => {
      const user = newId();
      const results = await parallel(12, () =>
        stores.schedules.createScheduleWithSlot(scheduleData({ user }), 4),
      );
      const created = results.filter((result): result is ISchedule => result !== 'limit');
      expect(created.map((schedule) => schedule.slot).sort()).toEqual([0, 1, 2, 3]);
      await stores.schedules.markScheduleDeleting(created[0].id, user);
      const refill = await parallel(6, () =>
        stores.schedules.createScheduleWithSlot(scheduleData({ user }), 4),
      );
      const replacements = refill.filter((result): result is ISchedule => result !== 'limit');
      expect(replacements.map((schedule) => schedule.slot)).toEqual([created[0].slot]);
      expect(await stores.schedules.countSchedulesByUser(user)).toBe(4);
    });

    it('resolves 8 parallel create replays of one key to one row', async () => {
      const user = newId();
      const results = await parallel(8, (index) =>
        stores.schedules.createScheduleWithSlot(
          scheduleData({ user, clientRequestId: 'intent-1', name: `attempt-${index}` }),
          10,
        ),
      );
      const ids = new Set(results.map((result) => (result as ISchedule)._id?.toString()));
      expect(ids.size).toBe(1);
      expect(await harness.readRaw('schedules')).toHaveLength(1);
    });

    it('decides parallel reservations by occurrence, active run and capacity slot', async () => {
      const schedule = await create();
      const sameOccurrence = await parallel(8, (index) =>
        stores.schedules.reserveStartedRun({
          scheduleId: schedule.id,
          user: String(schedule.user),
          scheduledFor: occurrence(),
          firedAt: new Date(),
          conversationId: `c-${index}`,
        }),
      );
      expect(sameOccurrence.filter((result) => 'run' in result)).toHaveLength(1);
      expect(sameOccurrence.filter((result) => !('run' in result))).toEqual(
        Array.from({ length: 7 }, () => ({ conflict: 'duplicate', existingStatus: 'started' })),
      );

      const overlapping = await create();
      const occurrences = await parallel(8, (index) =>
        stores.schedules.reserveStartedRun({
          scheduleId: overlapping.id,
          user: String(overlapping.user),
          scheduledFor: occurrence(index),
          firedAt: new Date(),
        }),
      );
      expect(occurrences.filter((result) => 'run' in result)).toHaveLength(1);
      expect(occurrences.filter((result) => !('run' in result))).toEqual(
        Array.from({ length: 7 }, () => ({ conflict: 'overlap' })),
      );
      expect(await runOf(overlapping.id)).toHaveLength(1);

      const contenders = await Promise.all(Array.from({ length: 8 }, () => create()));
      const slots = await parallel(8, (index) =>
        stores.schedules.reserveStartedRun({
          scheduleId: contenders[index].id,
          user: String(contenders[index].user),
          scheduledFor: occurrence(),
          firedAt: new Date(),
          capacitySlot: 0,
        }),
      );
      expect(slots.filter((result) => 'run' in result)).toHaveLength(1);
      expect(slots.filter((result) => !('run' in result))).toEqual(
        Array.from({ length: 7 }, () => ({ conflict: 'slot-taken' })),
      );
      const occupancy = await stores.schedules.getCapacityOccupancy();
      expect(occupancy.takenSlots.filter((slot) => slot === 0)).toHaveLength(1);
    });

    it('resumes one of 6 paused runs onto one slot, leaving the others paused', async () => {
      const paused = await Promise.all(Array.from({ length: 6 }, () => create()));
      for (const schedule of paused) {
        await stores.schedules.insertScheduleRun({
          scheduleId: schedule.id,
          user: String(schedule.user),
          scheduledFor: occurrence(),
          status: 'requires_action',
          firedAt: new Date(),
        });
      }
      const claims = await parallel(6, (index) =>
        stores.schedules.markRunResumeClaimed(paused[index].id, occurrence(), 0),
      );
      expect(claims.filter((claim) => 'capacitySlot' in claim)).toEqual([{ capacitySlot: 0 }]);
      expect(claims.filter((claim) => 'conflict' in claim)).toEqual(
        Array.from({ length: 5 }, () => ({ conflict: 'slot-taken' })),
      );
      const statuses = (await harness.readRaw('scheduleruns')).map((run) => run.status).sort();
      expect(statuses).toEqual([
        'requires_action',
        'requires_action',
        'requires_action',
        'requires_action',
        'requires_action',
        'started',
      ]);

      const again = await parallel(4, () =>
        stores.schedules.markRunResumeClaimed(paused[0].id, occurrence(), 1),
      );
      const winner = claims.findIndex((claim) => 'capacitySlot' in claim);
      expect(again.filter((claim) => 'capacitySlot' in claim)).toHaveLength(winner === 0 ? 0 : 1);
    });

    it('counts one occurrence once across 8 parallel settlements and replays', async () => {
      const schedule = await create();
      await stores.schedules.insertScheduleRun({
        scheduleId: schedule.id,
        user: String(schedule.user),
        scheduledFor: occurrence(),
        status: 'started',
        firedAt: new Date(),
      });
      const params = {
        scheduleId: schedule.id,
        scheduledFor: occurrence(),
        status: 'success' as const,
        autoDisableAfterFailures: 3,
      };
      await parallel(8, (index) =>
        index % 2 === 0
          ? stores.schedules.recordRunOutcome(params)
          : stores.schedules.finalizeBookkeeping(params),
      );
      const [row] = (await harness.readRaw('schedules')).filter((r) => r.id === schedule.id);
      expect(row.runCount).toBe(1);
      expect(row.countedFor).toEqual([occurrence()]);
    });

    it('linearizes MCP receipts racing settlements: a success never lands after a receipt', async () => {
      const denial = {
        server: 'Files',
        agentId: 'child',
        status: 'mcp_reauth_required' as const,
        reason: 'consent_revoked' as const,
        recovery: 'authorize' as const,
        automaticReplay: false as const,
      };
      const raced = await Promise.all(Array.from({ length: 6 }, () => create()));
      const outcomes = await Promise.all(
        raced.map(async (schedule) => {
          await stores.schedules.insertScheduleRun({
            scheduleId: schedule.id,
            user: String(schedule.user),
            scheduledFor: occurrence(),
            status: 'started',
            firedAt: new Date(),
            conversationId: 'c1',
            configRevision: 0,
          });
          const [admitted] = await Promise.all([
            stores.schedules.recordMCPToolAuthFailure({
              scheduleId: schedule.id,
              scheduledFor: occurrence(),
              conversationId: 'c1',
              server: 'Files',
              outcome: denial,
            }),
            stores.schedules.recordRunOutcome({
              scheduleId: schedule.id,
              scheduledFor: occurrence(),
              status: 'success',
              autoDisableAfterFailures: 5,
            }),
          ]);
          return { schedule, admitted };
        }),
      );
      for (const { schedule, admitted } of outcomes) {
        const [run] = await runOf(schedule.id);
        expect(run.status).toBe(admitted ? 'error' : 'success');
        expect(run.mcp ?? []).toEqual(admitted ? [denial] : []);
        const card = await stores.schedules.getScheduleById(schedule.id);
        expect(card?.lastRun?.status).toBe(run.status);
        expect(card?.enabled).toBe(!admitted);
      }
    });

    it('stores one of 8 parallel consent confirmations', async () => {
      const owner = newId();
      const identity = {
        scheduleId: 'consent-schedule',
        ownerId: owner,
        tenantId: 'tenant-1',
        agentId: 'root',
        invocationMode: 'delegated' as const,
      };
      await stores.schedules.createSchedule(
        scheduleData({
          id: identity.scheduleId,
          user: owner,
          tenantId: 'tenant-1',
          agent_id: 'root',
        }),
      );
      const enrollment = (revision: string) => ({
        version: 1 as const,
        revision,
        scheduleRevision: 0,
        consents: [
          {
            id: 'consent-1',
            revision,
            identity,
            resource: {
              serverName: 'warehouse',
              url: 'https://warehouse.example/mcp',
              configurationRevision: 'config-1',
              credentialMode: 'resource_bearer' as const,
              issuer: 'https://issuer.example/',
              audience: 'warehouse',
              scopes: ['read'],
            },
            permittedTools: [{ agentId: 'root', tools: ['query'] }],
            policyRevision: 'policy-1',
            grantedAtMs: Date.now() - 1000,
            absoluteExpiresAtMs: Date.now() + 600_000,
            revokedAtMs: null,
          },
        ],
      });
      const results = await parallel(8, (index) =>
        stores.scheduleConsents.confirmScheduleMCPConsent({
          identity,
          expectedConfigRevision: 0,
          expectedRevision: null,
          enrollment: enrollment(`grant-${index}`),
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const read = await stores.scheduleConsents.readScheduleMCPConsent(identity);
      expect(read?.enrollment?.revision).toBe(`grant-${results.indexOf(true)}`);
      const admissions = await parallel(8, () =>
        stores.scheduleConsents.admitScheduleMCPConsent({
          identity,
          expectedConfigRevision: 0,
          revision: read!.enrollment!.revision,
          consentId: 'consent-1',
        }),
      );
      expect(admissions.every(Boolean)).toBe(true);
    });
  });
});
