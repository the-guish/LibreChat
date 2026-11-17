import type { AgentTriggerDeliveryClaim } from '~/types';
import type { ContractHarness } from '~/contracts/harness';
import type { EnqueueInput } from '~/contracts/triggerDelivery.fixtures';
import type { DataStore } from '~/ports';
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
} from '~/types';
import {
  createTriggerDeliveryFixtures,
  BACKGROUND_SOURCE,
  REMOTE_SOURCE,
  MINUTE,
  SECOND,
  START,
} from '~/contracts/triggerDelivery.fixtures';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL trigger delivery store (docs/postgres-port/PHASE4.md §3.5,
 * R2): parallel calls on separate pool clients (and on separate store sets, as replicas) claim a
 * due delivery once, take an expired lease once, allocate a lane's sequence without a gap or a
 * repeat, and let exactly one writer win each compare-and-set the protocol states: a worker's
 * settlement under its fence, the first background result, a result claim, a batch release
 * against its confirmation, a detached action reservation, and an Event Actor receipt's
 * verification against its compensation. Each case runs with the shadow check off (the
 * production path: one statement per guarded write, rechecked on the locked row) and on (the
 * lock-then-write path the contract suites take).
 */
const PARALLEL = 8;
const RECEIPT_V2 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2;
const BATCH_V3 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3;
const DETACHED = AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1;
const GENERATION = START.getTime() + 5 * SECOND;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

