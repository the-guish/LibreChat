/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ScheduleStore` contract (`~/ports/schedule`), second part: the run rows and the schedule
 * bookkeeping they drive. Ported from `methods/schedule.methods.spec.ts`, which stays unchanged:
 * the occurrence claim (`{scheduleId, scheduledFor}` unique), the run-slot partial unique indexes
 * (one `started` run per schedule, one `started` run per capacity slot, both ignoring settled
 * rows) and the conflicts they map to, the capacity reads, the recorded project (a stored `null`
 * apart from a field never written), abort coordination (the serialized stop attempt, its
 * staleness, the persistence marker), the resume claim and its rollback, the fire details
 * (`droppedFileIds`, `$addToSet` of MCP receipts), the conversation and status fences of the
 * rollback delete, the active-run reads (`checkpointNamespace` only for the schedule's), the
 * settlement and pause transitions with the card projection (ordered by occurrence, fenced by the
 * run's config revision, never walked back from a settled card to a pause), the streak counters
 * (per-occurrence idempotent through the bounded `countedFor` dates, ordered by `countersAsOf`),
 * the auto-disable policies, the crash-replay bookkeeping, the reconciliation windows and their
 * rotation. The MCP receipt settlement is in `schedule.mcp.contract.ts`; the shared fixtures in
 * `schedule.fixtures.ts`.
 *
 * Not here (they stay in the method spec): the duplicate-key error formats injected by driver
 * spies (keyPattern, errmsg, message, unrecognized errors), the bookkeeping write made to fail by
 * a spy (its replay is covered here from the state it leaves), and the operator-shape spies.
 * Fixtures go through the store's own methods (`insertScheduleRun` stores a run as given) or raw.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { IScheduleRun } from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import { idOf, timeOf, useContractHarness } from './support';
import { occurrence, scheduleRunFixtures, unset } from './schedule.fixtures';

export function describeScheduleRunsContract(harness: ContractHarness): void {
  describe(`ScheduleStore contract (runs and bookkeeping): ${harness.name}`, () => {
    useContractHarness(harness);

    const {
      schedules,
      newId,
      create,
      runData,
      insert,
      runOf,
      runsOf,
      live,
      ownerOf,
      outcome,
      record,
      skip,
    } = scheduleRunFixtures(harness);

    /* ------------------------------------------------------------ runs */

    describe('insertScheduleRun', () => {
      it('stores the run as given and resolves null for an occurrence that already has one', async () => {
        const schedule = await create();
        const first = await insert(schedule, { conversationId: 'c1', configRevision: 0 });
        expect(first).toMatchObject({
          scheduleId: schedule.id,
          status: 'started',
          conversationId: 'c1',
          configRevision: 0,
        });
        expect(idOf(harness, first?.user)).toBe(ownerOf(schedule));
        expect(timeOf(first?.scheduledFor)).toBe(occurrence().getTime());
        expect(await insert(schedule, { status: 'success' })).toBeNull();
        expect(await runsOf(schedule.id)).toHaveLength(1);
      });

      it('stores distinct occurrences, and the same occurrence of another schedule', async () => {
        const schedule = await create();
        const other = await create();
        expect(await insert(schedule, { status: 'success' })).not.toBeNull();
        expect(
          await insert(schedule, { status: 'success', scheduledFor: occurrence(24) }),
        ).not.toBeNull();
        expect(await insert(other, { status: 'success' })).not.toBeNull();
        expect(await harness.readRaw('scheduleruns')).toHaveLength(3);
      });

      it('resolves null for a second started occurrence of one schedule (one active run)', async () => {
        const schedule = await create();
        expect(await insert(schedule)).not.toBeNull();
        expect(await insert(schedule, { scheduledFor: occurrence(1) })).toBeNull();
      });
    });

    describe('reserveStartedRun', () => {
      it('reserves the active slot, then reports another occurrence as an overlap', async () => {
        const schedule = await create();
        const first = await schedules().reserveStartedRun(
          runData(schedule, { status: 'success' as const }),
        );
        expect('run' in first && first.run.status).toBe('started');
        expect(
          await schedules().reserveStartedRun(runData(schedule, { scheduledFor: occurrence(24) })),
        ).toEqual({ conflict: 'overlap' });
        await record(schedule, { status: 'success' });
        const third = await schedules().reserveStartedRun(
          runData(schedule, { scheduledFor: occurrence(24) }),
        );
        expect('run' in third).toBe(true);
      });

      it('reports a re-fired occurrence as a duplicate, with the stored row’s status', async () => {
        const schedule = await create();
        await schedules().reserveStartedRun(runData(schedule, { conversationId: 'first' }));
        expect(
          await schedules().reserveStartedRun(runData(schedule, { conversationId: 'second' })),
        ).toEqual({ conflict: 'duplicate', existingStatus: 'started' });
        await record(schedule, { status: 'success' });
        expect(
          await schedules().reserveStartedRun(runData(schedule, { conversationId: 'third' })),
        ).toEqual({ conflict: 'duplicate', existingStatus: 'success' });
        for (const status of ['requires_action', 'interrupted'] as const) {
          const other = await create();
          await insert(other, { status });
          expect(await schedules().reserveStartedRun(runData(other))).toEqual({
            conflict: 'duplicate',
            existingStatus: status,
          });
        }
      });

      it('holds one started run per capacity slot across schedules; settled rows free theirs', async () => {
        const first = await create();
        const second = await create();
        const third = await create();
        expect(
          'run' in (await schedules().reserveStartedRun(runData(first, { capacitySlot: 0 }))),
        ).toBe(true);
        expect(await schedules().reserveStartedRun(runData(second, { capacitySlot: 0 }))).toEqual({
          conflict: 'slot-taken',
        });
        expect(await runsOf(second.id)).toEqual([]);
        // A settled row may keep the slot number; only `started` rows hold it.
        await insert(third, { status: 'success', capacitySlot: 1 });
        expect(
          'run' in (await schedules().reserveStartedRun(runData(second, { capacitySlot: 1 }))),
        ).toBe(true);
        await record(first, { status: 'success' });
        expect(unset((await runOf(first.id)).capacitySlot)).toBe(true);
        expect(
          'run' in
            (await schedules().reserveStartedRun(
              runData(third, { capacitySlot: 0, scheduledFor: occurrence(1) }),
            )),
        ).toBe(true);
      });
    });

    describe('getCapacityOccupancy and countActiveRuns', () => {
      it('reads the slots of started generation runs, and the unslotted ones apart', async () => {
        const admission = await create();
        const legacy = await create();
        const slotted = await create();
        const paused = await create();
        await schedules().reserveStartedRun(runData(admission, { admissionOnly: true }));
        await schedules().reserveStartedRun(runData(legacy, { scheduledFor: occurrence(1) }));
        await schedules().reserveStartedRun(
          runData(slotted, { scheduledFor: occurrence(2), capacitySlot: 2 }),
        );
        await insert(paused, { status: 'requires_action', capacitySlot: 5 });
        const occupancy = await schedules().getCapacityOccupancy();
        expect(occupancy).toEqual({ takenSlots: [2], unslotted: 1 });
        expect(await schedules().countActiveRuns()).toBe(3);
      });

      it('counts started runs across schedules, settled and paused ones excluded', async () => {
        expect(await schedules().countActiveRuns()).toBe(0);
        const a = await create();
        const b = await create();
        await insert(a);
        await insert(b, { scheduledFor: occurrence(1) });
        expect(await schedules().countActiveRuns()).toBe(2);
        await record(a, { status: 'success' });
        await record(b, { status: 'requires_action', scheduledFor: occurrence(1) });
        expect(await schedules().countActiveRuns()).toBe(0);
        expect(await schedules().getCapacityOccupancy()).toEqual({ takenSlots: [], unslotted: 0 });
      });
    });

    describe('getScheduleRunProject', () => {
      it('reports a recorded project, a recorded null and a field never written apart', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'success', chatProjectId: 'proj-1' });
        await insert(schedule, {
          status: 'success',
          scheduledFor: occurrence(1),
          chatProjectId: null,
        });
        await insert(schedule, { status: 'success', scheduledFor: occurrence(2) });
        expect(await schedules().getScheduleRunProject(schedule.id, occurrence())).toEqual({
          recorded: true,
          chatProjectId: 'proj-1',
        });
        expect(await schedules().getScheduleRunProject(schedule.id, occurrence(1))).toEqual({
          recorded: true,
        });
        expect(await schedules().getScheduleRunProject(schedule.id, occurrence(2))).toEqual({
          recorded: false,
        });
        expect(await schedules().getScheduleRunProject(schedule.id, occurrence(3))).toBeNull();
      });

      it('accepts the occurrence as an ISO string', async () => {
        const schedule = await create();
        await insert(schedule, { chatProjectId: 'proj-1' });
        expect(
          await schedules().getScheduleRunProject(schedule.id, occurrence().toISOString()),
        ).toEqual({ recorded: true, chatProjectId: 'proj-1' });
      });
    });

    describe('requestRunAbort, getScheduleRunAbortState and markRunAbortPersisted', () => {
      it('serializes stop attempts: a second unresolved stop answers in_progress', async () => {
        const schedule = await create();
        await insert(schedule);
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'stop')).toBe(true);
        const state = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(state).toMatchObject({ status: 'started', abortSource: 'stop' });
        expect(state?.abortRequestedAt).toBeInstanceOf(Date);
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'stop')).toBe(
          'in_progress',
        );
      });

      it('renews freshness on a deletion request without stealing an unresolved stop', async () => {
        const schedule = await create();
        await insert(schedule);
        await schedules().requestRunAbort(schedule.id, occurrence(), 'stop');
        const first = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'deletion')).toBe(true);
        const second = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(second?.abortSource).toBe('stop');
        expect(timeOf(second?.abortRequestedAt)).toBeGreaterThanOrEqual(
          timeOf(first?.abortRequestedAt),
        );
      });

      it('lets a stop take over a deletion stamp and re-open its persistence', async () => {
        const schedule = await create();
        await insert(schedule);
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'deletion')).toBe(true);
        expect(
          (await schedules().getScheduleRunAbortState(schedule.id, occurrence()))?.abortSource,
        ).toBe('deletion');
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'stop')).toBe(true);
        const state = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(state?.abortSource).toBe('stop');
        expect(unset(state?.abortPersistedAt)).toBe(true);
      });

      it('lets deletion take the source once the stop resolved, and a new stop re-opens it', async () => {
        const schedule = await create();
        await insert(schedule);
        await schedules().requestRunAbort(schedule.id, occurrence(), 'stop');
        await schedules().markRunAbortPersisted(schedule.id, occurrence());
        expect(
          (await schedules().getScheduleRunAbortState(schedule.id, occurrence()))?.abortPersistedAt,
        ).toBeInstanceOf(Date);
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'deletion')).toBe(true);
        expect(
          (await schedules().getScheduleRunAbortState(schedule.id, occurrence()))?.abortSource,
        ).toBe('deletion');
        await schedules().requestRunAbort(schedule.id, occurrence(), 'stop');
        const state = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(state?.abortSource).toBe('stop');
        expect(unset(state?.abortPersistedAt)).toBe(true);
      });

      it('lets a stop take over an unresolved stop older than 30 minutes', async () => {
        const schedule = await create();
        const stale = new Date(Date.now() - 31 * 60_000);
        await insert(schedule, { abortSource: 'stop', abortRequestedAt: stale });
        expect(await schedules().requestRunAbort(schedule.id, occurrence(), 'stop')).toBe(true);
        expect(
          timeOf(
            (await schedules().getScheduleRunAbortState(schedule.id, occurrence()))
              ?.abortRequestedAt,
          ),
        ).toBeGreaterThan(stale.getTime());
      });

      it('stamps a paused run without a source, and reports false with no active run', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'requires_action' });
        expect(await schedules().requestRunAbort(schedule.id, occurrence())).toBe(true);
        const state = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(state?.abortRequestedAt).toBeInstanceOf(Date);
        expect(unset(state?.abortSource)).toBe(true);
        const settled = await create();
        await insert(settled, { status: 'success' });
        expect(await schedules().requestRunAbort(settled.id, occurrence(), 'stop')).toBe(false);
        expect(await schedules().requestRunAbort(settled.id, occurrence(), 'deletion')).toBe(false);
        expect(await schedules().requestRunAbort('sched-missing', occurrence(), 'stop')).toBe(
          false,
        );
      });

      it('reads only the abort coordination fields, or null with no run', async () => {
        const schedule = await create();
        const mcp = [{ server: 'Graph', status: 'ready' as const }];
        await insert(schedule, { conversationId: 'c1', capacitySlot: 3, mcp });
        const state = await schedules().getScheduleRunAbortState(schedule.id, occurrence());
        expect(state).toMatchObject({ status: 'started', mcp });
        expect(state).not.toHaveProperty('conversationId');
        expect(state).not.toHaveProperty('capacitySlot');
        expect(await schedules().getScheduleRunAbortState(schedule.id, occurrence(1))).toBeNull();
      });

      it('stamps the persistence marker without touching the run’s update time', async () => {
        const schedule = await create();
        await insert(schedule);
        const before = await runOf(schedule.id);
        await schedules().markRunAbortPersisted(schedule.id, occurrence());
        const after = await runOf(schedule.id);
        expect(after.abortPersistedAt).toBeInstanceOf(Date);
        expect(timeOf(after.updatedAt)).toBe(timeOf(before.updatedAt));
      });
    });

    describe('getScheduleMCPCompletionState', () => {
      it('reports a live schedule of the captured identity without a consent as not enrolled', async () => {
        const schedule = await create({ tenantId: 'tenant-1' });
        const identity = {
          scheduleId: schedule.id,
          ownerId: ownerOf(schedule),
          tenantId: 'tenant-1',
          agentId: 'agent-test',
          invocationMode: 'delegated' as const,
        };
        expect(await schedules().getScheduleMCPCompletionState(identity)).toEqual({
          identity,
          enrolled: false,
        });
        for (const changed of [
          { ...identity, agentId: 'agent-other' },
          { ...identity, ownerId: newId() },
          { ...identity, tenantId: 'tenant-2' },
          { ...identity, scheduleId: 'sched-missing' },
        ]) {
          expect(await schedules().getScheduleMCPCompletionState(changed)).toEqual({
            identity: changed,
            enrolled: true,
          });
        }
        await schedules().markScheduleDeleting(schedule.id, ownerOf(schedule));
        expect((await schedules().getScheduleMCPCompletionState(identity))?.enrolled).toBe(true);
      });
    });

    describe('recordMCPToolAuthFailure', () => {
      it('records only on the matching active run, once, with the default receipt', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1' });
        const input = {
          scheduleId: schedule.id,
          scheduledFor: occurrence(),
          conversationId: 'c1',
          server: 'Graph',
        };
        expect(
          await schedules().recordMCPToolAuthFailure({ ...input, conversationId: 'another' }),
        ).toBe(false);
        expect(
          await schedules().recordMCPToolAuthFailure({ ...input, tenantId: 'other-tenant' }),
        ).toBe(false);
        expect(
          await schedules().recordMCPToolAuthFailure({ ...input, scheduledFor: occurrence(1) }),
        ).toBe(false);
        const before = await runOf(schedule.id);
        expect(await schedules().recordMCPToolAuthFailure(input)).toBe(true);
        expect(await schedules().recordMCPToolAuthFailure(input)).toBe(true);
        const after = await runOf(schedule.id);
        expect(after.mcp).toEqual([
          {
            server: 'Graph',
            status: 'mcp_configuration_missing',
            detail: 'unattended_auth_required',
          },
        ]);
        expect(timeOf(after.updatedAt)).toBe(timeOf(before.updatedAt));
      });

      it('binds the tenant: a tenant run needs it, an untenanted one refuses it', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1', tenantId: 'tenant-1' });
        const input = {
          scheduleId: schedule.id,
          scheduledFor: occurrence(),
          conversationId: 'c1',
          server: 'Graph',
        };
        expect(await schedules().recordMCPToolAuthFailure(input)).toBe(false);
        expect(await schedules().recordMCPToolAuthFailure({ ...input, tenantId: 'tenant-1' })).toBe(
          true,
        );
      });

      it('settles the run in error and disables the schedule for the configuration', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1' });
        const input = {
          scheduleId: schedule.id,
          scheduledFor: occurrence(),
          conversationId: 'c1',
          server: 'Graph',
        };
        await schedules().recordMCPToolAuthFailure(input);
        const mcp = (await runOf(schedule.id)).mcp as ScheduleMCPOutcome[];
        await record(schedule, {
          status: 'error',
          mcp,
          error: `mcp_configuration_missing: ${JSON.stringify(mcp)}`,
          autoDisableAfterFailures: 5,
        });
        const after = await live(schedule.id);
        expect(after).toMatchObject({
          enabled: false,
          disabledReason: 'mcp_configuration_missing',
        });
        expect(after.lastRun?.mcp).toEqual(mcp);
        // A replay of the receipt acknowledges the settled evidence.
        expect(await schedules().recordMCPToolAuthFailure(input)).toBe(true);
      });
    });

    describe('markRunResumeClaimed and releaseRunResumeClaim', () => {
      it('promotes a paused run to started under the slot, stamped resume-claimed', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'requires_action' });
        const before = await runOf(schedule.id);
        expect(await schedules().markRunResumeClaimed(schedule.id, occurrence(), 0)).toEqual({
          capacitySlot: 0,
        });
        const after = await runOf(schedule.id);
        expect(after).toMatchObject({ status: 'started', capacitySlot: 0 });
        expect(after.resumeClaimedAt).toBeInstanceOf(Date);
        expect(timeOf(after.updatedAt)).toBe(timeOf(before.updatedAt));
        expect(await schedules().markRunResumeClaimed(schedule.id, occurrence(), 1)).toEqual({
          conflict: 'not-paused',
        });
        expect(await schedules().markRunResumeClaimed('sched-missing', occurrence(), 1)).toEqual({
          conflict: 'not-paused',
        });
      });

      it('reports a taken slot and an active occurrence without changing the pause', async () => {
        const first = await create();
        const second = await create();
        await insert(first, { capacitySlot: 0, scheduledFor: occurrence(-1) });
        await insert(second, { status: 'requires_action' });
        expect(await schedules().markRunResumeClaimed(second.id, occurrence(), 0)).toEqual({
          conflict: 'slot-taken',
        });
        await insert(first, { status: 'requires_action' });
        expect(await schedules().markRunResumeClaimed(first.id, occurrence(), 1)).toEqual({
          conflict: 'overlap',
        });
        expect(await runOf(second.id)).toMatchObject({ status: 'requires_action' });
        expect(await runOf(first.id)).toMatchObject({ status: 'requires_action' });
      });

      it('rolls back only the exact reservation', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'requires_action' });
        await schedules().markRunResumeClaimed(schedule.id, occurrence(), 2);
        expect(await schedules().releaseRunResumeClaim(schedule.id, occurrence(), 1)).toBe(false);
        expect(await schedules().releaseRunResumeClaim(schedule.id, occurrence(), 2)).toBe(true);
        const run = await runOf(schedule.id);
        expect(run.status).toBe('requires_action');
        expect(unset(run.capacitySlot)).toBe(true);
        expect(unset(run.resumeClaimedAt)).toBe(true);
        expect(await schedules().releaseRunResumeClaim(schedule.id, occurrence(), 2)).toBe(false);
      });
    });

    describe('setRunFireDetails', () => {
      it('records the details on the run reserved for that conversation, merging receipts', async () => {
        const schedule = await create();
        const ready = { server: 'Graph', status: 'ready' as const };
        await insert(schedule, { conversationId: 'c1', mcp: [ready] });
        await schedules().setRunFireDetails(schedule.id, occurrence(), {
          conversationId: 'c-other',
          droppedFileIds: ['file-x'],
        });
        expect(await runOf(schedule.id)).not.toHaveProperty('droppedFileIds');
        const notion = { server: 'Notion', status: 'mcp_unavailable' as const };
        await schedules().setRunFireDetails(schedule.id, occurrence(), {
          conversationId: 'c1',
          droppedFileIds: ['missing-file'],
          mcp: [ready, notion],
        });
        expect(await runOf(schedule.id)).toMatchObject({
          conversationId: 'c1',
          droppedFileIds: ['missing-file'],
          mcp: [ready, notion],
        });
        await schedules().setRunFireDetails(schedule.id, occurrence(), {
          conversationId: 'c1',
          droppedFileIds: [],
          mcp: [notion],
        });
        expect(await runOf(schedule.id)).toMatchObject({
          droppedFileIds: ['missing-file'],
          mcp: [ready, notion],
        });
      });

      it('does not restore a cleared conversation from late fire details', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1' });
        await record(schedule, { status: 'interrupted', clearConversationId: true });
        await schedules().setRunFireDetails(schedule.id, occurrence(), {
          conversationId: 'c1',
          mcp: [{ server: 'Graph', status: 'ready' }],
        });
        const run = await runOf(schedule.id);
        expect(unset(run.conversationId)).toBe(true);
        expect(unset(run.mcp)).toBe(true);
      });
    });

    describe('deleteScheduleRun', () => {
      it('deletes only the reservation the caller inserted, still at the expected status', async () => {
        const schedule = await create();
        await schedules().reserveStartedRun(runData(schedule, { conversationId: 'conv-mine' }));
        await schedules().deleteScheduleRun(schedule.id, occurrence(), 'started', 'conv-theirs');
        expect(await schedules().getActiveRunsForSchedule(schedule.id)).toHaveLength(1);
        await schedules().deleteScheduleRun(schedule.id, occurrence(), 'requires_action');
        expect(await schedules().getActiveRunsForSchedule(schedule.id)).toHaveLength(1);
        await schedules().deleteScheduleRun(schedule.id, occurrence(), 'started', 'conv-mine');
        expect(await runsOf(schedule.id)).toEqual([]);
      });

      it('never rolls back a settled run, and deletes unfenced when nothing is expected', async () => {
        const schedule = await create();
        await schedules().reserveStartedRun(runData(schedule, { conversationId: 'conv-mine' }));
        await record(schedule, { status: 'success' });
        await schedules().deleteScheduleRun(schedule.id, occurrence(), 'started', 'conv-mine');
        expect(await runsOf(schedule.id)).toHaveLength(1);
        expect((await live(schedule.id)).lastRun?.status).toBe('success');
        await schedules().deleteScheduleRun(schedule.id, occurrence());
        expect(await runsOf(schedule.id)).toEqual([]);
      });
    });

    describe('getActiveRunsForSchedule and getActiveRunsForUser', () => {
      it('reads the schedule’s started and paused runs with their checkpoint namespace', async () => {
        const schedule = await create();
        await insert(schedule, { scheduledFor: occurrence(-2), status: 'success' });
        await insert(schedule, {
          scheduledFor: occurrence(-1),
          status: 'requires_action',
          checkpointNamespace: 'ns-paused',
        });
        await insert(schedule, { checkpointNamespace: 'ns-started' });
        const active = await schedules().getActiveRunsForSchedule(schedule.id);
        expect(
          active
            .map((run) => [run.status, run.checkpointNamespace])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
        ).toEqual([
          ['requires_action', 'ns-paused'],
          ['started', 'ns-started'],
        ]);
      });

      it('reads the owner’s in-flight runs, narrowed to the statuses asked for, without the namespace', async () => {
        const user = newId();
        const schedule = await create({ user });
        const other = await create();
        await insert(schedule, {
          scheduledFor: occurrence(1),
          status: 'requires_action',
          checkpointNamespace: 'ns',
        });
        await insert(schedule, { scheduledFor: occurrence(2), checkpointNamespace: 'ns' });
        await insert(schedule, { scheduledFor: occurrence(3), status: 'error' });
        await insert(other);
        const all = await schedules().getActiveRunsForUser(user);
        expect(all.map((run) => run.status).sort()).toEqual(['requires_action', 'started']);
        expect(all.every((run) => run.checkpointNamespace === undefined)).toBe(true);
        const started = await schedules().getActiveRunsForUser(user, ['started']);
        expect(started.map((run) => timeOf(run.scheduledFor))).toEqual([occurrence(2).getTime()]);
        expect(await schedules().getActiveRunsForUser(newId())).toEqual([]);
      });
    });

    /* ------------------------------------------------------------ outcomes and bookkeeping */

    describe('recordRunOutcome: settlement', () => {
      it('settles a success: the run, the card, runCount, and a reset of both streaks', async () => {
        const schedule = await create({
          failureCount: 2,
          balanceSkipCount: 3,
          disabledReason: 'insufficient_balance',
        });
        await insert(schedule, { capacitySlot: 4, admissionOnly: true });
        await record(schedule, { status: 'success', conversationId: 'convo-1', durationMs: 1234 });
        const run = await runOf(schedule.id);
        expect(run).toMatchObject({
          status: 'success',
          conversationId: 'convo-1',
          durationMs: 1234,
          bookkept: true,
        });
        expect(run.settledAt).toBeInstanceOf(Date);
        expect(unset(run.capacitySlot)).toBe(true);
        expect(unset(run.admissionOnly)).toBe(true);
        const updated = await live(schedule.id);
        expect(updated).toMatchObject({
          runCount: 1,
          failureCount: 0,
          balanceSkipCount: 0,
          enabled: true,
        });
        expect(unset(updated.disabledReason)).toBe(true);
        expect(updated.lastRun).toMatchObject({ status: 'success', conversationId: 'convo-1' });
        expect(updated.lastRun?.firedAt).toBeInstanceOf(Date);
        expect(timeOf(updated.lastRun?.scheduledFor)).toBe(occurrence().getTime());
        expect(timeOf(updated.countersAsOf)).toBe(occurrence().getTime());
        expect((updated.countedFor ?? []).map(timeOf)).toEqual([occurrence().getTime()]);
      });

      it('counts an error toward the streak and disables at the threshold, releasing the lease', async () => {
        const below = await create();
        await insert(below);
        const mcp = [{ server: 'Notion', status: 'mcp_unavailable' as const }];
        await record(below, { status: 'error', error: 'provider exploded', mcp });
        expect(await runOf(below.id)).toMatchObject({
          status: 'error',
          error: 'provider exploded',
          mcp,
        });
        expect(await live(below.id)).toMatchObject({
          failureCount: 1,
          runCount: 0,
          enabled: true,
          lastRun: { status: 'error', error: 'provider exploded' },
        });
        await schedules().markScheduleDeleting(below.id, ownerOf(below));

        const at = await create({ failureCount: 2 });
        await schedules().claimDueSchedule({ instanceId: 'inst-a', leaseMs: 60_000 });
        await insert(at);
        await record(at, { status: 'error', error: 'provider exploded' });
        const disabled = await live(at.id);
        expect(disabled).toMatchObject({
          failureCount: 3,
          enabled: false,
          disabledReason: 'too_many_failures',
        });
        expect(unset(disabled.leaseUntil)).toBe(true);
        expect(unset(disabled.leaseBy)).toBe(true);
      });

      it('records an interrupt on the card without touching the counters', async () => {
        const schedule = await create({ runCount: 4, failureCount: 1 });
        await insert(schedule);
        await record(schedule, { status: 'interrupted' });
        expect((await runOf(schedule.id)).status).toBe('interrupted');
        expect(await live(schedule.id)).toMatchObject({
          runCount: 4,
          failureCount: 1,
          lastRun: { status: 'interrupted' },
        });
      });

      it('settles a resumed run from requires_action with full bookkeeping', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'requires_action' });
        await record(schedule, { status: 'success', conversationId: 'convo-resumed' });
        expect((await runOf(schedule.id)).status).toBe('success');
        expect(await live(schedule.id)).toMatchObject({
          runCount: 1,
          lastRun: { status: 'success', conversationId: 'convo-resumed' },
        });
      });

      it('touches no bookkeeping without a matching active run', async () => {
        const schedule = await create({ runCount: 7 });
        await record(schedule, { status: 'success', conversationId: 'spoofed' });
        await insert(schedule, { scheduledFor: occurrence(1), status: 'success' });
        await record(schedule, { status: 'error', scheduledFor: occurrence(1) });
        const updated = await live(schedule.id);
        expect(updated.runCount).toBe(7);
        expect(updated.failureCount).toBe(0);
        expect(unset(updated.lastRun)).toBe(true);
        expect((await runOf(schedule.id, occurrence(1))).status).toBe('success');
      });

      it('erases the reserved conversation with clearConversationId, so replays cannot restore it', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'reserved-but-never-created' });
        await record(schedule, { status: 'interrupted', clearConversationId: true });
        expect(unset((await runOf(schedule.id)).conversationId)).toBe(true);
        expect(unset((await live(schedule.id)).lastRun?.conversationId)).toBe(true);
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'interrupted' }));
        expect(unset((await live(schedule.id)).lastRun?.conversationId)).toBe(true);
      });

      it('counts an occurrence once across repeated settlements', async () => {
        const schedule = await create();
        await insert(schedule);
        const params = outcome(schedule, { status: 'success', conversationId: 'convo-1' });
        await schedules().recordRunOutcome(params);
        await schedules().recordRunOutcome(params);
        const updated = await live(schedule.id);
        expect(updated.runCount).toBe(1);
        expect((updated.countedFor ?? []).map(timeOf)).toEqual([occurrence().getTime()]);
        expect((await runOf(schedule.id)).bookkept).toBe(true);
      });
    });

    describe('recordRunOutcome: the pause', () => {
      it('pauses the run, frees its slot and projects the card without touching counters', async () => {
        const schedule = await create({ failureCount: 1 });
        await schedules().reserveStartedRun(runData(schedule, { capacitySlot: 1 }));
        await record(schedule, {
          status: 'requires_action',
          conversationId: 'convo-paused',
          checkpointNamespace: 'owned-namespace',
        });
        const run = await runOf(schedule.id);
        expect(run).toMatchObject({ status: 'requires_action', conversationId: 'convo-paused' });
        expect(unset(run.capacitySlot)).toBe(true);
        expect(unset(run.settledAt)).toBe(true);
        const updated = await live(schedule.id);
        expect(updated).toMatchObject({
          runCount: 0,
          failureCount: 1,
          lastRun: { status: 'requires_action', conversationId: 'convo-paused' },
        });
        expect(await schedules().getActiveRunsForSchedule(schedule.id)).toEqual([
          expect.objectContaining({
            status: 'requires_action',
            checkpointNamespace: 'owned-namespace',
          }),
        ]);
        // A replay without a namespace keeps the stored one.
        await record(schedule, { status: 'requires_action', conversationId: 'convo-paused' });
        expect(
          (await schedules().getActiveRunsForSchedule(schedule.id))[0].checkpointNamespace,
        ).toBe('owned-namespace');
      });

      it('re-affirms the card on a replay, keeping the run’s fire time and the update time', async () => {
        const schedule = await create();
        const firedAt = new Date('2026-07-20T12:00:02.000Z');
        await insert(schedule, { firedAt });
        await record(schedule, { status: 'requires_action', conversationId: 'convo-1' });
        const afterFirst = await live(schedule.id);
        await record(schedule, { status: 'requires_action', conversationId: 'convo-2' });
        const afterSecond = await live(schedule.id);
        expect(afterSecond.lastRun?.conversationId).toBe('convo-2');
        expect(timeOf(afterSecond.lastRun?.firedAt)).toBe(firedAt.getTime());
        expect(timeOf(afterSecond.updatedAt)).toBe(timeOf(afterFirst.updatedAt));
      });

      it('does not project a pause without a matching active run, nor after the run settled', async () => {
        const spoofed = await create();
        await record(spoofed, { status: 'requires_action', conversationId: 'convo-spoof' });
        expect(unset((await live(spoofed.id)).lastRun)).toBe(true);

        const settled = await create();
        await insert(settled);
        await record(settled, { status: 'success', conversationId: 'convo-1' });
        await record(settled, { status: 'requires_action', conversationId: 'convo-1' });
        expect((await runOf(settled.id)).status).toBe('success');
        expect((await live(settled.id)).lastRun?.status).toBe('success');
      });

      it('refuses to walk the occurrence’s settled card back to a pause', async () => {
        const schedule = await create({
          lastRun: {
            status: 'success',
            firedAt: new Date(),
            scheduledFor: occurrence(),
            conversationId: 'convo-1',
          },
        });
        await insert(schedule);
        await record(schedule, { status: 'requires_action', conversationId: 'convo-1' });
        expect((await runOf(schedule.id)).status).toBe('requires_action');
        expect((await live(schedule.id)).lastRun?.status).toBe('success');
        const fresh = await create();
        await insert(fresh);
        await record(fresh, { status: 'requires_action', conversationId: 'convo-1' });
        expect((await live(fresh.id)).lastRun?.status).toBe('requires_action');
      });

      it('fences a recovery replay against a fresh resume claim, not an abandoned one', async () => {
        const staleBefore = () => new Date(Date.now() - 10 * 60_000);
        const raced = await create();
        await schedules().reserveStartedRun(
          runData(raced, { conversationId: 'c', capacitySlot: 0 }),
        );
        await record(raced, { status: 'requires_action', resumeClaimStaleBefore: staleBefore() });
        expect(await schedules().markRunResumeClaimed(raced.id, occurrence(), 3)).toEqual({
          capacitySlot: 3,
        });
        await record(raced, { status: 'requires_action', resumeClaimStaleBefore: staleBefore() });
        const claimed = await runOf(raced.id);
        expect(claimed).toMatchObject({ status: 'started', capacitySlot: 3 });
        expect(claimed.resumeClaimedAt).toBeInstanceOf(Date);

        const stuck = await create();
        await schedules().reserveStartedRun(
          runData(stuck, { conversationId: 'c', capacitySlot: 1 }),
        );
        await record(stuck, { status: 'requires_action', resumeClaimStaleBefore: staleBefore() });
        expect((await runOf(stuck.id)).status).toBe('requires_action');
        expect(unset((await runOf(stuck.id)).capacitySlot)).toBe(true);

        const abandoned = await create();
        await insert(abandoned, {
          capacitySlot: 4,
          resumeClaimedAt: new Date(Date.now() - 60 * 60_000),
        });
        await record(abandoned, {
          status: 'requires_action',
          resumeClaimStaleBefore: staleBefore(),
        });
        const recovered = await runOf(abandoned.id);
        expect(recovered.status).toBe('requires_action');
        expect(unset(recovered.capacitySlot)).toBe(true);
        expect(unset(recovered.resumeClaimedAt)).toBe(true);
      });
    });

    describe('recordRunOutcome: card order and config fences', () => {
      it('keeps a newer occurrence’s card and streak against a late older outcome', async () => {
        const schedule = await create();
        await insert(schedule, { scheduledFor: occurrence(-1) });
        await record(schedule, {
          status: 'requires_action',
          scheduledFor: occurrence(-1),
          conversationId: 'convo-older',
        });
        await insert(schedule);
        await record(schedule, { status: 'success', conversationId: 'convo-newer' });
        await record(schedule, {
          status: 'error',
          error: 'stale',
          scheduledFor: occurrence(-1),
          conversationId: 'convo-older',
          autoDisableAfterFailures: 1,
        });
        const updated = await live(schedule.id);
        expect(updated.lastRun).toMatchObject({ status: 'success', conversationId: 'convo-newer' });
        expect(updated.failureCount).toBe(0);
        expect(updated.enabled).toBe(true);
        expect(unset(updated.disabledReason)).toBe(true);
        expect((await runOf(schedule.id, occurrence(-1))).status).toBe('error');
      });

      it('still counts occurrences that settle in order', async () => {
        const schedule = await create();
        await insert(schedule, { scheduledFor: occurrence(-1), status: 'requires_action' });
        await insert(schedule);
        await record(schedule, {
          status: 'error',
          scheduledFor: occurrence(-1),
          autoDisableAfterFailures: 5,
        });
        await record(schedule, { status: 'error', autoDisableAfterFailures: 5 });
        expect((await live(schedule.id)).failureCount).toBe(2);
      });

      it('skips the bookkeeping of a run started under an older config revision', async () => {
        const schedule = await create();
        await insert(schedule, { configRevision: 0 });
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'edited' });
        await record(schedule, { status: 'error', error: 'boom' });
        expect((await runOf(schedule.id)).status).toBe('error');
        const after = await live(schedule.id);
        expect(after.failureCount).toBe(0);
        expect(unset(after.lastRun)).toBe(true);
      });

      it('does not auto-disable a schedule at the threshold when the run’s revision is stale', async () => {
        const schedule = await create({ failureCount: 5 });
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'renamed' });
        await insert(schedule, { configRevision: 0 });
        await record(schedule, { status: 'error', error: 'stale', autoDisableAfterFailures: 1 });
        expect((await live(schedule.id)).enabled).toBe(true);
        const current = await create();
        await insert(current, { configRevision: 0 });
        await record(current, { status: 'error', error: 'boom', autoDisableAfterFailures: 1 });
        expect(await live(current.id)).toMatchObject({
          enabled: false,
          disabledReason: 'too_many_failures',
        });
      });

      it('does not stamp a pause onto a schedule edited after the run started', async () => {
        const schedule = await create();
        await insert(schedule, { configRevision: 0 });
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'renamed' });
        await record(schedule, { status: 'requires_action', conversationId: 'convo-1' });
        expect((await runOf(schedule.id)).status).toBe('requires_action');
        expect(unset((await live(schedule.id)).lastRun)).toBe(true);
        await record(schedule, { status: 'success' });
        expect(await live(schedule.id)).toMatchObject({ runCount: 0 });
        expect(unset((await live(schedule.id)).lastRun)).toBe(true);
      });

      it('clears the transient disable reason on success only while enabled', async () => {
        const disabled = await create({ enabled: false, disabledReason: 'too_many_failures' });
        await insert(disabled);
        await record(disabled, { status: 'success' });
        expect(await live(disabled.id)).toMatchObject({
          enabled: false,
          disabledReason: 'too_many_failures',
          runCount: 1,
        });
      });
    });

    describe('recordRunOutcome: a mid-generation balance refusal', () => {
      it('walks the balance streak instead of the failure streak and frees capacity', async () => {
        const schedule = await create();
        await insert(schedule, { capacitySlot: 0, conversationId: 'c1' });
        await record(schedule, {
          status: 'skipped_balance',
          conversationId: 'c1',
          autoDisableAfterFailures: 5,
          balanceSkipDisableThreshold: 5,
        });
        const run = await runOf(schedule.id);
        expect(run).toMatchObject({ status: 'skipped_balance', bookkept: true });
        expect(unset(run.capacitySlot)).toBe(true);
        expect(await live(schedule.id)).toMatchObject({
          balanceSkipCount: 1,
          failureCount: 0,
          enabled: true,
          lastRun: { status: 'skipped_balance', conversationId: 'c1' },
        });
      });

      it('auto-disables for insufficient balance at the threshold, idempotent on replay', async () => {
        const schedule = await create({ balanceSkipCount: 4 });
        await insert(schedule, { capacitySlot: 0 });
        const params = outcome(schedule, {
          status: 'skipped_balance',
          autoDisableAfterFailures: 5,
          balanceSkipDisableThreshold: 5,
        });
        await schedules().recordRunOutcome(params);
        await schedules().finalizeBookkeeping(params);
        expect(await live(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: 'insufficient_balance',
          balanceSkipCount: 5,
        });
      });

      it('projects the card but walks no streak without a threshold', async () => {
        const schedule = await create({ balanceSkipCount: 2 });
        await insert(schedule);
        await record(schedule, { status: 'skipped_balance' });
        expect(await live(schedule.id)).toMatchObject({
          balanceSkipCount: 2,
          lastRun: { status: 'skipped_balance' },
        });
      });
    });

    describe('recordSkippedRun', () => {
      it('stores a settled skip and walks the balance streak to auto-disable', async () => {
        const schedule = await create();
        await skip(schedule, 'skipped_balance', {}, 2);
        const run = await runOf(schedule.id);
        expect(run).toMatchObject({ status: 'skipped_balance', bookkept: true });
        expect(run.firedAt).toBeInstanceOf(Date);
        expect(run.settledAt).toBeInstanceOf(Date);
        expect(await live(schedule.id)).toMatchObject({
          balanceSkipCount: 1,
          enabled: true,
          lastRun: { status: 'skipped_balance' },
        });
        await skip(schedule, 'skipped_balance', { scheduledFor: occurrence(24) }, 2);
        expect(await live(schedule.id)).toMatchObject({
          balanceSkipCount: 2,
          enabled: false,
          disabledReason: 'insufficient_balance',
        });
      });

      it('replays the same skip once, re-projecting the original fire time', async () => {
        const schedule = await create();
        await skip(schedule, 'skipped_balance', {}, 3);
        const firstFire = (await runOf(schedule.id)).firedAt;
        await skip(schedule, 'skipped_balance', {}, 3);
        const updated = await live(schedule.id);
        expect(updated.balanceSkipCount).toBe(1);
        expect(timeOf(updated.lastRun?.firedAt)).toBe(timeOf(firstFire));
        expect(await runsOf(schedule.id)).toHaveLength(1);
      });

      it('leaves an occurrence that already ran alone', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'success' });
        await skip(schedule, 'skipped_balance', {}, 5);
        const after = await live(schedule.id);
        expect(unset(after.lastRun)).toBe(true);
        expect(after.balanceSkipCount).toBe(0);
        expect((await runOf(schedule.id)).status).toBe('success');
      });

      it('records an overlap on the card and breaks the balance streak', async () => {
        const schedule = await create({ balanceSkipCount: 3 });
        await skip(schedule, 'skipped_overlap', {}, 2);
        expect(await runOf(schedule.id)).toMatchObject({
          status: 'skipped_overlap',
          bookkept: true,
        });
        expect(await live(schedule.id)).toMatchObject({
          balanceSkipCount: 0,
          enabled: true,
          lastRun: { status: 'skipped_overlap' },
        });
        expect((await runOf(schedule.id)).settledAt).toBeInstanceOf(Date);
      });

      it('fences the card and the streak by the claimed config revision', async () => {
        const stale = await create();
        await schedules().updateScheduleById(stale.id, ownerOf(stale), { name: 'edited' });
        await skip(stale, 'skipped_overlap', { configRevision: 0 });
        expect((await runOf(stale.id)).status).toBe('skipped_overlap');
        expect(unset((await live(stale.id)).lastRun)).toBe(true);
        await skip(stale, 'skipped_balance', { configRevision: 0, scheduledFor: occurrence(1) }, 1);
        expect(await live(stale.id)).toMatchObject({ balanceSkipCount: 0, enabled: true });

        const current = await create();
        await skip(current, 'skipped_overlap', { configRevision: 0 });
        expect((await live(current.id)).lastRun?.status).toBe('skipped_overlap');
      });

      it('keeps the occurrence marker, so an older settlement cannot roll the card back', async () => {
        const schedule = await create();
        await insert(schedule, { scheduledFor: occurrence(-1) });
        await record(schedule, { status: 'requires_action', scheduledFor: occurrence(-1) });
        await skip(schedule, 'skipped_balance', {}, 5);
        await record(schedule, { status: 'success', scheduledFor: occurrence(-1) });
        expect((await live(schedule.id)).lastRun?.status).toBe('skipped_balance');
      });

      it('resets the balance streak on an intervening error, interrupt or overlap', async () => {
        const schedule = await create({ balanceSkipCount: 4 });
        for (const [hours, status] of [
          [1, 'error'],
          [2, 'interrupted'],
        ] as const) {
          await insert(schedule, { scheduledFor: occurrence(hours) });
          await record(schedule, {
            status,
            scheduledFor: occurrence(hours),
            autoDisableAfterFailures: 10,
          });
          expect((await live(schedule.id)).balanceSkipCount).toBe(0);
        }
        await skip(schedule, 'skipped_balance', { scheduledFor: occurrence(3) }, 10);
        expect((await live(schedule.id)).balanceSkipCount).toBe(1);
        await skip(schedule, 'skipped_overlap', { scheduledFor: occurrence(4) });
        expect((await live(schedule.id)).balanceSkipCount).toBe(0);
      });

      it('keeps the counted occurrences to the newest 64, in the order counted', async () => {
        const schedule = await create();
        for (let index = 0; index < 66; index++) {
          await skip(schedule, 'skipped_balance', { scheduledFor: occurrence(index) }, 1_000);
        }
        const updated = await live(schedule.id);
        expect(updated.balanceSkipCount).toBe(66);
        expect((updated.countedFor ?? []).map(timeOf)).toEqual(
          Array.from({ length: 64 }, (_, index) => occurrence(index + 2).getTime()),
        );
        expect(timeOf(updated.countersAsOf)).toBe(occurrence(65).getTime());
      });
    });

    describe('getUnbookkeptRuns, finalizeBookkeeping and markRunsReconciled', () => {
      it('recovers a settled run whose bookkeeping never landed, once', async () => {
        const schedule = await create();
        await insert(schedule, { status: 'success', bookkept: false });
        expect((await live(schedule.id)).runCount).toBe(0);
        const pending = await schedules().getUnbookkeptRuns(new Date(Date.now() + 1000), 100);
        expect(pending.map((run) => run.scheduleId)).toEqual([schedule.id]);
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'success' }));
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'success' }));
        expect((await live(schedule.id)).runCount).toBe(1);
        expect((await runOf(schedule.id)).bookkept).toBe(true);
        expect(await schedules().getUnbookkeptRuns(new Date(Date.now() + 1000), 100)).toEqual([]);
      });

      it('reads only settled unbookkept runs fired before the cutoff', async () => {
        const schedule = await create();
        const old = new Date(Date.now() - 10 * 60_000);
        await insert(schedule, { status: 'skipped_balance', bookkept: false, firedAt: old });
        await insert(schedule, {
          status: 'error',
          bookkept: false,
          firedAt: new Date(),
          scheduledFor: occurrence(1),
        });
        await insert(schedule, {
          status: 'requires_action',
          bookkept: false,
          firedAt: old,
          scheduledFor: occurrence(2),
        });
        await insert(schedule, { status: 'success', firedAt: old, scheduledFor: occurrence(3) });
        const pending = await schedules().getUnbookkeptRuns(new Date(Date.now() - 60_000), 10);
        expect(pending.map((run) => run.status)).toEqual(['skipped_balance']);
      });

      it('rotates the window past rows already attempted, without touching updatedAt', async () => {
        const schedule = await create();
        const early = new Date('2026-07-20T10:00:00.000Z');
        const late = new Date('2026-07-20T11:00:00.000Z');
        await insert(schedule, {
          status: 'success',
          bookkept: false,
          firedAt: late,
          scheduledFor: occurrence(1),
        });
        await insert(schedule, { status: 'success', bookkept: false, firedAt: early });
        const cutoff = new Date(Date.now() + 1000);
        const first = await schedules().getUnbookkeptRuns(cutoff, 1);
        expect(timeOf(first[0].firedAt)).toBe(early.getTime());
        const before = await runOf(schedule.id);
        await schedules().markRunsReconciled(first);
        const stamped = await runOf(schedule.id);
        expect(stamped.reconciledAt).toBeInstanceOf(Date);
        expect(timeOf(stamped.updatedAt)).toBe(timeOf(before.updatedAt));
        const second = await schedules().getUnbookkeptRuns(cutoff, 1);
        expect(timeOf(second[0].firedAt)).toBe(late.getTime());
        await schedules().markRunsReconciled([]);
      });

      it('replays with the run’s original fire time and its config fence', async () => {
        const schedule = await create();
        const firedAt = new Date('2026-07-20T12:00:03.000Z');
        await insert(schedule, { status: 'success', bookkept: false, firedAt });
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'success' }));
        expect(timeOf((await live(schedule.id)).lastRun?.firedAt)).toBe(firedAt.getTime());

        const edited = await create();
        await insert(edited, { status: 'error', bookkept: false, configRevision: 0 });
        await schedules().updateScheduleById(edited.id, ownerOf(edited), { name: 'edited' });
        await schedules().finalizeBookkeeping(outcome(edited, { status: 'error' }));
        expect((await live(edited.id)).failureCount).toBe(0);
        expect((await runOf(edited.id)).bookkept).toBe(true);
      });

      it('re-applies the auto-disable on a replay after the count landed, without counting twice', async () => {
        // The state a crash leaves after the count landed and before the disable did.
        const schedule = await create({
          failureCount: 3,
          countedFor: [occurrence()],
          countersAsOf: occurrence(),
        });
        await insert(schedule, { status: 'error', bookkept: false });
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'error' }));
        expect(await live(schedule.id)).toMatchObject({
          failureCount: 3,
          enabled: false,
          disabledReason: 'too_many_failures',
        });
        expect((await runOf(schedule.id)).bookkept).toBe(true);
      });

      it('applies the bookkeeping of an occurrence with no run row at all', async () => {
        // NOTE(contract): unlike `recordRunOutcome` (no-match guard), `finalizeBookkeeping`
        // does not require a run row for the occurrence: it counts it and projects the card
        // with the replay time. Its only caller replays rows `getUnbookkeptRuns` returned.
        const schedule = await create();
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'success' }));
        const updated = await live(schedule.id);
        expect(updated.runCount).toBe(1);
        expect(updated.lastRun?.status).toBe('success');
        expect(await runsOf(schedule.id)).toEqual([]);
      });

      it('does not double-count a later occurrence replayed after an earlier one counted', async () => {
        const schedule = await create();
        await insert(schedule, { scheduledFor: occurrence(-1), status: 'requires_action' });
        await insert(schedule);
        await record(schedule, { status: 'success' });
        await record(schedule, { status: 'success', scheduledFor: occurrence(-1) });
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'success' }));
        // The later occurrence counted once; the earlier one settled behind the watermark.
        expect((await live(schedule.id)).runCount).toBe(1);
      });

      it('replays a half-applied overlap skip', async () => {
        const schedule = await create({ balanceSkipCount: 3 });
        await insert(schedule, {
          status: 'skipped_overlap',
          bookkept: false,
          firedAt: new Date(Date.now() - 10 * 60_000),
        });
        await schedules().finalizeBookkeeping(outcome(schedule, { status: 'skipped_overlap' }));
        expect(await live(schedule.id)).toMatchObject({
          balanceSkipCount: 0,
          lastRun: { status: 'skipped_overlap' },
        });
        expect((await runOf(schedule.id)).bookkept).toBe(true);
      });
    });

    describe('getRunsForReconciliation and markRunsReconciled', () => {
      it('reads started and paused runs fired before the cutoff in separate budgets', async () => {
        const schedule = await create();
        for (let index = 0; index < 3; index++) {
          await insert(schedule, {
            scheduledFor: occurrence(-10 - index),
            status: 'requires_action',
            firedAt: new Date('2020-01-01T00:00:00.000Z'),
          });
        }
        await insert(schedule, { firedAt: new Date('2020-06-01T00:00:00.000Z') });
        await insert(schedule, {
          scheduledFor: occurrence(5),
          status: 'success',
          firedAt: new Date('2020-01-01T00:00:00.000Z'),
        });
        const runs = await schedules().getRunsForReconciliation(
          new Date('2026-01-01T00:00:00.000Z'),
          2,
        );
        expect(runs.map((run) => run.status)).toEqual([
          'started',
          'requires_action',
          'requires_action',
        ]);
        expect(
          await schedules().getRunsForReconciliation(new Date('2020-01-01T00:00:00.000Z'), 10),
        ).toEqual([]);
      });

      it('rotates the paused and the started windows once the leaders were examined', async () => {
        const user = newId();
        const base = Date.parse('2026-07-01T00:00:00.000Z');
        const olderThan = new Date(base + 1000 * 60_000);
        const rows = (status: 'started' | 'requires_action', prefix: string): RawRecord[] =>
          Array.from({ length: 101 }, (_, index) => ({
            _id: newId(),
            scheduleId: status === 'started' ? `${prefix}-${index}` : prefix,
            user,
            scheduledFor: new Date(base + index * 60_000),
            firedAt: new Date(base + index * 60_000),
            status,
            createdAt: new Date(base),
            updatedAt: new Date(base),
          }));
        await harness.seedRaw('scheduleruns', [
          ...rows('started', 'started'),
          ...rows('requires_action', 'paused'),
        ]);
        const newest = new Date(base + 100 * 60_000).getTime();
        const hasNewest = (runs: IScheduleRun[], status: string) =>
          runs.some((run) => run.status === status && timeOf(run.scheduledFor) === newest);
        const first = await schedules().getRunsForReconciliation(olderThan, 100);
        expect(first).toHaveLength(200);
        expect(hasNewest(first, 'started')).toBe(false);
        expect(hasNewest(first, 'requires_action')).toBe(false);
        await schedules().markRunsReconciled(first);
        const second = await schedules().getRunsForReconciliation(olderThan, 100);
        expect(hasNewest(second, 'started')).toBe(true);
        expect(hasNewest(second, 'requires_action')).toBe(true);
      });
    });
  });
}
