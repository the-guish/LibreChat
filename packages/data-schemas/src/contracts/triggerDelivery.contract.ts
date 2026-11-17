/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TriggerDeliveryStore` contract (`~/ports/triggerDelivery`), first part: the queue itself,
 * ported from `methods/triggerDelivery.spec.ts`. Publication on an ordering lane (the idempotent
 * replay and the fingerprint conflict, the lane sequence allocated under the lane's publisher
 * reservation, publications a crashed writer left, the capability shield), the claim (one
 * winner, the lease skew margin, the capability fences, the claim order with its legacy rows),
 * the lane order a worker checks (`findEarlierAgentTriggerDelivery`), the attempt fences
 * (release, begin, defer, complete, retry, dead letter: exact winner and loser outcomes, the
 * history entries, the retention deadlines) and the reads and operations (status projection,
 * dead letters, requeue, active counts). Tenant scoping of the reads.
 *
 * The rest of the store: `triggerDelivery.lifecycle.contract.ts` (retirement, producer leases,
 * expediting, terminal handling, coalesced batches, the recovery sweeps),
 * `triggerDelivery.backgroundResults.contract.ts`, `triggerDelivery.eventActor.contract.ts` and
 * `triggerDelivery.purge.contract.ts`.
 *
 * Not here (they stay in the method spec): the receipt metric observer, claim contention made by
 * a spied compare-and-set (`AgentTriggerClaimContentionError`), publications paused between
 * writes by spies, the index-definition checks, and the read-preference spies. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
} from '~/types';
import type { ContractHarness } from './harness';
import {
  DAY,
  DELIVERIES,
  LANES,
  LEGACY_SHIELD_AT,
  MINUTE,
  REMOTE_SOURCE,
  SECOND,
  START,
  SUCCESS_RETENTION_MS,
  createTriggerDeliveryFixtures,
} from './triggerDelivery.fixtures';
import { idOf, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const DETACHED = AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1;
const RECEIPT_V2 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2;

/** The error a store method rejected with, or a failure when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to reject');
}

export function describeTriggerDeliveryContract(harness: ContractHarness): void {
  describe(`TriggerDeliveryStore contract (queue): ${harness.name}`, () => {
    useContractHarness(harness);

    const f = createTriggerDeliveryFixtures(harness);
    const store = () => f.store();
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);

    /* ------------------------------------------------------------------ setup */

    describe('ensureAgentTriggerDeliveryIndexes', () => {
      it('builds the indexes and enforces one delivery per key', async () => {
        await expect(store().ensureAgentTriggerDeliveryIndexes()).resolves.toBeUndefined();
        await expect(store().ensureAgentTriggerDeliveryIndexes()).resolves.toBeUndefined();
        const input = f.enqueueInput();
        await store().enqueueAgentTriggerDelivery(input);
        await expect(store().enqueueAgentTriggerDelivery(input)).resolves.toMatchObject({
          replayed: true,
        });
        expect(await f.deliveries()).toHaveLength(1);
      });

      it('rejects a raw second record with a used delivery key as a duplicate key', async () => {
        await f.seedDelivery({ deliveryKey: 'duplicate-key' });
        const error = await rejectionOf(f.seedDelivery({ deliveryKey: 'duplicate-key' }));
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
      });
    });

    /* ------------------------------------------------------------------ publish */

    describe('enqueueAgentTriggerDelivery', () => {
      it('publishes idempotently and rejects key reuse with different content', async () => {
        const input = f.enqueueInput();
        const first = await store().enqueueAgentTriggerDelivery(input);
        const replay = await store().enqueueAgentTriggerDelivery(input);

        expect(first.replayed).toBe(false);
        expect(first.delivery).toMatchObject({
          deliveryKey: input.deliveryKey,
          fingerprint: input.fingerprint,
          orderingKey: 'ordering-1',
          laneSequence: 1,
          envelope: input.envelope,
          tenantId: 'tenant-1',
          status: 'pending',
          attempts: 0,
          requeueCount: 0,
        });
        expect(idOf(harness, first.delivery.user)).toBe(input.user);
        expect(timeOf(first.delivery.availableAt)).toBe(START.getTime());
        expect(first.delivery.createdAt).toBeInstanceOf(Date);
        expect(replay).toMatchObject({ replayed: true, delivery: { id: first.delivery.id } });

        const conflict = await rejectionOf(
          store().enqueueAgentTriggerDelivery({ ...input, fingerprint: 'different' }),
        );
        expect(conflict.name).toBe('AgentTriggerDeliveryConflictError');
        expect(conflict.message).toContain(input.deliveryKey);
        expect(await f.deliveries()).toHaveLength(1);
      });

      it('stores the published row on its lane with the lane counter at its sequence', async () => {
        const input = f.enqueueInput({ orderingKey: 'stored-lane' });
        const { delivery } = await store().enqueueAgentTriggerDelivery(input);
        const row = await f.raw(input.deliveryKey);
        expect(row).toMatchObject({
          _id: delivery.id,
          user: input.user,
          status: 'pending',
          laneSequence: 1,
          attempts: 0,
          requeueCount: 0,
        });
        expect(timeOf(row?.claimAvailableAt)).toBe(START.getTime());
        expect(row).not.toHaveProperty('stagingRecoveryAt');
        expect(row).not.toHaveProperty('requiredWorkerCapability');
        expect(await f.lane('stored-lane')).toMatchObject({
          _id: 'stored-lane',
          value: 1,
          user: input.user,
          tailDeliveryId: delivery.id,
        });
        expect(await f.lane('stored-lane')).not.toHaveProperty('publisherDeliveryId');
      });

      it('keeps the stored mailbox flag on replay in both directions', async () => {
        const enabled = f.enqueueInput({ awaitTerminalHandling: true });
        const first = await store().enqueueAgentTriggerDelivery(enabled);
        const disabledReplay = await store().enqueueAgentTriggerDelivery({
          ...enabled,
          awaitTerminalHandling: undefined,
        });
        expect(first.delivery.awaitTerminalHandling).toBe(true);
        expect(disabledReplay).toMatchObject({
          replayed: true,
          delivery: { id: first.delivery.id, awaitTerminalHandling: true },
        });

        const disabled = f.enqueueInput();
        const second = await store().enqueueAgentTriggerDelivery(disabled);
        const enabledReplay = await store().enqueueAgentTriggerDelivery({
          ...disabled,
          awaitTerminalHandling: true,
        });
        expect(second.delivery.awaitTerminalHandling).toBeUndefined();
        expect(enabledReplay).toMatchObject({
          replayed: true,
          delivery: { id: second.delivery.id },
        });
        expect(enabledReplay.delivery.awaitTerminalHandling).toBeUndefined();
      });

      it('allocates one monotonic sequence per lane across concurrent store instances', async () => {
        const user = f.newUser();
        const replicas = [harness.createStores(), harness.createStores()];
        const enqueued = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            replicas[index % 2].agentTriggerDeliveries.enqueueAgentTriggerDelivery(
              f.enqueueInput({ user, orderingKey: 'shared-lane' }),
            ),
          ),
        );
        expect(enqueued.map(({ delivery }) => delivery.laneSequence).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );
        expect(await f.lane('shared-lane')).toMatchObject({ value: 12 });
        const other = await f.enqueue({ user, orderingKey: 'other-lane' });
        expect(other.delivery.laneSequence).toBe(1);
      });

      it('shields capability work from workers that predate capabilities', async () => {
        const queued = await f.enqueue({
          orderingKey: 'shielded-lane',
          requiredWorkerCapability: DETACHED,
        });
        expect(queued.delivery).toMatchObject({
          status: 'capability_pending',
          requiredWorkerCapability: DETACHED,
        });
        expect(timeOf(queued.delivery.availableAt)).toBe(START.getTime());
        const row = await f.raw(queued.delivery.deliveryKey);
        expect(row).toMatchObject({
          status: 'leased',
          capabilityStatus: 'pending',
          requiredWorkerCapability: DETACHED,
        });
        expect(timeOf(row?.claimAvailableAt)).toBe(START.getTime());
        expect(timeOf(row?.availableAt)).toBe(START.getTime());
        expect(row).not.toHaveProperty('leaseUntil');
      });

      it('refuses an unknown capability and a batched capability delivery', async () => {
        await expect(
          f.enqueue({ requiredWorkerCapability: 'teleportation_v1' }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          f.enqueue({
            requiredWorkerCapability: DETACHED,
            coalesceKey: 'batch',
            coalesceFrom: START,
            coalesceUntil: START,
          }),
        ).rejects.toBeInstanceOf(TypeError);
        expect(await f.deliveries()).toEqual([]);
      });

      it('publishes a replay of a staged row on its persisted lane', async () => {
        const user = f.newUser();
        const input = f.enqueueInput({ user, orderingKey: 'original-lane' });
        await f.seedStaging(input);

        const replay = await store().enqueueAgentTriggerDelivery({
          ...input,
          orderingKey: 'changed-lane',
        });

        expect(replay).toMatchObject({
          replayed: true,
          delivery: { orderingKey: 'original-lane', laneSequence: 1, status: 'pending' },
        });
        expect(await f.lane('original-lane')).toMatchObject({ value: 1 });
        expect(await f.lane('changed-lane')).toBeUndefined();
      });

      it('resumes its own abandoned publication without allocating a second sequence', async () => {
        const user = f.newUser();
        const input = f.enqueueInput({ user, orderingKey: 'publication-replay' });
        const staged = await f.seedStaging(input);
        await f.seedLane({
          _id: 'publication-replay',
          value: 1,
          user,
          tailDeliveryId: staged,
          publisherDeliveryId: staged,
          publisherStartedAt: START,
        });

        const replay = await store().enqueueAgentTriggerDelivery(input);

        expect(replay).toMatchObject({ replayed: true, delivery: { id: staged, laneSequence: 1 } });
        expect(await f.lane('publication-replay')).toMatchObject({ value: 1 });
      });

      it('publishes an abandoned lane owner before allocating the next sequence', async () => {
        const user = f.newUser();
        const first = await f.seedStaging({ user, orderingKey: 'publication-race' });
        await f.seedLane({
          _id: 'publication-race',
          value: 1,
          user,
          tailDeliveryId: first,
          publisherDeliveryId: first,
          publisherStartedAt: START,
        });

        const second = await f.enqueue({ user, orderingKey: 'publication-race' });

        expect(await f.raw(first)).toMatchObject({ status: 'pending', laneSequence: 1 });
        expect(second.delivery).toMatchObject({ status: 'pending', laneSequence: 2 });
        await expect(store().findEarlierAgentTriggerDelivery(second.delivery)).resolves.toEqual({
          availableAt: START,
        });
        const lane = await f.lane('publication-race');
        expect(lane).toMatchObject({ value: 2, tailDeliveryId: second.delivery.id });
        expect(lane).not.toHaveProperty('publisherDeliveryId');
      });

      it('publishes an orphaned staging row before a later delivery in the lane', async () => {
        const user = f.newUser();
        const first = await f.seedStaging({ user, orderingKey: 'orphaned-staging' });

        const second = await f.enqueue({ user, orderingKey: 'orphaned-staging' });

        expect(await f.raw(first)).toMatchObject({ status: 'pending', laneSequence: 1 });
        expect(second.delivery).toMatchObject({ status: 'pending', laneSequence: 2 });
        await expect(store().findEarlierAgentTriggerDelivery(second.delivery)).resolves.toEqual({
          availableAt: START,
        });
      });

      it('adopts a capability publication finished by a legacy lane publisher', async () => {
        const user = f.newUser();
        const capability = await f.seedStaging(
          {
            user,
            orderingKey: 'legacy-capability-publication',
            requiredWorkerCapability: DETACHED,
          },
          {
            capabilityStatus: 'publishing',
            claimAvailableAt: START,
            availableAt: LEGACY_SHIELD_AT,
            leaseUntil: LEGACY_SHIELD_AT,
            stagingRecoveryAt: START,
          },
        );
        await f.seedLane({
          _id: 'legacy-capability-publication',
          value: 1,
          user,
          publisherDeliveryId: capability,
          publisherStartedAt: START,
        });
        /** The pre-capability publication write: the old replica assigns the reserved sequence
         * and releases its reservation without touching the private fields. */
        await f.rewrite((collections) => {
          const row = collections[DELIVERIES].find((record) => record._id === capability)!;
          row.status = 'capability_pending';
          row.laneSequence = 1;
          delete row.stagingRecoveryAt;
          const lane = collections[LANES][0];
          lane.tailDeliveryId = capability;
          delete lane.publisherDeliveryId;
          delete lane.publisherStartedAt;
        });

        const later = await f.enqueue({ user, orderingKey: 'legacy-capability-publication' });

        expect(await f.raw(capability)).toMatchObject({
          status: 'leased',
          capabilityStatus: 'pending',
          laneSequence: 1,
        });
        expect(later.delivery).toMatchObject({ laneSequence: 2 });
      });

      it('stamps and scopes deliveries by the tenant in context', async () => {
        const queued = await inTenant('tenant-a', () =>
          f.enqueue({ deliveryKey: 'tenant-scoped', tenantId: undefined }),
        );
        expect(queued.delivery.tenantId).toBe('tenant-a');
        expect((await f.raw('tenant-scoped'))?.tenantId).toBe('tenant-a');
        await expect(
          inTenant('tenant-b', () => store().getAgentTriggerDelivery('tenant-scoped')),
        ).resolves.toBeNull();
        await expect(
          inTenant('tenant-a', () => store().getAgentTriggerDelivery('tenant-scoped')),
        ).resolves.toMatchObject({ id: queued.delivery.id });
        await expect(
          inTenant('tenant-b', () =>
            store().claimNextAgentTriggerDelivery({
              workerId: 'worker-b',
              claimToken: 'claim-b',
              now: START,
              leaseUntil: f.at(MINUTE),
            }),
          ),
        ).resolves.toBeNull();
      });
    });

    /* ------------------------------------------------------------------ claim */

    describe('claimNextAgentTriggerDelivery', () => {
      it('grants one winner across concurrent claims', async () => {
        await f.enqueue();
        const claims = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            f.claim({ workerId: `worker-${index}`, claimToken: `claim-${index}` }),
          ),
        );
        expect(claims.filter((claim) => claim != null)).toHaveLength(1);
      });

      it('claims a due delivery under the lease and leaves future work alone', async () => {
        await expect(f.claim()).resolves.toBeNull();
        const later = await f.enqueue({ orderingKey: 'later-lane', availableAt: f.at(MINUTE) });
        await expect(f.claim()).resolves.toBeNull();

        const claimed = await f.claim({
          workerId: 'worker-7',
          claimToken: 'claim-7',
          now: f.at(MINUTE),
          leaseUntil: f.at(2 * MINUTE),
        });
        expect(claimed).toMatchObject({
          id: later.delivery.id,
          status: 'leased',
          leaseBy: 'worker-7',
          claimToken: 'claim-7',
          attempts: 0,
        });
        expect(timeOf(claimed?.leaseUntil)).toBe(f.at(2 * MINUTE).getTime());
        const row = await f.raw(later.delivery.id);
        expect(row).toMatchObject({ status: 'leased', leaseBy: 'worker-7', claimToken: 'claim-7' });
        expect(timeOf(row?.updatedAt)).toBe(f.at(MINUTE).getTime());
      });

      it('honors the lease skew margin before taking an expired lease over', async () => {
        await f.enqueue();
        expect(await f.claim({ leaseUntil: f.at(MINUTE) })).not.toBeNull();

        await expect(
          f.claim({ workerId: 'worker-2', claimToken: 'claim-2', now: f.at(70 * SECOND) }),
        ).resolves.toBeNull();
        await expect(
          f.claim({ workerId: 'worker-2', claimToken: 'claim-2', now: f.at(91 * SECOND) }),
        ).resolves.toMatchObject({ claimToken: 'claim-2', leaseBy: 'worker-2' });
      });

      it('shields capability work from workers without the capability', async () => {
        const queued = await f.enqueue({ requiredWorkerCapability: RECEIPT_V2 });
        await expect(f.claim()).resolves.toBeNull();
        await expect(
          f.claim({ workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1] }),
        ).resolves.toBeNull();
        const claimed = await f.claim({
          workerId: 'capable-worker',
          claimToken: 'capable-claim',
          workerCapabilities: [RECEIPT_V2],
        });
        expect(claimed).toMatchObject({
          id: queued.delivery.id,
          status: 'capability_leased',
          leaseBy: 'capable-worker',
          claimToken: 'capable-claim',
        });
        /** The private lease; the outer shield keeps the legacy fence. */
        const row = await f.raw(queued.delivery.id);
        expect(row).toMatchObject({
          status: 'leased',
          capabilityStatus: 'leased',
          capabilityLeaseBy: 'capable-worker',
          capabilityClaimToken: 'capable-claim',
        });
        expect(timeOf(row?.leaseUntil)).toBe(LEGACY_SHIELD_AT.getTime());
      });

      it('lets ordinary successors pass an inert capability shield without its year-9999 fence', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          orderingKey: 'legacy-visible-capability-lane',
          requiredWorkerCapability: DETACHED,
        });
        const successor = await f.enqueue({
          user,
          orderingKey: 'legacy-visible-capability-lane',
          deliveryKey: 'ordinary-after-shielded-capability',
        });

        const oldClaim = await f.claim({ workerId: 'old-worker', claimToken: 'old-claim' });
        expect(oldClaim).toMatchObject({ id: successor.delivery.id });
        await expect(store().findEarlierAgentTriggerDelivery(successor.delivery)).resolves.toEqual({
          availableAt: START,
        });
        const recheckAt = f.at(5 * SECOND);
        await expect(
          store().releaseAgentTriggerDelivery({
            id: successor.delivery.id,
            workerId: 'old-worker',
            claimToken: 'old-claim',
            availableAt: recheckAt,
          }),
        ).resolves.toBe(true);
        await expect(store().countActiveAgentTriggerDeliveriesByUser(user, START)).resolves.toBe(0);

        const capable = await f.claimAndBegin({
          workerId: 'capable-worker',
          claimToken: 'capable-claim',
          workerCapabilities: [DETACHED],
        });
        expect(capable.claim).toMatchObject({ id: queued.delivery.id });
        await expect(store().countActiveAgentTriggerDeliveriesByUser(user, START)).resolves.toBe(1);
        await store().deadLetterAgentTriggerDelivery({
          ...capable.fence,
          attempt: capable.attempt,
          error: f.failure(),
          settledAt: START,
        });
        await expect(
          f.claim({ now: recheckAt, workerCapabilities: [DETACHED], claimToken: 'successor' }),
        ).resolves.toMatchObject({ id: successor.delivery.id });
      });

      it.each([DETACHED, AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2])(
        'keeps %s fenced through lease recovery, dead letter and requeue',
        async (capability) => {
          const queued = await f.enqueue({ requiredWorkerCapability: capability });
          expect(queued.delivery).toMatchObject({
            status: 'capability_pending',
            requiredWorkerCapability: capability,
          });
          const old = [AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1];
          await expect(f.claim({ workerCapabilities: old })).resolves.toBeNull();
          const capable = await f.claim({ workerCapabilities: [capability] });
          expect(capable).toMatchObject({ status: 'capability_leased' });

          /** Lease expiry: only a capable worker may recover it. */
          await f.patchDelivery(queued.delivery.id, { capabilityLeaseUntil: f.at(-MINUTE) });
          const recoveryNow = f.at(MINUTE);
          await expect(
            f.claim({ now: recoveryNow, workerCapabilities: old, claimToken: 'old-recovery' }),
          ).resolves.toBeNull();
          const recovered = await f.claimAndBegin({
            workerId: 'capable-worker-2',
            claimToken: 'capable-recovery',
            now: recoveryNow,
            workerCapabilities: [capability],
          });
          expect(recovered.attempt).toBe(1);
          await expect(
            store().deadLetterAgentTriggerDelivery({
              ...recovered.fence,
              attempt: 1,
              error: f.failure({ attemptedAt: recoveryNow }),
              settledAt: recoveryNow,
            }),
          ).resolves.toBe(true);
          expect(await f.raw(queued.delivery.id)).toMatchObject({
            status: 'capability_dead',
            capabilityStatus: 'dead',
          });

          const [deadLetter] = await store().getAgentTriggerDeadLetters();
          expect(deadLetter).toMatchObject({ id: queued.delivery.id, status: 'capability_dead' });
          await expect(
            store().requeueAgentTriggerDelivery(queued.delivery.id, recoveryNow),
          ).resolves.toMatchObject({ status: 'capability_pending' });
          await expect(
            f.claim({ now: recoveryNow, workerCapabilities: old, claimToken: 'old-requeue' }),
          ).resolves.toBeNull();
          const final = await f.claimAndBegin({
            workerId: 'capable-worker-3',
            claimToken: 'capable-final',
            now: recoveryNow,
            workerCapabilities: [capability],
          });
          await expect(
            store().completeAgentTriggerDelivery({
              ...final.fence,
              attempt: final.attempt,
              result: { status: 'complete' },
              settledAt: recoveryNow,
            }),
          ).resolves.toBe(true);
        },
      );

      it('claims the oldest due delivery whether or not it needs a capability', async () => {
        const ordinary = await f.enqueue({
          deliveryKey: 'ordinary-older',
          orderingKey: 'lane-a',
          availableAt: f.at(-2 * SECOND),
        });
        const capability = await f.enqueue({
          deliveryKey: 'capability-newer',
          orderingKey: 'lane-b',
          availableAt: f.at(-SECOND),
          requiredWorkerCapability: DETACHED,
        });
        await expect(f.claim({ workerCapabilities: [DETACHED] })).resolves.toMatchObject({
          id: ordinary.delivery.id,
          status: 'leased',
        });
        await expect(
          f.claim({ workerCapabilities: [DETACHED], claimToken: 'claim-2' }),
        ).resolves.toMatchObject({ id: capability.delivery.id, status: 'capability_leased' });
      });

      it('claims older capability work before newer ordinary work', async () => {
        const capability = await f.enqueue({
          deliveryKey: 'capability-older',
          orderingKey: 'lane-a',
          availableAt: f.at(-2 * SECOND),
          requiredWorkerCapability: DETACHED,
        });
        await f.enqueue({
          deliveryKey: 'ordinary-newer',
          orderingKey: 'lane-b',
          availableAt: f.at(-SECOND),
        });
        await expect(f.claim({ workerCapabilities: [DETACHED] })).resolves.toMatchObject({
          id: capability.delivery.id,
          status: 'capability_leased',
        });
      });

      it('claims a legacy row without a claim timestamp before every newer row', async () => {
        /** Old rows omit `claimAvailableAt`, and they sort first (a missing value before any
         * date), whatever their `availableAt`. */
        const fresh = await f.enqueue({ orderingKey: 'fresh-lane', availableAt: f.at(-MINUTE) });
        const legacy = await f.seedDelivery({
          orderingKey: 'legacy-lane',
          availableAt: START,
          createdAt: f.at(SECOND),
        });
        await expect(f.claim()).resolves.toMatchObject({ id: legacy });
        await expect(f.claim({ claimToken: 'claim-2' })).resolves.toMatchObject({
          id: fresh.delivery.id,
        });
      });

      it('breaks claim-time ties by creation time', async () => {
        const second = await f.seedDelivery({
          orderingKey: 'tie-b',
          claimAvailableAt: START,
          createdAt: f.at(2 * SECOND),
        });
        const first = await f.seedDelivery({
          orderingKey: 'tie-a',
          claimAvailableAt: START,
          createdAt: f.at(SECOND),
        });
        await expect(f.claim()).resolves.toMatchObject({ id: first });
        await expect(f.claim({ claimToken: 'claim-2' })).resolves.toMatchObject({ id: second });
      });

      it('adopts a dead capability delivery a pre-shield replica requeued', async () => {
        const queued = await f.enqueue({
          orderingKey: 'legacy-requeued-dead-capability',
          requiredWorkerCapability: DETACHED,
        });
        await f.kill({ workerCapabilities: [DETACHED] });
        const requeueAt = f.at(SECOND);
        /** What the pre-shield requeue leaves: it republishes `capability_pending` and does
         * not know the private lifecycle must be reset too. */
        await f.patchDelivery(queued.delivery.id, (row) => ({
          status: 'capability_pending',
          availableAt: requeueAt,
          settledAt: undefined,
          lastError: undefined,
          requeueCount: (row.requeueCount as number) + 1,
        }));

        const reclaimed = await f.claim({
          now: requeueAt,
          workerCapabilities: [DETACHED],
          claimToken: 'claim-after-legacy-requeue',
        });
        expect(reclaimed).toMatchObject({ id: queued.delivery.id, status: 'capability_leased' });
        const row = await f.raw(queued.delivery.id);
        expect(row).toMatchObject({ status: 'leased', capabilityStatus: 'leased' });
        expect(timeOf(row?.claimAvailableAt)).toBe(requeueAt.getTime());
      });

      it('refuses an empty or oversized capability name', async () => {
        await expect(f.claim({ workerCapabilities: [''] })).rejects.toBeInstanceOf(TypeError);
        await expect(f.claim({ workerCapabilities: ['x'.repeat(129)] })).rejects.toBeInstanceOf(
          TypeError,
        );
      });
    });

    /* ------------------------------------------------------------------ lane order */

    describe('findEarlierAgentTriggerDelivery', () => {
      it('reports the unsettled earlier delivery that blocks a due one', async () => {
        const first = await f.enqueue({ availableAt: f.at(MINUTE) });
        const second = await f.enqueue();
        const claimed = await f.claim();
        expect(claimed?.id).toBe(second.delivery.id);
        await expect(store().findEarlierAgentTriggerDelivery(claimed!)).resolves.toEqual({
          availableAt: f.at(MINUTE),
        });
        await expect(store().findEarlierAgentTriggerDelivery(first.delivery)).resolves.toBeNull();
      });

      it('reports the lease of a leased earlier delivery', async () => {
        await f.enqueue({ orderingKey: 'leased-lane' });
        await f.claim({ leaseUntil: f.at(MINUTE) });
        const second = await f.enqueue({ orderingKey: 'leased-lane' });
        await expect(store().findEarlierAgentTriggerDelivery(second.delivery)).resolves.toEqual({
          availableAt: START,
          leaseUntil: f.at(MINUTE),
        });
      });

      it('orders a lane by its sequence, not by tied timestamps or ids', async () => {
        await f.seedDelivery({
          _id: 'ffffffffffffffffffffffff',
          orderingKey: 'tied-lane',
          laneSequence: 1,
        });
        await f.seedDelivery({
          _id: '000000000000000000000001',
          orderingKey: 'tied-lane',
          laneSequence: 2,
        });
        await expect(
          store().findEarlierAgentTriggerDelivery({ orderingKey: 'tied-lane', laneSequence: 2 }),
        ).resolves.toEqual({ availableAt: START });
        await expect(
          store().findEarlierAgentTriggerDelivery({ orderingKey: 'tied-lane', laneSequence: 1 }),
        ).resolves.toBeNull();
      });

      it('lets a settled or dead earlier delivery stop blocking', async () => {
        await f.enqueue({ orderingKey: 'settled-lane' });
        await f.deliver();
        await f.enqueue({ orderingKey: 'settled-lane' });
        await f.kill({ claimToken: 'claim-2' });
        const third = await f.enqueue({ orderingKey: 'settled-lane' });
        await expect(store().findEarlierAgentTriggerDelivery(third.delivery)).resolves.toBeNull();
      });

      it('keeps a privately dead capability delivery from blocking old and new workers', async () => {
        await f.enqueue({
          orderingKey: 'dead-capability-lane',
          requiredWorkerCapability: DETACHED,
        });
        await f.kill({ workerCapabilities: [DETACHED] });
        const successor = await f.enqueue({ orderingKey: 'dead-capability-lane' });
        await expect(
          store().findEarlierAgentTriggerDelivery(successor.delivery),
        ).resolves.toBeNull();
        await expect(
          f.claim({ workerCapabilities: [DETACHED], claimToken: 'successor-claim' }),
        ).resolves.toMatchObject({ id: successor.delivery.id });
      });

      it('reports a leased capability delivery by its private lease', async () => {
        await f.enqueue({ orderingKey: 'capability-lane', requiredWorkerCapability: DETACHED });
        await f.claim({ workerCapabilities: [DETACHED], leaseUntil: f.at(2 * MINUTE) });
        const successor = await f.enqueue({ orderingKey: 'capability-lane' });
        await expect(store().findEarlierAgentTriggerDelivery(successor.delivery)).resolves.toEqual({
          availableAt: START,
          leaseUntil: f.at(2 * MINUTE),
        });
      });
    });

    /* ------------------------------------------------------------------ attempts */

    describe('releaseAgentTriggerDelivery', () => {
      it('releases only under the live claim, without consuming an attempt', async () => {
        const queued = await f.enqueue();
        const claimed = (await f.claim())!;
        const fence = { id: claimed.id, workerId: 'worker-1', claimToken: 'claim-1' };
        await expect(
          store().releaseAgentTriggerDelivery({
            ...fence,
            claimToken: 'stale',
            availableAt: f.at(MINUTE),
          }),
        ).resolves.toBe(false);
        await expect(
          store().releaseAgentTriggerDelivery({
            ...fence,
            workerId: 'worker-2',
            availableAt: START,
          }),
        ).resolves.toBe(false);
        await expect(
          store().releaseAgentTriggerDelivery({ ...fence, availableAt: f.at(MINUTE) }),
        ).resolves.toBe(true);
        await expect(
          store().releaseAgentTriggerDelivery({ ...fence, availableAt: START }),
        ).resolves.toBe(false);

        const released = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(released).toMatchObject({ status: 'pending', attempts: 0 });
        expect(timeOf(released?.availableAt)).toBe(f.at(MINUTE).getTime());
        expect(released).not.toHaveProperty('claimToken');
        await expect(f.claim({ claimToken: 'early' })).resolves.toBeNull();
        await expect(f.claim({ claimToken: 'due', now: f.at(MINUTE) })).resolves.toMatchObject({
          id: queued.delivery.id,
        });
      });
    });

    describe('beginAgentTriggerDeliveryAttempt', () => {
      it('numbers attempts under the live claim and refuses a lost one', async () => {
        await f.enqueue();
        const claimed = (await f.claim())!;
        const fence = { id: claimed.id, workerId: 'worker-1', claimToken: 'claim-1' };
        await expect(
          store().beginAgentTriggerDeliveryAttempt({ ...fence, claimToken: 'stale', now: START }),
        ).resolves.toBeNull();
        await expect(
          store().beginAgentTriggerDeliveryAttempt({ ...fence, now: START }),
        ).resolves.toBe(1);
        await expect(
          store().beginAgentTriggerDeliveryAttempt({ ...fence, now: START }),
        ).resolves.toBe(2);
        expect((await f.raw(claimed.id))?.attempts).toBe(2);
      });

      it('refuses an attempt once another worker took the expired lease over', async () => {
        await f.enqueue();
        const first = (await f.claim({ leaseUntil: f.at(10 * SECOND) }))!;
        const second = (await f.claim({ claimToken: 'claim-2', now: f.at(41 * SECOND) }))!;
        expect(second.id).toBe(first.id);
        await expect(
          store().completeAgentTriggerDelivery({
            id: first.id,
            workerId: 'worker-1',
            claimToken: 'claim-1',
            attempt: 1,
            result: { conversationId: 'stale' },
            settledAt: START,
          }),
        ).resolves.toBe(false);
        await expect(
          store().beginAgentTriggerDeliveryAttempt({
            id: first.id,
            workerId: 'worker-1',
            claimToken: 'claim-1',
            now: f.at(41 * SECOND),
          }),
        ).resolves.toBeNull();
        await expect(
          store().beginAgentTriggerDeliveryAttempt({
            id: second.id,
            workerId: 'worker-1',
            claimToken: 'claim-2',
            now: f.at(41 * SECOND),
          }),
        ).resolves.toBe(1);
      });
    });

    describe('deferAgentTriggerDeliveryAttempt', () => {
      it('gives the consumed attempt back and makes the delivery due later', async () => {
        const queued = await f.enqueue();
        const begun = await f.claimAndBegin();
        await expect(
          store().deferAgentTriggerDeliveryAttempt({
            ...begun.fence,
            attempt: begun.attempt + 1,
            availableAt: f.at(5 * SECOND),
          }),
        ).resolves.toBe(false);
        await expect(
          store().deferAgentTriggerDeliveryAttempt({
            ...begun.fence,
            attempt: begun.attempt,
            availableAt: f.at(5 * SECOND),
          }),
        ).resolves.toBe(true);
        const deferred = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(deferred).toMatchObject({ status: 'pending', attempts: 0 });
        expect(timeOf(deferred?.availableAt)).toBe(f.at(5 * SECOND).getTime());
        await expect(
          store().deferAgentTriggerDeliveryAttempt({
            ...begun.fence,
            attempt: begun.attempt,
            availableAt: f.at(5 * SECOND),
          }),
        ).resolves.toBe(false);
      });
    });

    describe('completeAgentTriggerDelivery and retryAgentTriggerDelivery', () => {
      it('records retry and success outcomes and expires only the successful row', async () => {
        const queued = await f.enqueue();
        const first = await f.claimAndBegin();
        await expect(
          store().retryAgentTriggerDelivery({
            ...first.fence,
            attempt: first.attempt,
            error: f.failure(),
            availableAt: f.at(SECOND),
          }),
        ).resolves.toBe(true);
        const retried = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(retried).toMatchObject({
          status: 'pending',
          attempts: 1,
          lastError: { code: 'RATE_LIMITED', retryable: true, status: 429 },
          history: [{ attempt: 1, outcome: 'retry', workerId: 'worker-1' }],
        });
        expect(retried).not.toHaveProperty('expiresAt');
        expect(timeOf(retried?.availableAt)).toBe(f.at(SECOND).getTime());

        const second = await f.claimAndBegin({
          workerId: 'worker-2',
          claimToken: 'claim-2',
          now: f.at(SECOND),
        });
        expect(second.attempt).toBe(2);
        await expect(
          store().completeAgentTriggerDelivery({
            ...second.fence,
            attempt: second.attempt,
            result: { conversationId: 'conversation-1' },
            settledAt: f.at(2 * SECOND),
          }),
        ).resolves.toBe(true);

        const stored = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(stored).toMatchObject({
          status: 'succeeded',
          attempts: 2,
          result: { conversationId: 'conversation-1' },
          history: [
            { attempt: 1, outcome: 'retry', workerId: 'worker-1' },
            { attempt: 2, outcome: 'succeeded', workerId: 'worker-2' },
          ],
        });
        expect(timeOf(stored?.history?.[0].at)).toBe(START.getTime());
        expect(stored?.history?.[0].error).toMatchObject({ code: 'RATE_LIMITED' });
        expect(stored).not.toHaveProperty('lastError');
        expect(stored).not.toHaveProperty('claimToken');
        expect(timeOf(stored?.settledAt)).toBe(f.at(2 * SECOND).getTime());
        expect(timeOf(stored?.expiresAt)).toBe(f.at(2 * SECOND).getTime() + SUCCESS_RETENTION_MS);
      });

      it('fences settlement on the claim, once, and records the attempt as given', async () => {
        await f.enqueue();
        const begun = await f.claimAndBegin();
        const input = {
          ...begun.fence,
          attempt: begun.attempt,
          result: { ok: true },
          settledAt: START,
        };
        await expect(
          store().completeAgentTriggerDelivery({ ...input, claimToken: 'stale' }),
        ).resolves.toBe(false);
        await expect(
          store().completeAgentTriggerDelivery({ ...input, workerId: 'worker-2' }),
        ).resolves.toBe(false);
        await expect(
          store().retryAgentTriggerDelivery({
            ...begun.fence,
            attempt: begun.attempt,
            error: f.failure(),
            availableAt: START,
            claimToken: 'stale',
          }),
        ).resolves.toBe(false);
        /** NOTE(contract): the settlements fence on the claim only, not on `attempt` (the port
         * header says "and, where given, its `attempt`"): a mismatched attempt settles and is
         * recorded in the history as given, while `attempts` keeps the begun count. */
        await expect(
          store().completeAgentTriggerDelivery({ ...input, attempt: begun.attempt + 1 }),
        ).resolves.toBe(true);
        await expect(store().completeAgentTriggerDelivery(input)).resolves.toBe(false);
        await expect(
          store().retryAgentTriggerDelivery({
            ...begun.fence,
            attempt: begun.attempt,
            error: f.failure(),
            availableAt: START,
          }),
        ).resolves.toBe(false);
        await expect(
          store().deadLetterAgentTriggerDelivery({
            ...begun.fence,
            attempt: begun.attempt,
            error: f.failure(),
            settledAt: START,
          }),
        ).resolves.toBe(false);
        expect((await f.deliveries())[0]).toMatchObject({
          status: 'succeeded',
          attempts: 1,
          history: [{ attempt: 2, outcome: 'succeeded', workerId: 'worker-1' }],
        });
      });

      it('caps the history at the newest 64 attempts', async () => {
        const queued = await f.enqueue();
        for (let attempt = 1; attempt <= 66; attempt += 1) {
          const now = f.at(attempt * SECOND);
          const begun = await f.claimAndBegin({ claimToken: `claim-${attempt}`, now });
          expect(begun.attempt).toBe(attempt);
          await store().retryAgentTriggerDelivery({
            ...begun.fence,
            attempt: begun.attempt,
            error: f.failure({ attemptedAt: now }),
            availableAt: now,
          });
        }
        const stored = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(stored?.history).toHaveLength(64);
        expect(stored?.history?.[0].attempt).toBe(3);
        expect(stored?.history?.[63].attempt).toBe(66);
      });

      it('reclaims the lane counter once the lane tail succeeds', async () => {
        await f.enqueue({ orderingKey: 'one-shot-resource-lane' });
        expect(await f.lane('one-shot-resource-lane')).toBeDefined();
        await f.deliver();
        expect(await f.lane('one-shot-resource-lane')).toBeUndefined();
        expect((await f.deliveries())[0]).not.toHaveProperty('laneCleanupPendingAt');
      });

      it('keeps the lane counter while a later delivery of the lane is unsettled', async () => {
        await f.enqueue({ orderingKey: 'busy-lane', availableAt: START });
        await f.enqueue({ orderingKey: 'busy-lane', availableAt: f.at(MINUTE) });
        await f.deliver();
        expect(await f.lane('busy-lane')).toMatchObject({ value: 2 });
      });
    });

    describe('deadLetterAgentTriggerDelivery', () => {
      it('retains dead letters, truncates failure text and unblocks the lane', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({ user, orderingKey: 'dead-letter-lane' });
        const begun = await f.claimAndBegin();
        await expect(
          store().deadLetterAgentTriggerDelivery({
            ...begun.fence,
            attempt: begun.attempt,
            error: f.failure({
              code: 'X'.repeat(256),
              message: 'x'.repeat(3_000),
              retryable: false,
            }),
            settledAt: START,
          }),
        ).resolves.toBe(true);

        const [dead] = await store().getAgentTriggerDeadLetters();
        expect(dead).toMatchObject({
          id: queued.delivery.id,
          status: 'dead',
          attempts: 1,
          history: [{ attempt: 1, outcome: 'dead', workerId: 'worker-1' }],
        });
        expect(dead.lastError?.code).toHaveLength(128);
        expect(dead.lastError?.message).toHaveLength(2048);
        expect(timeOf(dead.settledAt)).toBe(START.getTime());
        expect(dead.expiresAt).toBeUndefined();

        const later = await f.enqueue({ user, orderingKey: 'dead-letter-lane' });
        await expect(f.claim({ claimToken: 'claim-2' })).resolves.toMatchObject({
          id: later.delivery.id,
        });
      });

      it('expires a dead letter at its retention deadline when one is given', async () => {
        const queued = await f.enqueue();
        const expiresAt = f.at(30 * 24 * 60 * MINUTE);
        await f.kill({ expiresAt });
        const row = await f.raw(queued.delivery.id);
        expect(row?.status).toBe('dead');
        expect(timeOf(row?.expiresAt)).toBe(expiresAt.getTime());
      });
    });

    /* ------------------------------------------------------------------ reads */

    describe('getAgentTriggerDelivery', () => {
      it('reads a delivery by key, without its private fields', async () => {
        await expect(store().getAgentTriggerDelivery('missing')).resolves.toBeNull();
        const queued = await f.enqueue({
          requiredWorkerCapability: RECEIPT_V2,
          producerLeaseUntil: f.at(MINUTE),
        });
        const read = await store().getAgentTriggerDelivery(queued.delivery.deliveryKey);
        expect(read).toMatchObject({ id: queued.delivery.id, status: 'capability_pending' });
        for (const key of [
          'producerLeaseUntil',
          'backgroundToolResult',
          'backgroundToolResultBatch',
          'actorDetachedAction',
          'actorActionAdmittedAt',
          'capabilityStatus',
          'claimAvailableAt',
          'stagingRecoveryAt',
        ]) {
          expect(read).not.toHaveProperty(key);
        }
      });

      it('reports legacy success over stale private dead state', async () => {
        const queued = await f.enqueue({
          orderingKey: 'legacy-completed-dead-capability',
          requiredWorkerCapability: DETACHED,
        });
        await f.kill({ workerCapabilities: [DETACHED] });
        /** A pre-shield worker requeued and finished it: the outer lifecycle succeeded while the
         * private one is still `dead`. */
        await f.patchDelivery(queued.delivery.id, {
          status: 'succeeded',
          attempts: 2,
          result: { status: 'legacy-complete' },
          settledAt: f.at(2 * SECOND),
          lastError: undefined,
          leaseBy: undefined,
          leaseUntil: undefined,
          claimToken: undefined,
        });
        await expect(
          store().getAgentTriggerDelivery(queued.delivery.deliveryKey),
        ).resolves.toMatchObject({ status: 'succeeded', result: { status: 'legacy-complete' } });
        expect(await store().getAgentTriggerDeadLetters()).toEqual([]);
      });
    });

    describe('getAgentTriggerDeliveryStatus', () => {
      it('projects the public status for the exact owner, API key and tenant', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          envelope: { event: { source: REMOTE_SOURCE }, privatePayload: 'x'.repeat(1024) },
        });
        const status = await store().getAgentTriggerDeliveryStatus(
          queued.delivery.deliveryKey,
          user,
          REMOTE_SOURCE.id,
          'tenant-1',
        );
        expect(status).toEqual({
          deliveryKey: queued.delivery.deliveryKey,
          status: 'pending',
          attempts: 0,
          availableAt: START,
          createdAt: expect.any(Date),
        });
        await expect(
          store().getAgentTriggerDeliveryStatus(
            queued.delivery.deliveryKey,
            f.storeId(user),
            REMOTE_SOURCE.id,
            'tenant-1',
          ),
        ).resolves.toMatchObject({ status: 'pending' });
        for (const [owner, source, tenantId] of [
          [f.newUser(), REMOTE_SOURCE.id, 'tenant-1'],
          [user, 'source-key-2', 'tenant-1'],
          [user, REMOTE_SOURCE.id, 'tenant-2'],
        ]) {
          await expect(
            store().getAgentTriggerDeliveryStatus(
              queued.delivery.deliveryKey,
              owner,
              source,
              tenantId,
            ),
          ).resolves.toBeNull();
        }

        const internal = await f.enqueue({
          user,
          envelope: { event: { source: { id: REMOTE_SOURCE.id, type: 'schedule' } } },
        });
        await expect(
          store().getAgentTriggerDeliveryStatus(
            internal.delivery.deliveryKey,
            user,
            REMOTE_SOURCE.id,
            'tenant-1',
          ),
        ).resolves.toBeNull();
        await expect(
          store().getAgentTriggerDeliveryStatus(
            queued.delivery.deliveryKey,
            user,
            REMOTE_SOURCE.id,
          ),
        ).resolves.toBeNull();
      });

      it('shows an untenanted delivery to a read with or without a tenant', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          tenantId: undefined,
          envelope: { event: { source: REMOTE_SOURCE } },
        });
        for (const tenantId of [undefined, 'tenant-1', 'tenant-2']) {
          await expect(
            store().getAgentTriggerDeliveryStatus(
              queued.delivery.deliveryKey,
              user,
              REMOTE_SOURCE.id,
              tenantId,
            ),
          ).resolves.toMatchObject({ deliveryKey: queued.delivery.deliveryKey, status: 'pending' });
        }
      });

      it('reports the settled result, error and handling, and nothing private', async () => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          envelope: { event: { source: REMOTE_SOURCE } },
        });
        const begun = await f.claimAndBegin();
        await store().retryAgentTriggerDelivery({
          ...begun.fence,
          attempt: begun.attempt,
          error: f.failure(),
          availableAt: START,
        });
        const retrying = await store().getAgentTriggerDeliveryStatus(
          queued.delivery.deliveryKey,
          user,
          REMOTE_SOURCE.id,
          'tenant-1',
        );
        expect(retrying).toMatchObject({
          status: 'pending',
          attempts: 1,
          lastError: { code: 'RATE_LIMITED' },
        });
        await f.deliver({
          claimToken: 'claim-2',
          result: { status: 'started' },
          settledAt: f.at(SECOND),
          handling: {
            status: 'started',
            conversationId: 'conversation-1',
            streamId: 'conversation-1',
            generationCreatedAt: 1_787_000_000_000,
            startedAt: f.at(SECOND),
          },
        });
        const settled = await store().getAgentTriggerDeliveryStatus(
          queued.delivery.deliveryKey,
          user,
          REMOTE_SOURCE.id,
          'tenant-1',
        );
        expect(settled).toMatchObject({
          status: 'succeeded',
          attempts: 2,
          result: { status: 'started' },
          handling: { status: 'started', conversationId: 'conversation-1' },
        });
        expect(timeOf(settled?.settledAt)).toBe(f.at(SECOND).getTime());
        expect(Object.keys(settled ?? {}).sort()).toEqual(
          [
            'attempts',
            'availableAt',
            'createdAt',
            'deliveryKey',
            'handling',
            'result',
            'settledAt',
            'status',
          ].sort(),
        );
      });
    });

    describe('getAgentTriggerDeadLetters', () => {
      it('lists dead deliveries most recently updated first, up to the limit', async () => {
        const keys: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const queued = await f.enqueue({ orderingKey: `dead-${index}` });
          keys.push(queued.delivery.deliveryKey);
          await f.kill({ claimToken: `claim-${index}` });
        }
        await f.enqueue({ orderingKey: 'alive' });
        await f.patchDelivery(keys[0], { updatedAt: f.at(3 * MINUTE) });
        await f.patchDelivery(keys[1], { updatedAt: f.at(MINUTE) });
        await f.patchDelivery(keys[2], { updatedAt: f.at(2 * MINUTE) });

        expect((await store().getAgentTriggerDeadLetters()).map((row) => row.deliveryKey)).toEqual([
          keys[0],
          keys[2],
          keys[1],
        ]);
        expect((await store().getAgentTriggerDeadLetters(2)).map((row) => row.deliveryKey)).toEqual(
          [keys[0], keys[2]],
        );
      });

      it('refuses a limit that is not a positive integer and caps it at 200', async () => {
        for (const limit of [Number.NaN, 0, -1, 1.5]) {
          await expect(store().getAgentTriggerDeadLetters(limit)).rejects.toThrow(
            'Agent trigger dead-letter limit must be a positive integer',
          );
        }
        await harness.seedRaw(
          DELIVERIES,
          Array.from({ length: 205 }, (_, index) => ({
            _id: harness.ids.generate(),
            deliveryKey: `dead-${index}`,
            fingerprint: `dead-${index}`,
            orderingKey: `dead-${index}`,
            laneSequence: 1,
            envelope: {},
            user: harness.ids.generate(),
            status: 'dead',
            attempts: 1,
            availableAt: START,
            createdAt: START,
            updatedAt: f.at(index),
          })),
        );
        const listed = await store().getAgentTriggerDeadLetters(500);
        expect(listed).toHaveLength(200);
        expect(listed[0].deliveryKey).toBe('dead-204');
        expect(await store().getAgentTriggerDeadLetters()).toHaveLength(50);
      });
    });

    describe('requeueAgentTriggerDelivery', () => {
      it('republishes a dead letter at the lane tail after the lane catches up', async () => {
        const user = f.newUser();
        const orderingKey = 'dead-letter-requeue';
        const queued = await f.enqueue({ user, orderingKey });
        await f.kill();
        const later = await f.enqueue({ user, orderingKey });
        await f.claim({ workerId: 'worker-2', claimToken: 'claim-2', leaseUntil: f.at(MINUTE) });
        const stagedAhead = await f.seedStaging({ user, orderingKey }, { updatedAt: new Date(0) });

        const requeued = await store().requeueAgentTriggerDelivery(queued.delivery.id, START);
        expect(requeued).toMatchObject({
          id: queued.delivery.id,
          status: 'pending',
          attempts: 0,
          requeueCount: 1,
          laneSequence: 4,
        });
        expect(requeued?.lastError).toBeUndefined();
        expect(requeued?.settledAt).toBeUndefined();
        expect(await f.raw(stagedAhead)).toMatchObject({ status: 'pending', laneSequence: 3 });
        await expect(store().findEarlierAgentTriggerDelivery(requeued!)).resolves.toEqual({
          availableAt: START,
          leaseUntil: f.at(MINUTE),
        });
        expect(later.delivery.laneSequence).toBe(2);
        expect(await store().getAgentTriggerDeadLetters()).toEqual([]);
      });

      it('clears the dead-letter deadline and refuses anything not dead', async () => {
        const queued = await f.enqueue();
        await expect(
          store().requeueAgentTriggerDelivery(queued.delivery.id, START),
        ).resolves.toBeNull();
        await f.kill({ expiresAt: f.at(DAY) });
        const requeued = await store().requeueAgentTriggerDelivery(
          queued.delivery.id,
          f.at(SECOND),
        );
        expect(requeued).toMatchObject({ status: 'pending' });
        expect(timeOf(requeued?.availableAt)).toBe(f.at(SECOND).getTime());
        const row = await f.raw(queued.delivery.id);
        expect(row).not.toHaveProperty('expiresAt');
        await expect(
          store().requeueAgentTriggerDelivery(queued.delivery.id, START),
        ).resolves.toBeNull();
        await expect(
          store().requeueAgentTriggerDelivery(harness.ids.generate(), START),
        ).resolves.toBeNull();
      });

      it.each([
        ['applied', { status: 'applied', settledAt: START, action: { toolName: 'submit_move' } }],
        ['started', {}],
      ] as const)(
        'does not requeue a legacy dead delivery whose handling is %s',
        async (handlingStatus, handling) => {
          const queued = await f.enqueue();
          const stored = {
            status: handlingStatus,
            conversationId: 'legacy-conversation',
            streamId: 'legacy-conversation',
            generationCreatedAt: START.getTime(),
            startedAt: START,
            ...handling,
          };
          await f.patchDelivery(queued.delivery.id, { status: 'dead', handling: stored });
          await expect(
            store().requeueAgentTriggerDelivery(queued.delivery.id, START),
          ).resolves.toBeNull();
          expect(await f.raw(queued.delivery.id)).toMatchObject({
            status: 'dead',
            handling: { status: handlingStatus },
          });
        },
      );
    });

    describe('countActiveAgentTriggerDeliveriesByUser', () => {
      it('counts live leases, open admissions and detached launch authority', async () => {
        const user = f.newUser();
        const leased = await f.enqueue({ user, orderingKey: 'count-a' });
        const detached = await f.enqueue({ user, orderingKey: 'count-b' });
        const admitted = await f.enqueue({ user, orderingKey: 'count-c' });
        await f.enqueue({ orderingKey: 'count-other-user' });
        await f.claim({ leaseUntil: f.at(MINUTE) });
        expect((await f.raw(leased.delivery.id))?.status).toBe('leased');
        await expect(store().countActiveAgentTriggerDeliveriesByUser(user, START)).resolves.toBe(1);

        await f.patchDelivery(detached.delivery.id, {
          status: 'succeeded',
          actorDetachedAction: {
            version: 1,
            invocationId: detached.delivery.deliveryKey,
            expectedToolName: 'submit_move',
            toolName: 'submit_move_mcp_chess',
            toolCallId: 'call-delete-drain',
            turnId: 'response-delete-drain:0',
            taskId: `event_actor_${'d'.repeat(64)}`,
            idempotencyKey: 'd'.repeat(64),
            launchAttempt: 0,
            status: 'running',
            reservedAt: START,
            observedAt: START,
            recoveryAfter: f.at(MINUTE),
            launchedAt: START,
          },
        });
        await f.patchDelivery(admitted.delivery.id, {
          status: 'succeeded',
          actorActionAdmittedAt: START,
          actorActionAdmissionId: 'admission-delete-drain',
        });
        await expect(store().countActiveAgentTriggerDeliveriesByUser(user, START)).resolves.toBe(3);
        await expect(
          store().countActiveAgentTriggerDeliveriesByUser(f.storeId(user), f.at(MINUTE + 1)),
        ).resolves.toBe(2);

        for (const [status, expected] of [
          ['launch_indeterminate', 2],
          ['reserved', 2],
          ['succeeded', 1],
        ] as const) {
          await f.patchDelivery(detached.delivery.id, (row) => ({
            actorDetachedAction: { ...(row.actorDetachedAction as object), status },
          }));
          await expect(
            store().countActiveAgentTriggerDeliveriesByUser(user, f.at(MINUTE + 1)),
          ).resolves.toBe(expected);
        }
        await f.patchDelivery(admitted.delivery.id, {
          actorActionAdmittedAt: undefined,
          actorActionAdmissionId: undefined,
        });
        await expect(
          store().countActiveAgentTriggerDeliveriesByUser(user, f.at(MINUTE + 1)),
        ).resolves.toBe(0);
      });

      it('counts a private capability lease whatever its deadline', async () => {
        const user = f.newUser();
        await f.enqueue({ user, requiredWorkerCapability: DETACHED });
        await f.claim({ workerCapabilities: [DETACHED], leaseUntil: f.at(MINUTE) });
        await expect(
          store().countActiveAgentTriggerDeliveriesByUser(user, f.at(10 * MINUTE)),
        ).resolves.toBe(1);
      });
    });
  });
}
