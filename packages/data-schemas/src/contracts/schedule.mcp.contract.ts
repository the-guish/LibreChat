/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ScheduleStore` contract (`~/ports/schedule`), third part: the MCP receipts of a run
 * (`scheduleruns.mcp`) and their settlement onto the card (`lastRun.mcp`). Ported from
 * `methods/schedule.methods.spec.ts`, which stays unchanged: a durable receipt kept through later
 * fire details (`$addToSet`) and turning any settlement into a permanent failure that disables the
 * schedule, the `$nor`/`$elemMatch` receipt predicates that refuse a pause and a success, the
 * merged union of incoming and durable receipts, the races between a receipt and a settlement
 * (either order linearizes; a success never lands after an admitted receipt), the config fence
 * against an old receipt, the replay of a receipt's bookkeeping, the stale denied-pause replay
 * fenced by a fresh resume claim, the acknowledgment of only matching receipts after settlement,
 * and the MCP failure policy (which statuses disable at once, the ranking of mixed failures, no
 * disable inferred from error text or from a late older occurrence). The runs and bookkeeping are
 * in `schedule.runs.contract.ts`, which lists what stays in the method spec. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import { scheduledMCPFailureReasonSchema } from 'librechat-data-provider';
import type { ISchedule } from '~/types';
import type { ContractHarness } from './harness';
import { timeOf, useContractHarness } from './support';
import { occurrence, scheduleRunFixtures, unset } from './schedule.fixtures';

export function describeScheduleMCPContract(harness: ContractHarness): void {
  describe(`ScheduleStore contract (MCP receipts): ${harness.name}`, () => {
    useContractHarness(harness);

    const { schedules, create, runData, insert, runOf, live, ownerOf, outcome, record } =
      scheduleRunFixtures(harness);

    /* ------------------------------------------------------------ MCP receipts */

    const failures = [
      {
        server: 'Graph',
        status: 'mcp_configuration_missing' as const,
        detail: 'unattended_auth_required' as const,
      },
      {
        server: 'Graph',
        agentId: 'child',
        status: 'mcp_reauth_required' as const,
        reason: scheduledMCPFailureReasonSchema.enum.consent_revoked,
        recovery: 'authorize' as const,
        automaticReplay: false as const,
      },
      {
        server: 'Graph',
        agentId: 'child',
        status: 'mcp_permission_denied' as const,
        reason: scheduledMCPFailureReasonSchema.enum.tool_policy_denied,
        recovery: 'configure' as const,
        automaticReplay: false as const,
      },
      {
        server: 'Graph',
        agentId: 'child',
        status: 'mcp_reauth_required' as const,
        reason: scheduledMCPFailureReasonSchema.enum.credential_rejected,
        recovery: 'authorize' as const,
        automaticReplay: false as const,
      },
    ];

    describe.each([
      ['unattended_auth_required', failures[0]],
      ['consent_revoked', failures[1]],
      ['tool_policy_denied', failures[2]],
      ['credential_rejected', failures[3]],
    ] as const)('MCP receipt settlement: %s', (_name, failure) => {
      const ready = { server: 'Graph', status: 'ready' as const };
      const receipt = (schedule: ISchedule) => ({
        scheduleId: schedule.id,
        scheduledFor: occurrence(),
        conversationId: 'c1',
        server: 'Graph',
        outcome: failure,
      });

      it.each(['success', 'skipped_balance', 'error'] as const)(
        'keeps the receipt through later fire details and settles %s as a permanent failure',
        async (status) => {
          const schedule = await create();
          await insert(schedule, { conversationId: 'c1', configRevision: 0, mcp: [ready] });
          expect(await schedules().recordMCPToolAuthFailure(receipt(schedule))).toBe(true);
          await schedules().setRunFireDetails(schedule.id, occurrence(), {
            conversationId: 'c1',
            mcp: [ready],
            droppedFileIds: ['missing-file'],
          });
          expect((await runOf(schedule.id)).mcp).toEqual([ready, failure]);
          await record(schedule, {
            status,
            conversationId: 'c1',
            ...(status === 'success' ? { mcp: [ready] } : {}),
            ...(status === 'error' ? { error: 'Run ended in error' } : {}),
            autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
            balanceSkipDisableThreshold: 3,
          });
          expect(await runOf(schedule.id)).toMatchObject({
            status: 'error',
            bookkept: true,
            mcp: [ready, failure],
          });
          const card = await live(schedule.id);
          expect(card).toMatchObject({
            enabled: false,
            disabledReason: failure.status,
            failureCount: 1,
            balanceSkipCount: 0,
            lastRun: { status: 'error', mcp: [ready, failure] },
          });
          expect(card.lastRun?.error).toBe(
            status === 'error' ? 'Run ended in error' : 'MCP unattended authorization unavailable',
          );
          await record(schedule, {
            status: 'success',
            autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
          });
          expect((await live(schedule.id)).failureCount).toBe(1);
          expect(await schedules().recordMCPToolAuthFailure(receipt(schedule))).toBe(true);
        },
      );

      it('lets the receipt and the settlement linearize in either order', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1' });
        const [recorded] = await Promise.all([
          schedules().recordMCPToolAuthFailure(receipt(schedule)),
          record(schedule, {
            status: 'success',
            autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
          }),
        ]);
        const run = await runOf(schedule.id);
        const card = await live(schedule.id);
        expect(run.status).toBe(recorded ? 'error' : 'success');
        expect(card.disabledReason ?? undefined).toBe(recorded ? failure.status : undefined);
        expect(card.lastRun?.status).toBe(run.status);
      });

      it('fences an old receipt from disabling a schedule the owner has edited', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1', configRevision: 0 });
        await schedules().recordMCPToolAuthFailure(receipt(schedule));
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'edited' });
        await record(schedule, { status: 'success', autoDisableAfterFailures: 5 });
        expect((await runOf(schedule.id)).status).toBe('error');
        const after = await live(schedule.id);
        expect(after).toMatchObject({ enabled: true, failureCount: 0 });
        expect(unset(after.lastRun)).toBe(true);
      });

      it('replays the receipt’s bookkeeping from the state a failed bookkeeping write leaves', async () => {
        const schedule = await create();
        await insert(schedule, {
          conversationId: 'c1',
          status: 'error',
          bookkept: false,
          error: 'MCP unattended authorization unavailable',
          mcp: [failure],
        });
        const replay = outcome(schedule, {
          status: 'error',
          conversationId: 'c1',
          error: 'MCP unattended authorization unavailable',
          mcp: [failure],
          autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
        });
        await schedules().finalizeBookkeeping(replay);
        await schedules().finalizeBookkeeping(replay);
        expect((await runOf(schedule.id)).bookkept).toBe(true);
        expect(await live(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: failure.status,
          failureCount: 1,
        });
      });
    });

    describe('MCP receipts: the mixed union and the denial predicates', () => {
      const transient = {
        server: 'Graph',
        agentId: 'root',
        status: 'mcp_unavailable' as const,
        reason: scheduledMCPFailureReasonSchema.enum.dependency_unavailable,
        recovery: 'retry_later' as const,
        automaticReplay: false as const,
      };
      const permanent = {
        server: 'Graph',
        agentId: 'child',
        status: 'mcp_reauth_required' as const,
        reason: scheduledMCPFailureReasonSchema.enum.binding_mismatch,
        recovery: 'authorize' as const,
        automaticReplay: false as const,
      };
      const denial = {
        server: 'Files',
        agentId: 'child',
        status: 'mcp_reauth_required' as const,
        reason: 'consent_revoked' as const,
        recovery: 'authorize' as const,
        automaticReplay: false as const,
        detail: 'unattended_auth_required' as const,
      };

      it.each(['success', 'error', 'skipped_balance'] as const)(
        'keeps the merged union and suspends at once on %s',
        async (status) => {
          const schedule = await create();
          await insert(schedule, { conversationId: 'c1', configRevision: 0, mcp: [transient] });
          await record(schedule, {
            status,
            mcp: [transient, permanent, permanent],
            autoDisableAfterFailures: 99,
          });
          const run = await runOf(schedule.id);
          expect(run).toMatchObject({ status: 'error', bookkept: true });
          expect(run.mcp).toEqual([transient, permanent]);
          expect(await live(schedule.id)).toMatchObject({
            enabled: false,
            disabledReason: 'mcp_reauth_required',
            failureCount: 1,
            lastRun: { status: 'error', mcp: [transient, permanent] },
          });
        },
      );

      it('merges a receipt that races the settlement', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1', configRevision: 0 });
        const [recorded] = await Promise.all([
          schedules().recordMCPToolAuthFailure({
            scheduleId: schedule.id,
            scheduledFor: occurrence(),
            conversationId: 'c1',
            server: 'Graph',
            outcome: transient,
          }),
          record(schedule, { status: 'success', mcp: [permanent], autoDisableAfterFailures: 99 }),
        ]);
        const run = await runOf(schedule.id);
        expect(run.status).toBe('error');
        expect(run.mcp).toEqual(
          expect.arrayContaining(recorded ? [transient, permanent] : [permanent]),
        );
        expect(await live(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: 'mcp_reauth_required',
          failureCount: 1,
        });
      });

      it('cannot suspend a schedule edited after the mixed-denial occurrence started', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'c1', configRevision: 0, mcp: [transient] });
        await schedules().updateScheduleById(schedule.id, ownerOf(schedule), { name: 'edited' });
        await record(schedule, {
          status: 'success',
          mcp: [permanent],
          autoDisableAfterFailures: 99,
        });
        expect((await runOf(schedule.id)).mcp).toEqual([transient, permanent]);
        expect(await live(schedule.id)).toMatchObject({ enabled: true, failureCount: 0 });
      });

      it('leaves a denied pause active for its generation-aware owner', async () => {
        const schedule = await create();
        await schedules().reserveStartedRun(
          runData(schedule, { conversationId: 'denied-pause', capacitySlot: 2 }),
        );
        await schedules().recordMCPToolAuthFailure({
          scheduleId: schedule.id,
          scheduledFor: occurrence(),
          conversationId: 'denied-pause',
          server: 'Files',
          outcome: denial,
        });
        await record(schedule, { status: 'requires_action', autoDisableAfterFailures: 5 });
        expect(await runOf(schedule.id)).toMatchObject({
          status: 'started',
          capacitySlot: 2,
          mcp: [denial],
        });
        expect(unset((await live(schedule.id)).lastRun)).toBe(true);
      });

      it.each(['requires_action', 'error'] as const)(
        'does not settle a fresh resumed generation through a stale denied-pause replay (%s)',
        async (status) => {
          const schedule = await create();
          await schedules().reserveStartedRun(
            runData(schedule, { conversationId: 'resume-denial', capacitySlot: 1 }),
          );
          await record(schedule, {
            status: 'requires_action',
            autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
          });
          await schedules().markRunResumeClaimed(schedule.id, occurrence(), 4);
          const before = await runOf(schedule.id);
          await schedules().recordMCPToolAuthFailure({
            scheduleId: schedule.id,
            scheduledFor: occurrence(),
            conversationId: 'resume-denial',
            server: 'Files',
            outcome: denial,
          });
          await record(schedule, {
            status,
            resumeClaimStaleBefore: new Date(Date.now() - 10 * 60_000),
            autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
          });
          const after = await runOf(schedule.id);
          expect(after).toMatchObject({ status: 'started', capacitySlot: 4 });
          expect(timeOf(after.resumeClaimedAt)).toBe(timeOf(before.resumeClaimedAt));
          expect(after.mcp).toEqual([denial]);
        },
      );

      it.each(['success', 'interrupted', 'skipped_balance'] as const)(
        'keeps the denial’s status and recovery instead of %s',
        async (status) => {
          const schedule = await create();
          await insert(schedule, { conversationId: 'denied', configRevision: 0 });
          expect(
            await schedules().recordMCPToolAuthFailure({
              scheduleId: schedule.id,
              scheduledFor: occurrence(),
              conversationId: 'denied',
              server: 'Files',
              outcome: denial,
            }),
          ).toBe(true);
          await record(schedule, { status, autoDisableAfterFailures: 5 });
          expect(await runOf(schedule.id)).toMatchObject({ status: 'error', mcp: [denial] });
          expect(await live(schedule.id)).toMatchObject({
            enabled: false,
            disabledReason: 'mcp_reauth_required',
            lastRun: { status: 'error', mcp: [denial] },
          });
        },
      );

      it('acknowledges only matching receipts already admitted before the settlement', async () => {
        const schedule = await create();
        const input = {
          scheduleId: schedule.id,
          scheduledFor: occurrence(),
          conversationId: 'acknowledged',
          server: 'Files',
          outcome: denial,
        };
        await schedules().reserveStartedRun(runData(schedule, { conversationId: 'acknowledged' }));
        expect(await schedules().recordMCPToolAuthFailure(input)).toBe(true);
        await record(schedule, { status: 'success', autoDisableAfterFailures: 5 });
        const before = await runOf(schedule.id);
        expect(await schedules().recordMCPToolAuthFailure(input)).toBe(true);
        for (const changed of [
          { ...input, conversationId: 'another' },
          { ...input, tenantId: 'another' },
          { ...input, scheduledFor: new Date(occurrence().getTime() + 1) },
          { ...input, outcome: { ...denial, reason: 'consent_expired' as const } },
          { ...input, outcomes: [denial, { ...denial, server: 'new-server' }] },
          { ...input, outcomes: [] },
        ]) {
          expect(await schedules().recordMCPToolAuthFailure(changed)).toBe(false);
        }
        expect(await runOf(schedule.id)).toEqual(before);
        // Terminal receipts of a live schedule are never erased.
        expect(await schedules().eraseScheduleIfDrained(schedule.id)).toBe(false);
        expect(await runOf(schedule.id)).toEqual(before);
      });

      it('merges an incoming diagnosis with a durable receipt, the stronger reason disabling', async () => {
        const schedule = await create();
        await insert(schedule, { conversationId: 'union', configRevision: 0 });
        await schedules().recordMCPToolAuthFailure({
          scheduleId: schedule.id,
          scheduledFor: occurrence(),
          conversationId: 'union',
          server: 'Files',
          outcome: denial,
        });
        const stronger = {
          ...denial,
          server: 'Warehouse',
          status: 'mcp_permission_denied' as const,
          reason: 'tool_policy_denied' as const,
          recovery: 'restore_permission' as const,
        };
        await record(schedule, { status: 'error', mcp: [stronger], autoDisableAfterFailures: 5 });
        const updated = await live(schedule.id);
        expect(updated.lastRun?.mcp).toEqual(expect.arrayContaining([denial, stronger]));
        expect(updated.disabledReason).toBe('mcp_permission_denied');
      });

      it('never settles success after a concurrently admitted receipt wins', async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const schedule = await create();
          await insert(schedule, { conversationId: 'racing', configRevision: 0 });
          const [admitted] = await Promise.all([
            schedules().recordMCPToolAuthFailure({
              scheduleId: schedule.id,
              scheduledFor: occurrence(),
              conversationId: 'racing',
              server: 'Files',
              outcome: denial,
            }),
            record(schedule, { status: 'success', autoDisableAfterFailures: 5 }),
          ]);
          const run = await runOf(schedule.id);
          // A receipt admitted first turns the success into an error; otherwise none landed.
          expect(admitted ? run.status : (run.mcp ?? [])).toEqual(admitted ? 'error' : []);
        }
      });
    });

    describe('MCP failure policy', () => {
      it.each([
        'mcp_reauth_required',
        'mcp_configuration_missing',
        'mcp_permission_denied',
        'mcp_unavailable',
      ] as const)('records %s and disables at once only for user action', async (reason) => {
        const schedule = await create();
        await insert(schedule);
        await record(schedule, {
          status: 'error',
          error: `${reason}: [{"server":"Notion","status":"${reason}"}]`,
          mcp: [{ server: 'Notion', agentId: 'research-agent', status: reason }],
          autoDisableAfterFailures: 5,
        });
        const updated = await live(schedule.id);
        expect(updated.failureCount).toBe(1);
        expect(updated.enabled).toBe(reason === 'mcp_unavailable');
        expect(updated.disabledReason ?? undefined).toBe(
          reason === 'mcp_unavailable' ? undefined : reason,
        );
        expect(updated.lastRun?.mcp?.[0]).toMatchObject({
          server: 'Notion',
          agentId: 'research-agent',
          status: reason,
        });
      });

      it('infers no MCP disable from an ordinary error text, and ranks mixed failures', async () => {
        const plain = await create();
        await insert(plain);
        await record(plain, {
          status: 'error',
          error: 'mcp_configuration_missing: provider returned this text',
          autoDisableAfterFailures: 5,
        });
        expect(await live(plain.id)).toMatchObject({ failureCount: 1, enabled: true });

        const mixed = await create();
        await insert(mixed);
        await record(mixed, {
          status: 'error',
          error: 'mixed MCP failure',
          mcp: [
            { server: 'OAuth', status: 'mcp_reauth_required' },
            { server: 'Private', status: 'mcp_permission_denied' },
          ],
          autoDisableAfterFailures: 5,
        });
        expect(await live(mixed.id)).toMatchObject({
          enabled: false,
          disabledReason: 'mcp_permission_denied',
        });
      });

      it('does not apply a late MCP disable after a newer successful occurrence', async () => {
        const schedule = await create();
        await insert(schedule, { scheduledFor: occurrence(-1), status: 'requires_action' });
        await insert(schedule);
        await record(schedule, { status: 'success', autoDisableAfterFailures: 5 });
        await record(schedule, {
          status: 'error',
          scheduledFor: occurrence(-1),
          error: 'mcp_reauth_required',
          mcp: [{ server: 'Notion', status: 'mcp_reauth_required' }],
          autoDisableAfterFailures: 5,
        });
        expect((await live(schedule.id)).enabled).toBe(true);
      });
    });
  });
}
