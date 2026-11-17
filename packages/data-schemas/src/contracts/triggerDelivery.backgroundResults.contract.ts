/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TriggerDeliveryStore` contract (`~/ports/triggerDelivery`), third part: the background tool
 * results a delivery carries, ported from `methods/triggerDelivery.spec.ts`. The pending listings
 * (what is still going to arrive, its order, the dead ones apart, the overfull conversation read
 * in two bounded parts, the legacy rows left out), the result receipt (first result wins, exact
 * replays, a dead letter or an erasure fencing a late write), the single-result claim and its
 * release, and the receipt batches (`envelope` paths, `backgroundToolResultBatch` with its
 * `candidates`/`members` arrays): the frozen membership a retry reads back, the followers'
 * owner status, the scope a batch never crosses (tenant, owner, branch, agent, conversation,
 * capability), the dispatch count that decides whether a release is proven safe, the queue
 * token fence, the confirmation that settles every member, and the composed release of the
 * parent message's claim stamps (`releaseBatchProjections`, the message store).
 *
 * Not here (they stay in the method spec): crashes, lost replies and pauses injected between the
 * batch writes by spies (`updateMany`/`updateOne`/`findOneAndUpdate`/`exec`), the index plan check,
 * and the stress report. Nothing here may import `mongoose` or the MongoDB driver.
 */
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
} from '~/types';
import type { AgentBackgroundToolResultBatchInput } from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import type { IdLike } from '~/ports/common';
import type { EnqueueInput } from './triggerDelivery.fixtures';
import {
  BACKGROUND_SOURCE,
  DAY,
  MESSAGES,
  QUEUED_TURN_SOURCE,
  START,
  SUBAGENT_SOURCE,
  SUCCESS_RETENTION_MS,
  createTriggerDeliveryFixtures,
} from './triggerDelivery.fixtures';
import { timeOf, useContractHarness } from './support';

const RECEIPT_V2 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2;
const BATCH_V3 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3;

export function describeTriggerDeliveryBackgroundResultsContract(harness: ContractHarness): void {
  describe(`TriggerDeliveryStore contract (background results): ${harness.name}`, () => {
    useContractHarness(harness);

    const f = createTriggerDeliveryFixtures(harness);
    const store = () => f.store();

    /** A background completion of `conversation-1` (receipt v2 unless overridden). */
    const completion = (user: string, taskId: string, overrides: Partial<EnqueueInput> = {}) =>
      f.enqueue({
        user,
        orderingKey: `background-lane-${taskId}`,
        envelope: {
          event: {
            source: BACKGROUND_SOURCE,
            payload: { taskId, toolCallId: `call-${taskId}`, toolName: 'slow_task' },
          },
          target: { conversationId: 'conversation-1' },
        },
        requiredWorkerCapability: RECEIPT_V2,
        ...overrides,
      });
    const persist = (deliveryKey: string, output = 'durable output', settledAt = START) =>
      store().persistAgentBackgroundToolResult({
        deliveryKey,
        sourceId: BACKGROUND_SOURCE.id,
        result: { status: 'completed', output, settledAt },
      });
    const pending = (user: IdLike, overrides: Record<string, unknown> = {}) =>
      store().listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: BACKGROUND_SOURCE.id,
        ...overrides,
      });

    /* ------------------------------------------------------------------ listings */

    describe('listPendingAgentBackgroundToolCompletions', () => {
      it('lists what is still going to arrive, running or settled, without the content', async () => {
        const user = f.newUser();
        const running = await completion(user, 'task-running');
        const settled = await completion(user, 'task-settled');
        await persist(settled.delivery.deliveryKey, 'secret output');
        await f.patchDelivery(running.delivery.id, { updatedAt: START });
        await f.patchDelivery(settled.delivery.id, { updatedAt: f.at(1) });

        const listed = await pending(user);
        expect(listed.truncated).toBe(false);
        expect(listed.dead).toEqual([]);
        expect(listed.completions).toEqual([
          {
            deliveryKey: running.delivery.deliveryKey,
            taskId: 'task-running',
            toolCallId: 'call-task-running',
            toolName: 'slow_task',
            dispatchedAt: expect.any(Date),
            claimedByWakeup: false,
          },
          {
            deliveryKey: settled.delivery.deliveryKey,
            taskId: 'task-settled',
            toolCallId: 'call-task-settled',
            toolName: 'slow_task',
            dispatchedAt: expect.any(Date),
            result: { status: 'completed', settledAt: START },
            claimedByWakeup: false,
          },
        ]);
        expect(timeOf(listed.completions[0].dispatchedAt)).toBe(timeOf(running.delivery.createdAt));
        expect(JSON.stringify(listed)).not.toContain('secret output');
      });

      it('lists the least recently updated first, ties by id', async () => {
        const user = f.newUser();
        const rows = [];
        for (const taskId of ['task-a', 'task-b', 'task-c']) {
          rows.push(await completion(user, taskId));
        }
        await f.patchDelivery(rows[0].delivery.id, { updatedAt: f.at(2) });
        await f.patchDelivery(rows[1].delivery.id, { updatedAt: START });
        await f.patchDelivery(rows[2].delivery.id, { updatedAt: START });
        const [low, high] = [rows[1], rows[2]].map((row) => row.delivery.id).sort();
        const byId = new Map(rows.map((row) => [row.delivery.id, row.delivery.deliveryKey]));
        expect((await pending(user)).completions.map((entry) => entry.deliveryKey)).toEqual([
          byId.get(low),
          byId.get(high),
          rows[0].delivery.deliveryKey,
        ]);
      });

      it('reports a wake-up claim on a listed result', async () => {
        const user = f.newUser();
        const queued = await completion(user, 'task-claimed', {
          envelope: {
            event: {
              source: BACKGROUND_SOURCE,
              payload: { taskId: 'task-claimed', toolCallId: 'call', toolName: 'slow_task' },
            },
            target: { conversationId: 'conversation-1', parentMessageId: 'response-1' },
          },
        });
        await persist(queued.delivery.deliveryKey);
        await store().claimAgentBackgroundToolResults({
          deliveryKey: queued.delivery.deliveryKey,
          sourceId: BACKGROUND_SOURCE.id,
          userId: user,
          conversationId: 'conversation-1',
          parentMessageId: 'response-1',
          claimId: 'claim-1',
        });
        expect((await pending(user)).completions).toEqual([
          expect.objectContaining({ taskId: 'task-claimed', claimedByWakeup: true }),
        ]);
      });

      it('leaves out delivered rows and everything outside the conversation, owner and source', async () => {
        const user = f.newUser();
        const delivered = await completion(user, 'task-delivered');
        await f.patchDelivery(delivered.delivery.id, { status: 'succeeded' });
        await completion(f.newUser(), 'task-other-user');
        await completion(user, 'task-other-conversation', {
          envelope: {
            event: {
              source: BACKGROUND_SOURCE,
              payload: {
                taskId: 'task-other-conversation',
                toolCallId: 'call',
                toolName: 'slow_task',
              },
            },
            target: { conversationId: 'conversation-2' },
          },
        });
        await completion(user, 'task-other-source', {
          envelope: {
            event: {
              source: QUEUED_TURN_SOURCE,
              payload: { taskId: 'task-other-source', toolCallId: 'call', toolName: 'slow_task' },
            },
            target: { conversationId: 'conversation-1' },
          },
        });
        await completion(user, 'task-legacy', {
          requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
        });
        const waiting = await completion(user, 'task-waiting');
        const batched = await completion(user, 'task-batched', {
          requiredWorkerCapability: BATCH_V3,
        });

        expect(
          (await pending(f.storeId(user))).completions.map((entry) => entry.deliveryKey).sort(),
        ).toEqual([waiting.delivery.deliveryKey, batched.delivery.deliveryKey].sort());
      });

      it('looks up one task and reports a truncated page', async () => {
        const user = f.newUser();
        const first = await completion(user, 'task-first');
        const second = await completion(user, 'task-second');
        await f.patchDelivery(first.delivery.id, { updatedAt: START });
        await f.patchDelivery(second.delivery.id, { updatedAt: f.at(1) });

        await expect(pending(user, { taskId: 'task-second' })).resolves.toEqual({
          completions: [expect.objectContaining({ deliveryKey: second.delivery.deliveryKey })],
          dead: [],
          truncated: false,
        });
        const page = await pending(user, { limit: 1 });
        expect(page.completions.map((entry) => entry.taskId)).toEqual(['task-second']);
        expect(page.truncated).toBe(true);
      });

      it('reports dead-lettered tasks apart from pending ones', async () => {
        const user = f.newUser();
        const privatelyDead = await completion(user, 'task-dead');
        await f.patchDelivery(privatelyDead.delivery.id, {
          status: 'leased',
          capabilityStatus: 'dead',
        });
        const deadLetter = await completion(user, 'task-dead-letter');
        await f.patchDelivery(deadLetter.delivery.id, { status: 'dead' });

        const listed = await pending(user);
        expect(listed.completions).toEqual([]);
        expect(listed.dead.map(({ taskId }) => taskId).sort()).toEqual([
          'task-dead',
          'task-dead-letter',
        ]);
        expect(listed.dead[0]).toEqual(
          expect.objectContaining({ toolName: 'slow_task', dispatchedAt: expect.any(Date) }),
        );
      });

      it('does not let 201 retained dead letters hide a new result or a late failure', async () => {
        const user = f.newUser();
        await harness.seedRaw(
          'agenttriggerdeliveries',
          Array.from({ length: 201 }, (_, index) => ({
            _id: harness.ids.generate(),
            deliveryKey: `background-dead-${index}`,
            fingerprint: `background-dead-${index}`,
            orderingKey: `background-dead-${index}`,
            laneSequence: 1,
            envelope: {
              event: {
                source: BACKGROUND_SOURCE,
                payload: {
                  taskId: `old-dead-${index}`,
                  toolCallId: `call-old-dead-${index}`,
                  toolName: 'slow_task',
                },
              },
              target: { conversationId: 'conversation-1' },
            },
            user,
            status: 'dead',
            requiredWorkerCapability: RECEIPT_V2,
            attempts: 1,
            availableAt: START,
            createdAt: f.at(index * 1_000),
            updatedAt: f.at(index * 1_000),
            backgroundToolResult: {
              status: 'completed',
              output: 'private output',
              settledAt: START,
            },
          })),
        );
        const waiting = await completion(user, 'new-pending');
        await persist(waiting.delivery.deliveryKey, 'private pending result');
        const late = await completion(user, 'late-failure');
        await persist(late.delivery.deliveryKey, 'private late result');
        await f.patchDelivery(late.delivery.id, { status: 'dead', createdAt: f.at(-60_000) });

        const listed = await pending(user);
        expect(listed.completions.map(({ taskId }) => taskId)).toEqual(['new-pending']);
        expect(listed.dead).toHaveLength(200);
        expect(listed.dead[0].taskId).toBe('late-failure');
        expect(listed.dead.some(({ taskId }) => taskId === 'old-dead-0')).toBe(false);
        expect(listed.truncated).toBe(true);
        expect(JSON.stringify(listed)).not.toContain('private');
      });

      it('refuses a malformed lookup', async () => {
        for (const overrides of [
          { conversationId: '' },
          { sourceId: '' },
          { taskId: '' },
          { limit: 0 },
          { limit: 1.5 },
        ]) {
          await expect(pending(f.newUser(), overrides)).rejects.toBeInstanceOf(TypeError);
        }
      });
    });

    describe('listUndeliveredAgentTriggerTaskIds', () => {
      it("lists a conversation's undelivered task ids of one source, oldest first", async () => {
        const user = f.newUser();
        const task = (taskId: string, conversationId = 'conversation-1') =>
          completion(user, taskId, {
            requiredWorkerCapability: undefined,
            envelope: {
              event: { source: SUBAGENT_SOURCE, payload: { taskId } },
              target: { conversationId },
            },
          });
        const second = await task('child-second');
        const first = await task('child-first');
        await f.patchDelivery(first.delivery.id, { createdAt: START });
        await f.patchDelivery(second.delivery.id, { createdAt: f.at(1) });
        const delivered = await task('child-delivered');
        await f.patchDelivery(delivered.delivery.id, { status: 'succeeded' });
        const dead = await task('child-dead');
        await f.patchDelivery(dead.delivery.id, { status: 'leased', capabilityStatus: 'dead' });
        await task('child-elsewhere', 'conversation-2');
        await completion(user, 'background-task');

        await expect(
          store().listUndeliveredAgentTriggerTaskIds({
            user,
            conversationId: 'conversation-1',
            sourceId: SUBAGENT_SOURCE.id,
          }),
        ).resolves.toEqual({ taskIds: ['child-first', 'child-second'], truncated: false });
        await expect(
          store().listUndeliveredAgentTriggerTaskIds({
            user: f.newUser(),
            conversationId: 'conversation-1',
            sourceId: SUBAGENT_SOURCE.id,
          }),
        ).resolves.toEqual({ taskIds: [], truncated: false });
        await expect(
          store().listUndeliveredAgentTriggerTaskIds({
            user,
            conversationId: '',
            sourceId: SUBAGENT_SOURCE.id,
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('truncates past 200 task ids', async () => {
        const user = f.newUser();
        await harness.seedRaw(
          'agenttriggerdeliveries',
          Array.from({ length: 201 }, (_, index) => ({
            _id: harness.ids.generate(),
            deliveryKey: `child-${index}`,
            fingerprint: `child-${index}`,
            orderingKey: `child-${index}`,
            laneSequence: 1,
            envelope: {
              event: { source: SUBAGENT_SOURCE, payload: { taskId: `task-${index}` } },
              target: { conversationId: 'conversation-1' },
            },
            user,
            status: 'pending',
            attempts: 0,
            availableAt: START,
            createdAt: f.at(index),
            updatedAt: f.at(index),
          })),
        );
        const listed = await store().listUndeliveredAgentTriggerTaskIds({
          user,
          conversationId: 'conversation-1',
          sourceId: SUBAGENT_SOURCE.id,
        });
        expect(listed.truncated).toBe(true);
        expect(listed.taskIds).toHaveLength(200);
        expect(listed.taskIds[0]).toBe('task-0');
        expect(listed.taskIds[199]).toBe('task-199');
      });
    });

    /* ------------------------------------------------------------------ receipts */

    describe('persistAgentBackgroundToolResult and getAgentBackgroundToolResult', () => {
      it('stores the first result, replays it exactly, and refuses a different one', async () => {
        const queued = await completion(f.newUser(), 'task-1');
        const input = {
          deliveryKey: queued.delivery.deliveryKey,
          sourceId: BACKGROUND_SOURCE.id,
          result: { status: 'completed' as const, output: 'durable output', settledAt: START },
        };
        const lookup = { deliveryKey: input.deliveryKey, sourceId: BACKGROUND_SOURCE.id };
        await expect(store().getAgentBackgroundToolResult(lookup)).resolves.toBeNull();
        await expect(store().persistAgentBackgroundToolResult(input)).resolves.toBe(true);
        await expect(store().persistAgentBackgroundToolResult(input)).resolves.toBe(true);
        await expect(store().getAgentBackgroundToolResult(lookup)).resolves.toEqual(input.result);
        for (const result of [
          { ...input.result, output: 'conflicting output' },
          { ...input.result, status: 'error' as const },
          { ...input.result, settledAt: f.at(1) },
        ]) {
          await expect(
            store().persistAgentBackgroundToolResult({ ...input, result }),
          ).resolves.toBe(false);
        }
        await expect(
          store().getAgentBackgroundToolResult({ ...lookup, sourceId: 'other-source' }),
        ).resolves.toBeNull();
        expect(await store().getAgentTriggerDelivery(input.deliveryKey)).not.toHaveProperty(
          'backgroundToolResult',
        );
        const row = await f.raw(input.deliveryKey);
        expect(timeOf(row?.updatedAt)).toBe(timeOf(queued.delivery.updatedAt));
      });

      it('refuses a result for a delivery without a receipt capability', async () => {
        const legacy = await completion(f.newUser(), 'legacy', {
          requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
        });
        await expect(persist(legacy.delivery.deliveryKey)).resolves.toBe(false);
        await expect(persist('missing')).resolves.toBe(false);
      });

      it.each([
        ['receipt', 'BACKGROUND_TOOL_PRODUCER_LOST'],
        ['death', 'BACKGROUND_TOOL_PRODUCER_LOST'],
        ['receipt', 'PARENT_STATE_UNAVAILABLE'],
        ['death', 'PARENT_STATE_UNAVAILABLE'],
      ])('fences result publication when %s wins (%s)', async (winner, code) => {
        const queued = await completion(f.newUser(), 'task-race');
        const begun = await f.claimAndBegin({ workerCapabilities: [RECEIPT_V2] });
        const write = () => persist(queued.delivery.deliveryKey, 'late output');
        const dead = () =>
          store().deadLetterAgentTriggerDelivery({
            ...begun.fence,
            attempt: begun.attempt,
            settledAt: START,
            error: f.failure({ code, retryable: code !== 'BACKGROUND_TOOL_PRODUCER_LOST' }),
          });
        await expect(winner === 'receipt' ? write() : dead()).resolves.toBe(true);
        await expect(winner === 'receipt' ? dead() : write()).resolves.toBe(false);
      });

      it.each(['shield', 'legacy'] as const)(
        'recovers a committed result after generic retry exhaustion through the %s fence',
        async (format) => {
          const queued = await completion(f.newUser(), 'task-exhausted');
          const begun = await f.claimAndBegin({ workerCapabilities: [RECEIPT_V2] });
          if (format === 'legacy') {
            await f.patchDelivery(queued.delivery.id, {
              status: 'capability_leased',
              leaseBy: begun.fence.workerId,
              claimToken: begun.fence.claimToken,
              leaseUntil: f.at(60_000),
              capabilityStatus: undefined,
              capabilityLeaseBy: undefined,
              capabilityLeaseUntil: undefined,
              capabilityClaimToken: undefined,
            });
          }
          await persist(queued.delivery.deliveryKey, 'saved output');
          const receiptRetryAt = f.at(300_000);
          const terminal = {
            ...begun.fence,
            attempt: begun.attempt,
            settledAt: START,
            receiptRetryAt,
            error: f.failure({ code: 'PARENT_STATE_UNAVAILABLE' }),
          };
          await expect(
            store().deadLetterAgentTriggerDelivery({ ...terminal, claimToken: 'stale' }),
          ).resolves.toBe(false);
          expect((await f.raw(queued.delivery.id))?.attempts).toBe(begun.attempt);
          await expect(store().deadLetterAgentTriggerDelivery(terminal)).resolves.toBe(false);
          const row = await f.raw(queued.delivery.id);
          expect(row).toMatchObject({
            attempts: 0,
            ...(format === 'shield'
              ? { capabilityStatus: 'pending' }
              : { status: 'capability_pending' }),
          });
          expect(timeOf(row?.claimAvailableAt)).toBe(receiptRetryAt.getTime());
          await expect(
            store().getAgentBackgroundToolResult({
              deliveryKey: queued.delivery.deliveryKey,
              sourceId: BACKGROUND_SOURCE.id,
            }),
          ).resolves.toMatchObject({ output: 'saved output' });

          const recovered = await f.claimAndBegin({
            claimToken: 'recovered',
            now: receiptRetryAt,
            workerCapabilities: [RECEIPT_V2],
          });
          expect(recovered.claim.id).toBe(queued.delivery.id);
          expect(recovered.attempt).toBe(1);
          await expect(
            store().deadLetterAgentTriggerDelivery({
              ...recovered.fence,
              attempt: recovered.attempt,
              settledAt: receiptRetryAt,
              receiptRetryAt,
              error: f.failure({ code: 'PARENT_NOT_FOUND', retryable: false }),
            }),
          ).resolves.toBe(true);
        },
      );

      it('refuses a malformed result', async () => {
        const queued = await completion(f.newUser(), 'task-malformed');
        for (const result of [
          { status: 'exploded', output: '', settledAt: START },
          { status: 'completed', output: 'x'.repeat(64 * 1024 + 1), settledAt: START },
          { status: 'completed', output: '', settledAt: new Date(Number.NaN) },
        ]) {
          await expect(
            store().persistAgentBackgroundToolResult({
              deliveryKey: queued.delivery.deliveryKey,
              sourceId: BACKGROUND_SOURCE.id,
              result: result as never,
            }),
          ).rejects.toBeInstanceOf(TypeError);
        }
        await expect(
          store().getAgentBackgroundToolResult({ deliveryKey: '', sourceId: BACKGROUND_SOURCE.id }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    /* ------------------------------------------------------------------ single claims */

    describe('claimAgentBackgroundToolResults, getAgentBackgroundToolResultClaim and releaseAgentBackgroundToolResultClaims', () => {
      const claimable = async (user: string) => {
        const queued = await f.enqueue({
          deliveryKey: 'background-completion-result-to-claim',
          user,
          envelope: {
            event: {
              source: BACKGROUND_SOURCE,
              payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'slow_tool' },
            },
            target: {
              agentId: 'agent-1',
              conversationId: 'conversation-1',
              parentMessageId: 'response-1',
            },
          },
          requiredWorkerCapability: RECEIPT_V2,
        });
        return {
          queued,
          claim: {
            deliveryKey: queued.delivery.deliveryKey,
            sourceId: BACKGROUND_SOURCE.id,
            userId: user,
            conversationId: 'conversation-1',
            parentMessageId: 'response-1',
            agentId: 'agent-1',
            claimId: 'delivery-claim-1',
            limit: 1,
          },
        };
      };
      const claimLookup = (user: string) => ({
        sourceId: BACKGROUND_SOURCE.id,
        userId: user,
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
        taskId: 'task-1',
      });

      it('elects one claimant before returning the output', async () => {
        const user = f.newUser();
        const { queued, claim } = await claimable(user);
        await expect(store().claimAgentBackgroundToolResults(claim)).resolves.toEqual({
          status: 'not_ready',
        });
        await persist(queued.delivery.deliveryKey, 'private output');

        await expect(store().claimAgentBackgroundToolResults(claim)).resolves.toEqual({
          status: 'acquired',
          results: [
            {
              taskId: 'task-1',
              toolCallId: 'call-1',
              toolName: 'slow_tool',
              status: 'completed',
              output: 'private output',
            },
          ],
        });
        await expect(store().claimAgentBackgroundToolResults(claim)).resolves.toMatchObject({
          status: 'acquired',
        });
        await expect(
          store().claimAgentBackgroundToolResults({ ...claim, claimId: 'delivery-claim-2' }),
        ).resolves.toEqual({ status: 'claimed', claimId: 'delivery-claim-1' });
        const stamp = await store().getAgentBackgroundToolResultClaim(claimLookup(user));
        expect(stamp).toMatchObject({ kind: 'wakeup', claimId: 'delivery-claim-1' });
        expect(stamp?.claimedAt).toBeInstanceOf(Date);
        await expect(
          store().getAgentBackgroundToolResultClaim({ ...claimLookup(user), taskId: 'task-2' }),
        ).resolves.toBeNull();
        await expect(
          store().claimAgentBackgroundToolResults({ ...claim, agentId: 'agent-2' }),
        ).resolves.toEqual({ status: 'not_ready' });
      });

      it('grants one claimant among concurrent claims', async () => {
        const user = f.newUser();
        const { queued, claim } = await claimable(user);
        await persist(queued.delivery.deliveryKey);
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            store().claimAgentBackgroundToolResults({ ...claim, claimId: `claim-${index}` }),
          ),
        );
        expect(results.filter((result) => result.status === 'acquired')).toHaveLength(1);
        const stamp = await store().getAgentBackgroundToolResultClaim(claimLookup(user));
        expect(results.filter((result) => result.status === 'claimed')).toEqual(
          Array(5).fill({ status: 'claimed', claimId: stamp?.claimId }),
        );
      });

      it('releases only the claimant, so another may claim', async () => {
        const user = f.newUser();
        const { queued, claim } = await claimable(user);
        await persist(queued.delivery.deliveryKey);
        await store().claimAgentBackgroundToolResults(claim);
        const release = {
          sourceId: BACKGROUND_SOURCE.id,
          userId: user,
          conversationId: 'conversation-1',
          parentMessageId: 'response-1',
          claimId: 'delivery-claim-1',
        };
        await expect(
          store().releaseAgentBackgroundToolResultClaims({ ...release, claimId: 'someone-else' }),
        ).resolves.toBe(true);
        await expect(
          store().getAgentBackgroundToolResultClaim(claimLookup(user)),
        ).resolves.not.toBeNull();
        await expect(store().releaseAgentBackgroundToolResultClaims(release)).resolves.toBe(true);
        await expect(
          store().getAgentBackgroundToolResultClaim(claimLookup(user)),
        ).resolves.toBeNull();
        await expect(
          store().claimAgentBackgroundToolResults({ ...claim, claimId: 'delivery-claim-2' }),
        ).resolves.toMatchObject({ status: 'acquired' });
      });

      it('keeps a receipt-v2 claim readable at the paths older manual polls use', async () => {
        const user = f.newUser();
        const { queued, claim } = await claimable(user);
        await persist(queued.delivery.deliveryKey);
        await store().claimAgentBackgroundToolResults({ ...claim, claimId: 'one' });
        const row = await f.raw(queued.delivery.deliveryKey);
        expect(row).toMatchObject({
          requiredWorkerCapability: RECEIPT_V2,
          envelope: {
            target: { conversationId: 'conversation-1', parentMessageId: 'response-1' },
            event: { payload: { taskId: 'task-1' } },
          },
          backgroundToolResult: { resultClaim: { kind: 'wakeup', claimId: 'one' } },
        });
      });

      it('refuses a malformed claim or release', async () => {
        const user = f.newUser();
        const { claim } = await claimable(user);
        await expect(
          store().claimAgentBackgroundToolResults({ ...claim, claimId: '' }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          store().claimAgentBackgroundToolResults({ ...claim, conversationId: 'x'.repeat(257) }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            sourceId: BACKGROUND_SOURCE.id,
            userId: user,
            conversationId: 'conversation-1',
            parentMessageId: 'response-1',
            claimId: 'x'.repeat(129),
          }),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    /* ------------------------------------------------------------------ batches */

    describe('receipt batches', () => {
      let user: string;
      beforeEach(() => {
        user = f.newUser();
      });

      const target = {
        conversationId: 'conversation',
        parentMessageId: 'parent',
        agentId: 'agent',
      };
      const ready = async (key: string, overrides: Partial<EnqueueInput> = {}) => {
        await f.enqueue({
          deliveryKey: key,
          orderingKey: `lane-${key}`,
          user,
          tenantId: 'tenant-1',
          requiredWorkerCapability: BATCH_V3,
          envelope: {
            event: {
              type: 'background-tool.completion',
              source: BACKGROUND_SOURCE,
              payload: { taskId: key, toolCallId: `call-${key}`, toolName: 'tool' },
            },
            target,
          },
          ...overrides,
        });
        await store().persistAgentBackgroundToolResult({
          deliveryKey: key,
          sourceId: BACKGROUND_SOURCE.id,
          result: { status: 'completed', output: `output-${key}`, settledAt: START },
        });
      };
      const input = (deliveryKey: string): AgentBackgroundToolResultBatchInput => ({
        deliveryKey,
        sourceId: BACKGROUND_SOURCE.id,
        userId: user,
        tenantId: 'tenant-1',
        ...target,
        limit: 8,
        maxMetadataChars: 16000,
      });
      const batch = (
        deliveryKey: string,
        overrides: Partial<AgentBackgroundToolResultBatchInput> = {},
      ) => store().claimAgentBackgroundToolResultBatch({ ...input(deliveryKey), ...overrides });
      const confirm = async (deliveryKey: string) => {
        const plan = await store().getAgentBackgroundToolResultBatch(input(deliveryKey));
        if (plan == null) return false;
        return store().confirmAgentBackgroundToolResultBatch({
          ...input(deliveryKey),
          batchId: plan.batchId,
        });
      };
      const resultClaim = (taskId: string) =>
        store().getAgentBackgroundToolResultClaim({ ...input(taskId), taskId });
      const retireDeadOwner = async (key: string) => {
        await f.patchDelivery(key, { capabilityStatus: 'dead' });
        await expect(
          store().retireAgentTriggerDelivery({
            deliveryKey: key,
            sourceId: BACKGROUND_SOURCE.id,
            reason: 'recovery',
            onlyIfDead: true,
            settledAt: START,
          }),
        ).resolves.toBe(true);
      };

      it('freezes ready membership, defers followers, and confirms every receipt', async () => {
        await ready('one');
        await ready('two');
        const acquired = await batch('one');
        expect(acquired).toMatchObject({
          status: 'acquired',
          batchId: expect.any(String),
          results: [
            {
              taskId: 'one',
              toolCallId: 'call-one',
              toolName: 'tool',
              status: 'completed',
              output: 'output-one',
            },
            { taskId: 'two', output: 'output-two' },
          ],
        });
        if (acquired.status !== 'acquired') throw new Error('Expected acquired batch');
        await expect(batch('two')).resolves.toEqual({
          status: 'claimed',
          claimId: 'one',
          batchId: acquired.batchId,
          ownerStatus: 'pending',
        });
        await expect(resultClaim('two')).resolves.toMatchObject({
          kind: 'wakeup',
          claimId: 'one',
          batchId: acquired.batchId,
        });
        await ready('late');
        expect(await batch('one')).toEqual(acquired);
        const plan = await store().getAgentBackgroundToolResultBatch(input('one'));
        expect(plan).toMatchObject({
          batchId: acquired.batchId,
          dispatchCount: 0,
          members: ['one', 'two'],
        });
        expect(plan?.candidates.slice().sort()).toEqual(['one', 'two']);

        expect(await confirm('one')).toBe(true);
        expect(await confirm('one')).toBe(true);
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'applied',
        });
        expect((await resultClaim('two'))?.appliedAt).toBeInstanceOf(Date);
        await f.dropRaw('agenttriggerdeliveries', (row) => row.deliveryKey === 'one');
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'applied',
        });
        expect((await batch('late')).status).toBe('acquired');
      });

      it('waits for a result, and tells legacy deliveries apart', async () => {
        await f.enqueue({
          deliveryKey: 'unsettled',
          orderingKey: 'lane-unsettled',
          user,
          requiredWorkerCapability: BATCH_V3,
          envelope: {
            event: {
              type: 'background-tool.completion',
              source: BACKGROUND_SOURCE,
              payload: { taskId: 'unsettled', toolCallId: 'call', toolName: 'tool' },
            },
            target,
          },
        });
        await expect(batch('unsettled')).resolves.toEqual({
          status: 'not_ready',
          waitingForResult: true,
        });
        await ready('v2', { requiredWorkerCapability: RECEIPT_V2 });
        await expect(batch('v2')).resolves.toEqual({ status: 'legacy' });
        await expect(batch('missing')).resolves.toEqual({ status: 'legacy' });
        await expect(
          store().getAgentBackgroundToolResultBatch(input('unsettled')),
        ).resolves.toBeNull();
      });

      it('never mixes tenants, owners, branches, agents, conversations or v2 deliveries', async () => {
        await ready('one');
        await ready('v2', { requiredWorkerCapability: RECEIPT_V2 });
        await ready('tenant', { tenantId: 'tenant-2' });
        await ready('user', { user: f.newUser() });
        for (const [key, field, value] of [
          ['branch', 'parentMessageId', 'other-parent'],
          ['agent', 'agentId', 'other-agent'],
          ['conversation', 'conversationId', 'other-conversation'],
        ] as const) {
          await ready(key, {
            envelope: {
              event: {
                type: 'background-tool.completion',
                source: BACKGROUND_SOURCE,
                payload: { taskId: key, toolCallId: key, toolName: 'tool' },
              },
              target: { ...target, [field]: value },
            },
          });
        }
        expect(await batch('one')).toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'one' }],
        });
        expect(((await batch('one')) as { results: unknown[] }).results).toHaveLength(1);
        await expect(batch('v2')).resolves.toEqual({ status: 'legacy' });
        await expect(batch('tenant')).resolves.toEqual({ status: 'not_ready' });
      });

      it('batches untenanted deliveries only with untenanted ones', async () => {
        await ready('plain-one', { tenantId: undefined });
        await ready('plain-two', { tenantId: undefined });
        await ready('tenanted');
        const acquired = await batch('plain-one', { tenantId: undefined });
        expect(acquired).toMatchObject({ status: 'acquired' });
        expect(
          (acquired as { results: Array<{ taskId: string }> }).results.map(
            (result) => result.taskId,
          ),
        ).toEqual(['plain-one', 'plain-two']);
        await expect(batch('plain-one')).resolves.toEqual({ status: 'not_ready' });
      });

      it('releases every member and clears the frozen plan after a definite rejection', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        await expect(
          store().releaseAgentBackgroundToolResultClaims({ ...input('one'), claimId: 'one' }),
        ).resolves.toBe(true);
        await expect(resultClaim('one')).resolves.toBeNull();
        await expect(resultClaim('two')).resolves.toBeNull();
        await expect(store().getAgentBackgroundToolResultBatch(input('one'))).resolves.toBeNull();
        expect((await batch('two')).status).toBe('acquired');
      });

      it('releases the parent message claim stamps of the batch', async () => {
        await ready('one');
        await ready('two');
        const acquired = await batch('one');
        if (acquired.status !== 'acquired') throw new Error('Expected acquired batch');
        const stamp = { kind: 'wakeup', claimId: 'one', batchId: acquired.batchId };
        const part = (taskId: string, resultClaim?: RawRecord) => ({
          type: 'tool_call',
          tool_call: {
            id: `call-${taskId}`,
            name: 'tool',
            backgroundTask: { taskId, ...(resultClaim != null && { resultClaim }) },
          },
        });
        await harness.seedRaw(MESSAGES, [
          {
            _id: harness.ids.generate(),
            messageId: 'parent',
            conversationId: 'conversation',
            user,
            isCreatedByUser: false,
            content: [
              part('one', stamp),
              part('two', stamp),
              part('other', { ...stamp, claimId: 'x' }),
            ],
            createdAt: START,
            updatedAt: START,
          },
        ]);

        await expect(
          store().releaseAgentBackgroundToolResultClaims({ ...input('one'), claimId: 'one' }),
        ).resolves.toBe(true);
        const [message] = await harness.readRaw(MESSAGES);
        const claims = (message.content as Array<{ tool_call: { backgroundTask: RawRecord } }>).map(
          (entry) => entry.tool_call.backgroundTask.resultClaim ?? null,
        );
        expect(claims).toEqual([null, null, { ...stamp, claimId: 'x' }]);
      });

      it('keeps followers recoverable when their root dies or is retired', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        await f.patchDelivery('one', { status: 'leased', capabilityStatus: 'dead' });
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'recoverable',
        });

        await f.patchDelivery('one', {
          status: 'succeeded',
          capabilityStatus: undefined,
          result: { backgroundToolCompletionRetired: true },
        });
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'recoverable',
        });
        expect(await f.raw('two')).toBeDefined();
      });

      it('keeps v2 workers off a batch root and its followers', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        await expect(f.claim({ workerCapabilities: [RECEIPT_V2] })).resolves.toBeNull();
        await expect(
          f.claim({ workerCapabilities: [BATCH_V3], claimToken: 'new' }),
        ).resolves.not.toBeNull();
      });

      it('cannot discard a follower once a root acquired its receipt', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        await expect(
          store().retireAgentTriggerDelivery({
            deliveryKey: 'two',
            sourceId: BACKGROUND_SOURCE.id,
            settledAt: START,
            reason: 'discarded',
            onlyIfUnclaimed: true,
            requireTransition: true,
          }),
        ).resolves.toBe(false);
        expect(await batch('one')).toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'one' }, { taskId: 'two' }],
        });
      });

      it('retains frozen membership across an ambiguous dispatch and its failed retry', async () => {
        await ready('one');
        await ready('two');
        const acquired = await batch('one');
        if (acquired.status !== 'acquired') throw new Error('Expected acquired batch');
        const owner = { ...input('one'), batchId: acquired.batchId };
        await expect(
          store().beginAgentBackgroundToolResultBatchDispatch({ ...owner, dispatchId: 'first' }),
        ).resolves.toBe(true);
        await ready('late');
        await expect(
          store().beginAgentBackgroundToolResultBatchDispatch({ ...owner, dispatchId: 'retry' }),
        ).resolves.toBe(true);
        expect(await store().getAgentBackgroundToolResultBatch(input('one'))).toMatchObject({
          dispatchCount: 2,
          dispatchId: 'retry',
        });
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            ...owner,
            claimId: 'one',
            dispatchId: 'retry',
          }),
        ).resolves.toBe(false);
        expect(await batch('one')).toEqual(acquired);
        await expect(store().confirmAgentBackgroundToolResultBatch(owner)).resolves.toBe(true);
        await expect(resultClaim('late')).resolves.toBeNull();
        expect((await batch('late')).status).toBe('acquired');
      });

      it('releases only a proven first handoff failure', async () => {
        await ready('one');
        await ready('two');
        const acquired = await batch('one');
        if (acquired.status !== 'acquired') throw new Error('Expected acquired batch');
        const owner = { ...input('one'), batchId: acquired.batchId };
        await store().beginAgentBackgroundToolResultBatchDispatch({
          ...owner,
          dispatchId: 'first',
        });
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            ...owner,
            claimId: 'one',
            dispatchId: 'different-attempt',
          }),
        ).resolves.toBe(false);
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            ...owner,
            claimId: 'one',
            dispatchId: 'first',
          }),
        ).resolves.toBe(true);
      });

      it('refuses dispatch for another batch, after confirmation, or after retirement', async () => {
        await ready('one');
        await ready('two');
        const acquired = await batch('one');
        if (acquired.status !== 'acquired') throw new Error('Expected acquired batch');
        const owner = { ...input('one'), batchId: acquired.batchId };
        await expect(
          store().beginAgentBackgroundToolResultBatchDispatch({
            ...owner,
            batchId: 'other-batch',
            dispatchId: 'x',
          }),
        ).resolves.toBe(false);
        await expect(
          store().confirmAgentBackgroundToolResultBatch({ ...owner, batchId: 'other-batch' }),
        ).resolves.toBe(false);
        await retireDeadOwner('one');
        await expect(
          store().beginAgentBackgroundToolResultBatchDispatch({ ...owner, dispatchId: 'late' }),
        ).resolves.toBe(false);
      });

      it('fences release and confirmation on the queue token', async () => {
        await ready('one');
        await ready('two');
        await f.patchDelivery('one', { capabilityClaimToken: 'current' });
        expect((await batch('one', { deliveryClaimToken: 'current' })).status).toBe('acquired');
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            ...input('one'),
            claimId: 'one',
            deliveryClaimToken: 'expired',
          }),
        ).resolves.toBe(false);
        expect((await batch('two')).status).toBe('claimed');
        expect(await confirm('one')).toBe(true);
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            ...input('one'),
            claimId: 'one',
            deliveryClaimToken: 'current',
          }),
        ).resolves.toBe(false);
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'applied',
        });
      });

      it('lets exactly one of a release and a confirmation win', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        const [released, confirmed] = await Promise.all([
          store().releaseAgentBackgroundToolResultClaims({ ...input('one'), claimId: 'one' }),
          confirm('one'),
        ]);
        expect(Number(released) + Number(confirmed)).toBe(1);
      });

      it('bounds the selection, down to a batch of one', async () => {
        await ready('one');
        await ready('two');
        expect(await batch('one', { limit: 1 })).toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'one' }],
        });
        await expect(resultClaim('two')).resolves.toBeNull();
        await expect(batch('one', { limit: 0 })).rejects.toBeInstanceOf(TypeError);
        await expect(batch('one', { maxMetadataChars: 0 })).rejects.toBeInstanceOf(TypeError);
        await expect(batch('')).rejects.toBeInstanceOf(TypeError);
      });

      it('reduces concurrent conversations to one turn each without duplicates', async () => {
        const keys: string[][] = [];
        for (let group = 0; group < 3; group += 1) {
          keys.push([]);
          for (let task = 0; task < 4; task += 1) {
            const key = `group-${group}-task-${task}`;
            keys[group].push(key);
            await ready(key, {
              envelope: {
                event: {
                  type: 'background-tool.completion',
                  source: BACKGROUND_SOURCE,
                  payload: { taskId: key, toolCallId: key, toolName: 'tool' },
                },
                target: { ...target, conversationId: `conversation-${group}` },
              },
            });
          }
        }
        const consumed: string[] = [];
        let turns = 0;
        for (let round = 0; round < 4; round += 1) {
          await Promise.all(
            keys.map(async (group, index) => {
              const claim = { ...input(group[round]), conversationId: `conversation-${index}` };
              const result = await store().claimAgentBackgroundToolResultBatch(claim);
              if (result.status !== 'acquired') return;
              turns += 1;
              consumed.push(...result.results.map((entry) => entry.taskId));
              await store().confirmAgentBackgroundToolResultBatch({
                ...claim,
                batchId: result.batchId,
              });
            }),
          );
        }
        expect(turns).toBe(3);
        expect(consumed.slice().sort()).toEqual(keys.flat().sort());
      });

      it('retains a retired owner until every claim is released', async () => {
        await ready('one');
        await ready('two');
        const acquired = await batch('one');
        if (acquired.status !== 'acquired') throw new Error('Expected acquired batch');
        await retireDeadOwner('one');
        /** The recovering process stopped before the release: the owner keeps no deadline. */
        expect(await f.raw('one')).not.toHaveProperty('expiresAt');
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'recoverable',
        });
        await expect(
          store().releaseAgentBackgroundToolResultClaims({
            ...input('one'),
            claimId: 'one',
            batchId: acquired.batchId,
            recoveryFenced: true,
          }),
        ).resolves.toBe(true);
        const owner = await f.raw('one');
        expect(owner).not.toHaveProperty('backgroundToolResultBatch');
        expect(timeOf(owner?.expiresAt)).toBeGreaterThan(Date.now() + SUCCESS_RETENTION_MS - DAY);
        expect((await batch('two')).status).toBe('acquired');
      });

      it('copies admission proof to a retired owner when the batch is confirmed', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        await retireDeadOwner('one');
        expect(await confirm('one')).toBe(true);
        const owner = await f.raw('one');
        expect((owner?.backgroundToolResultBatch as RawRecord)?.proofCopiedAt).toBeInstanceOf(Date);
        expect(owner?.expiresAt).toBeInstanceOf(Date);
        await expect(batch('one')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'applied',
        });
        await f.dropRaw('agenttriggerdeliveries', (row) => row.deliveryKey === 'one');
        await expect(batch('two')).resolves.toMatchObject({
          status: 'claimed',
          ownerStatus: 'applied',
        });
      });

      it('finishes an interrupted release on the next claim of the root', async () => {
        await ready('one');
        await ready('two');
        const old = await batch('one');
        if (old.status !== 'acquired') throw new Error('Expected acquired batch');
        /** A release marked the plan and stopped before clearing the receipts. */
        await f.patchDelivery('one', (row) => ({
          backgroundToolResultBatch: {
            ...(row.backgroundToolResultBatch as RawRecord),
            releasing: true,
            releaseId: 'interrupted-release',
          },
        }));
        const resumed = await batch('one');
        expect(resumed).toMatchObject({
          status: 'acquired',
          results: [{ taskId: 'one' }, { taskId: 'two' }],
        });
        expect((resumed as { batchId: string }).batchId).not.toBe(old.batchId);
        await expect(resultClaim('two')).resolves.toMatchObject({
          batchId: (resumed as { batchId: string }).batchId,
        });
      });

      it('erases private batch state with the conversation results and keeps it out of reads', async () => {
        await ready('one');
        await ready('two');
        await batch('one');
        expect(await store().getAgentTriggerDelivery('one')).not.toHaveProperty(
          'backgroundToolResultBatch',
        );
        await store().eraseAgentTriggerDeliveryConversationResults(user, ['conversation']);
        const row = await f.raw('one');
        expect(row).not.toHaveProperty('backgroundToolResultBatch');
        expect(row).not.toHaveProperty('backgroundToolResult');
        expect(row?.backgroundToolResultErasedAt).toBeInstanceOf(Date);
        await expect(store().getAgentBackgroundToolResultBatch(input('one'))).resolves.toBeNull();
      });
    });
  });
}
