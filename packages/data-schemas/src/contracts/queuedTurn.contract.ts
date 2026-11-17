/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AgentQueuedTurnStore` contract (`~/ports/queuedTurn`), first part: queue, delivery and
 * deletion. Ported from `methods/queuedTurn.spec.ts`, which stays unchanged: the follow-up turns
 * queued on a conversation and the per-conversation lane that orders them. Enqueue (payload
 * normalization and its fingerprint, the `files` array, exact replay and the idempotency conflict,
 * the versioned delivery reservation, monotonic lane sequences under concurrency, the cap of 100
 * active turns and its slot reuse, owner, tenant and conversation scopes, a retired lane); the
 * reads (lane order: priority then sequence, the active record's fields, the receipts with dead
 * turns until dismissed, the legacy admission boundary repaired on read, the recovery read that
 * repairs a visible reservation oldest first or cancels one whose lane is gone); delivery
 * reservation and publication; the deletion steps (exact scopes, the account purge, conversation
 * deletion with lane retirement and its 24-hour fence, delivery retirement and the
 * missing-delivery fence); and the lane fences as partial unique indexes (claimed, admission
 * started, admission slot, sequence, active slot, request id) through `harness.errors`. Claim and
 * admission are in `queuedTurn.admission.contract.ts`; the shared fixtures in
 * `queuedTurn.fixtures.ts`.
 *
 * Not here (they stay in the method spec): the quarantine of duplicate admission lanes that
 * `ensureAgentQueuedTurnIndexes` runs only while a fence index is missing (dropping an index is
 * not expressible here; with the fences installed it leaves such a lane alone, pinned below),
 * the lane-writer interleavings driven by spies (a stale writer resuming after deletion), and
 * direct edits of the lane collection (a stolen or deleted lane record), which only the store
 * writes. `deleteConvos` reaching `deleteAgentQueuedTurns` is in `conversation.domain.contract.ts`.
 * Turns are created through the store, legacy and interrupted states raw. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { ReasoningEffort } from 'librechat-data-provider';
import type { ContractHarness } from './harness';
import type { EnqueueAgentQueuedTurnStoreInput } from '~/ports/queuedTurn';
import {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
} from '~/methods/queuedTurn';
import { idOf, timeOf, useContractHarness } from './support';
import {
  START,
  LATER,
  after,
  unset,
  rejectionOf,
  rootLineageId,
  queuedTurnFixtures,
} from './queuedTurn.fixtures';

export function describeAgentQueuedTurnContract(harness: ContractHarness): void {
  describe(`AgentQueuedTurnStore contract (queue, delivery and deletion): ${harness.name}`, () => {
    useContractHarness(harness);

    const newId = () => harness.ids.generate();
    let user: string;

    beforeEach(() => {
      user = newId();
    });

    const {
      turns,
      scope,
      enqueueInput,
      enqueue,
      claimInput,
      publish,
      startAdmission,
      admit,
      storedTurn,
      lanes,
      rawTurn,
      seedTurns,
    } = queuedTurnFixtures(harness, () => user);

    /* ------------------------------------------------------------ setup and fences */

    describe('ensureAgentQueuedTurnIndexes and the lane fences', () => {
      it('resolves again with the fences installed, leaving turns and lanes as they are', async () => {
        const turn = await enqueue();
        const before = await harness.readRaw('agentqueuedturns');
        const beforeLanes = await lanes();
        await turns().ensureAgentQueuedTurnIndexes();
        await turns().ensureAgentQueuedTurnIndexes();
        expect(await harness.readRaw('agentqueuedturns')).toEqual(before);
        expect(await lanes()).toEqual(beforeLanes);
        expect((await enqueue()).sequence).toBe(turn.sequence + 1);
      });

      it('leaves a lane whose admission order is not total alone while the fences exist', async () => {
        // NOTE(contract): the quarantine of such lanes (dead, `QUEUED_TURN_ADMISSION_ORDER_
        // UNAVAILABLE`, lane retired) runs only while a fence index is missing, as an upgrade
        // step; with the fences installed, a legacy lane with a claimed turn and a dead turn
        // that crossed the admission boundary is not settled.
        const claimed = rawTurn({
          status: 'claimed',
          sequence: 1,
          claimId: 'legacy-claim',
          claimBy: 'legacy-worker',
          claimUntil: LATER,
        });
        const crossed = rawTurn({
          status: 'dead',
          sequence: 2,
          deliveryKey: 'legacy-delivery',
          deliveryState: 'published',
          admissionId: 'legacy-delivery',
          admissionStartedAt: START,
          terminalReceipt: {
            outcome: 'dead',
            settledAt: START,
            failure: { code: 'ADMISSION_INDETERMINATE', message: 'Legacy owner disappeared' },
          },
        });
        await seedTurns(claimed, crossed);
        const before = await harness.readRaw('agentqueuedturns');
        await turns().ensureAgentQueuedTurnIndexes();
        expect(await harness.readRaw('agentqueuedturns')).toEqual(before);
      });

      it.each([
        [
          'a second claimed turn',
          { status: 'claimed', claimId: 'c', claimBy: 'w', claimUntil: LATER },
        ],
        [
          'a second turn past the admission boundary',
          { status: 'dead', admissionStartedAt: START },
        ],
        ['a second admission slot', { status: 'queued', admissionSlot: true }],
      ] as const)(
        'rejects %s in one lane as a duplicate key, not in another lane',
        async (_name, fence) => {
          await seedTurns(rawTurn({ ...fence, sequence: 1 }));
          const rejection = await rejectionOf(seedTurns(rawTurn({ ...fence, sequence: 2 })));
          expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
          await seedTurns(rawTurn({ ...fence, sequence: 3, laneId: 'lane-other' }));
          await seedTurns(rawTurn({ ...fence, sequence: 1, conversationId: 'conversation-2' }));
          expect(await harness.readRaw('agentqueuedturns')).toHaveLength(3);
        },
      );

      it('keeps one sequence, one active slot and one request id per conversation scope', async () => {
        await seedTurns(rawTurn({ sequence: 1, activeSlot: 7, clientRequestId: 'request-a' }));
        for (const duplicate of [
          { sequence: 1 },
          { sequence: 2, activeSlot: 7 },
          { sequence: 3, clientRequestId: 'request-a' },
        ]) {
          const rejection = await rejectionOf(seedTurns(rawTurn(duplicate)));
          expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
        }
        await seedTurns(
          rawTurn({
            sequence: 1,
            activeSlot: 7,
            clientRequestId: 'request-a',
            tenantId: 'tenant-2',
          }),
          rawTurn({ sequence: 1, activeSlot: 7, clientRequestId: 'request-a', user: newId() }),
          rawTurn({ status: 'admitted', clientRequestId: 'request-b' }),
          rawTurn({ status: 'admitted', clientRequestId: 'request-c' }),
        );
        expect(await harness.readRaw('agentqueuedturns')).toHaveLength(5);
      });
    });

    /* ------------------------------------------------------------ queue and reads */

    describe('enqueueAgentQueuedTurn', () => {
      it('queues a turn at sequence 1 of a new lane, with the record’s fields', async () => {
        const before = Date.now();
        const { turn, replayed } = await turns().enqueueAgentQueuedTurn(
          enqueueInput({ clientRequestId: 'request-a' }),
        );
        expect(replayed).toBe(false);
        expect(turn).toMatchObject({
          queuedTurnId: expect.any(String),
          tenantId: 'tenant-1',
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          parentMessageId: 'parent-1',
          clientRequestId: 'request-a',
          laneId: expect.any(String),
          sequence: 1,
          activeSlot: expect.any(Number),
          status: 'queued',
          priority: false,
          text: 'follow up',
          attempts: 0,
          deliveryState: 'pending',
        });
        expect(idOf(harness, turn.user)).toBe(user);
        expect(timeOf(turn.availableAt)).toBe(START.getTime());
        expect(timeOf(turn.createdAt)).toBeGreaterThanOrEqual(before);
        expect(turn.fingerprint.length).toBeGreaterThanOrEqual(43);
        expect(turn).not.toHaveProperty('deliveryKey');
        expect(turn).not.toHaveProperty('admissionSlot');
        expect(await storedTurn(turn.queuedTurnId)).toMatchObject({
          status: 'queued',
          sequence: 1,
          user,
        });
        expect(await lanes()).toHaveLength(1);
      });

      it('normalizes the payload, replays the same request and conflicts on changed content', async () => {
        const input = enqueueInput({
          text: '  follow up  ',
          files: [
            { file_id: ' file-1 ', filename: ' report.pdf ', llmDeliveryPath: 'text' },
            { file_id: 'file-1', filename: 'ignored duplicate' },
            { file_id: 'file-2', type: 'image/png', width: 10, height: 20, bytes: 300 },
          ],
          quotes: [' quote ', '', 'second'],
          manualSkills: [' skill-a ', 'skill-a'],
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
          expectedPredecessorCreatedAt: 42,
        });
        const first = await turns().enqueueAgentQueuedTurn(input);
        const files = [
          { file_id: 'file-1', filename: 'report.pdf', llmDeliveryPath: 'text' },
          { file_id: 'file-2', type: 'image/png', height: 20, width: 10, bytes: 300 },
        ];
        expect(first.turn).toMatchObject({
          text: 'follow up',
          files,
          quotes: ['quote', 'second'],
          manualSkills: ['skill-a'],
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
          expectedPredecessorCreatedAt: 42,
        });
        expect((await storedTurn(first.turn.queuedTurnId)).files).toEqual(files);
        // An older replica's retry without the display-only delivery path replays.
        const replay = await turns().enqueueAgentQueuedTurn({
          ...input,
          text: 'follow up',
          files: [
            { file_id: 'file-1', filename: 'report.pdf' },
            { file_id: 'file-2', type: 'image/png', width: 10, height: 20, bytes: 300 },
          ],
          quotes: ['quote', 'second'],
          manualSkills: ['skill-a'],
        });
        expect(replay).toMatchObject({
          replayed: true,
          turn: { queuedTurnId: first.turn.queuedTurnId },
        });
        for (const changed of [
          { agentId: 'agent-2' },
          { parentMessageId: 'different-parent' },
          { reasoningOverride: { key: 'reasoning_effort' as const, value: ReasoningEffort.low } },
          { files: [{ file_id: 'file-3' }] },
          { priority: true },
        ]) {
          await expect(
            turns().enqueueAgentQueuedTurn({ ...input, ...changed }),
          ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
        }
        expect(await harness.readRaw('agentqueuedturns')).toHaveLength(1);
      });

      it('keeps a maximum-length response parent, and refuses a longer one before writing', async () => {
        const parentMessageId = 'a'.repeat(257);
        const first = await enqueue({ parentMessageId, clientRequestId: 'long-parent' });
        expect(first.parentMessageId).toBe(parentMessageId);
        await expect(
          turns().getEffectiveAgentQueuedTurnPredecessor({
            ...scope(),
            sequence: first.sequence,
            rootParentMessageId: parentMessageId,
          }),
        ).resolves.toEqual({ lineagePredecessorId: rootLineageId(parentMessageId) });
        await turns().deleteAllAgentQueuedTurnsForUser({ user });
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ parentMessageId: 'a'.repeat(258) })),
        ).rejects.toBeInstanceOf(TypeError);
        expect(await harness.readRaw('agentqueuedturns')).toEqual([]);
        expect(await lanes()).toEqual([]);
      });

      it.each([
        ['an empty turn', { text: '   ' }],
        ['an oversized request id', { clientRequestId: 'r'.repeat(129) }],
        [
          'too many files',
          { files: Array.from({ length: 21 }, (_, index) => ({ file_id: `f-${index}` })) },
        ],
        ['negative file metadata', { files: [{ file_id: 'f', bytes: -1 }] }],
        [
          'an invalid delivery path',
          { files: [{ file_id: 'f', llmDeliveryPath: 'email' as 'text' }] },
        ],
        [
          'too many manual skills',
          { manualSkills: Array.from({ length: 33 }, (_, index) => `s-${index}`) },
        ],
        ['a negative predecessor epoch', { expectedPredecessorCreatedAt: -1 }],
        ['an oversized conversation id', { conversationId: 'c'.repeat(257) }],
      ] as const)('throws a TypeError for %s, writing nothing', async (_name, overrides) => {
        await expect(
          turns().enqueueAgentQueuedTurn(
            enqueueInput(overrides as Partial<EnqueueAgentQueuedTurnStoreInput>),
          ),
        ).rejects.toBeInstanceOf(TypeError);
        expect(await harness.readRaw('agentqueuedturns')).toEqual([]);
      });

      it('keeps at most 10 quotes, and refuses a turn without text through the schema', async () => {
        const quotes = Array.from({ length: 12 }, (_, index) => ` quote ${index} `);
        expect((await enqueue({ text: 'see quotes', quotes })).quotes).toEqual(
          quotes.slice(0, 10).map((quote) => quote.trim()),
        );
        // NOTE(contract): the normalizer accepts a turn of quotes or files alone (the port and
        // its TypeError say text, a file or a quote), but the stored record requires a
        // non-empty `text`, so such a turn rejects with the schema's validation error and no
        // turn is written.
        for (const payload of [{ quotes: ['quote'] }, { files: [{ file_id: 'file-1' }] }]) {
          await expect(
            turns().enqueueAgentQueuedTurn(
              enqueueInput({ text: '', clientRequestId: 'textless', ...payload }),
            ),
          ).rejects.toThrow(/text/);
        }
        expect(await harness.readRaw('agentqueuedturns')).toHaveLength(1);
      });

      it('refuses an approval snapshot without a delivery reservation before writing', async () => {
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ codeApprovalMode: 'ask' })),
        ).rejects.toThrow('versioned delivery reservation');
        expect(await harness.readRaw('agentqueuedturns')).toEqual([]);
      });

      it('stores an approval snapshot under its delivery reservation and replays it exactly', async () => {
        const queuedTurnId = newId();
        const input = enqueueInput({
          codeApprovalMode: 'fullAccess',
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
          deliveryReservation: { queuedTurnId, deliveryKey: 'v2-key' },
        });
        const first = await turns().enqueueAgentQueuedTurn(input);
        expect(first.turn).toMatchObject({
          queuedTurnId,
          codeApprovalMode: 'fullAccess',
          deliveryKey: 'v2-key',
          deliveryState: 'publishing',
        });
        const target = { ...scope(), queuedTurnId };
        expect(
          await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'legacy-v1-key' }),
        ).toMatchObject({ outcome: 'conflict' });
        expect(
          await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'v2-key' }),
        ).toMatchObject({ outcome: 'already_reserved' });
        expect((await turns().enqueueAgentQueuedTurn(input)).replayed).toBe(true);
        await expect(
          turns().enqueueAgentQueuedTurn({ ...input, codeApprovalMode: 'ask' }),
        ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
        const claimed = await turns().claimNextAgentQueuedTurn(claimInput(queuedTurnId));
        expect(claimed).toMatchObject({
          outcome: 'acquired',
          claim: { codeApprovalMode: 'fullAccess' },
        });
        expect((await turns().listActiveAgentQueuedTurns(scope()))[0]?.codeApprovalMode).toBe(
          'fullAccess',
        );
      });

      it('rejects an upgraded replay of a turn stored without an approval mode', async () => {
        const input = enqueueInput();
        const created = await turns().enqueueAgentQueuedTurn(input);
        expect(created.turn).not.toHaveProperty('codeApprovalMode');
        await expect(
          turns().enqueueAgentQueuedTurn({
            ...input,
            codeApprovalMode: 'fullAccess',
            deliveryReservation: { queuedTurnId: newId(), deliveryKey: 'v2-key' },
          }),
        ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
      });

      it('allocates distinct increasing sequences under concurrent enqueues', async () => {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            turns().enqueueAgentQueuedTurn(
              enqueueInput({ clientRequestId: `concurrent-${index}`, text: `turn ${index}` }),
            ),
          ),
        );
        expect(results.map(({ turn }) => turn.sequence).sort((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        expect(new Set(results.map(({ turn }) => turn.activeSlot)).size).toBe(8);
        expect(new Set(results.map(({ turn }) => turn.laneId)).size).toBe(1);
      });

      it('caps a conversation at 100 active turns while replaying exactly', async () => {
        const inputs = Array.from({ length: 101 }, (_, index) =>
          enqueueInput({ clientRequestId: `capacity-${index}`, text: `turn ${index}` }),
        );
        // One store instance, as one replica serves a conversation's burst.
        const store = turns();
        const results = await Promise.allSettled(
          inputs.map((input) => store.enqueueAgentQueuedTurn(input)),
        );
        const fulfilled = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const rejected = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        expect(fulfilled).toHaveLength(100);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(AgentQueuedTurnCapacityError);
        const replayInput = inputs.find(
          (input) => input.clientRequestId === fulfilled[0].turn.clientRequestId,
        );
        expect(await turns().enqueueAgentQueuedTurn(replayInput!)).toMatchObject({
          replayed: true,
          turn: { queuedTurnId: fulfilled[0].turn.queuedTurnId },
        });
        expect(await turns().listActiveAgentQueuedTurns(scope())).toHaveLength(100);
      });

      it('reuses the slot of a settled turn and isolates capacity by owner, tenant and conversation', async () => {
        const store = turns();
        const queued = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            store
              .enqueueAgentQueuedTurn(
                enqueueInput({ clientRequestId: `slot-${index}`, text: `turn ${index}` }),
              )
              .then(({ turn }) => turn),
          ),
        );
        await turns().cancelAgentQueuedTurn({
          ...scope(),
          queuedTurnId: queued[0].queuedTurnId,
          settledAt: START,
        });
        expect(await enqueue({ clientRequestId: 'reused-slot' })).toMatchObject({
          status: 'queued',
          activeSlot: queued[0].activeSlot,
        });
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ clientRequestId: 'overflow' })),
        ).rejects.toBeInstanceOf(AgentQueuedTurnCapacityError);
        for (const other of [
          { conversationId: 'conversation-2' },
          { tenantId: 'tenant-2' },
          { user: newId() },
        ]) {
          expect(
            (
              await turns().enqueueAgentQueuedTurn(
                enqueueInput({ ...other, clientRequestId: 'other' }),
              )
            ).replayed,
          ).toBe(false);
        }
      });

      it('keeps untenanted turns in the untenanted scope', async () => {
        const turn = await enqueue({ tenantId: undefined, clientRequestId: 'untenanted' });
        expect(turn).not.toHaveProperty('tenantId');
        expect(await storedTurn(turn.queuedTurnId)).not.toHaveProperty('tenantId');
        expect(
          (
            await turns().listActiveAgentQueuedTurns({ user, conversationId: 'conversation-1' })
          ).map((row) => row.queuedTurnId),
        ).toEqual([turn.queuedTurnId]);
        expect(await turns().listActiveAgentQueuedTurns(scope())).toEqual([]);
      });

      it('refuses a conversation being deleted', async () => {
        await enqueue();
        await turns().prepareAgentQueuedTurnConversationDeletion({
          user,
          targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
          settledAt: START,
        });
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ clientRequestId: 'after-delete' })),
        ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
        await expect(
          turns().enqueueAgentQueuedTurn(
            enqueueInput({ clientRequestId: 'after-delete', tenantId: 'tenant-2' }),
          ),
        ).resolves.toMatchObject({ replayed: false });
      });
    });

    describe('getAgentQueuedTurnByClientRequestId', () => {
      it('finds the conversation’s turn by request id, whatever its status', async () => {
        const turn = await enqueue({ clientRequestId: 'lookup' });
        await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: turn.queuedTurnId });
        expect(
          await turns().getAgentQueuedTurnByClientRequestId({
            ...scope(),
            clientRequestId: 'lookup',
          }),
        ).toMatchObject({ queuedTurnId: turn.queuedTurnId, status: 'cancelled' });
        for (const other of [
          { conversationId: 'another-conversation' },
          { tenantId: 'tenant-2' },
          { user: newId() },
        ]) {
          expect(
            await turns().getAgentQueuedTurnByClientRequestId({
              ...scope(other),
              clientRequestId: 'lookup',
            }),
          ).toBeNull();
        }
      });

      it('repairs a legacy admission receipt’s lineage boundary on read', async () => {
        const legacy = rawTurn({
          status: 'admitted',
          sequence: 1,
          clientRequestId: 'legacy-admitted',
          deliveryKey: 'legacy-delivery',
          deliveryState: 'published',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            admissionId: 'legacy-delivery',
            admissionMode: 'ordinary',
            generationCreatedAt: 41,
          },
        });
        await seedTurns(legacy);
        const read = await turns().getAgentQueuedTurnByClientRequestId({
          ...scope(),
          clientRequestId: 'legacy-admitted',
        });
        expect(read?.terminalReceipt).toMatchObject({
          outcome: 'admitted',
          lineagePredecessorId: rootLineageId(),
          rootPredecessor: true,
        });
        expect((await storedTurn(legacy._id as string)).terminalReceipt).toMatchObject({
          lineagePredecessorId: rootLineageId(),
          rootPredecessor: true,
        });
      });
    });

    describe('listActiveAgentQueuedTurns', () => {
      it('lists queued and claimed turns, priority first then by sequence, with the active fields', async () => {
        const first = await enqueue({ clientRequestId: 'first' });
        await enqueue({ clientRequestId: 'second' });
        const priority = await enqueue({ clientRequestId: 'priority', priority: true });
        const cancelled = await enqueue({ clientRequestId: 'cancelled' });
        await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: cancelled.queuedTurnId });
        await turns().claimNextAgentQueuedTurn(claimInput(priority.queuedTurnId));
        const active = await turns().listActiveAgentQueuedTurns(scope());
        expect(active.map((turn) => [turn.clientRequestId, turn.status])).toEqual([
          ['priority', 'claimed'],
          ['first', 'queued'],
          ['second', 'queued'],
        ]);
        expect(active[1]).toMatchObject({
          queuedTurnId: first.queuedTurnId,
          sequence: 1,
          text: 'follow up',
          attempts: 0,
          deliveryState: 'pending',
        });
        for (const field of ['user', 'tenantId', 'fingerprint', 'laneId', 'claimId', 'claimBy']) {
          expect(active[0]).not.toHaveProperty(field);
        }
        expect(await turns().listActiveAgentQueuedTurns({ ...scope(), limit: 1 })).toHaveLength(1);
      });

      it.each([0, 101, 1.5])('throws a TypeError for a limit of %p', async (limit) => {
        await expect(
          turns().listActiveAgentQueuedTurns({ ...scope(), limit }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    describe('listAgentQueuedTurnReceipts', () => {
      it('lists a dead turn until the user dismisses it, and known requests whatever their status', async () => {
        const dead = await enqueue({ clientRequestId: 'dead' });
        await publish(dead, 'delivery-dead');
        expect(
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: dead.queuedTurnId,
            deliveryKey: 'delivery-dead',
            settledAt: START,
            failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
          }),
        ).toMatchObject({ outcome: 'dead' });
        const queued = await enqueue({ clientRequestId: 'queued' });
        expect(await turns().listAgentQueuedTurnReceipts(scope())).toMatchObject([
          {
            queuedTurnId: dead.queuedTurnId,
            status: 'dead',
            terminalReceipt: {
              outcome: 'dead',
              failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
            },
          },
          { queuedTurnId: queued.queuedTurnId, status: 'queued' },
        ]);
        expect(
          await turns().cancelAgentQueuedTurn({
            ...scope(),
            queuedTurnId: dead.queuedTurnId,
            settledAt: LATER,
          }),
        ).toMatchObject({ outcome: 'cancelled' });
        expect(
          (await turns().listAgentQueuedTurnReceipts(scope())).map((turn) => turn.queuedTurnId),
        ).toEqual([queued.queuedTurnId]);
        expect(
          (
            await turns().listAgentQueuedTurnReceipts({
              ...scope(),
              clientRequestIds: [' dead ', 'dead', 'unknown'],
            })
          ).map((turn) => [turn.clientRequestId, turn.status]),
        ).toEqual([
          ['dead', 'cancelled'],
          ['queued', 'queued'],
        ]);
      });

      it('throws a TypeError for more than 100 request ids', async () => {
        await expect(
          turns().listAgentQueuedTurnReceipts({
            ...scope(),
            clientRequestIds: Array.from({ length: 101 }, (_, index) => `request-${index}`),
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('projects the newest 100 dead turns', async () => {
        const deadIds: string[] = [];
        for (let index = 0; index < 101; index++) {
          const turn = await enqueue({ clientRequestId: `dead-${index}`, text: `dead ${index}` });
          await publish(turn, `delivery-${index}`);
          await turns().deadLetterAgentQueuedTurn({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: `delivery-${index}`,
            settledAt: START,
            failure: { code: 'FAILED', message: `failure ${index}` },
          });
          deadIds.push(turn.queuedTurnId);
        }
        const receipts = await turns().listAgentQueuedTurnReceipts(scope());
        expect(receipts).toHaveLength(100);
        expect(receipts.map((turn) => turn.queuedTurnId)).toEqual(deadIds.slice(1));
      });
    });

    describe('findQueuedTurnsNeedingDelivery', () => {
      it('lists queued turns whose delivery is unpublished, oldest available first', async () => {
        const later = await enqueue({ clientRequestId: 'later', availableAt: LATER });
        const sooner = await enqueue({ clientRequestId: 'sooner', availableAt: START });
        const published = await enqueue({ clientRequestId: 'published' });
        await publish(published, 'delivery-published');
        const reserved = await enqueue({ clientRequestId: 'reserved', availableAt: after(1) });
        await turns().reserveAgentQueuedTurnDelivery({
          ...scope(),
          queuedTurnId: reserved.queuedTurnId,
          deliveryKey: 'delivery-reserved',
        });
        const activity = { found: false };
        expect(
          (await turns().findQueuedTurnsNeedingDelivery(100, activity)).map(
            (turn) => turn.queuedTurnId,
          ),
        ).toEqual([sooner.queuedTurnId, later.queuedTurnId, reserved.queuedTurnId]);
        expect(activity.found).toBe(false);
        expect(await turns().findQueuedTurnsNeedingDelivery(1)).toHaveLength(1);
      });

      it('lists cancelled and dead turns whose delivery is still publishing', async () => {
        const cancelled = await enqueue({ clientRequestId: 'cancelled' });
        await turns().reserveAgentQueuedTurnDelivery({
          ...scope(),
          queuedTurnId: cancelled.queuedTurnId,
          deliveryKey: 'delivery-cancelled',
        });
        await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: cancelled.queuedTurnId });
        const dropped = await enqueue({ clientRequestId: 'dropped' });
        await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: dropped.queuedTurnId });
        expect(await storedTurn(dropped.queuedTurnId)).toMatchObject({ deliveryState: 'retired' });
        expect(await turns().findQueuedTurnsNeedingDelivery()).toMatchObject([
          {
            queuedTurnId: cancelled.queuedTurnId,
            status: 'cancelled',
            deliveryState: 'publishing',
          },
        ]);
      });

      it('repairs a visible reservation oldest first, which blocked the lane’s claims', async () => {
        const first = await enqueue({ clientRequestId: 'visible-first' });
        const interrupted = rawTurn({
          clientRequestId: 'interrupted-reservation',
          laneId: first.laneId,
          activeSlot: ((first.activeSlot ?? 0) + 1) % 100,
          status: 'reserving',
          text: 'repair me',
        });
        await seedTurns(interrupted);
        expect(await turns().claimNextAgentQueuedTurn(claimInput(first.queuedTurnId))).toEqual({
          outcome: 'blocked',
          claim: null,
        });
        const activity = { found: false };
        const pending = await turns().findQueuedTurnsNeedingDelivery(100, activity);
        expect(activity.found).toBe(true);
        expect(pending.map((turn) => turn.queuedTurnId)).toEqual([
          first.queuedTurnId,
          interrupted._id,
        ]);
        expect(await storedTurn(interrupted._id as string)).toMatchObject({
          status: 'queued',
          sequence: 2,
        });
        expect(
          (await turns().claimNextAgentQueuedTurn(claimInput(first.queuedTurnId))).outcome,
        ).toBe('acquired');
        expect((await enqueue()).sequence).toBe(3);
      });

      it('cancels a reservation whose lane is gone, reporting the activity', async () => {
        await seedTurns(
          rawTurn({ status: 'reserving', activeSlot: 1, laneId: 'lane-gone' }),
          rawTurn({ status: 'reserving', activeSlot: 2, laneId: 'lane-gone' }),
        );
        for (let pass = 0; pass < 2; pass++) {
          const activity = { found: false };
          expect(await turns().findQueuedTurnsNeedingDelivery(1, activity)).toEqual([]);
          expect(activity.found).toBe(true);
        }
        const empty = { found: false };
        expect(await turns().findQueuedTurnsNeedingDelivery(1, empty)).toEqual([]);
        expect(empty.found).toBe(false);
        for (const turn of await harness.readRaw('agentqueuedturns')) {
          expect(turn).toMatchObject({
            status: 'cancelled',
            deliveryState: 'retired',
            terminalReceipt: { outcome: 'cancelled', failure: { code: 'OWNER_DRAINED' } },
          });
          expect(unset(turn.activeSlot)).toBe(true);
        }
      });

      it.each([0, 1001])('throws a TypeError for a limit of %p', async (limit) => {
        await expect(turns().findQueuedTurnsNeedingDelivery(limit)).rejects.toBeInstanceOf(
          TypeError,
        );
      });
    });

    /* ------------------------------------------------------------ delivery */

    describe('reserveAgentQueuedTurnDelivery and markQueuedTurnScheduled', () => {
      it('reserves and publishes a delivery once, idempotently, refusing another key', async () => {
        const turn = await enqueue();
        const target = { ...scope(), queuedTurnId: turn.queuedTurnId };
        const replay = await turns().enqueueAgentQueuedTurn(
          enqueueInput({
            clientRequestId: turn.clientRequestId,
          }),
        );
        expect(replay.turn).not.toHaveProperty('scheduledAt');
        expect(
          await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'delivery-1' }),
        ).toMatchObject({
          outcome: 'reserved',
          turn: { deliveryKey: 'delivery-1', deliveryState: 'publishing' },
        });
        expect(
          await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'delivery-1' }),
        ).toMatchObject({ outcome: 'already_reserved' });
        const scheduled = await turns().markQueuedTurnScheduled({
          ...target,
          deliveryKey: 'delivery-1',
          scheduledAt: START,
        });
        expect(scheduled).toMatchObject({
          outcome: 'scheduled',
          turn: { deliveryKey: 'delivery-1', deliveryState: 'published' },
        });
        expect(timeOf(scheduled.turn?.scheduledAt)).toBe(START.getTime());
        expect(
          await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'delivery-1' }),
        ).toMatchObject({ outcome: 'already_reserved' });
        expect(
          await turns().markQueuedTurnScheduled({ ...target, deliveryKey: 'delivery-1' }),
        ).toMatchObject({ outcome: 'already_scheduled' });
        expect(
          await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'delivery-2' }),
        ).toMatchObject({ outcome: 'conflict', turn: { deliveryKey: 'delivery-1' } });
        expect(
          await turns().markQueuedTurnScheduled({ ...target, deliveryKey: 'delivery-2' }),
        ).toMatchObject({ outcome: 'conflict' });
        expect(await turns().findQueuedTurnsNeedingDelivery()).toEqual([]);
      });

      it('publishes after a worker claimed the turn, and refuses an unreserved or missing turn', async () => {
        const turn = await enqueue();
        const target = { ...scope(), queuedTurnId: turn.queuedTurnId };
        expect(
          await turns().markQueuedTurnScheduled({ ...target, deliveryKey: 'delivery-fast' }),
        ).toMatchObject({ outcome: 'conflict' });
        await turns().reserveAgentQueuedTurnDelivery({ ...target, deliveryKey: 'delivery-fast' });
        await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId));
        expect(
          await turns().markQueuedTurnScheduled({
            ...target,
            deliveryKey: 'delivery-fast',
            scheduledAt: START,
          }),
        ).toMatchObject({ outcome: 'scheduled', turn: { status: 'claimed' } });
        const missing = { ...scope(), queuedTurnId: newId(), deliveryKey: 'delivery-x' };
        expect(await turns().reserveAgentQueuedTurnDelivery(missing)).toEqual({
          outcome: 'conflict',
          turn: null,
        });
        expect(await turns().markQueuedTurnScheduled(missing)).toEqual({
          outcome: 'conflict',
          turn: null,
        });
      });

      it('reserves no delivery for a settled turn', async () => {
        const turn = await enqueue();
        await turns().cancelAgentQueuedTurn({ ...scope(), queuedTurnId: turn.queuedTurnId });
        expect(
          await turns().reserveAgentQueuedTurnDelivery({
            ...scope(),
            queuedTurnId: turn.queuedTurnId,
            deliveryKey: 'delivery-late',
          }),
        ).toMatchObject({ outcome: 'conflict', turn: { status: 'cancelled' } });
      });
    });

    /* ------------------------------------------------------------ deletion */

    describe('deleteAgentQueuedTurns and deleteAllAgentQueuedTurnsForUser', () => {
      it('deletes the turns and lanes of exactly one conversation scope', async () => {
        const otherUser = newId();
        await enqueue({ clientRequestId: 'delete' });
        await enqueue({ clientRequestId: 'delete-2' });
        await enqueue({ clientRequestId: 'other-conversation', conversationId: 'conversation-2' });
        await enqueue({ clientRequestId: 'other-tenant', tenantId: 'tenant-2' });
        await enqueue({ clientRequestId: 'other-user', user: otherUser });
        expect(await turns().deleteAgentQueuedTurns(scope())).toBe(2);
        expect(
          (await harness.readRaw('agentqueuedturns')).map((turn) => turn.clientRequestId).sort(),
        ).toEqual(['other-conversation', 'other-tenant', 'other-user']);
        expect(await lanes()).toHaveLength(3);
        // A new lane starts over.
        expect((await enqueue({ clientRequestId: 'after-delete' })).sequence).toBe(1);
        expect(await turns().deleteAgentQueuedTurns(scope({ conversationId: 'none' }))).toBe(0);
      });

      it('deletes every conversation of the owner within one tenant scope when none is given', async () => {
        await enqueue({ clientRequestId: 'a' });
        await enqueue({ clientRequestId: 'b', conversationId: 'conversation-2' });
        await enqueue({ clientRequestId: 'c', tenantId: undefined });
        expect(await turns().deleteAgentQueuedTurns({ user, tenantId: 'tenant-1' })).toBe(2);
        expect(
          (await harness.readRaw('agentqueuedturns')).map((turn) => turn.clientRequestId),
        ).toEqual(['c']);
        expect(await turns().deleteAgentQueuedTurns({ user })).toBe(1);
        expect(await lanes()).toEqual([]);
      });

      it('purges the owner across every tenant, keeping other users', async () => {
        const otherUser = newId();
        await enqueue({ clientRequestId: 'tenant-one' });
        await enqueue({ clientRequestId: 'tenant-two', tenantId: 'tenant-2' });
        await enqueue({ clientRequestId: 'untenanted', tenantId: undefined });
        await enqueue({ clientRequestId: 'other-user', user: otherUser });
        expect(await turns().deleteAllAgentQueuedTurnsForUser({ user })).toBe(3);
        expect(
          (await harness.readRaw('agentqueuedturns')).map((turn) => turn.clientRequestId),
        ).toEqual(['other-user']);
        expect((await lanes()).map((lane) => lane.user)).toEqual([otherUser]);
        expect(await turns().deleteAllAgentQueuedTurnsForUser({ user })).toBe(0);
      });
    });

    describe('prepareAgentQueuedTurnConversationDeletion and deletePreparedAgentQueuedTurnConversations', () => {
      const target = [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }];

      it('retires the lane, cancels unadmitted turns and waits for their deliveries to retire', async () => {
        const reserved = await enqueue({ clientRequestId: 'reserved' });
        await turns().reserveAgentQueuedTurnDelivery({
          ...scope(),
          queuedTurnId: reserved.queuedTurnId,
          deliveryKey: 'delivery-delete-one',
        });
        const plain = await enqueue({ clientRequestId: 'plain' });
        await enqueue({ clientRequestId: 'other-tenant', tenantId: 'tenant-2' });
        await enqueue({ clientRequestId: 'other-conversation', conversationId: 'conversation-2' });
        const untouched = (await harness.readRaw('agentqueuedturns')).filter(
          (turn) => turn.conversationId !== 'conversation-1' || turn.tenantId !== 'tenant-1',
        );

        expect(
          await turns().prepareAgentQueuedTurnConversationDeletion({
            user,
            targets: target,
            settledAt: START,
          }),
        ).toEqual(['delivery-delete-one']);
        for (const turn of [reserved, plain]) {
          expect(await storedTurn(turn.queuedTurnId)).toMatchObject({
            status: 'cancelled',
            terminalReceipt: { outcome: 'cancelled', failure: { code: 'OWNER_DRAINED' } },
          });
        }
        expect(await storedTurn(plain.queuedTurnId)).toMatchObject({ deliveryState: 'retired' });
        expect(await turns().findQueuedTurnsNeedingDelivery()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              queuedTurnId: reserved.queuedTurnId,
              deliveryState: 'publishing',
            }),
          ]),
        );
        await expect(
          turns().deletePreparedAgentQueuedTurnConversations({ user, targets: target }),
        ).rejects.toThrow('deliveries must retire');
        await turns().markQueuedTurnScheduled({
          ...scope(),
          queuedTurnId: reserved.queuedTurnId,
          deliveryKey: 'delivery-delete-one',
          scheduledAt: START,
        });
        expect(
          await turns().markAgentQueuedTurnDeliveryRetired({ deliveryKey: 'delivery-delete-one' }),
        ).toBe(true);
        expect(
          await turns().deletePreparedAgentQueuedTurnConversations({ user, targets: target }),
        ).toBe(2);
        expect(
          (await harness.readRaw('agentqueuedturns')).sort((a, b) =>
            String(a.clientRequestId).localeCompare(String(b.clientRequestId)),
          ),
        ).toEqual(
          untouched.sort((a, b) =>
            String(a.clientRequestId).localeCompare(String(b.clientRequestId)),
          ),
        );
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ clientRequestId: 'cannot-reopen' })),
        ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
      });

      it('deletes a conversation across every tenant for an all-tenants target', async () => {
        await enqueue({ clientRequestId: 'tenant-one' });
        await enqueue({ clientRequestId: 'tenant-two', tenantId: 'tenant-2' });
        await enqueue({ clientRequestId: 'untenanted', tenantId: undefined });
        await enqueue({ clientRequestId: 'kept', conversationId: 'conversation-2' });
        const all = [{ conversationId: 'conversation-1', allTenants: true as const }];
        expect(
          await turns().prepareAgentQueuedTurnConversationDeletion({
            user,
            targets: all,
            settledAt: START,
          }),
        ).toEqual([]);
        expect(
          await turns().deletePreparedAgentQueuedTurnConversations({ user, targets: all }),
        ).toBe(3);
        expect(
          (await harness.readRaw('agentqueuedturns')).map((turn) => turn.clientRequestId),
        ).toEqual(['kept']);
        for (const tenantId of ['tenant-1', 'tenant-2', undefined]) {
          await expect(
            turns().enqueueAgentQueuedTurn(enqueueInput({ tenantId, clientRequestId: 'again' })),
          ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
        }
      });

      it.each(['queued', 'claimed', 'reserving'] as const)(
        'cancels only the selected conversations’ %s turns',
        async (status) => {
          const otherUser = newId();
          const scopes = [
            { conversationId: 'conversation-1', tenantId: 'tenant-1' },
            { conversationId: 'conversation-3', tenantId: undefined },
            { conversationId: 'conversation-2', tenantId: 'tenant-1' },
            { conversationId: 'conversation-1', tenantId: 'tenant-2' },
            { conversationId: 'conversation-1', tenantId: undefined },
            { conversationId: 'conversation-1', tenantId: 'tenant-1', user: otherUser },
          ];
          const queued: string[] = [];
          for (const [index, target] of scopes.entries()) {
            if (status === 'reserving') {
              const record = rawTurn({ ...target, status, laneId: `lane-${index}`, activeSlot: 1 });
              if (target.tenantId === undefined) {
                delete record.tenantId;
              }
              await seedTurns(record);
              queued.push(record._id as string);
              continue;
            }
            const turn = await enqueue({ ...target, clientRequestId: `isolation-${index}` });
            const claim =
              status === 'claimed'
                ? await turns().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId, target))
                : null;
            expect(claim?.outcome ?? 'acquired').toBe('acquired');
            queued.push(turn.queuedTurnId);
          }
          const untouched = (await harness.readRaw('agentqueuedturns')).filter(
            (turn) => !queued.slice(0, 2).includes(turn._id as string),
          );
          const input = { user, targets: scopes.slice(0, 2), settledAt: START };
          expect(await turns().prepareAgentQueuedTurnConversationDeletion(input)).toEqual([]);
          for (const queuedTurnId of queued.slice(0, 2)) {
            expect(await storedTurn(queuedTurnId)).toMatchObject({
              status: 'cancelled',
              deliveryState: 'retired',
              terminalReceipt: { failure: { code: 'OWNER_DRAINED' } },
            });
          }
          expect(await turns().deletePreparedAgentQueuedTurnConversations(input)).toBe(2);
          expect(await harness.readRaw('agentqueuedturns')).toEqual(untouched);
        },
      );

      it('settles an empty conversation despite an unrelated published delivery, repeatably', async () => {
        const turn = await enqueue();
        await admit(turn, 'unrelated-published', 42);
        const before = await harness.readRaw('agentqueuedturns');
        for (const targets of [
          [{ conversationId: 'empty-chat', tenantId: 'tenant-1' }],
          [{ conversationId: 'conversation-1' }],
          [{ conversationId: 'conversation-1', tenantId: 'tenant-2' }],
          [{ conversationId: 'empty-chat', allTenants: true as const }],
        ]) {
          for (let pass = 0; pass < 2; pass++) {
            expect(
              await turns().prepareAgentQueuedTurnConversationDeletion({
                user,
                targets,
                settledAt: START,
              }),
            ).toEqual([]);
            expect(
              await turns().deletePreparedAgentQueuedTurnConversations({ user, targets }),
            ).toBe(0);
          }
        }
        expect(await harness.readRaw('agentqueuedturns')).toEqual(before);
      });

      it('includes the deliveries of dead and admitted turns, and waits for an admission to settle', async () => {
        const dead = await enqueue({ clientRequestId: 'dead-before-delete' });
        await publish(dead, 'delivery-dead');
        await turns().claimNextAgentQueuedTurn(claimInput(dead.queuedTurnId));
        await turns().releaseAgentQueuedTurn({
          ...claimInput(dead.queuedTurnId),
          disposition: 'dead',
          settledAt: START,
          failure: { code: 'TEST_DEAD', message: 'dead before deletion' },
        });
        // Priority: a dead turn heads the lane until dismissed, so it would block a FIFO successor.
        const admitting = await enqueue({
          clientRequestId: 'admission-during-delete',
          priority: true,
        });
        const { claim } = await startAdmission(admitting, 'delivery-admission');
        await expect(
          turns().prepareAgentQueuedTurnConversationDeletion({
            user,
            targets: target,
            settledAt: START,
          }),
        ).rejects.toThrow('admission must settle');
        expect(await storedTurn(admitting.queuedTurnId)).toMatchObject({
          status: 'claimed',
          admissionId: 'delivery-admission',
        });
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ clientRequestId: 'lane-still-open' })),
        ).resolves.toMatchObject({ replayed: false });
        await turns().markAgentQueuedTurnAdmitted({
          ...claim,
          admissionId: 'delivery-admission',
          admissionMode: 'ordinary',
          generationCreatedAt: 42,
          lineagePredecessorId: rootLineageId(),
          settledAt: LATER,
        });
        expect(
          (
            await turns().prepareAgentQueuedTurnConversationDeletion({
              user,
              targets: target,
              settledAt: LATER,
            })
          ).sort(),
        ).toEqual(['delivery-admission', 'delivery-dead']);
        await expect(
          turns().deletePreparedAgentQueuedTurnConversations({ user, targets: target }),
        ).rejects.toThrow('deliveries must retire');
        for (const deliveryKey of ['delivery-admission', 'delivery-dead']) {
          expect(await turns().markAgentQueuedTurnDeliveryRetired({ deliveryKey })).toBe(true);
          expect(await turns().markAgentQueuedTurnDeliveryRetired({ deliveryKey })).toBe(true);
        }
        expect(
          await turns().deletePreparedAgentQueuedTurnConversations({ user, targets: target }),
        ).toBe(3);
      });

      it('fences the deleted lane for 24 hours', async () => {
        await turns().prepareAgentQueuedTurnConversationDeletion({
          user,
          targets: [{ conversationId: 'never-queued', tenantId: 'tenant-1' }],
          settledAt: START,
        });
        const [lane] = await lanes();
        expect(lane).toMatchObject({ user, tenantId: 'tenant-1', conversationId: 'never-queued' });
        expect(timeOf(lane.retiredAt)).toBe(START.getTime());
        expect(timeOf(lane.expiresAt)).toBe(START.getTime() + 24 * 60 * 60_000);
        await expect(
          turns().enqueueAgentQueuedTurn(enqueueInput({ conversationId: 'never-queued' })),
        ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
      });

      it('throws a TypeError without a target', async () => {
        await expect(
          turns().prepareAgentQueuedTurnConversationDeletion({ user, targets: [] }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          turns().deletePreparedAgentQueuedTurnConversations({ user, targets: [] }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    describe('delivery retirement', () => {
      it('retires only a settled turn’s delivery', async () => {
        const turn = await enqueue();
        await publish(turn, 'delivery-live');
        expect(
          await turns().markAgentQueuedTurnDeliveryRetired({ deliveryKey: 'delivery-live' }),
        ).toBe(false);
        expect(await storedTurn(turn.queuedTurnId)).toMatchObject({ deliveryState: 'published' });
        expect(await turns().markAgentQueuedTurnDeliveryRetired({ deliveryKey: 'unknown' })).toBe(
          false,
        );
      });

      it('retires a settled source whose published delivery aged out, through the fence', async () => {
        const turn = await enqueue();
        await publish(turn, 'delivery-expired');
        await turns().cancelAgentQueuedTurn({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          settledAt: LATER,
        });
        expect(
          await turns().markAgentQueuedTurnMissingDeliveryRetired({
            deliveryKey: 'delivery-expired',
          }),
        ).toBe(false);
        expect(
          await turns().beginAgentQueuedTurnMissingDeliveryRetirement({
            deliveryKey: 'delivery-expired',
          }),
        ).toBe(true);
        expect(
          await turns().beginAgentQueuedTurnMissingDeliveryRetirement({
            deliveryKey: 'delivery-expired',
          }),
        ).toBe(true);
        expect(await storedTurn(turn.queuedTurnId)).toMatchObject({ deliveryState: 'retiring' });
        expect(
          await turns().markAgentQueuedTurnMissingDeliveryRetired({
            deliveryKey: 'delivery-expired',
          }),
        ).toBe(true);
        expect(
          await turns().markAgentQueuedTurnMissingDeliveryRetired({
            deliveryKey: 'delivery-expired',
          }),
        ).toBe(true);
        expect(await storedTurn(turn.queuedTurnId)).toMatchObject({
          status: 'cancelled',
          deliveryState: 'retired',
        });
        expect(
          await turns().beginAgentQueuedTurnMissingDeliveryRetirement({
            deliveryKey: 'delivery-expired',
          }),
        ).toBe(false);
      });

      it('infers no absence while publication can still cross the probe', async () => {
        const turn = await enqueue();
        await turns().reserveAgentQueuedTurnDelivery({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: 'delivery-race',
        });
        await turns().cancelAgentQueuedTurn({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          settledAt: START,
        });
        expect(
          await turns().beginAgentQueuedTurnMissingDeliveryRetirement({
            deliveryKey: 'delivery-race',
          }),
        ).toBe(false);
        await turns().markQueuedTurnScheduled({
          ...scope(),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: 'delivery-race',
          scheduledAt: LATER,
        });
        expect(
          await turns().beginAgentQueuedTurnMissingDeliveryRetirement({
            deliveryKey: 'delivery-race',
          }),
        ).toBe(true);
        expect(await storedTurn(turn.queuedTurnId)).toMatchObject({ deliveryState: 'retiring' });
      });

      it('fences an active turn from the missing-delivery path', async () => {
        const turn = await enqueue();
        await publish(turn, 'delivery-active');
        expect(
          await turns().beginAgentQueuedTurnMissingDeliveryRetirement({
            deliveryKey: 'delivery-active',
          }),
        ).toBe(false);
        expect(
          await turns().markAgentQueuedTurnMissingDeliveryRetired({
            deliveryKey: 'delivery-active',
          }),
        ).toBe(false);
        await expect(
          turns().markAgentQueuedTurnDeliveryRetired({ deliveryKey: ' ' }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });
  });
}
