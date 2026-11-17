/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AgentQueuedTurnStore` contract (`~/ports/queuedTurn`), second part: claim and admission.
 * Ported from `methods/queuedTurn.spec.ts`, which stays unchanged: cancellation, the claim (one
 * admission slot per lane, the expected head, priority behind an existing claim, leases and their
 * expiry, claims across store instances), release, the admission (`started`, `already_started`,
 * the published-delivery fence, `retired` for a missing lane or an older lane generation,
 * `order_unavailable`) and its receipt, dead-lettering with the `ADMISSION_INDETERMINATE`
 * quarantine and exact-evidence reconciliation (protocol v2 waiting for the source receipt), the
 * reconciliation lease with its fair rotation through `defer`, and the effective predecessor
 * (lineage from the root through exact edges, scoped to one queue root, fail-closed on branches,
 * missing evidence and legacy rows unless inferred). The queue, delivery and deletion steps are in
 * `queuedTurn.contract.ts`, which lists what stays in the method spec. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import type { RawRecord, ContractHarness } from './harness';
import { readRawWhere, timeOf, useContractHarness } from './support';
import { START, LATER, after, rootLineageId, queuedTurnFixtures } from './queuedTurn.fixtures';

export function describeAgentQueuedTurnAdmissionContract(harness: ContractHarness): void {
  describe(`AgentQueuedTurnStore contract (claim and admission): ${harness.name}`, () => {
    useContractHarness(harness);

    const newId = () => harness.ids.generate();
    let user: string;

    beforeEach(() => {
      user = newId();
    });

    const {
      turns,
      scope,
      enqueue,
      claimInput,
      publish,
      startAdmission,
      admit,
      quarantine,
      storedTurn,
      rawTurn,
      seedTurns,
    } = queuedTurnFixtures(harness, () => user);

    /* ------------------------------------------------------------ claim and admission */

    describe('cancelAgentQueuedTurn', () => {
      it('cancels queued and claimed turns until their admission starts', async () => {
        const queued = await enqueue();
        const cancelled = await turns().cancelAgentQueuedTurn({
          ...scope(),
          queuedTurnId: queued.queuedTurnId,
          settledAt: START,
        });
        expect(cancelled).toMatchObject({
          outcome: 'cancelled',
          turn: {
            status: 'cancelled',
            deliveryState: 'retired',
            terminalReceipt: { outcome: 'cancelled' },
          },
        });
        expect(timeOf(cancelled.turn?.terminalReceipt?.settledAt)).toBe(START.getTime());
        expect(cancelled.turn).not.toHaveProperty('activeSlot');
        expect(
          await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: queued.queuedTurnId }),
        ).toMatchObject({ outcome: 'already_cancelled' });
        expect(await turns().claimNextAgentQueuedTurn(claimInput(queued.queuedTurnId))).toEqual({
          outcome: 'missing',
          claim: null,
        });

        const claimed = await enqueue({ clientRequestId: 'claimed' });
        await turns().claimNextAgentQueuedTurn(claimInput(claimed.queuedTurnId));
        const claimCancelled = await turns().cancelAgentQueuedTurn({
          ...scope(),
          conversationId: undefined,
          queuedTurnId: claimed.queuedTurnId,
        });
        expect(claimCancelled).toMatchObject({ outcome: 'cancelled' });
        for (const field of ['admissionSlot', 'claimId', 'claimBy', 'claimUntil']) {
          expect(claimCancelled.turn).not.toHaveProperty(field);
        }

        const admitting = await enqueue({ clientRequestId: 'admitting' });
        await startAdmission(admitting, 'admission-cancel');
        expect(
          await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: admitting.queuedTurnId }),
        ).toMatchObject({ outcome: 'not_cancellable', turn: { status: 'claimed' } });
      });

      it('keeps a reserved delivery’s state and refuses another scope', async () => {
        const turn = await enqueue();
        await turns().reserveAgentQueuedTurnDelivery({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: 'delivery-1',
        });
        expect(
          await turns().cancelAgentQueuedTurn({
            ...scope({ conversationId: 'conversation-2' }),
            queuedTurnId: turn.queuedTurnId,
          }),
        ).toEqual({ outcome: 'not_found', turn: null });
        expect(
          await turns().cancelAgentQueuedTurn({
            ...scope({ user: newId() }),
            queuedTurnId: turn.queuedTurnId,
          }),
        ).toEqual({ outcome: 'not_found', turn: null });
        expect(
          await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: turn.queuedTurnId }),
        ).toMatchObject({ outcome: 'cancelled', turn: { deliveryState: 'publishing' } });
      });
    });

    describe('claimNextAgentQueuedTurn', () => {
      it('claims the lane head, priority first, and replays the same live claim', async () => {
        const first = await enqueue({ clientRequestId: 'first' });
        const second = await enqueue({ clientRequestId: 'second' });
        const priority = await enqueue({ clientRequestId: 'priority', priority: true });
        expect(await turns().claimNextAgentQueuedTurn(claimInput(first.queuedTurnId))).toEqual({
          outcome: 'blocked',
          claim: null,
        });
        const acquired = await turns().claimNextAgentQueuedTurn(claimInput(priority.queuedTurnId));
        expect(acquired).toMatchObject({
          outcome: 'acquired',
          claim: {
            queuedTurnId: priority.queuedTurnId,
            status: 'claimed',
            admissionSlot: true,
            claimId: 'claim-1',
            claimBy: 'worker-1',
            attempts: 1,
          },
        });
        expect(timeOf(acquired.claim?.claimUntil)).toBe(LATER.getTime());
        expect(
          await turns().claimNextAgentQueuedTurn(claimInput(priority.queuedTurnId)),
        ).toMatchObject({ outcome: 'replayed', claim: { attempts: 1 } });
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(second.queuedTurnId, { claimId: 'other', claimBy: 'worker-2' }),
          ),
        ).toEqual({ outcome: 'blocked', claim: null });
      });

      it('serializes competing claims across store instances: one admission slot per lane', async () => {
        const normal = await enqueue({ clientRequestId: 'normal' });
        const priority = await enqueue({ clientRequestId: 'priority', priority: true });
        const [normalResult, priorityResult] = await Promise.all([
          turns().claimNextAgentQueuedTurn(claimInput(normal.queuedTurnId, { claimId: 'n' })),
          harness
            .createStores()
            .agentQueuedTurns.claimNextAgentQueuedTurn(
              claimInput(priority.queuedTurnId, { claimId: 'p', claimBy: 'worker-2' }),
            ),
        ]);
        expect(normalResult).toEqual({ outcome: 'blocked', claim: null });
        expect(priorityResult).toMatchObject({ outcome: 'acquired' });
        expect(
          (await harness.readRaw('agentqueuedturns')).filter((turn) => turn.status === 'claimed'),
        ).toHaveLength(1);
      });

      it('keeps later priority work behind an existing claim until it is released', async () => {
        const normal = await enqueue({ clientRequestId: 'claimed-first' });
        const normalClaim = claimInput(normal.queuedTurnId, { claimId: 'normal-owner' });
        await turns().claimNextAgentQueuedTurn(normalClaim);
        const priority = await enqueue({ clientRequestId: 'priority-after', priority: true });
        const priorityClaim = claimInput(priority.queuedTurnId, {
          claimId: 'priority-owner',
          claimBy: 'worker-2',
        });
        expect(await turns().claimNextAgentQueuedTurn(priorityClaim)).toEqual({
          outcome: 'blocked',
          claim: null,
        });
        await turns().releaseAgentQueuedTurn({
          ...normalClaim,
          disposition: 'dead',
          settledAt: START,
          failure: { code: 'TEST_SETTLED', message: 'Release the lane reservation' },
        });
        expect((await turns().claimNextAgentQueuedTurn(priorityClaim)).outcome).toBe('acquired');
      });

      it('reclaims an expired lease under a new identity, which still blocks the others', async () => {
        const turn = await enqueue();
        await turns().claimNextAgentQueuedTurn(
          claimInput(turn.queuedTurnId, { leaseUntil: after(1, START) }),
        );
        const priority = await enqueue({ clientRequestId: 'priority', priority: true });
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(turn.queuedTurnId, {
              claimId: 'claim-2',
              claimBy: 'worker-2',
              now: after(2, START),
            }),
          ),
        ).toMatchObject({ outcome: 'acquired', claim: { claimId: 'claim-2', attempts: 2 } });
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(priority.queuedTurnId, {
              claimId: 'priority-claim',
              claimBy: 'worker-3',
              now: after(2, START),
            }),
          ),
        ).toEqual({ outcome: 'blocked', claim: null });
        // The expired first claim does not replay.
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(turn.queuedTurnId, { now: after(2, START) }),
          ),
        ).toEqual({ outcome: 'blocked', claim: null });
      });

      it('keeps a dead turn at the lane head until the user dismisses it', async () => {
        const dead = await enqueue({ clientRequestId: 'dead-head' });
        const next = await enqueue({ clientRequestId: 'next' });
        await turns().claimNextAgentQueuedTurn(claimInput(dead.queuedTurnId));
        await turns().releaseAgentQueuedTurn({
          ...claimInput(dead.queuedTurnId),
          disposition: 'dead',
          settledAt: START,
          failure: { code: 'TEST_DEAD', message: 'dead at the head' },
        });
        const nextClaim = claimInput(next.queuedTurnId, { claimId: 'next' });
        expect(await turns().claimNextAgentQueuedTurn(nextClaim)).toEqual({
          outcome: 'blocked',
          claim: null,
        });
        expect(await turns().claimNextAgentQueuedTurn(claimInput(dead.queuedTurnId))).toEqual({
          outcome: 'missing',
          claim: null,
        });
        await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: dead.queuedTurnId });
        expect((await turns().claimNextAgentQueuedTurn(nextClaim)).outcome).toBe('acquired');
      });

      it('blocks a turn not yet available, and reports a missing turn or lane', async () => {
        const turn = await enqueue({ availableAt: LATER });
        expect(await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId))).toEqual({
          outcome: 'blocked',
          claim: null,
        });
        expect(
          (
            await turns().claimNextAgentQueuedTurn(
              claimInput(turn.queuedTurnId, { now: LATER, leaseUntil: after(60_000) }),
            )
          ).outcome,
        ).toBe('acquired');
        expect(await turns().claimNextAgentQueuedTurn(claimInput(newId()))).toEqual({
          outcome: 'missing',
          claim: null,
        });
        await seedTurns(
          rawTurn({ sequence: 1, laneId: 'lane-without-record', conversationId: 'orphan' }),
        );
        const [orphan] = await readRawWhere(harness, 'agentqueuedturns', {
          conversationId: 'orphan',
        });
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(orphan._id as string, { conversationId: 'orphan' }),
          ),
        ).toEqual({ outcome: 'missing', claim: null });
      });

      it('throws a TypeError for a lease that does not end after the claim', async () => {
        const turn = await enqueue();
        await expect(
          turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId, { leaseUntil: START })),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    describe('releaseAgentQueuedTurn', () => {
      it('returns a retry to the queue until it is available again', async () => {
        const turn = await enqueue();
        await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId));
        const released = await turns().releaseAgentQueuedTurn({
          ...claimInput(turn.queuedTurnId),
          disposition: 'retry',
          availableAt: LATER,
        });
        expect(released).toMatchObject({
          outcome: 'released',
          turn: { status: 'queued', attempts: 1 },
        });
        expect(timeOf(released.turn?.availableAt)).toBe(LATER.getTime());
        for (const field of ['admissionSlot', 'claimId', 'claimBy', 'claimUntil']) {
          expect(released.turn).not.toHaveProperty(field);
        }
        expect(released.turn?.activeSlot).toBe(turn.activeSlot);
        expect(
          (await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId))).outcome,
        ).toBe('blocked');
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(turn.queuedTurnId, { now: LATER, leaseUntil: after(1) }),
          ),
        ).toMatchObject({ outcome: 'acquired', claim: { attempts: 2 } });
      });

      it('settles a dead turn, freeing its slot, only through the exact claim fence', async () => {
        const turn = await enqueue();
        await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId));
        expect(
          await turns().releaseAgentQueuedTurn({
            ...claimInput(turn.queuedTurnId, { claimId: 'stale' }),
            disposition: 'retry',
            availableAt: LATER,
          }),
        ).toMatchObject({ outcome: 'conflict', turn: { status: 'claimed' } });
        const dead = await turns().releaseAgentQueuedTurn({
          ...claimInput(turn.queuedTurnId),
          disposition: 'dead',
          settledAt: START,
          failure: { code: ' BROKEN ', message: 'cannot continue' },
        });
        expect(dead).toMatchObject({
          outcome: 'dead',
          turn: {
            status: 'dead',
            terminalReceipt: {
              outcome: 'dead',
              failure: { code: 'BROKEN', message: 'cannot continue' },
            },
          },
        });
        expect(dead.turn).not.toHaveProperty('activeSlot');
        expect(
          await turns().releaseAgentQueuedTurn({
            ...claimInput(newId()),
            disposition: 'retry',
            availableAt: LATER,
          }),
        ).toEqual({ outcome: 'conflict', turn: null });
      });
    });

    describe('beginAgentQueuedTurnAdmission', () => {
      it('starts the admission at the lane root and replays it', async () => {
        const turn = await enqueue({ expectedPredecessorCreatedAt: 83 });
        const { claim, started } = await startAdmission(turn, 'admission-1');
        expect(started.turn).toMatchObject({
          status: 'claimed',
          admissionId: 'admission-1',
          admissionEffectivePredecessorCreatedAt: 83,
          admissionLineagePredecessorId: rootLineageId(),
        });
        expect(timeOf(started.turn?.admissionStartedAt)).toBe(START.getTime());
        expect(
          await turns().beginAgentQueuedTurnAdmission({
            ...claim,
            admissionId: 'admission-1',
            startedAt: LATER,
          }),
        ).toMatchObject({ outcome: 'already_started' });
      });

      it('conflicts until the delivery under the admission id is published', async () => {
        const turn = await enqueue();
        await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId));
        const begin = (admissionId: string) =>
          turns().beginAgentQueuedTurnAdmission({
            ...claimInput(turn.queuedTurnId),
            admissionId,
            startedAt: START,
          });
        expect(await begin('admission-1')).toMatchObject({ outcome: 'conflict' });
        await turns().reserveAgentQueuedTurnDelivery({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: 'admission-1',
        });
        expect(await begin('admission-1')).toMatchObject({ outcome: 'conflict' });
        await turns().markQueuedTurnScheduled({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: 'admission-1',
        });
        expect(await begin('admission-2')).toMatchObject({ outcome: 'conflict' });
        expect(
          await turns().beginAgentQueuedTurnAdmission({
            ...claimInput(turn.queuedTurnId, { claimId: 'stale' }),
            admissionId: 'admission-1',
            startedAt: START,
          }),
        ).toMatchObject({ outcome: 'conflict' });
        expect(await begin('admission-1')).toMatchObject({ outcome: 'started' });
      });

      it('retires a claimed turn whose lane is gone or of an older generation', async () => {
        const claimed = (extra: RawRecord) =>
          rawTurn({
            status: 'claimed',
            admissionSlot: true,
            claimId: 'claim-1',
            claimBy: 'worker-1',
            claimUntil: LATER,
            deliveryKey: 'delivery-old',
            deliveryState: 'published',
            ...extra,
          });
        const orphan = claimed({ conversationId: 'orphan', sequence: 1, laneId: 'lane-gone' });
        const current = await enqueue();
        const obsolete = claimed({
          sequence: 9,
          laneId: 'lane-old-generation',
          activeSlot: ((current.activeSlot ?? 0) + 1) % 100,
        });
        await seedTurns(orphan, obsolete);
        for (const [record, conversationId] of [
          [orphan, 'orphan'],
          [obsolete, 'conversation-1'],
        ] as const) {
          const result = await turns().beginAgentQueuedTurnAdmission({
            ...claimInput(record._id as string, { conversationId }),
            admissionId: 'delivery-old',
            startedAt: LATER,
          });
          expect(result).toMatchObject({
            outcome: 'retired',
            turn: {
              status: 'cancelled',
              terminalReceipt: { outcome: 'cancelled', failure: { code: 'LANE_RETIRED' } },
            },
          });
          expect(result.turn).not.toHaveProperty('admissionSlot');
        }
        expect(
          (await turns().claimNextAgentQueuedTurn(claimInput(current.queuedTurnId))).outcome,
        ).toBe('acquired');
      });

      it('settles the turn dead when its predecessor order cannot be established', async () => {
        const predecessor = await enqueue({ clientRequestId: 'predecessor' });
        await admit(predecessor, 'delivery-predecessor', undefined);
        const turn = await enqueue({ clientRequestId: 'successor' });
        await publish(turn, 'delivery-successor');
        const claim = claimInput(turn.queuedTurnId, { claimId: 'delivery-successor' });
        await turns().claimNextAgentQueuedTurn(claim);
        const result = await turns().beginAgentQueuedTurnAdmission({
          ...claim,
          admissionId: 'delivery-successor',
          startedAt: START,
        });
        expect(result).toMatchObject({
          outcome: 'order_unavailable',
          turn: {
            status: 'dead',
            terminalReceipt: {
              outcome: 'dead',
              failure: { code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE' },
            },
          },
        });
        expect(result.turn).not.toHaveProperty('admissionStartedAt');
      });
    });

    describe('markAgentQueuedTurnAdmitted and hasAgentQueuedTurnAdmissionReceipt', () => {
      it('admits the started turn once, with an exact receipt', async () => {
        const turn = await enqueue({ priority: true, expectedPredecessorCreatedAt: 83 });
        const { claim } = await startAdmission(turn, 'admission-1');
        const admission = {
          ...claim,
          admissionId: 'admission-1',
          admissionMode: 'ordinary' as const,
          generationId: 'generation-1',
          generationCreatedAt: 84,
          effectivePredecessorCreatedAt: 83,
          lineagePredecessorId: rootLineageId(),
          settledAt: START,
        };
        expect(
          await turns().markAgentQueuedTurnAdmitted({
            ...admission,
            effectivePredecessorCreatedAt: 82,
          }),
        ).toMatchObject({ outcome: 'conflict' });
        const admitted = await turns().markAgentQueuedTurnAdmitted(admission);
        expect(admitted).toMatchObject({
          outcome: 'admitted',
          turn: {
            status: 'admitted',
            deliveryState: 'published',
            terminalReceipt: {
              outcome: 'admitted',
              admissionId: 'admission-1',
              admissionMode: 'ordinary',
              generationId: 'generation-1',
              generationCreatedAt: 84,
              effectivePredecessorCreatedAt: 83,
              lineagePredecessorId: rootLineageId(),
            },
          },
        });
        for (const field of [
          'activeSlot',
          'admissionSlot',
          'claimId',
          'admissionId',
          'admissionStartedAt',
        ]) {
          expect(admitted.turn).not.toHaveProperty(field);
        }
        expect(await turns().markAgentQueuedTurnAdmitted(admission)).toMatchObject({
          outcome: 'already_admitted',
        });
        expect(
          await turns().markAgentQueuedTurnAdmitted({ ...admission, admissionId: 'different' }),
        ).toMatchObject({ outcome: 'conflict' });
        const receipt = {
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          admissionId: 'admission-1',
          generationId: 'generation-1',
          generationCreatedAt: 84,
          effectivePredecessorCreatedAt: 83,
        };
        expect(await turns().hasAgentQueuedTurnAdmissionReceipt(receipt)).toBe(true);
        expect(
          await turns().hasAgentQueuedTurnAdmissionReceipt({
            ...receipt,
            lineagePredecessorId: rootLineageId(),
          }),
        ).toBe(true);
        for (const changed of [
          { generationCreatedAt: 85 },
          { effectivePredecessorCreatedAt: 82 },
          { generationId: 'generation-2' },
          { admissionId: 'admission-2' },
          { lineagePredecessorId: 'other' },
          { tenantId: 'tenant-2' },
        ]) {
          expect(await turns().hasAgentQueuedTurnAdmissionReceipt({ ...receipt, ...changed })).toBe(
            false,
          );
        }
        await expect(
          turns().hasAgentQueuedTurnAdmissionReceipt({ ...receipt, generationCreatedAt: -1 }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('marks a root admission without an epoch as the lane root', async () => {
        const turn = await enqueue();
        const admitted = await admit(turn, 'admission-root', 42);
        expect(admitted?.terminalReceipt).toMatchObject({
          lineagePredecessorId: rootLineageId(),
          rootPredecessor: true,
        });
        expect(admitted?.terminalReceipt).not.toHaveProperty('effectivePredecessorCreatedAt');
      });
    });

    describe('deadLetterAgentQueuedTurn', () => {
      it('settles a turn dead before its admission, then reports it terminal', async () => {
        const turn = await enqueue();
        await publish(turn, 'delivery-dead');
        const target = {
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: 'delivery-dead',
          settledAt: START,
          failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
        };
        expect(
          await turns().deadLetterAgentQueuedTurn({ ...target, deliveryKey: 'delivery-other' }),
        ).toMatchObject({ outcome: 'conflict', turn: { status: 'queued' } });
        const dead = await turns().deadLetterAgentQueuedTurn(target);
        expect(dead).toMatchObject({
          outcome: 'dead',
          turn: { status: 'dead', terminalReceipt: { outcome: 'dead', failure: target.failure } },
        });
        expect(dead.turn).not.toHaveProperty('activeSlot');
        expect(await turns().deadLetterAgentQueuedTurn(target)).toMatchObject({
          outcome: 'already_terminal',
        });
        expect(
          await turns().deadLetterAgentQueuedTurn({ ...target, queuedTurnId: newId() }),
        ).toEqual({ outcome: 'missing', turn: null });
      });

      it('quarantines a started admission as indeterminate, keeping the lane blocked', async () => {
        const turn = await enqueue();
        await quarantine(turn, 'delivery-ambiguous');
        const stored = await storedTurn(turn.queuedTurnId);
        expect(stored).toMatchObject({
          status: 'claimed',
          admissionSlot: true,
          admissionId: 'delivery-ambiguous',
          deliveryState: 'published',
          reconciliationAttempts: 0,
          terminalReceipt: { outcome: 'dead', failure: { code: 'ADMISSION_INDETERMINATE' } },
        });
        expect(timeOf(stored.reconciliationAvailableAt)).toBe(LATER.getTime());
        expect(stored).not.toHaveProperty('claimId');
        expect(
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: 'delivery-ambiguous',
            settledAt: after(1),
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'duplicate terminal callback' },
          }),
        ).toMatchObject({ outcome: 'already_terminal' });
        const priority = await enqueue({ clientRequestId: 'priority', priority: true });
        expect(
          await turns().claimNextAgentQueuedTurn(
            claimInput(priority.queuedTurnId, {
              claimId: 'p',
              now: LATER,
              leaseUntil: after(60_000),
            }),
          ),
        ).toEqual({ outcome: 'blocked', claim: null });
        expect(
          await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: turn.queuedTurnId }),
        ).toMatchObject({ outcome: 'not_cancellable' });
        await expect(
          turns().prepareAgentQueuedTurnConversationDeletion({
            user,
            targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
          }),
        ).rejects.toThrow('admission must settle');
      });

      it('reconciles a started admission to admitted with exact evidence', async () => {
        const turn = await enqueue();
        await startAdmission(turn, 'root-delivery');
        expect(
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: 'root-delivery',
            settledAt: LATER,
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
            admissionEvidence: { generationId: 'root-generation', generationCreatedAt: 42 },
          }),
        ).toMatchObject({
          outcome: 'admission_reconciled',
          turn: {
            status: 'admitted',
            terminalReceipt: {
              admissionId: 'root-delivery',
              admissionMode: 'ordinary',
              generationId: 'root-generation',
              generationCreatedAt: 42,
              lineagePredecessorId: rootLineageId(),
              rootPredecessor: true,
            },
          },
        });
        await expect(
          turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: 'root-delivery',
            settledAt: LATER,
            failure: { code: 'F', message: 'm' },
            admissionEvidence: { generationCreatedAt: -1 },
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('reconciles through a chained predecessor’s boundary', async () => {
        const predecessor = await enqueue({
          clientRequestId: 'p',
          expectedPredecessorCreatedAt: 40,
        });
        const turn = await enqueue({ clientRequestId: 't', expectedPredecessorCreatedAt: 40 });
        await admit(predecessor, 'delivery-predecessor', 41);
        await startAdmission(turn, 'delivery-turn');
        expect(
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: 'delivery-turn',
            settledAt: LATER,
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
            admissionEvidence: { generationId: 'generation-reconciled', generationCreatedAt: 42 },
          }),
        ).toMatchObject({
          outcome: 'admission_reconciled',
          turn: {
            terminalReceipt: {
              generationCreatedAt: 42,
              effectivePredecessorCreatedAt: 41,
              lineagePredecessorId: predecessor.queuedTurnId,
            },
          },
        });
      });

      it('keeps a protocol-v2 admission indeterminate on job evidence until the exact receipt', async () => {
        const turn = await enqueue();
        const successor = await enqueue({ clientRequestId: 'successor' });
        const { claim } = await startAdmission(turn, 'source-fenced', {
          admissionProtocolVersion: 2,
        });
        expect(
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: 'source-fenced',
            settledAt: LATER,
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'source receipt unavailable' },
            admissionEvidence: { generationId: 'job-generation', generationCreatedAt: 43 },
          }),
        ).toMatchObject({
          outcome: 'admission_indeterminate',
          turn: {
            status: 'claimed',
            admissionProtocolVersion: 2,
            admissionSlot: true,
            terminalReceipt: { failure: { code: 'ADMISSION_INDETERMINATE' } },
          },
        });
        const successorClaim = claimInput(successor.queuedTurnId, { claimId: 'successor' });
        expect((await turns().claimNextAgentQueuedTurn(successorClaim)).outcome).toBe('blocked');
        expect(
          await turns().markAgentQueuedTurnAdmitted({
            ...claim,
            admissionId: 'source-fenced',
            admissionMode: 'ordinary',
            generationId: 'exact-generation',
            generationCreatedAt: 44,
            lineagePredecessorId: rootLineageId(),
            settledAt: after(1),
          }),
        ).toMatchObject({ outcome: 'admitted', turn: { status: 'admitted' } });
        expect((await turns().claimNextAgentQueuedTurn(successorClaim)).outcome).toBe('acquired');
      });
    });

    describe('claimQueuedTurnsForAdmissionReconciliation and deferAgentQueuedTurnAdmissionReconciliation', () => {
      it('leases quarantined admissions, then unblocks the successor once reconciled', async () => {
        const first = await enqueue({ clientRequestId: 'late', expectedPredecessorCreatedAt: 41 });
        const successor = await enqueue({
          clientRequestId: 'successor',
          expectedPredecessorCreatedAt: 41,
        });
        await quarantine(first, 'delivery-late');
        const now = after(1);
        const activity = { found: false };
        const claimed = await turns().claimQueuedTurnsForAdmissionReconciliation(
          {
            claimId: 'reconciliation-1',
            claimBy: 'reconciler-1',
            now,
            leaseUntil: after(60_000, now),
          },
          activity,
        );
        expect(activity.found).toBe(true);
        expect(claimed).toMatchObject([
          {
            queuedTurnId: first.queuedTurnId,
            reconciliationClaimId: 'reconciliation-1',
            reconciliationClaimBy: 'reconciler-1',
            reconciliationAttempts: 1,
          },
        ]);
        expect(timeOf(claimed[0].reconciliationClaimUntil)).toBe(after(60_000, now).getTime());
        // Leased: another reconciler finds nothing until the lease ends.
        expect(
          await turns().claimQueuedTurnsForAdmissionReconciliation({
            claimId: 'reconciliation-2',
            claimBy: 'reconciler-2',
            now,
            leaseUntil: after(60_000, now),
          }),
        ).toEqual([]);
        const successorClaim = claimInput(successor.queuedTurnId, {
          claimId: 'successor-delivery',
        });
        expect((await turns().claimNextAgentQueuedTurn(successorClaim)).outcome).toBe('blocked');
        expect(
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: first.queuedTurnId,
            deliveryKey: 'delivery-late',
            settledAt: LATER,
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
            admissionEvidence: { generationId: 'generation-late', generationCreatedAt: 43 },
            reconciliationClaimId: 'reconciliation-1',
            reconciliationClaimBy: 'reconciler-1',
          }),
        ).toMatchObject({ outcome: 'admission_reconciled', turn: { status: 'admitted' } });
        const empty = { found: false };
        expect(
          await turns().claimQueuedTurnsForAdmissionReconciliation(
            {
              claimId: 'reconciliation-3',
              claimBy: 'reconciler-1',
              now: after(120_000, now),
              leaseUntil: after(180_000, now),
            },
            empty,
          ),
        ).toEqual([]);
        expect(empty.found).toBe(false);
        expect((await turns().claimNextAgentQueuedTurn(successorClaim)).outcome).toBe('acquired');
      });

      it('rotates fairly through defer, preserving a late exact receipt', async () => {
        const first = await enqueue({
          conversationId: 'conversation-1',
          clientRequestId: 'fair-1',
        });
        const second = await enqueue({
          conversationId: 'conversation-2',
          clientRequestId: 'fair-2',
        });
        await quarantine(first, 'delivery-fair-1', { admissionProtocolVersion: 2 });
        const secondClaim = await quarantine(second, 'delivery-fair-2', {
          admissionProtocolVersion: 2,
        });
        const now = after(1);
        const lease = { now, leaseUntil: after(60_000, now), limit: 1 };
        const firstBatch = await turns().claimQueuedTurnsForAdmissionReconciliation({
          claimId: 'fair-claim-1',
          claimBy: 'reconciler-1',
          ...lease,
        });
        expect(firstBatch.map((turn) => turn.queuedTurnId)).toEqual([first.queuedTurnId]);
        const defer = {
          ...scope(),
          queuedTurnId: first.queuedTurnId,
          deliveryKey: 'delivery-fair-1',
          claimId: 'fair-claim-1',
          claimBy: 'reconciler-1',
          availableAt: after(60_000, now),
        };
        expect(
          await turns().deferAgentQueuedTurnAdmissionReconciliation({ ...defer, claimBy: 'other' }),
        ).toBe(false);
        expect(await turns().deferAgentQueuedTurnAdmissionReconciliation(defer)).toBe(true);
        expect(await turns().deferAgentQueuedTurnAdmissionReconciliation(defer)).toBe(false);
        expect(await storedTurn(first.queuedTurnId)).not.toHaveProperty('reconciliationClaimId');
        const secondBatch = await turns().claimQueuedTurnsForAdmissionReconciliation({
          claimId: 'fair-claim-2',
          claimBy: 'reconciler-1',
          ...lease,
        });
        expect(secondBatch.map((turn) => turn.queuedTurnId)).toEqual([second.queuedTurnId]);
        expect(
          await turns().deferAgentQueuedTurnAdmissionReconciliation({
            ...scope({ conversationId: 'conversation-2' }),
            queuedTurnId: second.queuedTurnId,
            deliveryKey: 'delivery-fair-2',
            claimId: 'fair-claim-2',
            claimBy: 'reconciler-1',
            availableAt: after(60_000, now),
          }),
        ).toBe(true);
        expect(
          await turns().markAgentQueuedTurnAdmitted({
            ...secondClaim,
            admissionId: 'delivery-fair-2',
            admissionMode: 'ordinary',
            generationId: 'generation-late-proof',
            generationCreatedAt: 44,
            lineagePredecessorId: rootLineageId(),
            settledAt: after(2),
          }),
        ).toMatchObject({ outcome: 'admitted' });
        // Deferred until its availability: nothing to lease now, the first again afterwards.
        expect(
          await turns().claimQueuedTurnsForAdmissionReconciliation({
            claimId: 'fair-claim-3',
            claimBy: 'reconciler-1',
            ...lease,
          }),
        ).toEqual([]);
        expect(
          (
            await turns().claimQueuedTurnsForAdmissionReconciliation({
              claimId: 'fair-claim-4',
              claimBy: 'reconciler-1',
              now: after(60_000, now),
              leaseUntil: after(120_000, now),
            })
          ).map((turn) => [turn.queuedTurnId, turn.reconciliationAttempts]),
        ).toEqual([[first.queuedTurnId, 2]]);
      });

      it('leases a started admission whose claim expired', async () => {
        const turn = await enqueue();
        await startAdmission(turn, 'delivery-expired-claim');
        expect(
          await turns().claimQueuedTurnsForAdmissionReconciliation({
            claimId: 'early',
            claimBy: 'reconciler',
            now: START,
            leaseUntil: LATER,
          }),
        ).toEqual([]);
        expect(
          (
            await turns().claimQueuedTurnsForAdmissionReconciliation({
              claimId: 'expired',
              claimBy: 'reconciler',
              now: LATER,
              leaseUntil: after(60_000),
            })
          ).map((row) => row.queuedTurnId),
        ).toEqual([turn.queuedTurnId]);
      });

      it.each([
        ['a lease ending at the claim', { leaseUntil: START }],
        ['a limit of 0', { limit: 0 }],
        ['a limit over 1000', { limit: 1001 }],
        ['an empty claim id', { claimId: ' ' }],
      ] as const)('throws a TypeError for %s', async (_name, overrides) => {
        await expect(
          turns().claimQueuedTurnsForAdmissionReconciliation({
            claimId: 'claim',
            claimBy: 'reconciler',
            now: START,
            leaseUntil: LATER,
            ...overrides,
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    describe('getEffectiveAgentQueuedTurnPredecessor', () => {
      const predecessorOf = (sequence: number, extra: Record<string, unknown> = {}) =>
        turns().getEffectiveAgentQueuedTurnPredecessor({
          ...scope(),
          sequence,
          rootParentMessageId: 'parent-1',
          ...extra,
        });

      it('follows exact lineage edges from the root, with the root epoch when none was admitted', async () => {
        expect(await predecessorOf(1)).toEqual({ lineagePredecessorId: rootLineageId() });
        expect(await predecessorOf(1, { expectedPredecessorCreatedAt: 10 })).toEqual({
          lineagePredecessorId: rootLineageId(),
          effectivePredecessorCreatedAt: 10,
        });
        const first = await enqueue({ clientRequestId: 'first', expectedPredecessorCreatedAt: 10 });
        const second = await enqueue({
          clientRequestId: 'second',
          expectedPredecessorCreatedAt: 10,
        });
        await admit(first, 'delivery-first', 11);
        const secondAdmitted = await admit(second, 'delivery-second', 12);
        expect(secondAdmitted?.terminalReceipt).toMatchObject({
          lineagePredecessorId: first.queuedTurnId,
          effectivePredecessorCreatedAt: 11,
        });
        expect(await predecessorOf(3, { expectedPredecessorCreatedAt: 10 })).toEqual({
          lineagePredecessorId: second.queuedTurnId,
          effectivePredecessorCreatedAt: 12,
        });
        // A turn's own admission is left out: sequence 2 follows the first.
        expect(await predecessorOf(2, { expectedPredecessorCreatedAt: 10 })).toEqual({
          lineagePredecessorId: first.queuedTurnId,
          effectivePredecessorCreatedAt: 11,
        });
      });

      it('scopes the lineage to one queue root (parent and root epoch)', async () => {
        const rootA = await enqueue({
          clientRequestId: 'root-a',
          expectedPredecessorCreatedAt: 10,
        });
        await admit(rootA, 'delivery-root-a', 11);
        expect(await predecessorOf(5, { expectedPredecessorCreatedAt: 10 })).toEqual({
          lineagePredecessorId: rootA.queuedTurnId,
          effectivePredecessorCreatedAt: 11,
        });
        expect(await predecessorOf(5, { expectedPredecessorCreatedAt: 20 })).toEqual({
          lineagePredecessorId: rootLineageId(),
          effectivePredecessorCreatedAt: 20,
        });
        expect(await predecessorOf(5)).toEqual({ lineagePredecessorId: rootLineageId() });
        expect(
          await turns().getEffectiveAgentQueuedTurnPredecessor({
            ...scope(),
            sequence: 5,
            rootParentMessageId: 'parent-2',
            expectedPredecessorCreatedAt: 10,
          }),
        ).toEqual({
          lineagePredecessorId: rootLineageId('parent-2'),
          effectivePredecessorCreatedAt: 10,
        });
        expect(
          await turns().getEffectiveAgentQueuedTurnPredecessor({
            ...scope({ tenantId: 'tenant-2' }),
            sequence: 5,
            rootParentMessageId: 'parent-1',
          }),
        ).toEqual({ lineagePredecessorId: rootLineageId() });
      });

      it('fails closed on missing generation evidence, a branch, or legacy rows unless inferred', async () => {
        const branched = rawTurn({
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            generationCreatedAt: 5,
            lineagePredecessorId: rootLineageId(),
          },
        });
        await seedTurns(
          { ...branched, _id: newId(), sequence: 1, clientRequestId: 'branch-1' },
          { ...branched, _id: newId(), sequence: 2, clientRequestId: 'branch-2' },
        );
        expect(await predecessorOf(3)).toBeNull();
        await turns().deleteAllAgentQueuedTurnsForUser({ user });

        const legacy = rawTurn({
          status: 'admitted',
          sequence: 1,
          terminalReceipt: { outcome: 'admitted', settledAt: START, generationCreatedAt: 7 },
        });
        await seedTurns(legacy);
        expect(await predecessorOf(2)).toBeNull();
        expect(await predecessorOf(2, { allowLegacyPredecessorInference: true })).toEqual({
          lineagePredecessorId: legacy._id,
          effectivePredecessorCreatedAt: 7,
        });
        await turns().deleteAllAgentQueuedTurnsForUser({ user });

        await seedTurns(
          rawTurn({
            status: 'admitted',
            sequence: 1,
            terminalReceipt: {
              outcome: 'admitted',
              settledAt: START,
              lineagePredecessorId: rootLineageId(),
            },
          }),
        );
        expect(await predecessorOf(2)).toBeNull();
      });

      it('throws a TypeError for a sequence that is not a positive integer', async () => {
        await expect(predecessorOf(0)).rejects.toBeInstanceOf(TypeError);
        await expect(predecessorOf(1.5)).rejects.toBeInstanceOf(TypeError);
      });
    });
  });
}