describePostgres('PostgreSQL trigger delivery store under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    const f = createTriggerDeliveryFixtures(harness);
    let stores: DataStore;
    const store = () => stores.agentTriggerDeliveries;

    beforeAll(async () => {
      await harness.setup();
      stores = harness.createStores();
    }, 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const claimers = (now = START, count = PARALLEL) =>
      Promise.all(
        range(count).map((index) =>
          f.claim({ workerId: `worker-${index}`, claimToken: `claim-${index}`, now }),
        ),
      );
    const claimed = (claims: Array<AgentTriggerDeliveryClaim | null>) =>
      claims.filter((claim): claim is AgentTriggerDeliveryClaim => claim != null);

    it('grants one winner among concurrent claims of a due delivery', async () => {
      await f.enqueue();
      const winners = claimed(await claimers());
      expect(winners).toHaveLength(1);
      const [row] = await f.deliveries();
      expect(row).toMatchObject({
        status: 'leased',
        leaseBy: winners[0].leaseBy,
        claimToken: winners[0].claimToken,
      });
    });

    it('spreads concurrent claimers over distinct deliveries, never one twice', async () => {
      for (const index of range(PARALLEL)) {
        await f.enqueue({ orderingKey: `lane-${index}` });
      }
      const winners = claimed(await claimers(START, PARALLEL * 2));
      expect(winners).toHaveLength(PARALLEL);
      expect(new Set(winners.map((claim) => claim.id)).size).toBe(PARALLEL);
      expect(new Set(winners.map((claim) => claim.claimToken)).size).toBe(PARALLEL);
    });

    it('takes over an expired lease once, and only past the skew margin', async () => {
      await f.enqueue();
      expect(await f.claim({ workerId: 'first', claimToken: 'first' })).not.toBeNull();
      expect(claimed(await claimers(f.at(MINUTE + 25 * SECOND)))).toHaveLength(0);
      const winners = claimed(await claimers(f.at(MINUTE + 31 * SECOND)));
      expect(winners).toHaveLength(1);
      expect(winners[0].claimToken).not.toBe('first');
    });

    it('lets one capable worker claim a shielded capability delivery', async () => {
      await f.enqueue({ requiredWorkerCapability: DETACHED });
      const claims = await Promise.all(
        range(PARALLEL).map((index) =>
          f.claim({
            workerId: `worker-${index}`,
            claimToken: `claim-${index}`,
            workerCapabilities: [DETACHED],
          }),
        ),
      );
      const winners = claimed(claims);
      expect(winners).toHaveLength(1);
      expect(winners[0].status).toBe('capability_leased');
      expect(await f.deliveries()).toEqual([
        expect.objectContaining({ status: 'leased', capabilityStatus: 'leased' }),
      ]);
    });

    it('allocates a lane sequence without a gap or a repeat across two store sets', async () => {
      const user = f.newUser();
      const replicas = [harness.createStores(), harness.createStores()];
      const enqueued = await Promise.all(
        range(24).map((index) =>
          replicas[index % 2].agentTriggerDeliveries.enqueueAgentTriggerDelivery(
            f.enqueueInput({ user, orderingKey: 'contended-lane' }),
          ),
        ),
      );
      expect(enqueued.map(({ delivery }) => delivery.laneSequence).sort((a, b) => a - b)).toEqual(
        range(24).map((index) => index + 1),
      );
      expect(await f.lane('contended-lane')).toMatchObject({ value: 24 });
      expect(await f.lane('contended-lane')).not.toHaveProperty('publisherDeliveryId');
    });

    it('stores one delivery for concurrent enqueues of one key', async () => {
      const input = f.enqueueInput({ orderingKey: 'replayed-lane' });
      const results = await Promise.all(
        range(PARALLEL).map(() => store().enqueueAgentTriggerDelivery(input)),
      );
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.delivery.id)).size).toBe(1);
      expect(results.every((result) => result.delivery.laneSequence === 1)).toBe(true);
      expect(await f.deliveries()).toHaveLength(1);
      expect(await f.lane('replayed-lane')).toMatchObject({ value: 1 });
    });

    it('settles a claimed attempt once among racing complete, retry and dead-letter', async () => {
      await f.enqueue();
      const { fence, attempt } = await f.claimAndBegin();
      const outcomes = await Promise.all([
        store().completeAgentTriggerDelivery({
          ...fence,
          attempt,
          result: { ok: true },
          settledAt: START,
        }),
        store().retryAgentTriggerDelivery({
          ...fence,
          attempt,
          error: f.failure(),
          availableAt: f.at(MINUTE),
        }),
        store().deadLetterAgentTriggerDelivery({
          ...fence,
          attempt,
          error: f.failure({ retryable: false }),
          settledAt: START,
        }),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const [row] = await f.deliveries();
      expect(row.history).toHaveLength(1);
    });

    it('begins one attempt per claim among concurrent begins', async () => {
      await f.enqueue();
      const claim = await f.claim();
      if (claim == null) throw new Error('Expected a claim');
      const fence = { id: claim.id, workerId: claim.leaseBy, claimToken: claim.claimToken };
      const attempts = await Promise.all(
        range(PARALLEL).map(() =>
          store().beginAgentTriggerDeliveryAttempt({ ...fence, now: START }),
        ),
      );
      const begun = attempts.filter((attempt): attempt is number => attempt != null);
      expect(new Set(begun).size).toBe(begun.length);
      const [row] = await f.deliveries();
      expect(row.attempts).toBe(begun.length);
    });

    describe('background results', () => {
      let user: string;
      beforeEach(() => {
        user = f.newUser();
      });
      const target = {
        conversationId: 'conversation',
        parentMessageId: 'parent',
        agentId: 'agent',
      };
      const enqueueBackground = (key: string, overrides: Partial<EnqueueInput> = {}) =>
        f.enqueue({
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
      const persist = (key: string, output: string) =>
        store().persistAgentBackgroundToolResult({
          deliveryKey: key,
          sourceId: BACKGROUND_SOURCE.id,
          result: { status: 'completed', output, settledAt: START },
        });
      const input = (deliveryKey: string) => ({
        deliveryKey,
        sourceId: BACKGROUND_SOURCE.id,
        userId: user,
        tenantId: 'tenant-1',
        ...target,
        limit: 8,
        maxMetadataChars: 16000,
      });
      const confirm = async (deliveryKey: string) => {
        const plan = await store().getAgentBackgroundToolResultBatch(input(deliveryKey));
        if (plan == null) return false;
        return store().confirmAgentBackgroundToolResultBatch({
          ...input(deliveryKey),
          batchId: plan.batchId,
        });
      };

      it('keeps the first of concurrent different results', async () => {
        await enqueueBackground('task');
        const stored = await Promise.all(
          range(PARALLEL).map((index) => persist('task', `o${index}`)),
        );
        expect(stored.filter(Boolean)).toHaveLength(1);
        const receipt = await store().getAgentBackgroundToolResult({
          deliveryKey: 'task',
          sourceId: BACKGROUND_SOURCE.id,
        });
        expect(receipt?.output).toBe(`o${stored.indexOf(true)}`);
      });

      it('replays one identical result to every concurrent writer', async () => {
        await enqueueBackground('task');
        const stored = await Promise.all(range(PARALLEL).map(() => persist('task', 'same')));
        expect(stored.every(Boolean)).toBe(true);
      });

      it('elects one claimant among concurrent result claims', async () => {
        await enqueueBackground('task', { requiredWorkerCapability: RECEIPT_V2 });
        await persist('task', 'output');
        const claims = await Promise.all(
          range(PARALLEL).map((index) =>
            store().claimAgentBackgroundToolResults({
              deliveryKey: 'task',
              sourceId: BACKGROUND_SOURCE.id,
              userId: user,
              conversationId: target.conversationId,
              parentMessageId: target.parentMessageId,
              agentId: target.agentId,
              claimId: `claim-${index}`,
              limit: 1,
            }),
          ),
        );
        expect(claims.filter((claim) => claim.status === 'acquired')).toHaveLength(1);
        const stamp = await store().getAgentBackgroundToolResultClaim({
          sourceId: BACKGROUND_SOURCE.id,
          userId: user,
          conversationId: target.conversationId,
          parentMessageId: target.parentMessageId,
          taskId: 'task',
        });
        expect(claims.filter((claim) => claim.status === 'claimed')).toEqual(
          Array(PARALLEL - 1).fill({ status: 'claimed', claimId: stamp?.claimId }),
        );
      });

      it('lets exactly one of a batch release and its confirmation win', async () => {
        for (const round of range(4)) {
          await harness.reset();
          await enqueueBackground(`one-${round}`);
          await persist(`one-${round}`, 'output-one');
          await enqueueBackground(`two-${round}`);
          await persist(`two-${round}`, 'output-two');
          const acquired = await store().claimAgentBackgroundToolResultBatch(input(`one-${round}`));
          expect(acquired.status).toBe('acquired');
          const [released, confirmed] = await Promise.all([
            store().releaseAgentBackgroundToolResultClaims({
              ...input(`one-${round}`),
              claimId: `one-${round}`,
            }),
            confirm(`one-${round}`),
          ]);
          expect(Number(released) + Number(confirmed)).toBe(1);
        }
      });
    });

    describe('Event Actor receipts', () => {
      const started = async (bindingId: string, conversationId: string) => {
        const user = f.newUser();
        const queued = await f.enqueue({
          user,
          awaitTerminalHandling: true,
          envelope: { mode: 'continue', target: { bindingId }, event: { source: REMOTE_SOURCE } },
        });
        await f.deliver({
          result: { status: 'started' },
          settledAt: new Date(GENERATION),
          awaitTerminalHandling: true,
          handling: {
            status: 'started',
            conversationId,
            streamId: conversationId,
            generationCreatedAt: GENERATION,
            startedAt: new Date(GENERATION),
          },
        });
        return {
          deliveryKey: queued.delivery.deliveryKey,
          user,
          tenantId: 'tenant-1',
          bindingId,
          conversationId,
        };
      };

      it('lets exactly one of a verification and a compensation settle the receipt', async () => {
        for (const round of range(4)) {
          const identity = await started(`binding-${round}`, `conversation-${round}`);
          const common = {
            ...identity,
            generationCreatedAt: GENERATION,
            settledAt: new Date(GENERATION + 4 * SECOND),
          };
          const checkpoint = {
            threadId: identity.conversationId,
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
          expect(stored?.actorReceipt?.resolution).toBe(
            verified ? 'checkpoint_verified' : 'action_compensated',
          );
        }
      });
    });
  });
});
