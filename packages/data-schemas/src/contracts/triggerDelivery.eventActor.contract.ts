/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TriggerDeliveryStore` contract (`~/ports/triggerDelivery`), fourth part: the Event Actor
 * receipts a delivery carries, ported from `methods/triggerDelivery.spec.ts`. The action
 * admission (one marker per delivery, its owner token, a legacy token-less marker that stays
 * protected, the leased-transport window, the tenant and identity scope), the detached action
 * (one replica reserves it, the derived task id and idempotency key, `running`,
 * `launch_indeterminate` at its recovery fence, terminal evidence once, the retry generations
 * kept in `actorDetachedActionHistory`, capped at 8, and at most 16 launch attempts), the
 * receipt (settled once with the public outcome, replayed exactly, every conflicting identity
 * refused, verification racing compensation with one winner, a dead delivery and its batch
 * retired by a late receipt), the lazy backfill of receipts recorded before the ledger, and the
 * storage metrics.
 *
 * Not here (they stay in the method spec): the receipt metric observer. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import type { ContractHarness } from './harness';
import type { EnqueueInput } from './triggerDelivery.fixtures';
import {
  DELIVERIES,
  MINUTE,
  REMOTE_SOURCE,
  SECOND,
  START,
  SUCCESS_RETENTION_MS,
  createTriggerDeliveryFixtures,
} from './triggerDelivery.fixtures';
import { idOf, timeOf, useContractHarness } from './support';

const GENERATION = START.getTime() + SECOND;

export function describeTriggerDeliveryEventActorContract(harness: ContractHarness): void {
  describe(`TriggerDeliveryStore contract (Event Actor receipts): ${harness.name}`, () => {
    useContractHarness(harness);

    const f = createTriggerDeliveryFixtures(harness);
    const store = () => f.store();

    const bindingEnvelope = (bindingId: string) => ({
      mode: 'continue',
      target: { bindingId },
      event: { source: REMOTE_SOURCE },
    });
    const started = (conversationId: string, generationCreatedAt = GENERATION) => ({
      status: 'started' as const,
      conversationId,
      streamId: conversationId,
      generationCreatedAt,
      startedAt: new Date(generationCreatedAt),
    });
    /** A binding delivery whose transport attempt started the child generation (`succeeded`,
     * handling `started`), its owner and identity. */
    const startedDelivery = async (
      bindingId = 'binding-1',
      conversationId = 'conversation-1',
      overrides: Partial<EnqueueInput> = {},
    ) => {
      const user = f.newUser();
      const queued = await f.enqueue({
        user,
        awaitTerminalHandling: true,
        envelope: bindingEnvelope(bindingId),
        ...overrides,
      });
      await f.deliver({
        result: { status: 'started' },
        settledAt: new Date(GENERATION),
        awaitTerminalHandling: true,
        handling: started(conversationId),
      });
      return {
        queued,
        user,
        identity: {
          deliveryKey: queued.delivery.deliveryKey,
          user,
          tenantId: 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
          bindingId,
          conversationId,
        },
      };
    };
    const receiptOf = (conversationId: string) => ({
      resolution: 'checkpoint_verified' as const,
      checkpoint: {
        threadId: conversationId,
        checkpointId: 'checkpoint-1',
        checkpointNs: 'event:1',
      },
      action: { toolName: 'submit_move', toolCallId: 'call-1' },
    });

    /* ------------------------------------------------------------------ admission */

    describe('admitAgentEventActorAction, releaseAgentEventActorAction, hasAgentEventActorActionAdmission and getAgentEventActorActionAdmission', () => {
      it('admits one action per delivery, under its owner token, while the transport is leased', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({ user, envelope: bindingEnvelope('binding-1') });
        await f.claimAndBegin();
        const admission = {
          deliveryKey: queued.delivery.deliveryKey,
          user,
          tenantId: 'tenant-1',
          bindingId: 'binding-1',
          conversationId: 'conversation-1',
          admittedAt: new Date(GENERATION + 500),
          admissionId: 'admission-1',
        };
        const successor = { ...admission, admissionId: 'admission-2' };
        await expect(store().hasAgentEventActorActionAdmission(admission)).resolves.toBe(false);
        await expect(store().getAgentEventActorActionAdmission(admission)).resolves.toBeNull();
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(true);
        await expect(store().hasAgentEventActorActionAdmission(admission)).resolves.toBe(true);
        await expect(store().getAgentEventActorActionAdmission(admission)).resolves.toBe(
          'admission-1',
        );
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(false);
        await expect(store().admitAgentEventActorAction(successor)).resolves.toBe(false);
        await expect(store().releaseAgentEventActorAction(admission)).resolves.toBe(true);
        await expect(store().admitAgentEventActorAction(successor)).resolves.toBe(true);
        /** The predecessor's delayed release cannot clear its successor. */
        await expect(store().releaseAgentEventActorAction(admission)).resolves.toBe(false);
        await expect(store().hasAgentEventActorActionAdmission(successor)).resolves.toBe(true);
        await expect(store().releaseAgentEventActorAction(successor)).resolves.toBe(true);
        await expect(store().getAgentEventActorActionAdmission(admission)).resolves.toBeNull();

        const row = await f.raw(queued.delivery.id);
        expect(row).not.toHaveProperty('actorActionAdmittedAt');
        expect(row).not.toHaveProperty('actorActionAdmissionId');
      });

      it('keeps a token-less legacy admission protected', async () => {
        const { identity } = await startedDelivery();
        const admission = { ...identity, admittedAt: START, admissionId: 'admission-1' };
        const successor = { ...admission, admissionId: 'admission-2' };
        await f.patchDelivery(identity.deliveryKey, { actorActionAdmittedAt: START });
        await expect(store().hasAgentEventActorActionAdmission(admission)).resolves.toBe(true);
        await expect(store().getAgentEventActorActionAdmission(admission)).resolves.toBeNull();
        await expect(store().admitAgentEventActorAction(successor)).resolves.toBe(false);
        await expect(store().releaseAgentEventActorAction(admission)).resolves.toBe(false);

        /** A stale token left behind by a newer worker does not own the old timestamp. */
        await f.patchDelivery(identity.deliveryKey, {
          actorActionAdmissionId: 'stale-new-worker-token',
        });
        await expect(store().hasAgentEventActorActionAdmission(admission)).resolves.toBe(true);
        await expect(store().admitAgentEventActorAction(successor)).resolves.toBe(false);
        await expect(store().releaseAgentEventActorAction(admission)).resolves.toBe(false);
      });

      it('scopes the admission to the owner, tenant, binding and started conversation', async () => {
        const { identity } = await startedDelivery();
        const admission = { ...identity, admittedAt: START, admissionId: 'admission-1' };
        for (const conflict of [
          { ...admission, user: f.newUser() },
          { ...admission, tenantId: 'tenant-2' },
          { ...admission, tenantId: undefined },
          { ...admission, bindingId: 'binding-2' },
          { ...admission, conversationId: 'conversation-2' },
          { ...admission, deliveryKey: 'missing' },
        ]) {
          await expect(store().admitAgentEventActorAction(conflict)).resolves.toBe(false);
        }
        await expect(
          store().admitAgentEventActorAction({ ...admission, user: f.storeId(identity.user) }),
        ).resolves.toBe(true);
        await expect(
          store().hasAgentEventActorActionAdmission({ ...admission, tenantId: 'tenant-2' }),
        ).resolves.toBe(false);
        await expect(
          store().releaseAgentEventActorAction({ ...admission, conversationId: 'conversation-2' }),
        ).resolves.toBe(false);
      });

      it('admits on an untenanted delivery only without a tenant', async () => {
        const { identity } = await startedDelivery('binding-plain', 'conversation-plain', {
          tenantId: undefined,
        });
        expect(identity.tenantId).toBeUndefined();
        const admission = { ...identity, admittedAt: START, admissionId: 'admission-1' };
        await expect(
          store().admitAgentEventActorAction({ ...admission, tenantId: 'tenant-1' }),
        ).resolves.toBe(false);
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(true);
      });

      it('refuses an admission on a pending delivery, and a malformed one', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({ user, envelope: bindingEnvelope('binding-1') });
        const admission = {
          deliveryKey: queued.delivery.deliveryKey,
          user,
          tenantId: 'tenant-1',
          bindingId: 'binding-1',
          conversationId: 'conversation-1',
          admittedAt: START,
          admissionId: 'admission-1',
        };
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(false);
        await expect(
          store().admitAgentEventActorAction({ ...admission, admittedAt: new Date(Number.NaN) }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          store().admitAgentEventActorAction({ ...admission, admissionId: 'x'.repeat(65) }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('serializes no-action settlement against a renewed admission', async () => {
        const { identity } = await startedDelivery();
        const admission = {
          ...identity,
          admittedAt: new Date(GENERATION + 500),
          admissionId: 'admission-1',
        };
        const noAction = {
          deliveryKey: identity.deliveryKey,
          conversationId: identity.conversationId,
          generationCreatedAt: GENERATION,
          status: 'completed_no_action' as const,
          settledAt: new Date(GENERATION + SECOND),
        };
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(true);
        await expect(store().settleAgentTriggerHandlingOutcome(noAction)).resolves.toBe(false);
        await expect(store().releaseAgentEventActorAction(admission)).resolves.toBe(true);
        await expect(store().settleAgentTriggerHandlingOutcome(noAction)).resolves.toBe(true);
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(false);
      });
    });

    /* ------------------------------------------------------------------ detached actions */

    describe('detached actions', () => {
      const reservationOf = (
        identity: {
          deliveryKey: string;
          user: string;
          tenantId?: string;
          bindingId: string;
          conversationId: string;
        },
        overrides: Record<string, unknown> = {},
      ) => ({
        ...identity,
        generationCreatedAt: GENERATION,
        turnId: 'response-detached-1:0',
        invocationId: identity.deliveryKey,
        expectedToolName: 'submit_move',
        toolName: 'submit_move_mcp_chess',
        toolCallId: 'call-detached-1',
        reservedAt: new Date(GENERATION + SECOND),
        recoveryAfter: new Date(GENERATION + 61 * SECOND),
        ...overrides,
      });
      const admitted = async () => {
        const delivery = await startedDelivery('binding-detached-1', 'conversation-detached-1', {
          tenantId: undefined,
        });
        await expect(
          store().admitAgentEventActorAction({
            ...delivery.identity,
            admittedAt: new Date(GENERATION),
            admissionId: 'admission-detached-1',
          }),
        ).resolves.toBe(true);
        return delivery;
      };

      it('gives one replica the reservation, with the derived task id and key', async () => {
        const { identity } = await admitted();
        const reservation = reservationOf(identity);
        const contenders = await Promise.all([
          store().reserveAgentEventActorDetachedAction(reservation),
          store().reserveAgentEventActorDetachedAction(reservation),
        ]);
        expect(contenders.map((result) => result.status).sort()).toEqual(['replay', 'reserved']);
        expect(contenders[0].action).toEqual(contenders[1].action);

        const idempotencyKey = createHash('sha256')
          .update(
            [
              identity.user,
              '',
              identity.deliveryKey,
              identity.bindingId,
              identity.conversationId,
              String(GENERATION),
              reservation.turnId,
              reservation.invocationId,
              reservation.expectedToolName,
              reservation.toolName,
              reservation.toolCallId,
              '0',
            ].join('\0'),
          )
          .digest('hex');
        const taskId = `event_actor_${createHash('sha256')
          .update('librechat:event-actor:task:v1\0')
          .update(idempotencyKey)
          .digest('hex')}`;
        expect(contenders[0].action).toEqual({
          version: 1,
          invocationId: reservation.invocationId,
          expectedToolName: 'submit_move',
          toolName: 'submit_move_mcp_chess',
          toolCallId: 'call-detached-1',
          turnId: 'response-detached-1:0',
          taskId,
          idempotencyKey,
          launchAttempt: 0,
          status: 'reserved',
          reservedAt: reservation.reservedAt,
          observedAt: reservation.reservedAt,
          recoveryAfter: reservation.recoveryAfter,
        });
        await expect(store().reserveAgentEventActorDetachedAction(reservation)).resolves.toEqual({
          status: 'replay',
          action: contenders[0].action,
        });
        await expect(
          store().reserveAgentEventActorDetachedAction({
            ...reservation,
            toolCallId: 'other-call',
          }),
        ).resolves.toMatchObject({ status: 'conflict', action: { taskId } });
        await expect(
          store().getAgentEventActorDetachedAction({
            ...identity,
            generationCreatedAt: GENERATION,
          }),
        ).resolves.toEqual(contenders[0].action);
        expect(await store().getAgentTriggerDelivery(identity.deliveryKey)).not.toHaveProperty(
          'actorDetachedAction',
        );
      });

      it('refuses a reservation without an admission, and a malformed one', async () => {
        const { identity } = await startedDelivery('binding-x', 'conversation-x', {
          tenantId: undefined,
        });
        await expect(
          store().reserveAgentEventActorDetachedAction(reservationOf(identity)),
        ).rejects.toThrow('Detached event actor action reservation owner is unavailable');
        for (const overrides of [
          { turnId: '' },
          { generationCreatedAt: -1 },
          { recoveryAfter: new Date(GENERATION + SECOND) },
          { reservedAt: new Date(Number.NaN) },
        ]) {
          await expect(
            store().reserveAgentEventActorDetachedAction(reservationOf(identity, overrides)),
          ).rejects.toBeInstanceOf(TypeError);
        }
        await expect(
          store().getAgentEventActorDetachedAction({
            ...identity,
            generationCreatedAt: GENERATION,
          }),
        ).resolves.toBeNull();
      });

      it('moves through running, indeterminate and terminal evidence exactly once', async () => {
        const { identity } = await admitted();
        const reservation = reservationOf(identity);
        const { action } = await store().reserveAgentEventActorDetachedAction(reservation);
        const update = {
          ...identity,
          generationCreatedAt: GENERATION,
          taskId: action.taskId,
          idempotencyKey: action.idempotencyKey,
          observedAt: new Date(GENERATION + 2 * SECOND),
        };
        await expect(
          store().markAgentEventActorDetachedActionLaunchIndeterminate({
            ...update,
            observedAt: new Date(reservation.recoveryAfter.getTime() - 1),
          }),
        ).resolves.toEqual({ status: 'conflict' });
        await expect(
          store().markAgentEventActorDetachedActionLaunchIndeterminate({
            ...update,
            observedAt: reservation.recoveryAfter,
          }),
        ).resolves.toEqual({ status: 'applied' });
        await expect(
          store().markAgentEventActorDetachedActionLaunchIndeterminate({
            ...update,
            observedAt: new Date(reservation.recoveryAfter.getTime() + 1),
          }),
        ).resolves.toEqual({ status: 'already_applied' });
        await expect(
          store().markAgentEventActorDetachedActionRunning({
            ...update,
            recoveryAfter: new Date(GENERATION + 1_802 * SECOND),
          }),
        ).resolves.toEqual({ status: 'conflict' });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            status: 'failed',
            error: 'move service unavailable',
          }),
        ).resolves.toEqual({ status: 'applied' });
        await expect(
          store().markAgentEventActorDetachedActionRunning({
            ...update,
            recoveryAfter: new Date(GENERATION + 1_802 * SECOND),
          }),
        ).resolves.toEqual({ status: 'already_applied' });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            observedAt: new Date(GENERATION + 5 * SECOND),
            status: 'failed',
            error: 'move service unavailable',
          }),
        ).resolves.toEqual({ status: 'already_applied' });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            status: 'succeeded',
            result: 'conflicting result',
          }),
        ).resolves.toEqual({ status: 'conflict' });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            idempotencyKey: 'f'.repeat(64),
            status: 'failed',
            error: 'move service unavailable',
          }),
        ).resolves.toEqual({ status: 'conflict' });
        const stored = await store().getAgentEventActorDetachedAction({
          ...identity,
          generationCreatedAt: GENERATION,
        });
        expect(stored).toMatchObject({
          status: 'failed',
          error: 'move service unavailable',
          settledAt: new Date(GENERATION + 2 * SECOND),
          observedAt: new Date(GENERATION + 2 * SECOND),
        });
      });

      it('acknowledges the launch and settles success with its result', async () => {
        const { identity } = await admitted();
        const { action } = await store().reserveAgentEventActorDetachedAction(
          reservationOf(identity),
        );
        const update = {
          ...identity,
          generationCreatedAt: GENERATION,
          taskId: action.taskId,
          idempotencyKey: action.idempotencyKey,
          observedAt: new Date(GENERATION + 2 * SECOND),
          recoveryAfter: new Date(GENERATION + 1_802 * SECOND),
        };
        await expect(store().markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
          status: 'applied',
        });
        await expect(store().markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
          status: 'already_applied',
        });
        expect(
          await store().getAgentEventActorDetachedAction({
            ...identity,
            generationCreatedAt: GENERATION,
          }),
        ).toMatchObject({
          status: 'running',
          launchedAt: update.observedAt,
          recoveryAfter: update.recoveryAfter,
        });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            observedAt: new Date(GENERATION + 3 * SECOND),
            status: 'succeeded',
            result: 'move accepted',
          }),
        ).resolves.toEqual({ status: 'applied' });
        await expect(
          store().markAgentEventActorDetachedActionLaunchIndeterminate({
            ...update,
            observedAt: new Date(GENERATION + 2_000 * SECOND),
          }),
        ).resolves.toEqual({ status: 'conflict' });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            status: 'succeeded',
            error: 'both',
            result: 'x',
          }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          store().markAgentEventActorDetachedActionRunning({
            ...update,
            recoveryAfter: update.observedAt,
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('reserves a retry after a failure and keeps the earlier attempt in the history', async () => {
        const { identity } = await admitted();
        const reservation = reservationOf(identity);
        const first = await store().reserveAgentEventActorDetachedAction(reservation);
        const settle = (action: typeof first.action, observedAt: number, error: string) =>
          store().settleAgentEventActorDetachedAction({
            ...identity,
            generationCreatedAt: GENERATION,
            taskId: action.taskId,
            idempotencyKey: action.idempotencyKey,
            status: 'failed',
            error,
            observedAt: new Date(observedAt),
          });
        await expect(
          settle(first.action, GENERATION + 2 * SECOND, 'definite failure'),
        ).resolves.toEqual({ status: 'applied' });
        await expect(
          store().reserveAgentEventActorDetachedAction(reservation),
        ).resolves.toMatchObject({
          status: 'replay',
          action: { taskId: first.action.taskId, status: 'failed' },
        });

        const retryInput = reservationOf(identity, {
          turnId: 'response-detached-1:1',
          reservedAt: new Date(GENERATION + 3 * SECOND),
          recoveryAfter: new Date(GENERATION + 63 * SECOND),
        });
        const retry = await store().reserveAgentEventActorDetachedAction(retryInput);
        expect(retry).toMatchObject({
          status: 'reserved',
          action: { launchAttempt: 1, toolCallId: 'call-detached-1', status: 'reserved' },
        });
        expect(retry.action.taskId).not.toBe(first.action.taskId);
        await expect(store().reserveAgentEventActorDetachedAction(retryInput)).resolves.toEqual({
          status: 'replay',
          action: retry.action,
        });
        const row = await f.raw(identity.deliveryKey);
        expect(row?.actorDetachedActionHistory).toEqual([
          expect.objectContaining({
            taskId: first.action.taskId,
            status: 'failed',
            error: 'definite failure',
            launchAttempt: 0,
          }),
        ]);
        await expect(
          store().reserveAgentEventActorDetachedAction(
            reservationOf(identity, { turnId: 'response-detached-1:2' }),
          ),
        ).resolves.toMatchObject({ status: 'conflict', action: { taskId: retry.action.taskId } });
      });

      it('keeps the newest 8 attempts in the history and stops at 16 launch attempts', async () => {
        const { identity } = await admitted();
        let current = await store().reserveAgentEventActorDetachedAction(reservationOf(identity));
        for (let attempt = 1; attempt <= 15; attempt += 1) {
          await store().settleAgentEventActorDetachedAction({
            ...identity,
            generationCreatedAt: GENERATION,
            taskId: current.action.taskId,
            idempotencyKey: current.action.idempotencyKey,
            status: 'cancelled',
            observedAt: new Date(GENERATION + attempt * SECOND),
          });
          current = await store().reserveAgentEventActorDetachedAction(
            reservationOf(identity, { turnId: `response-detached-1:${attempt}` }),
          );
          expect(current).toMatchObject({ status: 'reserved', action: { launchAttempt: attempt } });
        }
        const row = await f.raw(identity.deliveryKey);
        const history = row?.actorDetachedActionHistory as Array<{ launchAttempt: number }>;
        expect(history.map((entry) => entry.launchAttempt)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);

        await store().settleAgentEventActorDetachedAction({
          ...identity,
          generationCreatedAt: GENERATION,
          taskId: current.action.taskId,
          idempotencyKey: current.action.idempotencyKey,
          status: 'cancelled',
          observedAt: new Date(GENERATION + 99 * SECOND),
        });
        await expect(
          store().reserveAgentEventActorDetachedAction(
            reservationOf(identity, { turnId: 'response-detached-1:16' }),
          ),
        ).resolves.toMatchObject({ status: 'conflict', action: { launchAttempt: 15 } });
      });

      it('reserves for the exact leased owner before the handling is persisted', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          awaitTerminalHandling: true,
          tenantId: undefined,
          envelope: bindingEnvelope('binding-leased'),
        });
        const begun = await f.claimAndBegin();
        const identity = {
          deliveryKey: queued.delivery.deliveryKey,
          user,
          bindingId: 'binding-leased',
          conversationId: 'conversation-leased',
        };
        await store().admitAgentEventActorAction({
          ...identity,
          admittedAt: new Date(GENERATION),
          admissionId: 'admission-leased',
        });
        const reservation = await store().reserveAgentEventActorDetachedAction(
          reservationOf(identity),
        );
        expect(reservation.status).toBe('reserved');
        const update = {
          ...identity,
          generationCreatedAt: GENERATION,
          taskId: reservation.action.taskId,
          idempotencyKey: reservation.action.idempotencyKey,
          observedAt: new Date(GENERATION + 2 * SECOND),
          recoveryAfter: new Date(GENERATION + 1_802 * SECOND),
        };
        await expect(store().markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
          status: 'applied',
        });
        /** The transport attempt is retried and then dead-lettered: the evidence survives. */
        const retryAt = new Date(GENERATION + 3 * SECOND);
        await store().retryAgentTriggerDelivery({
          ...begun.fence,
          attempt: begun.attempt,
          error: f.failure({ attemptedAt: retryAt }),
          availableAt: retryAt,
        });
        await expect(store().markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
          status: 'already_applied',
        });
        const retried = await f.claimAndBegin({ claimToken: 'claim-retry', now: retryAt });
        await store().deadLetterAgentTriggerDelivery({
          ...retried.fence,
          attempt: retried.attempt,
          error: f.failure({ attemptedAt: retryAt }),
          settledAt: retryAt,
        });
        await expect(
          store().settleAgentEventActorDetachedAction({
            ...update,
            status: 'succeeded',
            result: 'accepted',
            observedAt: new Date(GENERATION + 4 * SECOND),
          }),
        ).resolves.toEqual({ status: 'applied' });
        await expect(
          store().getAgentEventActorDetachedAction({
            ...identity,
            generationCreatedAt: GENERATION,
          }),
        ).resolves.toEqual(expect.objectContaining({ status: 'succeeded', result: 'accepted' }));
        const row = await f.raw(queued.delivery.id);
        expect(row).not.toHaveProperty('handling');
      });
    });

    /* ------------------------------------------------------------------ receipts */

    describe('settleAgentEventActorReceipt and getAgentEventActorReceipt', () => {
      it('settles the public outcome and the exact receipt in one delivery once', async () => {
        const { identity, queued } = await startedDelivery();
        const admission = {
          ...identity,
          admittedAt: new Date(GENERATION + 500),
          admissionId: 'admission-1',
        };
        const receipt = receiptOf('conversation-1');
        const settlement = {
          ...identity,
          generationCreatedAt: GENERATION,
          status: 'applied' as const,
          settledAt: new Date(GENERATION + SECOND),
          requiresActionAdmission: true as const,
          receipt,
        };
        await expect(store().getAgentEventActorReceipt(identity)).resolves.toBeNull();
        await expect(store().settleAgentEventActorReceipt(settlement)).resolves.toBe(false);
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(true);
        await expect(
          store().settleAgentEventActorReceipt({
            ...settlement,
            requiresActionAdmission: undefined,
          }),
        ).resolves.toBe(false);
        await expect(store().settleAgentEventActorReceipt(settlement)).resolves.toBe(true);
        await expect(store().settleAgentEventActorReceipt(settlement)).resolves.toBe(true);
        await expect(store().releaseAgentEventActorAction(admission)).resolves.toBe(false);
        const row = await f.raw(identity.deliveryKey);
        expect(row).not.toHaveProperty('actorActionAdmittedAt');
        expect(row).not.toHaveProperty('actorActionAdmissionId');
        await expect(
          store().countActiveAgentTriggerDeliveriesByUser(identity.user, settlement.settledAt),
        ).resolves.toBe(0);

        const stored = {
          bindingId: 'binding-1',
          ...receipt,
          settledAt: settlement.settledAt,
        };
        await expect(store().getAgentEventActorReceipt(identity)).resolves.toEqual(stored);
        const delivery = await store().getAgentTriggerDelivery(identity.deliveryKey);
        expect(delivery).toMatchObject({
          status: 'succeeded',
          handling: { status: 'applied', action: receipt.action, settledAt: settlement.settledAt },
          actorReceipt: stored,
        });
        expect(timeOf(delivery?.expiresAt)).toBe(
          settlement.settledAt.getTime() + SUCCESS_RETENTION_MS,
        );
        expect(
          await store().getAgentTriggerDeliveryStatus(
            identity.deliveryKey,
            identity.user,
            REMOTE_SOURCE.id,
            'tenant-1',
          ),
        ).not.toHaveProperty('actorReceipt');
        expect(idOf(harness, queued.delivery.user)).toBe(identity.user);

        for (const conflict of [
          { ...settlement, user: f.newUser() },
          { ...settlement, tenantId: 'tenant-2' },
          { ...settlement, bindingId: 'binding-2' },
          { ...settlement, conversationId: 'conversation-2' },
          { ...settlement, generationCreatedAt: GENERATION + 1 },
          {
            ...settlement,
            receipt: {
              ...receipt,
              checkpoint: { ...receipt.checkpoint, checkpointId: 'checkpoint-2' },
            },
          },
          { ...settlement, receipt: { ...receipt, action: { toolName: 'resign_game' } } },
          { ...settlement, settledAt: new Date(GENERATION + 2 * SECOND) },
          {
            ...settlement,
            status: 'failed' as const,
            receipt: { ...receipt, resolution: 'action_compensated' as const },
          },
        ]) {
          await expect(store().settleAgentEventActorReceipt(conflict)).resolves.toBe(false);
        }
        for (const miss of [
          { ...identity, user: f.newUser() },
          { ...identity, tenantId: undefined },
          { ...identity, conversationId: 'conversation-2' },
        ]) {
          await expect(store().getAgentEventActorReceipt(miss)).resolves.toBeNull();
        }
      });

      it('retires a dead transport by an exact receipt replay', async () => {
        const { identity } = await startedDelivery();
        const settlement = {
          ...identity,
          generationCreatedAt: GENERATION,
          status: 'applied' as const,
          settledAt: new Date(GENERATION + SECOND),
          receipt: receiptOf('conversation-1'),
        };
        await expect(store().settleAgentEventActorReceipt(settlement)).resolves.toBe(true);
        /** A receipt written by the pre-normalization build after transport dead-lettered it. */
        await f.patchDelivery(identity.deliveryKey, { status: 'dead', lastError: f.failure() });
        await expect(store().settleAgentEventActorReceipt(settlement)).resolves.toBe(true);
        const row = await f.raw(identity.deliveryKey);
        expect(row?.status).toBe('succeeded');
        expect(row).not.toHaveProperty('lastError');
      });

      it('refuses an outcome that disagrees with its resolution or lacks a checkpoint', async () => {
        const { identity } = await startedDelivery();
        const base = {
          ...identity,
          generationCreatedAt: GENERATION,
          settledAt: new Date(GENERATION + SECOND),
        };
        const receipt = receiptOf('conversation-1');
        await expect(
          store().settleAgentEventActorReceipt({ ...base, status: 'failed', receipt }),
        ).resolves.toBe(false);
        await expect(
          store().settleAgentEventActorReceipt({
            ...base,
            status: 'applied',
            receipt: { ...receipt, resolution: 'action_compensated' },
          }),
        ).resolves.toBe(false);
        await expect(
          store().settleAgentEventActorReceipt({
            ...base,
            status: 'applied',
            receipt: { ...receipt, checkpoint: { threadId: 't', checkpointNs: 'ns' } },
          }),
        ).resolves.toBe(false);
        await expect(
          store().settleAgentEventActorReceipt({
            ...base,
            status: 'applied',
            receipt: {
              ...receipt,
              resolution: 'history_repaired',
              checkpoint: { threadId: 't', checkpointNs: 'ns' },
            },
          }),
        ).resolves.toBe(true);
      });

      it('records a compensation as a failed outcome with its error', async () => {
        const { identity } = await startedDelivery();
        await expect(
          store().settleAgentEventActorReceipt({
            ...identity,
            generationCreatedAt: GENERATION,
            status: 'failed',
            settledAt: new Date(GENERATION + SECOND),
            receipt: { ...receiptOf('conversation-1'), resolution: 'action_compensated' },
          }),
        ).resolves.toBe(true);
        const delivery = await store().getAgentTriggerDelivery(identity.deliveryKey);
        expect(delivery?.handling).toMatchObject({
          status: 'failed',
          error: 'Agent event actor action was compensated',
        });
        expect(delivery?.handling).not.toHaveProperty('action');
      });

      it('allows exactly one winner when verification races compensation', async () => {
        const { identity } = await startedDelivery('binding-race', 'conversation-race');
        const common = {
          ...identity,
          generationCreatedAt: GENERATION,
          settledAt: new Date(GENERATION + 4 * SECOND),
        };
        const checkpoint = {
          threadId: 'conversation-race',
          checkpointId: 'cp',
          checkpointNs: 'race',
        };
        const [verified, compensated] = await Promise.all([
          store().settleAgentEventActorReceipt({
            ...common,
            status: 'applied',
            receipt: {
              resolution: 'checkpoint_verified',
              checkpoint,
              action: { toolName: 'submit_move' },
            },
          }),
          store().settleAgentEventActorReceipt({
            ...common,
            status: 'failed',
            error: 'operator compensated action',
            receipt: {
              resolution: 'action_compensated',
              checkpoint,
              action: { toolName: 'submit_move' },
            },
          }),
        ]);
        expect(Number(verified) + Number(compensated)).toBe(1);
        const stored = await store().getAgentTriggerDelivery(identity.deliveryKey);
        expect(stored?.handling?.status).toBe(verified ? 'applied' : 'failed');
        expect(stored?.actorReceipt?.resolution).toBe(
          verified ? 'checkpoint_verified' : 'action_compensated',
        );
      });

      it('retires a dead batch root and its members once the admitted action settles', async () => {
        const user = f.newUser();
        const orderingKey = 'late-terminal-batch';
        const envelope = bindingEnvelope('binding-late-terminal');
        const queued = await f.enqueue({ user, orderingKey, envelope });
        const handling = started('conversation-late-terminal');
        const member = await f.seedDelivery({
          user,
          orderingKey,
          envelope,
          laneSequence: 2,
          status: 'dead',
          attempts: 3,
          batchRootId: queued.delivery.id,
          settledAt: START,
          lastError: f.failure(),
          handling,
        });
        await f.patchDelivery(queued.delivery.id, {
          status: 'dead',
          attempts: 3,
          batchMemberIds: [member],
          batchMembersSettledAt: START,
          actorActionAdmittedAt: START,
          handling,
        });

        await expect(
          store().settleAgentEventActorReceipt({
            deliveryKey: queued.delivery.deliveryKey,
            user,
            tenantId: 'tenant-1',
            bindingId: 'binding-late-terminal',
            conversationId: 'conversation-late-terminal',
            generationCreatedAt: GENERATION,
            status: 'applied',
            settledAt: new Date(GENERATION + SECOND),
            requiresActionAdmission: true,
            receipt: {
              resolution: 'checkpoint_verified',
              checkpoint: {
                threadId: 'conversation-late-terminal',
                checkpointId: 'cp',
                checkpointNs: 'late',
              },
              action: { toolName: 'submit_move' },
            },
          }),
        ).resolves.toBe(true);
        const root = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(root).toMatchObject({ status: 'succeeded', handling: { status: 'applied' } });
        expect(root?.lastError).toBeUndefined();
        expect(await f.raw(member)).toMatchObject({
          status: 'succeeded',
          handling: { status: 'applied' },
        });
        const memberKey = (await f.raw(member))?.deliveryKey as string;
        await expect(
          store().getAgentTriggerDeliveryStatus(memberKey, user, REMOTE_SOURCE.id, 'tenant-1'),
        ).resolves.toMatchObject({ status: 'succeeded', handling: { status: 'applied' } });
        expect(await f.lane(orderingKey)).toBeUndefined();
        await expect(
          store().requeueAgentTriggerDelivery(queued.delivery.id, START),
        ).resolves.toBeNull();
      });

      it('settles beside more than 1,024 retained receipts without evicting one', async () => {
        const user = f.newUser();
        const settledAt = new Date(START.getTime() + 10 * SECOND);
        await harness.seedRaw(
          DELIVERIES,
          Array.from({ length: 1_025 }, (_, index) => ({
            _id: harness.ids.generate(),
            deliveryKey: `retained-receipt-${index}`,
            fingerprint: `retained-fingerprint-${index}`,
            orderingKey: `retained-lane-${index}`,
            laneSequence: 1,
            envelope: { mode: 'continue', target: { bindingId: `binding-${index}` } },
            user,
            tenantId: 'tenant-1',
            status: 'succeeded',
            attempts: 1,
            availableAt: START,
            handling: {
              status: 'applied',
              conversationId: `conversation-${index}`,
              streamId: `conversation-${index}`,
              generationCreatedAt: START.getTime() + index,
              startedAt: START,
              settledAt,
              action: { toolName: 'submit_move', toolCallId: `call-${index}` },
            },
            actorReceipt: {
              bindingId: `binding-${index}`,
              resolution: 'checkpoint_verified',
              checkpoint: {
                threadId: `conversation-${index}`,
                checkpointId: `checkpoint-${index}`,
                checkpointNs: `event-actor/${index}`,
              },
              action: { toolName: 'submit_move', toolCallId: `call-${index}` },
              settledAt,
            },
            settledAt,
            expiresAt: new Date(settledAt.getTime() + SUCCESS_RETENTION_MS),
            createdAt: START,
            updatedAt: START,
          })),
        );
        const fresh = await startedDelivery('binding-fresh', 'conversation-fresh');
        await expect(
          store().settleAgentEventActorReceipt({
            ...fresh.identity,
            generationCreatedAt: GENERATION,
            status: 'applied',
            settledAt: new Date(GENERATION + SECOND),
            receipt: receiptOf('conversation-fresh'),
          }),
        ).resolves.toBe(true);
        expect((await f.deliveries()).filter((row) => row.actorReceipt != null)).toHaveLength(
          1_026,
        );
        await expect(
          store().getAgentEventActorReceipt({
            deliveryKey: 'retained-receipt-0',
            user,
            tenantId: 'tenant-1',
            bindingId: 'binding-0',
            conversationId: 'conversation-0',
          }),
        ).resolves.toMatchObject({
          resolution: 'checkpoint_verified',
          action: { toolCallId: 'call-0' },
        });
      });
    });

    /* ------------------------------------------------------------------ backfill */

    describe('backfillAgentEventActorReceipt', () => {
      const legacyTerminal = async (handling: Record<string, unknown>, status = 'dead') => {
        const user = f.newUser();
        const queued = await f.enqueue({ user, envelope: bindingEnvelope('binding-legacy') });
        await f.patchDelivery(queued.delivery.id, {
          status,
          handling: {
            conversationId: 'conversation-legacy',
            streamId: 'conversation-legacy',
            generationCreatedAt: GENERATION,
            startedAt: START,
            settledAt: START,
            ...handling,
          },
          settledAt: START,
          expiresAt: f.at(SECOND),
        });
        return {
          deliveryKey: queued.delivery.deliveryKey,
          user,
          tenantId: 'tenant-1',
          bindingId: 'binding-legacy',
          conversationId: 'conversation-legacy',
          generationCreatedAt: GENERATION,
          settledAt: f.at(3 * SECOND),
        };
      };
      const checkpoint = {
        threadId: 'conversation-legacy',
        checkpointId: 'checkpoint-legacy',
        checkpointNs: 'event-actor/legacy',
      };

      it('moves one exact legacy receipt onto its terminal delivery, once', async () => {
        const action = { toolName: 'submit_move', toolCallId: 'call-legacy' };
        const common = await legacyTerminal({ status: 'applied', action });
        const input = {
          ...common,
          status: 'applied' as const,
          receipt: { resolution: 'checkpoint_verified' as const, checkpoint, action },
        };
        await expect(
          Promise.all([
            store().backfillAgentEventActorReceipt(input),
            store().backfillAgentEventActorReceipt(input),
          ]),
        ).resolves.toEqual([true, true]);
        await expect(
          store().backfillAgentEventActorReceipt({
            ...input,
            receipt: { ...input.receipt, checkpoint: { ...checkpoint, checkpointId: 'different' } },
          }),
        ).resolves.toBe(false);
        await expect(store().getAgentEventActorReceipt(common)).resolves.toEqual({
          bindingId: 'binding-legacy',
          ...input.receipt,
          settledAt: input.settledAt,
        });
        const row = await f.raw(common.deliveryKey);
        expect(row?.status).toBe('succeeded');
        expect(timeOf(row?.expiresAt)).toBe(input.settledAt.getTime() + SUCCESS_RETENTION_MS);
        expect(timeOf(row?.settledAt)).toBe(input.settledAt.getTime());
      });

      it('refuses a receipt whose action or outcome the delivery does not record', async () => {
        const action = { toolName: 'submit_move', toolCallId: 'call-legacy' };
        const common = await legacyTerminal({ status: 'applied', action });
        for (const receipt of [
          {
            resolution: 'checkpoint_verified' as const,
            checkpoint,
            action: { toolName: 'other_tool' },
          },
          {
            resolution: 'checkpoint_verified' as const,
            checkpoint: { threadId: 't', checkpointNs: 'n' },
            action,
          },
        ]) {
          await expect(
            store().backfillAgentEventActorReceipt({ ...common, status: 'applied', receipt }),
          ).resolves.toBe(false);
        }
        await expect(
          store().backfillAgentEventActorReceipt({
            ...common,
            status: 'failed',
            receipt: { resolution: 'action_compensated', checkpoint, action },
          }),
        ).resolves.toBe(false);
        await expect(store().getAgentEventActorReceipt(common)).resolves.toBeNull();
      });

      it('never migrates a compensated legacy receipt as an applied outcome', async () => {
        const action = { toolName: 'submit_move', toolCallId: 'call-compensated' };
        const common = await legacyTerminal(
          { status: 'failed', error: 'Applied action was compensated' },
          'succeeded',
        );
        await expect(
          store().backfillAgentEventActorReceipt({
            ...common,
            status: 'failed',
            receipt: { resolution: 'action_compensated', checkpoint, action },
          }),
        ).resolves.toBe(true);
        await expect(
          store().backfillAgentEventActorReceipt({
            ...common,
            status: 'applied',
            receipt: { resolution: 'checkpoint_verified', checkpoint, action },
          }),
        ).resolves.toBe(false);
        await expect(store().getAgentEventActorReceipt(common)).resolves.toMatchObject({
          resolution: 'action_compensated',
        });
      });
    });

    /* ------------------------------------------------------------------ metrics */

    describe('getAgentEventActorReceiptStorageMetrics', () => {
      it('counts retained receipts by resolution, expired ones, and retrying or dead deliveries', async () => {
        const empty = await store().getAgentEventActorReceiptStorageMetrics(START);
        expect(empty).toEqual({
          retainedByResolution: {
            checkpoint_verified: 0,
            action_compensated: 0,
            history_repaired: 0,
          },
          expiryEligible: 0,
          retryDeliveries: 0,
          deadDeliveries: 0,
        });

        const settle = async (
          bindingId: string,
          resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired',
          settledAt: Date,
        ) => {
          const { identity } = await startedDelivery(bindingId, `conversation-${bindingId}`);
          await store().settleAgentEventActorReceipt({
            ...identity,
            generationCreatedAt: GENERATION,
            status: resolution === 'action_compensated' ? 'failed' : 'applied',
            settledAt,
            receipt: { ...receiptOf(identity.conversationId), resolution },
          });
        };
        await settle('a', 'checkpoint_verified', f.at(SECOND));
        await settle('b', 'checkpoint_verified', f.at(-SUCCESS_RETENTION_MS - MINUTE));
        await settle('c', 'action_compensated', f.at(SECOND));
        await settle('d', 'history_repaired', f.at(SECOND));

        const handling = started('conversation-retry', START.getTime());
        await f.seedDelivery({
          envelope: { mode: 'continue', target: { bindingId: 'binding-retry' } },
          status: 'pending',
          attempts: 2,
          handling,
        });
        await f.seedDelivery({
          envelope: { mode: 'continue', target: { bindingId: 'binding-shielded-retry' } },
          status: 'leased',
          capabilityStatus: 'pending',
          attempts: 1,
          handling,
        });
        await f.seedDelivery({
          envelope: { mode: 'continue', target: { bindingId: 'binding-fresh' } },
          status: 'pending',
          attempts: 0,
          handling,
        });
        await f.seedDelivery({
          envelope: { mode: 'continue', target: { bindingId: 'binding-dead' } },
          status: 'dead',
          attempts: 3,
          handling,
        });
        await f.seedDelivery({
          envelope: { mode: 'continue', target: { bindingId: 'binding-private-dead' } },
          status: 'leased',
          capabilityStatus: 'dead',
          attempts: 3,
          handling,
        });
        await f.seedDelivery({
          envelope: { event: { source: REMOTE_SOURCE } },
          status: 'dead',
          attempts: 3,
          handling,
        });

        await expect(store().getAgentEventActorReceiptStorageMetrics(START)).resolves.toEqual({
          retainedByResolution: {
            checkpoint_verified: 2,
            action_compensated: 1,
            history_repaired: 1,
          },
          expiryEligible: 1,
          retryDeliveries: 2,
          deadDeliveries: 2,
        });
      });
    });
  });
}
