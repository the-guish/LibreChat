/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TriggerDeliveryStore` contract (`~/ports/triggerDelivery`), second part: what happens to a
 * delivery besides a worker's attempt, ported from `methods/triggerDelivery.spec.ts`. Retirement
 * of internal deliveries by identity (its status fences, the replay and `requireTransition`
 * outcomes, a resolver's claim winning), the producer liveness lease (`$max`, live versus expired
 * at the boundary), expediting deferred deliveries (the selections, the held-delivery wake marker
 * that a release or deferral honors), the terminal handling outcome of a started generation (the
 * exact generation, the binding lane kept open until it settles), coalesced batches (the window
 * intersection, the size cap, the lane tail, settling and requeueing members with their root),
 * and the recovery sweeps (lane publications a crashed writer left, purge-fenced rows rotated so
 * later work is not starved, batch receipts, lane cleanup).
 *
 * Not here (they stay in the method spec): finalization failures injected into a settlement
 * (`recovery.required`), writes paused between steps by spies, and the purge-marker race made by
 * a spied `exists`. Nothing here may import `mongoose` or the MongoDB driver.
 */
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
} from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import type { EnqueueInput } from './triggerDelivery.fixtures';
import {
  BACKGROUND_SOURCE,
  DAY,
  DELIVERIES,
  LANES,
  MINUTE,
  PURGES,
  QUEUED_TURN_SOURCE,
  REMOTE_SOURCE,
  SECOND,
  START,
  SUBAGENT_SOURCE,
  SUCCESS_RETENTION_MS,
  createTriggerDeliveryFixtures,
} from './triggerDelivery.fixtures';
import { idOf, timeOf, useContractHarness } from './support';

const RECEIPT_V2 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2;
const GENERATION = 1_787_000_000_000;

export function describeTriggerDeliveryLifecycleContract(harness: ContractHarness): void {
  describe(`TriggerDeliveryStore contract (lifecycle and recovery): ${harness.name}`, () => {
    useContractHarness(harness);

    const f = createTriggerDeliveryFixtures(harness);
    const store = () => f.store();
    const byLane = async (orderingKey: string) =>
      (await f.deliveries())
        .filter((row) => row.orderingKey === orderingKey)
        .sort((a, b) => (a.laneSequence as number) - (b.laneSequence as number));
    const started = (generationCreatedAt: number, conversationId = 'actor-thread') => ({
      status: 'started' as const,
      conversationId,
      streamId: conversationId,
      generationCreatedAt,
      startedAt: new Date(generationCreatedAt),
    });

    /* ------------------------------------------------------------------ retire */

    describe('retireAgentTriggerDelivery', () => {
      const retirement = (deliveryKey: string, overrides: Record<string, unknown> = {}) => ({
        deliveryKey,
        sourceId: BACKGROUND_SOURCE.id,
        settledAt: START,
        reason: 'result persistence failed',
        ...overrides,
      });

      it('retires a pending internal delivery, replays, and unblocks its lane successor', async () => {
        const user = f.newUser();
        const lane = 'background-completion-lane';
        const envelope = { event: { source: BACKGROUND_SOURCE } };
        const first = await f.enqueue({ user, orderingKey: lane, envelope });
        const successor = await f.enqueue({ user, orderingKey: lane, envelope });

        await expect(
          store().retireAgentTriggerDelivery(retirement(first.delivery.deliveryKey)),
        ).resolves.toBe(true);
        await expect(
          store().retireAgentTriggerDelivery(retirement(first.delivery.deliveryKey)),
        ).resolves.toBe(true);
        await expect(
          store().retireAgentTriggerDelivery(
            retirement(first.delivery.deliveryKey, { sourceId: 'other-internal-source' }),
          ),
        ).resolves.toBe(false);
        const row = await f.raw(first.delivery.deliveryKey);
        expect(row).toMatchObject({
          status: 'succeeded',
          result: {
            status: 'settled',
            backgroundToolCompletionRetired: true,
            reason: 'result persistence failed',
          },
        });
        expect(timeOf(row?.settledAt)).toBe(START.getTime());
        expect(timeOf(row?.expiresAt)).toBe(START.getTime() + SUCCESS_RETENTION_MS);

        await expect(f.claim()).resolves.toMatchObject({ id: successor.delivery.id });
      });

      it('retires only internal deliveries of the named source', async () => {
        const external = await f.enqueue({
          envelope: { event: { source: { id: BACKGROUND_SOURCE.id, type: 'webhook' } } },
        });
        await expect(
          store().retireAgentTriggerDelivery(retirement(external.delivery.deliveryKey)),
        ).resolves.toBe(false);
        expect((await f.raw(external.delivery.id))?.status).toBe('pending');
        await expect(store().retireAgentTriggerDelivery(retirement('missing'))).resolves.toBe(
          false,
        );
      });

      it('accepts an already successful internal delivery as retirement evidence', async () => {
        const queued = await f.enqueue({ envelope: { event: { source: QUEUED_TURN_SOURCE } } });
        await f.deliver({ result: { status: 'settled' } });
        await expect(
          store().retireAgentTriggerDelivery({
            deliveryKey: queued.delivery.deliveryKey,
            sourceId: QUEUED_TURN_SOURCE.id,
            settledAt: f.at(1),
            reason: 'source already terminalized',
          }),
        ).resolves.toBe(true);
        const row = await f.raw(queued.delivery.id);
        expect(row).toMatchObject({ status: 'succeeded', result: { status: 'settled' } });
        expect(timeOf(row?.settledAt)).toBe(START.getTime());
      });

      it('tells retiring a completion apart from finding it already delivered', async () => {
        const envelope = { event: { source: BACKGROUND_SOURCE } };
        const delivered = await f.enqueue({ orderingKey: 'lane-a', envelope });
        await f.deliver();
        const retire = (deliveryKey: string, requireTransition?: true) =>
          store().retireAgentTriggerDelivery(
            retirement(deliveryKey, {
              reason: 'background result discarded by its owner',
              onlyIfUnclaimed: true,
              ...(requireTransition != null && { requireTransition }),
            }),
          );
        await expect(retire(delivered.delivery.deliveryKey)).resolves.toBe(true);
        await expect(retire(delivered.delivery.deliveryKey, true)).resolves.toBe(false);

        const waiting = await f.enqueue({ orderingKey: 'lane-b', envelope });
        await expect(retire(waiting.delivery.deliveryKey, true)).resolves.toBe(true);
      });

      it('does not accept a succeeded delivery still awaiting terminal handling', async () => {
        const queued = await f.enqueue({
          awaitTerminalHandling: true,
          envelope: { event: { source: BACKGROUND_SOURCE } },
        });
        await f.deliver({
          awaitTerminalHandling: true,
          handling: started(GENERATION),
          settledAt: new Date(GENERATION),
        });
        const input = retirement(queued.delivery.deliveryKey);
        await expect(store().retireAgentTriggerDelivery(input)).resolves.toBe(false);
        await expect(
          store().retireAgentTriggerDelivery({ ...input, allowSucceeded: true }),
        ).resolves.toBe(false);
      });

      it('accepts transport success without handling only when allowed', async () => {
        const queued = await f.enqueue({ envelope: { event: { source: BACKGROUND_SOURCE } } });
        await f.deliver({ handling: started(GENERATION), settledAt: new Date(GENERATION) });
        const input = retirement(queued.delivery.deliveryKey);
        await expect(store().retireAgentTriggerDelivery(input)).resolves.toBe(false);
        await expect(
          store().retireAgentTriggerDelivery({ ...input, allowSucceeded: true }),
        ).resolves.toBe(true);
      });

      it('does not retire a completion a resolver already leased for a manual poll', async () => {
        const queued = await f.enqueue({ envelope: { event: { source: BACKGROUND_SOURCE } } });
        await f.claim({ workerId: 'completion-worker', claimToken: 'completion-claim' });
        await expect(
          store().retireAgentTriggerDelivery(
            retirement(queued.delivery.deliveryKey, { onlyIfUnclaimed: true }),
          ),
        ).resolves.toBe(false);
        expect(await f.raw(queued.delivery.id)).toMatchObject({
          status: 'leased',
          leaseBy: 'completion-worker',
        });
        await expect(
          store().retireAgentTriggerDelivery(retirement(queued.delivery.deliveryKey)),
        ).resolves.toBe(true);
        const row = await f.raw(queued.delivery.id);
        expect(row?.status).toBe('succeeded');
        expect(row).not.toHaveProperty('leaseBy');
        expect(row).not.toHaveProperty('claimToken');
      });

      it('retires a shielded completion before a private resolver claims it, not after', async () => {
        const pending = await f.enqueue({
          orderingKey: 'lane-a',
          envelope: { event: { source: BACKGROUND_SOURCE } },
          requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
        });
        expect(await f.raw(pending.delivery.id)).toMatchObject({
          status: 'leased',
          capabilityStatus: 'pending',
        });
        await expect(
          store().retireAgentTriggerDelivery(
            retirement(pending.delivery.deliveryKey, { onlyIfUnclaimed: true }),
          ),
        ).resolves.toBe(true);
        const retired = await f.raw(pending.delivery.id);
        expect(retired).toMatchObject({
          status: 'succeeded',
          result: { backgroundToolCompletionRetired: true },
        });
        expect(retired).not.toHaveProperty('capabilityStatus');

        const leased = await f.enqueue({
          orderingKey: 'lane-b',
          envelope: { event: { source: BACKGROUND_SOURCE } },
          requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
        });
        await expect(
          f.claim({
            workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1],
          }),
        ).resolves.toMatchObject({ id: leased.delivery.id });
        await expect(
          store().retireAgentTriggerDelivery(
            retirement(leased.delivery.deliveryKey, { onlyIfUnclaimed: true }),
          ),
        ).resolves.toBe(false);
        expect(await f.raw(leased.delivery.id)).toMatchObject({
          status: 'leased',
          capabilityStatus: 'leased',
        });
      });

      it('reconciles only an irreversibly dead completion when asked to', async () => {
        const queued = await f.enqueue({ envelope: { event: { source: BACKGROUND_SOURCE } } });
        const input = retirement(queued.delivery.deliveryKey, {
          settledAt: f.at(1),
          reason: 'manual poll recovered dead completion',
          onlyIfDead: true,
        });
        await expect(store().retireAgentTriggerDelivery(input)).resolves.toBe(false);
        await f.kill();
        await expect(store().retireAgentTriggerDelivery(input)).resolves.toBe(true);
        /** A later claim-release retry recognizes the recovery although it is no longer dead. */
        await expect(store().retireAgentTriggerDelivery(input)).resolves.toBe(true);
        expect(await f.raw(queued.delivery.id)).toMatchObject({
          status: 'succeeded',
          result: { backgroundToolCompletionRetired: true },
        });
        expect(await f.raw(queued.delivery.id)).not.toHaveProperty('lastError');
      });

      it('refuses a malformed retirement', async () => {
        for (const input of [
          retirement(''),
          retirement('key', { sourceId: '' }),
          retirement('key', { settledAt: new Date(Number.NaN) }),
          retirement('key', { onlyIfUnclaimed: true, onlyIfDead: true }),
        ]) {
          await expect(store().retireAgentTriggerDelivery(input)).rejects.toBeInstanceOf(TypeError);
        }
      });

      it('truncates the recorded reason', async () => {
        const queued = await f.enqueue({ envelope: { event: { source: BACKGROUND_SOURCE } } });
        await store().retireAgentTriggerDelivery(
          retirement(queued.delivery.deliveryKey, { reason: 'r'.repeat(3_000) }),
        );
        const result = (await f.raw(queued.delivery.id))?.result as { reason: string };
        expect(result.reason).toHaveLength(2048);
      });
    });

    /* ------------------------------------------------------------------ producer lease */

    describe('renewAgentTriggerDeliveryProducerLease and getAgentTriggerDeliveryProducerLease', () => {
      const leased = (overrides: Partial<EnqueueInput> = {}) =>
        f.enqueue({
          envelope: { event: { source: BACKGROUND_SOURCE } },
          requiredWorkerCapability: RECEIPT_V2,
          ...overrides,
        });

      it('renews idempotently, never shortens, and classifies liveness at the boundary', async () => {
        const initial = f.at(30 * SECOND);
        const queued = await leased({ producerLeaseUntil: initial });
        const lookup = (now: Date) =>
          store().getAgentTriggerDeliveryProducerLease({
            deliveryKey: queued.delivery.deliveryKey,
            sourceId: BACKGROUND_SOURCE.id,
            now,
          });
        await expect(lookup(START)).resolves.toEqual({ status: 'live', leaseUntil: initial });
        await expect(lookup(initial)).resolves.toEqual({ status: 'expired', leaseUntil: initial });
        await expect(lookup(f.at(1, initial))).resolves.toEqual({
          status: 'expired',
          leaseUntil: initial,
        });

        const renewal = {
          deliveryKey: queued.delivery.deliveryKey,
          sourceId: BACKGROUND_SOURCE.id,
          leaseUntil: f.at(MINUTE),
        };
        await expect(store().renewAgentTriggerDeliveryProducerLease(renewal)).resolves.toBe(true);
        await expect(store().renewAgentTriggerDeliveryProducerLease(renewal)).resolves.toBe(true);
        await expect(
          store().renewAgentTriggerDeliveryProducerLease({ ...renewal, leaseUntil: initial }),
        ).resolves.toBe(true);
        await expect(lookup(initial)).resolves.toEqual({
          status: 'live',
          leaseUntil: f.at(MINUTE),
        });
      });

      it('reports a missing lease and renews one that was never set', async () => {
        const queued = await leased();
        const lookup = {
          deliveryKey: queued.delivery.deliveryKey,
          sourceId: BACKGROUND_SOURCE.id,
          now: START,
        };
        await expect(store().getAgentTriggerDeliveryProducerLease(lookup)).resolves.toEqual({
          status: 'missing',
        });
        await expect(
          store().renewAgentTriggerDeliveryProducerLease({
            deliveryKey: queued.delivery.deliveryKey,
            sourceId: BACKGROUND_SOURCE.id,
            leaseUntil: f.at(MINUTE),
          }),
        ).resolves.toBe(true);
        await expect(store().getAgentTriggerDeliveryProducerLease(lookup)).resolves.toEqual({
          status: 'live',
          leaseUntil: f.at(MINUTE),
        });
        await expect(
          store().getAgentTriggerDeliveryProducerLease({ ...lookup, sourceId: 'other-source' }),
        ).resolves.toEqual({ status: 'missing' });
      });

      it('renews only an unsettled background completion of the source', async () => {
        const ordinary = await f.enqueue({
          orderingKey: 'ordinary',
          envelope: { event: { source: BACKGROUND_SOURCE } },
        });
        const settled = await leased({ orderingKey: 'settled' });
        await store().retireAgentTriggerDelivery({
          deliveryKey: settled.delivery.deliveryKey,
          sourceId: BACKGROUND_SOURCE.id,
          settledAt: START,
          reason: 'done',
        });
        for (const deliveryKey of [ordinary.delivery.deliveryKey, settled.delivery.deliveryKey]) {
          await expect(
            store().renewAgentTriggerDeliveryProducerLease({
              deliveryKey,
              sourceId: BACKGROUND_SOURCE.id,
              leaseUntil: f.at(MINUTE),
            }),
          ).resolves.toBe(false);
        }
        await expect(
          store().renewAgentTriggerDeliveryProducerLease({
            deliveryKey: '',
            sourceId: BACKGROUND_SOURCE.id,
            leaseUntil: f.at(MINUTE),
          }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          store().getAgentTriggerDeliveryProducerLease({
            deliveryKey: 'key',
            sourceId: BACKGROUND_SOURCE.id,
            now: new Date(Number.NaN),
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    /* ------------------------------------------------------------------ expedite */

    describe('expediteAgentTriggerDeliveries', () => {
      const later = f.at(30 * SECOND);
      const capable = {
        workerId: 'background-capable-worker',
        claimToken: 'background-capable-claim',
        workerCapabilities: [RECEIPT_V2],
      };
      let lane = 0;
      const waiting = (overrides: Partial<EnqueueInput> = {}) => {
        lane += 1;
        return f.enqueue({
          orderingKey: `background-lane-${lane}`,
          envelope: { event: { source: BACKGROUND_SOURCE } },
          requiredWorkerCapability: RECEIPT_V2,
          availableAt: later,
          ...overrides,
        });
      };
      const availableAt = async (id: string) => {
        const row = await f.raw(id);
        return timeOf(row?.claimAvailableAt ?? row?.availableAt);
      };

      it('makes a deferred delivery claimable now once its result is durable', async () => {
        const target = await waiting();
        const sibling = await waiting();
        await expect(f.claim(capable)).resolves.toBeNull();
        await expect(
          store().expediteAgentTriggerDeliveries({
            deliveryKeys: [target.delivery.deliveryKey],
            sourceIds: [BACKGROUND_SOURCE.id],
            now: START,
          }),
        ).resolves.toEqual({ expedited: 1, held: 0 });
        await expect(f.claim(capable)).resolves.toMatchObject({ id: target.delivery.id });
        await expect(f.claim({ ...capable, claimToken: 'second-claim' })).resolves.toBeNull();
        expect(await availableAt(sibling.delivery.id)).toBe(later.getTime());
      });

      it("moves only the principal's waiting deliveries from the named sources", async () => {
        const user = f.newUser();
        const mine = await waiting({ user });
        const otherUser = await waiting();
        const otherSource = await waiting({
          user,
          envelope: { event: { source: QUEUED_TURN_SOURCE } },
        });
        const external = await waiting({
          user,
          envelope: { event: { source: { id: BACKGROUND_SOURCE.id, type: 'webhook' } } },
        });
        const due = await waiting({ user, availableAt: START });

        await expect(
          store().expediteAgentTriggerDeliveries({
            user,
            sourceIds: [BACKGROUND_SOURCE.id],
            now: START,
          }),
        ).resolves.toEqual({ expedited: 1, held: 0 });
        expect(await availableAt(mine.delivery.id)).toBe(START.getTime());
        expect(await availableAt(otherUser.delivery.id)).toBe(later.getTime());
        expect(await availableAt(otherSource.delivery.id)).toBe(later.getTime());
        expect(await availableAt(external.delivery.id)).toBe(later.getTime());
        expect(await availableAt(due.delivery.id)).toBe(START.getTime());
      });

      it('moves an ordinary deferred internal delivery by its due time', async () => {
        const user = f.newUser();
        const ordinary = await waiting({ user, requiredWorkerCapability: undefined });
        await expect(
          store().expediteAgentTriggerDeliveries({
            user: f.storeId(user),
            sourceIds: [BACKGROUND_SOURCE.id],
            now: START,
          }),
        ).resolves.toEqual({ expedited: 1, held: 0 });
        expect(timeOf((await f.raw(ordinary.delivery.id))?.availableAt)).toBe(START.getTime());
        await expect(f.claim()).resolves.toMatchObject({ id: ordinary.delivery.id });
      });

      it('marks a delivery a worker holds instead of moving it', async () => {
        const user = f.newUser();
        const held = await waiting({ user, availableAt: START });
        await expect(f.claim(capable)).resolves.toMatchObject({ id: held.delivery.id });
        const before = await f.raw(held.delivery.id);

        await expect(
          store().expediteAgentTriggerDeliveries({
            user,
            sourceIds: [BACKGROUND_SOURCE.id],
            now: f.at(-MINUTE),
          }),
        ).resolves.toEqual({ expedited: 0, held: 1 });
        const after = await f.raw(held.delivery.id);
        expect(after?.status).toBe(before?.status);
        expect(after?.capabilityStatus).toBe('leased');
        expect(timeOf(after?.availableAt)).toBe(timeOf(before?.availableAt));
        expect(timeOf(after?.wakeRequestedAt)).toBe(f.at(-MINUTE).getTime());
      });

      it('re-checks at once when readiness changed while the delivery was held', async () => {
        const user = f.newUser();
        const held = await waiting({ user, availableAt: START });
        const begun = await f.claimAndBegin(capable);
        expect(begun.claim.id).toBe(held.delivery.id);
        await expect(
          store().expediteAgentTriggerDeliveries({
            user,
            sourceIds: [BACKGROUND_SOURCE.id],
            now: START,
          }),
        ).resolves.toEqual({ expedited: 0, held: 1 });

        const beforeDefer = Date.now();
        await expect(
          store().deferAgentTriggerDeliveryAttempt({
            ...begun.fence,
            attempt: begun.attempt,
            availableAt: later,
          }),
        ).resolves.toBe('expedited');
        const deferred = await f.raw(held.delivery.id);
        expect(deferred).not.toHaveProperty('wakeRequestedAt');
        expect(deferred?.attempts).toBe(0);
        expect(await availableAt(held.delivery.id)).toBeGreaterThanOrEqual(beforeDefer);

        const now = new Date();
        const second = await f.claimAndBegin({
          ...capable,
          claimToken: 'second-claim',
          now,
          leaseUntil: f.at(MINUTE, now),
        });
        expect(second.claim.id).toBe(held.delivery.id);
        await expect(
          store().deferAgentTriggerDeliveryAttempt({
            ...second.fence,
            attempt: second.attempt,
            availableAt: later,
          }),
        ).resolves.toBe(true);
        expect(await availableAt(held.delivery.id)).toBe(later.getTime());
      });

      it.each(['ordinary', 'legacy', 'shielded'] as const)(
        'honors a held wake marker on release for %s leases',
        async (profile) => {
          const row = await waiting({
            availableAt: START,
            ...(profile === 'ordinary' && { requiredWorkerCapability: undefined }),
          });
          if (profile === 'legacy') {
            /** A capability row as the pre-shield build stored it: no private lifecycle. */
            await f.patchDelivery(row.delivery.id, {
              status: 'capability_pending',
              availableAt: START,
              capabilityStatus: undefined,
              leaseUntil: undefined,
            });
          }
          const claimed = await f.claim(capable);
          expect(claimed?.id).toBe(row.delivery.id);
          const fence = {
            id: row.delivery.id,
            workerId: capable.workerId,
            claimToken: capable.claimToken,
          };
          await store().expediteAgentTriggerDeliveries({
            deliveryKeys: [row.delivery.deliveryKey],
            sourceIds: [BACKGROUND_SOURCE.id],
            now: START,
          });
          await expect(
            store().releaseAgentTriggerDelivery({
              ...fence,
              claimToken: 'stale',
              availableAt: later,
            }),
          ).resolves.toBe(false);
          expect(timeOf((await f.raw(row.delivery.id))?.wakeRequestedAt)).toBe(START.getTime());
          await expect(
            store().releaseAgentTriggerDelivery({ ...fence, availableAt: later }),
          ).resolves.toBe(true);
          const released = await f.raw(row.delivery.id);
          expect(released).not.toHaveProperty('wakeRequestedAt');
          expect(timeOf(released?.availableAt)).toBeLessThanOrEqual(Date.now());
          expect(timeOf(released?.claimAvailableAt)).toBe(timeOf(released?.availableAt));
          expect(released?.attempts).toBe(0);

          const reclaimed = await f.claim({ ...capable, now: new Date(), claimToken: 'next' });
          expect(reclaimed?.id).toBe(row.delivery.id);
          await store().releaseAgentTriggerDelivery({
            ...fence,
            claimToken: 'next',
            availableAt: later,
          });
          expect(await availableAt(row.delivery.id)).toBe(later.getTime());
        },
      );

      it('selects named child tasks of a conversation and leaves unfinished siblings', async () => {
        const user = f.newUser();
        const task = (taskId: string) =>
          waiting({
            user,
            envelope: {
              event: { source: SUBAGENT_SOURCE, payload: { taskId } },
              target: { conversationId: 'parent' },
            },
          });
        const original = await task('original');
        const recovered = await task('recovered');
        const sibling = await task('sibling');
        await expect(
          store().expediteAgentTriggerDeliveries({
            user,
            conversationId: 'parent',
            taskIds: ['original', 'recovered'],
            sourceIds: [SUBAGENT_SOURCE.id],
            now: START,
          }),
        ).resolves.toEqual({ expedited: 2, held: 0 });
        expect(await availableAt(original.delivery.id)).toBe(START.getTime());
        expect(await availableAt(recovered.delivery.id)).toBe(START.getTime());
        expect(await availableAt(sibling.delivery.id)).toBe(later.getTime());
        await expect(
          store().expediteAgentTriggerDeliveries({
            user,
            conversationId: 'parent',
            taskIds: [],
            sourceIds: [SUBAGENT_SOURCE.id],
            now: START,
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it("narrows a principal's selection to the conversation being resumed", async () => {
        const user = f.newUser();
        const target = await waiting({
          user,
          envelope: {
            event: { source: BACKGROUND_SOURCE },
            target: { conversationId: 'settled-convo' },
          },
        });
        const other = await waiting({
          user,
          envelope: {
            event: { source: BACKGROUND_SOURCE },
            target: { conversationId: 'other-convo' },
          },
        });
        await expect(
          store().expediteAgentTriggerDeliveries({
            user,
            conversationId: 'settled-convo',
            sourceIds: [BACKGROUND_SOURCE.id],
            now: START,
          }),
        ).resolves.toEqual({ expedited: 1, held: 0 });
        expect(await availableAt(target.delivery.id)).toBe(START.getTime());
        expect(await availableAt(other.delivery.id)).toBe(later.getTime());
      });

      it('refuses an unbounded or malformed selection', async () => {
        for (const input of [
          { sourceIds: [BACKGROUND_SOURCE.id], now: START },
          { user: f.newUser(), sourceIds: [], now: START },
          {
            deliveryKeys: ['trigger_x'],
            sourceIds: [BACKGROUND_SOURCE.id],
            now: new Date(Number.NaN),
          },
        ]) {
          await expect(store().expediteAgentTriggerDeliveries(input)).rejects.toBeInstanceOf(
            TypeError,
          );
        }
      });
    });

    /* ------------------------------------------------------------------ terminal handling */

    describe('settleAgentTriggerHandlingOutcome', () => {
      it('keeps a binding lane queued until the earlier child turn settles', async () => {
        const user = f.newUser();
        const first = await f.enqueue({
          user,
          orderingKey: 'binding-lane',
          awaitTerminalHandling: true,
        });
        const generationCreatedAt = START.getTime() + SECOND;
        await f.deliver({
          result: { mode: 'continue', status: 'started', conversationId: 'actor-thread' },
          settledAt: new Date(generationCreatedAt),
          awaitTerminalHandling: true,
          handling: started(generationCreatedAt),
        });
        const second = await f.enqueue({
          user,
          orderingKey: 'binding-lane',
          awaitTerminalHandling: true,
        });
        const secondClaim = await f.claim({
          workerId: 'worker-2',
          claimToken: 'claim-2',
          now: new Date(generationCreatedAt),
        });
        expect(second.delivery.laneSequence).toBe(first.delivery.laneSequence + 1);
        expect(secondClaim?.id).toBe(second.delivery.id);
        await expect(store().findEarlierAgentTriggerDelivery(secondClaim!)).resolves.toMatchObject({
          availableAt: START,
          reason: 'active_handling',
        });
        expect(await f.raw(first.delivery.id)).not.toHaveProperty('expiresAt');

        await expect(
          store().settleAgentTriggerHandlingOutcome({
            deliveryKey: first.delivery.deliveryKey,
            conversationId: 'actor-thread',
            generationCreatedAt,
            status: 'applied',
            settledAt: new Date(generationCreatedAt + SECOND),
            action: { toolName: 'submit_action' },
          }),
        ).resolves.toBe(true);
        const settled = await f.raw(first.delivery.id);
        expect(settled).toMatchObject({
          handling: { status: 'applied', action: { toolName: 'submit_action' } },
        });
        expect(timeOf(settled?.expiresAt)).toBe(
          generationCreatedAt + SECOND + SUCCESS_RETENTION_MS,
        );
        await expect(store().findEarlierAgentTriggerDelivery(secondClaim!)).resolves.toBeNull();
      });

      it('reclaims a binding lane only after its admitted child turn settles', async () => {
        const queued = await f.enqueue({
          orderingKey: 'settling-binding-lane',
          awaitTerminalHandling: true,
        });
        const generationCreatedAt = START.getTime() + SECOND;
        await f.deliver({
          settledAt: new Date(generationCreatedAt),
          awaitTerminalHandling: true,
          handling: started(generationCreatedAt),
        });
        expect(await f.lane('settling-binding-lane')).toBeDefined();
        await expect(
          store().settleAgentTriggerHandlingOutcome({
            deliveryKey: queued.delivery.deliveryKey,
            conversationId: 'actor-thread',
            generationCreatedAt,
            status: 'completed_no_action',
            settledAt: new Date(generationCreatedAt + SECOND),
          }),
        ).resolves.toBe(true);
        expect(await f.lane('settling-binding-lane')).toBeUndefined();
      });

      it('settles only the exact started generation, once', async () => {
        const queued = await f.enqueue({
          envelope: {
            mode: 'continue',
            target: { bindingId: 'binding-1' },
            event: { source: REMOTE_SOURCE },
          },
        });
        await f.deliver({
          settledAt: f.at(SECOND),
          handling: { ...started(GENERATION, 'conversation-1'), startedAt: f.at(SECOND) },
        });
        const settle = (overrides: Record<string, unknown>) =>
          store().settleAgentTriggerHandlingOutcome({
            deliveryKey: queued.delivery.deliveryKey,
            conversationId: 'conversation-1',
            generationCreatedAt: GENERATION,
            status: 'failed',
            settledAt: f.at(3 * SECOND),
            error: 'provider rejected the model',
            ...overrides,
          });
        await expect(
          settle({ generationCreatedAt: GENERATION - 1, error: 'stale failure' }),
        ).resolves.toBe(false);
        await expect(settle({ conversationId: 'conversation-2' })).resolves.toBe(false);
        await expect(settle({ deliveryKey: 'missing' })).resolves.toBe(false);
        await expect(settle({})).resolves.toBe(true);
        await expect(settle({})).resolves.toBe(true);
        await expect(
          settle({
            status: 'applied',
            settledAt: f.at(4 * SECOND),
            error: undefined,
            action: { toolName: 'submit_move' },
          }),
        ).resolves.toBe(false);
        const stored = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(stored).toMatchObject({
          handling: {
            status: 'failed',
            settledAt: f.at(3 * SECOND),
            error: 'provider rejected the model',
          },
        });
      });

      it('projects a started continuation and its outcome on the public status', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          envelope: {
            mode: 'continue',
            target: { bindingId: 'binding-1' },
            event: { source: REMOTE_SOURCE },
          },
        });
        await f.deliver({
          result: { mode: 'continue', status: 'started' },
          settledAt: f.at(SECOND),
          handling: { ...started(GENERATION, 'conversation-1'), startedAt: f.at(SECOND) },
        });
        const status = () =>
          store().getAgentTriggerDeliveryStatus(
            queued.delivery.deliveryKey,
            user,
            REMOTE_SOURCE.id,
            'tenant-1',
          );
        await expect(status()).resolves.toMatchObject({
          status: 'succeeded',
          handling: {
            status: 'started',
            conversationId: 'conversation-1',
            streamId: 'conversation-1',
            generationCreatedAt: GENERATION,
            startedAt: f.at(SECOND),
          },
        });
        await store().settleAgentTriggerHandlingOutcome({
          deliveryKey: queued.delivery.deliveryKey,
          conversationId: 'conversation-1',
          generationCreatedAt: GENERATION,
          status: 'cancelled',
          settledAt: f.at(2 * SECOND),
        });
        await expect(status()).resolves.toMatchObject({
          handling: { status: 'cancelled', settledAt: f.at(2 * SECOND) },
        });
      });
    });

    /* ------------------------------------------------------------------ coalesced batches */

    describe('coalesced batches (enqueue, getAgentTriggerDeliveryBatch, settlement)', () => {
      const batchInput = (
        orderingKey: string,
        coalesceUntil: Date,
        overrides: Partial<EnqueueInput> = {},
      ): Partial<EnqueueInput> => ({
        orderingKey,
        coalesceKey: `trigger_batch_${orderingKey}`,
        coalesceFrom: new Date(coalesceUntil.getTime() - 750),
        coalesceUntil,
        availableAt: coalesceUntil,
        envelopeBytes: 128,
        ...overrides,
      });

      it('coalesces a concurrent burst behind one claimable root and settles every receipt', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        const replicas = [harness.createStores(), harness.createStores()];
        const queued = await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            replicas[index % 2].agentTriggerDeliveries.enqueueAgentTriggerDelivery(
              f.enqueueInput({
                user,
                ...batchInput('commentary-lane', coalesceUntil, { awaitTerminalHandling: true }),
                envelope: {
                  mode: 'continue',
                  target: { bindingId: 'binding-1' },
                  event: { id: `event-${index}`, source: REMOTE_SOURCE },
                },
              }),
            ),
          ),
        );
        const rows = await byLane('commentary-lane');
        const [root] = rows.filter((row) => row.status === 'pending');
        expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1);
        expect(rows.filter((row) => row.status === 'batched')).toHaveLength(3);
        expect(root).toMatchObject({ batchSize: 4, batchBytes: 512 });
        expect(root.batchMemberIds).toHaveLength(3);
        for (const member of rows.filter((row) => row.status === 'batched')) {
          expect(member.batchRootId).toBe(root._id);
        }
        /** A member's public status is its root's, under the member's own key. */
        const memberKey = rows.find((row) => row.status === 'batched')!.deliveryKey as string;
        await expect(
          store().getAgentTriggerDeliveryStatus(memberKey, user, REMOTE_SOURCE.id, 'tenant-1'),
        ).resolves.toEqual({
          deliveryKey: memberKey,
          status: 'pending',
          attempts: 0,
          availableAt: coalesceUntil,
          createdAt: expect.any(Date),
        });

        const claims = await Promise.all(
          replicas.map((replica, index) =>
            replica.agentTriggerDeliveries.claimNextAgentTriggerDelivery({
              workerId: `worker-${index}`,
              claimToken: `claim-${index}`,
              now: coalesceUntil,
              leaseUntil: f.at(MINUTE, coalesceUntil),
            }),
          ),
        );
        const won = claims.filter((claim) => claim != null);
        expect(won).toHaveLength(1);
        const claim = won[0]!;
        const members = await store().getAgentTriggerDeliveryBatch(claim);
        expect(members.map((member) => member.id).sort()).toEqual(
          (root.batchMemberIds as string[]).slice().sort(),
        );
        expect(members.every((member) => member.status === 'batched')).toBe(true);
        await expect(
          store().getAgentTriggerDeliveryBatch({
            id: claim.id,
            batchMemberIds: (root.batchMemberIds as string[]).map((id) => f.storeId(id)),
          }),
        ).resolves.toHaveLength(3);

        const attempt = await store().beginAgentTriggerDeliveryAttempt({
          id: claim.id,
          workerId: claim.leaseBy,
          claimToken: claim.claimToken,
          now: coalesceUntil,
        });
        const result = { mode: 'continue', status: 'started', conversationId: 'child-thread' };
        await expect(
          store().completeAgentTriggerDelivery({
            id: claim.id,
            workerId: claim.leaseBy,
            claimToken: claim.claimToken,
            attempt: attempt!,
            result,
            settledAt: coalesceUntil,
            awaitTerminalHandling: true,
            handling: { ...started(GENERATION, 'child-thread'), startedAt: coalesceUntil },
          }),
        ).resolves.toBe(true);

        const settled = await byLane('commentary-lane');
        expect(settled.every((row) => row.status === 'succeeded')).toBe(true);
        expect(settled.map((row) => row.result)).toEqual(Array(4).fill(result));
        expect(settled.every((row) => row.expiresAt == null)).toBe(true);
        const receipts = await Promise.all(
          queued.map(({ delivery }) =>
            store().getAgentTriggerDeliveryStatus(
              delivery.deliveryKey,
              user,
              REMOTE_SOURCE.id,
              'tenant-1',
            ),
          ),
        );
        expect(receipts.every((receipt) => receipt?.status === 'succeeded')).toBe(true);
        expect(receipts.every((receipt) => receipt?.handling?.status === 'started')).toBe(true);

        const later = await f.enqueue({
          user,
          orderingKey: 'commentary-lane',
          awaitTerminalHandling: true,
          availableAt: coalesceUntil,
        });
        const laterClaim = await f.claim({ claimToken: 'claim-later', now: coalesceUntil });
        expect(laterClaim?.id).toBe(later.delivery.id);
        await expect(store().findEarlierAgentTriggerDelivery(laterClaim!)).resolves.toMatchObject({
          reason: 'active_handling',
        });

        const outcome = {
          deliveryKey: root.deliveryKey as string,
          conversationId: 'child-thread',
          generationCreatedAt: GENERATION,
          status: 'completed_no_action' as const,
          settledAt: f.at(SECOND, coalesceUntil),
        };
        await expect(store().settleAgentTriggerHandlingOutcome(outcome)).resolves.toBe(true);
        await expect(store().findEarlierAgentTriggerDelivery(laterClaim!)).resolves.toBeNull();
        const ids = new Set(queued.map(({ delivery }) => delivery.id));
        let terminal = (await f.deliveries()).filter((row) => ids.has(row._id as string));
        expect(
          terminal.every((row) => (row.handling as RawRecord)?.status === 'completed_no_action'),
        ).toBe(true);

        /** A member whose handling copy was lost is repaired by the replayed outcome. */
        const member = terminal.find((row) => row._id !== root._id)!;
        await f.patchDelivery(member._id as string, { handling: undefined });
        await expect(store().settleAgentTriggerHandlingOutcome(outcome)).resolves.toBe(true);
        terminal = (await f.deliveries()).filter((row) => ids.has(row._id as string));
        expect(
          terminal.every((row) => (row.handling as RawRecord)?.status === 'completed_no_action'),
        ).toBe(true);
        expect(
          terminal.every(
            (row) => timeOf(row.expiresAt) === outcome.settledAt.getTime() + SUCCESS_RETENTION_MS,
          ),
        ).toBe(true);
      });

      it('reads no members for a delivery outside a batch and refuses a missing one', async () => {
        const queued = await f.enqueue();
        await expect(store().getAgentTriggerDeliveryBatch(queued.delivery)).resolves.toEqual([]);
        await expect(
          store().getAgentTriggerDeliveryBatch({ id: queued.delivery.id, batchMemberIds: [] }),
        ).resolves.toEqual([]);
        await expect(
          store().getAgentTriggerDeliveryBatch({
            id: queued.delivery.id,
            batchMemberIds: [harness.ids.generate()],
          }),
        ).rejects.toThrow('Agent trigger batch member is missing');
        const other = await f.enqueue();
        await f.patchDelivery(other.delivery.id, { batchRootId: harness.ids.generate() });
        await expect(
          store().getAgentTriggerDeliveryBatch({
            id: queued.delivery.id,
            batchMemberIds: [other.delivery.id],
          }),
        ).rejects.toThrow('Agent trigger batch member belongs to another root');
      });

      it('promotes mailbox semantics when an enabled delivery joins an unmarked root', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        const first = await f.enqueue({
          user,
          ...batchInput('mixed-rollout-batch', coalesceUntil),
        });
        await f.enqueue({
          user,
          ...batchInput('mixed-rollout-batch', coalesceUntil, { awaitTerminalHandling: true }),
        });
        expect(await f.raw(first.delivery.id)).toMatchObject({
          status: 'pending',
          awaitTerminalHandling: true,
          batchSize: 2,
        });
      });

      it('caps a batch at 8, and starts new batches outside the window', async () => {
        const user = f.newUser();
        const openUntil = new Date(Date.now() + MINUTE);
        await Promise.all(
          Array.from({ length: 9 }, () =>
            f.enqueue({ user, ...batchInput('bounded-lane', openUntil, { envelopeBytes: 64 }) }),
          ),
        );
        const bounded = await byLane('bounded-lane');
        expect(bounded.filter((row) => row.status === 'pending')).toHaveLength(2);
        expect(bounded.filter((row) => row.status === 'batched')).toHaveLength(7);
        expect(Math.max(...bounded.map((row) => (row.batchSize as number) ?? 0))).toBe(8);

        const closedUntil = new Date(Date.now() - 1);
        for (let index = 0; index < 2; index += 1) {
          await f.enqueue({
            user,
            ...batchInput('closed-lane', closedUntil, { envelopeBytes: 64 }),
          });
        }
        expect((await byLane('closed-lane')).map((row) => row.status)).toEqual([
          'pending',
          'pending',
        ]);

        const nearUntil = new Date(Date.now() + MINUTE);
        await f.enqueue({
          user,
          ...batchInput('scheduled-lane', nearUntil, { envelopeBytes: 64 }),
        });
        await f.enqueue({
          user,
          ...batchInput('scheduled-lane', new Date(nearUntil.getTime() + DAY), {
            envelopeBytes: 64,
            coalesceKey: 'trigger_batch_scheduled-lane',
          }),
        });
        expect((await byLane('scheduled-lane')).map((row) => row.status)).toEqual([
          'pending',
          'pending',
        ]);
      });

      it('intersects overlapping batch windows whatever the publication order', async () => {
        const user = f.newUser();
        const earlierFrom = new Date(Date.now() + MINUTE);
        const earlierUntil = new Date(earlierFrom.getTime() + 750);
        const laterFrom = new Date(earlierFrom.getTime() + 250);
        const laterUntil = new Date(laterFrom.getTime() + 750);
        const shared = {
          user,
          orderingKey: 'overlapping-window-lane',
          coalesceKey: 'trigger_batch_overlapping',
          envelopeBytes: 64,
        };
        await f.enqueue({
          ...shared,
          coalesceFrom: laterFrom,
          coalesceUntil: laterUntil,
          availableAt: laterUntil,
        });
        await f.enqueue({
          ...shared,
          coalesceFrom: earlierFrom,
          coalesceUntil: earlierUntil,
          availableAt: earlierUntil,
        });
        const rows = await byLane('overlapping-window-lane');
        const root = rows.find((row) => row.status === 'pending')!;
        expect(rows.map((row) => row.status)).toEqual(['pending', 'batched']);
        expect(root.batchSize).toBe(2);
        expect(timeOf(root.coalesceFrom)).toBe(laterFrom.getTime());
        expect(timeOf(root.coalesceUntil)).toBe(earlierUntil.getTime());
        expect(timeOf(root.availableAt)).toBe(earlierUntil.getTime());
      });

      it('starts a new batch when another delivery took the lane tail', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        const lane = 'intervening-delivery-lane';
        await f.enqueue({ user, ...batchInput(lane, coalesceUntil, { coalesceKey: 'first' }) });
        await f.enqueue({
          user,
          ...batchInput(lane, coalesceUntil, { coalesceKey: 'intervening' }),
        });
        await f.enqueue({ user, ...batchInput(lane, coalesceUntil, { coalesceKey: 'first' }) });
        const rows = await byLane(lane);
        expect(rows.map((row) => row.status)).toEqual(['pending', 'pending', 'pending']);
        expect(rows.map((row) => row.batchSize)).toEqual([1, 1, 1]);
      });

      it('dead-letters every member with the root and carries the deadline to them', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        const expiresAt = f.at(7 * DAY, coalesceUntil);
        await Promise.all(
          Array.from({ length: 2 }, () =>
            f.enqueue({ user, ...batchInput('batch-dead-retention-lane', coalesceUntil) }),
          ),
        );
        await f.kill({ now: coalesceUntil, expiresAt });
        const rows = await byLane('batch-dead-retention-lane');
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.status).toBe('dead');
          expect(timeOf(row.expiresAt)).toBe(expiresAt.getTime());
          expect(row).not.toHaveProperty('deadLetterExpiresAt');
        }
        const root = rows.find((row) => row.batchMemberIds != null);
        expect(root?.batchMembersSettledAt).toBeInstanceOf(Date);
        /** The members are listed through their root only. */
        expect((await store().getAgentTriggerDeadLetters()).map((row) => row.id)).toEqual([
          root?._id,
        ]);
      });

      it('requeues a dead batch as a root instead of nesting it under a newer batch', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        await Promise.all(
          Array.from({ length: 2 }, () =>
            f.enqueue({ user, ...batchInput('batch-requeue-lane', coalesceUntil) }),
          ),
        );
        const dead = await f.kill({ now: coalesceUntil });
        await f.enqueue({ user, ...batchInput('batch-requeue-lane', coalesceUntil) });

        const requeued = await store().requeueAgentTriggerDelivery(dead.fence.id, coalesceUntil);
        expect(requeued).toMatchObject({ status: 'pending', batchSize: 2, requeueCount: 1 });
        expect(requeued?.batchRootId).toBeUndefined();
        const rows = await byLane('batch-requeue-lane');
        expect(rows.filter((row) => row.status === 'pending')).toHaveLength(2);
        const members = rows.filter((row) => row.batchRootId === dead.fence.id);
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ status: 'batched', batchRootRequeueCount: 1 });
      });

      it('refuses to requeue a batch whose member a newer generation already settled', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        await Promise.all(
          Array.from({ length: 2 }, () =>
            f.enqueue({ user, ...batchInput('batch-generation-lane', coalesceUntil) }),
          ),
        );
        const dead = await f.kill({ now: coalesceUntil });
        const root = (await f.raw(dead.fence.id))!;
        const memberId = (root.batchMemberIds as string[])[0];
        await f.rewrite((collections) => {
          const rows = collections[DELIVERIES];
          delete rows.find((row) => row._id === root._id)!.batchMembersSettledAt;
          const member = rows.find((row) => row._id === memberId)!;
          member.status = 'succeeded';
          member.batchRootRequeueCount = 1;
          member.settledAt = f.at(SECOND, coalesceUntil);
          delete member.lastError;
        });

        await expect(
          store().requeueAgentTriggerDelivery(dead.fence.id, coalesceUntil),
        ).rejects.toThrow('Not every agent trigger batch receipt could be prepared for requeue');
        expect(await f.raw(memberId)).toMatchObject({
          status: 'succeeded',
          batchRootRequeueCount: 1,
        });
        await expect(store().recoverAgentTriggerLanePublications()).rejects.toThrow(
          'Not every agent trigger batch receipt could be prepared for requeue',
        );
        expect(await f.raw(memberId)).toMatchObject({
          status: 'succeeded',
          batchRootRequeueCount: 1,
        });
        expect(await f.raw(dead.fence.id)).not.toHaveProperty('batchMembersSettledAt');
      });
    });

    /* ------------------------------------------------------------------ recovery sweeps */

    describe('recoverAgentTriggerLanePublications', () => {
      it('publishes an orphaned staging row, with or without its fairness cursor', async () => {
        const user = f.newUser();
        const withCursor = await f.seedStaging(
          { user, orderingKey: 'maintenance-staging' },
          { stagingRecoveryAt: START },
        );
        const legacy = await f.seedStaging({ user, orderingKey: 'legacy-maintenance-staging' });

        const activity = { found: false };
        await expect(store().recoverAgentTriggerLanePublications(5, activity)).resolves.toBe(2);
        expect(activity.found).toBe(true);
        expect(await f.raw(withCursor)).toMatchObject({ status: 'pending', laneSequence: 1 });
        expect(await f.raw(legacy)).toMatchObject({ status: 'pending', laneSequence: 1 });
        expect(await f.lane('maintenance-staging')).toMatchObject({ value: 1 });

        const idle = { found: false };
        await expect(store().recoverAgentTriggerLanePublications(5, idle)).resolves.toBe(0);
        expect(idle.found).toBe(false);
      });

      it('publishes an abandoned lane reservation', async () => {
        const user = f.newUser();
        const staged = await f.seedStaging({ user, orderingKey: 'abandoned-publisher' });
        await f.seedLane({
          _id: 'abandoned-publisher',
          value: 1,
          user,
          tailDeliveryId: staged,
          publisherDeliveryId: staged,
          publisherStartedAt: START,
        });
        await expect(store().recoverAgentTriggerLanePublications(1)).resolves.toBe(1);
        expect(await f.raw(staged)).toMatchObject({ status: 'pending', laneSequence: 1 });
        const lane = await f.lane('abandoned-publisher');
        expect(lane).toMatchObject({ value: 1 });
        expect(lane).not.toHaveProperty('publisherDeliveryId');
      });

      it('leaves staging and a lane reservation alone while the owner has a purge marker', async () => {
        const user = f.newUser();
        await harness.seedRaw(PURGES, [
          {
            _id: user,
            fenceStartedAt: START,
            tenantId: 'tenant-1',
            createdAt: START,
            updatedAt: START,
          },
        ]);
        const staged = await f.seedStaging(
          { user, orderingKey: 'purge-fenced-staging' },
          { stagingRecoveryAt: START },
        );
        const reserved = await f.seedStaging({ user, orderingKey: 'purge-fenced-publisher' });
        await f.seedLane({
          _id: 'purge-fenced-publisher',
          value: 1,
          user,
          tailDeliveryId: reserved,
          publisherDeliveryId: reserved,
          publisherStartedAt: START,
        });

        const activity = { found: false };
        await expect(store().recoverAgentTriggerLanePublications(5, activity)).resolves.toBe(0);
        expect(activity.found).toBe(true);
        expect(await f.raw(staged)).toMatchObject({ status: 'staging', laneSequence: 0 });
        expect(await f.raw(reserved)).toMatchObject({ status: 'staging', laneSequence: 0 });
        expect(await f.lane('purge-fenced-staging')).toBeUndefined();
        expect(await f.lane('purge-fenced-publisher')).toMatchObject({
          publisherDeliveryId: reserved,
          value: 1,
        });
      });

      it('rotates purge-fenced staging rows so later recovery work is not starved', async () => {
        const users = [f.newUser(), f.newUser(), f.newUser()];
        for (const [index, user] of users.entries()) {
          if (index < 2) {
            await harness.seedRaw(PURGES, [
              { _id: user, fenceStartedAt: START, createdAt: START, updatedAt: START },
            ]);
          }
          await f.seedStaging(
            { user, orderingKey: `staging-rotation-${index}` },
            { stagingRecoveryAt: f.at(index) },
          );
        }
        await expect(store().recoverAgentTriggerLanePublications(2)).resolves.toBe(0);
        await expect(store().recoverAgentTriggerLanePublications(2)).resolves.toBe(1);
        expect((await byLane('staging-rotation-2'))[0]).toMatchObject({
          status: 'pending',
          laneSequence: 1,
        });
        expect((await byLane('staging-rotation-0'))[0]).toMatchObject({ status: 'staging' });
      });

      it('rotates purge-fenced publishers so later recovery work is not starved', async () => {
        const users = [f.newUser(), f.newUser(), f.newUser()];
        for (const [index, user] of users.entries()) {
          if (index < 2) {
            await harness.seedRaw(PURGES, [
              { _id: user, fenceStartedAt: START, createdAt: START, updatedAt: START },
            ]);
          }
          const orderingKey = `publisher-rotation-${index}`;
          const staged = await f.seedStaging({ user, orderingKey }, { stagingRecoveryAt: START });
          await f.seedLane({
            _id: orderingKey,
            value: 1,
            user,
            publisherDeliveryId: staged,
            publisherStartedAt: f.at(index),
          });
        }
        await expect(store().recoverAgentTriggerLanePublications(2)).resolves.toBe(0);
        await expect(store().recoverAgentTriggerLanePublications(2)).resolves.toBe(1);
        expect((await byLane('publisher-rotation-2'))[0]).toMatchObject({
          status: 'pending',
          laneSequence: 1,
        });
      });

      it('finishes a batch requeue interrupted after the root was staged', async () => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        await Promise.all(
          Array.from({ length: 2 }, () =>
            f.enqueue({
              user,
              orderingKey: 'batch-requeue-recovery-lane',
              coalesceKey: 'trigger_batch_requeue_recovery',
              coalesceFrom: new Date(coalesceUntil.getTime() - 750),
              coalesceUntil,
              availableAt: coalesceUntil,
              envelopeBytes: 128,
            }),
          ),
        );
        const dead = await f.kill({ now: coalesceUntil });
        /** The requeue claimed the root for publication and stopped before preparing its member. */
        await f.patchDelivery(dead.fence.id, (row) => ({
          status: 'staging',
          laneSequence: 0,
          requeueCount: (row.requeueCount as number) + 1,
          availableAt: coalesceUntil,
          claimAvailableAt: coalesceUntil,
          stagingRecoveryAt: START,
          settledAt: undefined,
          lastError: undefined,
          expiresAt: undefined,
        }));
        const member = (await f.deliveries()).find((row) => row.batchRootId === dead.fence.id)!;
        expect(member.status).toBe('dead');

        await expect(store().recoverAgentTriggerLanePublications()).resolves.toBeGreaterThan(0);
        expect(await f.raw(dead.fence.id)).toMatchObject({ status: 'pending', requeueCount: 1 });
        expect(await f.raw(member._id as string)).toMatchObject({
          status: 'batched',
          batchRootRequeueCount: 1,
        });
      });

      it('refuses a limit that is not a positive integer', async () => {
        for (const limit of [0, -1, 1.5, Number.NaN]) {
          await expect(store().recoverAgentTriggerLanePublications(limit)).rejects.toBeInstanceOf(
            TypeError,
          );
        }
      });
    });

    describe('recoverAgentTriggerBatchReceipts', () => {
      const coalesced = async (orderingKey: string, count = 2) => {
        const user = f.newUser();
        const coalesceUntil = new Date(Date.now() + MINUTE);
        await Promise.all(
          Array.from({ length: count }, (_, index) =>
            f.enqueue({
              user,
              orderingKey,
              coalesceKey: `trigger_batch_${orderingKey}`,
              coalesceFrom: new Date(coalesceUntil.getTime() - 750),
              coalesceUntil,
              availableAt: coalesceUntil,
              envelopeBytes: 128,
              envelope: { event: { id: `event-${index}`, source: REMOTE_SOURCE } },
            }),
          ),
        );
        return (await byLane(orderingKey)).find((row) => row.status === 'pending')!;
      };

      it('settles the members and cleans the lane after an interrupted root success', async () => {
        const root = await coalesced('batch-recovery-lane');
        const result = { mode: 'continue', status: 'started', conversationId: 'child-thread' };
        await f.patchDelivery(root._id as string, {
          status: 'succeeded',
          attempts: 1,
          result,
          settledAt: START,
          expiresAt: f.at(SUCCESS_RETENTION_MS),
          laneCleanupPendingAt: START,
        });

        const activity = { found: false };
        await expect(store().recoverAgentTriggerBatchReceipts(25, activity)).resolves.toBe(1);
        expect(activity.found).toBe(true);
        const rows = await byLane('batch-recovery-lane');
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === 'succeeded')).toBe(true);
        expect(rows.map((row) => row.result)).toEqual([result, result]);
        expect(timeOf(rows.find((row) => row._id === root._id)?.batchMembersSettledAt)).toBe(
          START.getTime(),
        );
        expect(await f.lane('batch-recovery-lane')).toBeUndefined();

        await expect(store().recoverAgentTriggerBatchReceipts()).resolves.toBe(0);
        expect(
          rows.map((row) => (row.history as unknown[] | undefined)?.length ?? 0).sort(),
        ).toEqual([0, 1]);
      });

      it('arms a dead root deadline only once its members are settled', async () => {
        const root = await coalesced('batch-dead-deferred-lane');
        const expiresAt = f.at(7 * DAY);
        /** The root was dead-lettered and the process stopped before settling its member. */
        await f.patchDelivery(root._id as string, {
          status: 'dead',
          attempts: 1,
          settledAt: START,
          lastError: f.failure({ retryable: false }),
          deadLetterExpiresAt: expiresAt,
        });
        await expect(store().recoverAgentTriggerBatchReceipts()).resolves.toBeGreaterThan(0);
        for (const row of await byLane('batch-dead-deferred-lane')) {
          expect(row.status).toBe('dead');
          expect(timeOf(row.expiresAt)).toBe(expiresAt.getTime());
          expect(row).not.toHaveProperty('deadLetterExpiresAt');
        }
      });

      it('settles a dead root whose members expired already', async () => {
        const root = await coalesced('batch-dead-expired-members-lane');
        const expiresAt = new Date(Date.now() - SECOND);
        await f.rewrite((collections) => {
          collections[DELIVERIES] = collections[DELIVERIES].filter(
            (row) => row.orderingKey !== 'batch-dead-expired-members-lane' || row._id === root._id,
          );
          Object.assign(collections[DELIVERIES].find((row) => row._id === root._id)!, {
            status: 'dead',
            attempts: 1,
            settledAt: START,
            lastError: f.failure({ retryable: false }),
            deadLetterExpiresAt: expiresAt,
          });
        });
        await expect(store().recoverAgentTriggerBatchReceipts()).resolves.toBeGreaterThan(0);
        const settled = await f.raw(root._id as string);
        expect(settled?.batchMembersSettledAt).toBeInstanceOf(Date);
        expect(timeOf(settled?.expiresAt)).toBe(expiresAt.getTime());
        expect(settled).not.toHaveProperty('deadLetterExpiresAt');
      });

      it('finds nothing to do on a quiet queue and refuses a bad limit', async () => {
        await f.enqueue();
        const activity = { found: false };
        await expect(store().recoverAgentTriggerBatchReceipts(5, activity)).resolves.toBe(0);
        expect(activity.found).toBe(false);
        await expect(store().recoverAgentTriggerBatchReceipts(0)).rejects.toBeInstanceOf(TypeError);
      });
    });

    describe('reclaimInactiveAgentTriggerLanes', () => {
      it('rediscovers lane cleanup when success committed before the cleanup', async () => {
        const queued = await f.enqueue({ orderingKey: 'crashed-lane-cleanup' });
        await f.deliver();
        /** The success committed with its cleanup marker; the lane write was lost. */
        await f.rewrite((collections) => {
          Object.assign(collections[DELIVERIES][0], { laneCleanupPendingAt: START });
          collections[LANES].push({
            _id: 'crashed-lane-cleanup',
            value: 1,
            user: idOf(harness, queued.delivery.user),
            tailDeliveryId: queued.delivery.id,
            createdAt: START,
            updatedAt: START,
          });
        });

        const activity = { found: false };
        await expect(store().reclaimInactiveAgentTriggerLanes(1, activity)).resolves.toBe(1);
        expect(activity.found).toBe(true);
        expect(await f.lane('crashed-lane-cleanup')).toBeUndefined();
        expect(await f.raw(queued.delivery.id)).not.toHaveProperty('laneCleanupPendingAt');
        await expect(store().reclaimInactiveAgentTriggerLanes(1)).resolves.toBe(0);
      });

      it('keeps a lane whose newer delivery is still unsettled', async () => {
        const user = f.newUser();
        const first = await f.enqueue({ user, orderingKey: 'still-busy-lane' });
        await f.enqueue({ user, orderingKey: 'still-busy-lane', availableAt: f.at(MINUTE) });
        await f.deliver();
        await f.patchDelivery(first.delivery.id, { laneCleanupPendingAt: START });
        await store().reclaimInactiveAgentTriggerLanes(5);
        expect(await f.lane('still-busy-lane')).toMatchObject({ value: 2 });
        expect(await f.raw(first.delivery.id)).not.toHaveProperty('laneCleanupPendingAt');
      });

      it('refuses a limit that is not a positive integer', async () => {
        await expect(store().reclaimInactiveAgentTriggerLanes(0)).rejects.toBeInstanceOf(TypeError);
      });
    });
  });
}
