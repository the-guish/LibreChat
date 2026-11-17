import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { EnqueueAgentQueuedTurnStoreInput } from '~/ports/queuedTurn';
import type { AgentQueuedTurnStore } from '~/ports/queuedTurn';
import {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnLaneRetiredError,
} from '~/methods/queuedTurn';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL queued-turn store (docs/postgres-port/PHASE4.md §3.5): calls
 * from separate store instances (separate pool clients, no shared in-process lane queue) contend
 * through the lane writer lease and the partial unique indexes alone. Concurrent enqueues get
 * distinct increasing sequences and slots in one lane, replay one request once and stop at the
 * capacity; one turn per lane holds the claim and the admission slot whoever races for it; a
 * started admission is started once; a reconciliation lease goes to one reconciler; the raw
 * fences reject all but one concurrent writer; a lane retired while enqueues race leaves no
 * active turn behind. Each case runs with the shadow check off (the production path: one
 * statement per guarded write, rechecked on the locked row) and on (the lock-then-write path the
 * contract suites take).
 */
const PARALLEL = 8;
const START = new Date('2026-08-30T12:00:00.000Z');
const LATER = new Date(START.getTime() + 60_000);
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

describePostgres('PostgreSQL queued-turn store under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    /** A new store instance: its own composition, so its own in-process lane queue. */
    const fresh = (): AgentQueuedTurnStore => harness.createStores().agentQueuedTurns;
    let user: string;

    beforeAll(() => harness.setup(), 120_000);
    afterAll(() => harness.teardown());
    beforeEach(async () => {
      await harness.reset();
      user = harness.ids.generate();
    });

    const scope = (conversationId = 'conversation-1') => ({
      user,
      tenantId: 'tenant-1',
      conversationId,
    });
    const enqueueInput = (
      clientRequestId: string,
      overrides: Partial<EnqueueAgentQueuedTurnStoreInput> = {},
    ): EnqueueAgentQueuedTurnStoreInput => ({
      ...scope(),
      agentId: 'agent-1',
      parentMessageId: 'parent-1',
      clientRequestId,
      text: `turn ${clientRequestId}`,
      availableAt: START,
      ...overrides,
    });
    const claimInput = (queuedTurnId: string, claimId: string, conversationId?: string) => ({
      ...scope(conversationId),
      queuedTurnId,
      claimId,
      claimBy: `worker-${claimId}`,
      now: START,
      leaseUntil: LATER,
    });
    const storedTurns = () => harness.readRaw('agentqueuedturns');
    const rawTurn = (extra: RawRecord): RawRecord => ({
      _id: harness.ids.generate(),
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      parentMessageId: 'parent-1',
      clientRequestId: `raw-${harness.ids.generate()}`,
      fingerprint: 'x'.repeat(43),
      laneId: 'lane-raw',
      status: 'queued',
      priority: false,
      text: 'raw turn',
      attempts: 0,
      availableAt: START,
      deliveryState: 'pending',
      createdAt: START,
      updatedAt: START,
      ...extra,
    });
    /** Enqueues, publishes and claims a turn of `conversationId`, the claim id its delivery key. */
    const claimPublished = async (conversationId: string, deliveryKey: string) => {
      const store = fresh();
      const { turn } = await store.enqueueAgentQueuedTurn({
        ...enqueueInput(`request-${deliveryKey}`),
        conversationId,
      });
      const target = { ...scope(conversationId), queuedTurnId: turn.queuedTurnId, deliveryKey };
      await store.reserveAgentQueuedTurnDelivery(target);
      await store.markQueuedTurnScheduled({ ...target, scheduledAt: START });
      const claim = claimInput(turn.queuedTurnId, deliveryKey, conversationId);
      expect((await store.claimNextAgentQueuedTurn(claim)).outcome).toBe('acquired');
      return { turn, claim };
    };

    it('gives concurrent enqueues distinct increasing sequences and slots in one lane', async () => {
      const results = await Promise.all(
        range(PARALLEL).map((index) => fresh().enqueueAgentQueuedTurn(enqueueInput(`c-${index}`))),
      );
      expect(results.every(({ replayed }) => !replayed)).toBe(true);
      expect(results.map(({ turn }) => turn.sequence).sort((a, b) => a - b)).toEqual(
        range(PARALLEL).map((index) => index + 1),
      );
      expect(new Set(results.map(({ turn }) => turn.activeSlot)).size).toBe(PARALLEL);
      expect(new Set(results.map(({ turn }) => turn.laneId)).size).toBe(1);
      const lanes = await harness.readRaw('agentqueuedturnsequences');
      expect(lanes).toHaveLength(1);
      expect(lanes[0]).toMatchObject({ value: PARALLEL });
      expect(lanes[0].writerId == null).toBe(true);
      expect((await storedTurns()).every((turn) => turn.status === 'queued')).toBe(true);
    });

    it('stores one turn for concurrent retries of one request, the others replaying it', async () => {
      const results = await Promise.all(
        range(PARALLEL).map(() => fresh().enqueueAgentQueuedTurn(enqueueInput('same-request'))),
      );
      expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
      expect(new Set(results.map(({ turn }) => turn.queuedTurnId)).size).toBe(1);
      expect(await storedTurns()).toHaveLength(1);
    });

    it('stops concurrent enqueues at the capacity of 100 active turns', async () => {
      await harness.seedRaw(
        'agentqueuedturns',
        range(98).map((index) => rawTurn({ sequence: index + 1, activeSlot: index })),
      );
      const results = await Promise.allSettled(
        range(6).map((index) => fresh().enqueueAgentQueuedTurn(enqueueInput(`over-${index}`))),
      );
      const fulfilled = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.turn] : [],
      );
      const rejected = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      expect(fulfilled.map((turn) => turn.sequence).sort((a, b) => a - b)).toEqual([99, 100]);
      expect(
        fulfilled.map((turn) => turn.activeSlot).sort((a, b) => Number(a) - Number(b)),
      ).toEqual([98, 99]);
      expect(rejected).toHaveLength(4);
      for (const reason of rejected) {
        expect(reason).toBeInstanceOf(AgentQueuedTurnCapacityError);
      }
      expect(await storedTurns()).toHaveLength(100);
    });

    it('lets one turn of a lane hold the claim and the admission slot, whichever claims race', async () => {
      const store = fresh();
      const turns = [];
      for (const index of range(PARALLEL)) {
        turns.push((await store.enqueueAgentQueuedTurn(enqueueInput(`claim-${index}`))).turn);
      }
      const results = await Promise.all(
        turns.map((turn, index) =>
          fresh().claimNextAgentQueuedTurn(claimInput(turn.queuedTurnId, `claim-${index}`)),
        ),
      );
      const acquired = results.filter((result) => result.outcome === 'acquired');
      expect(acquired).toHaveLength(1);
      expect(acquired[0].claim?.queuedTurnId).toBe(turns[0].queuedTurnId);
      expect(results.filter((result) => result.outcome === 'blocked')).toHaveLength(PARALLEL - 1);
      const stored = await storedTurns();
      expect(stored.filter((turn) => turn.status === 'claimed')).toHaveLength(1);
      expect(stored.filter((turn) => turn.admissionSlot === true)).toHaveLength(1);
    });

    it('gives the lane head to one of several workers, and an expired lease to one of several', async () => {
      const { turn } = await fresh().enqueueAgentQueuedTurn(enqueueInput('head'));
      const first = await Promise.all(
        range(PARALLEL).map((index) =>
          fresh().claimNextAgentQueuedTurn({
            ...claimInput(turn.queuedTurnId, `first-${index}`),
            leaseUntil: new Date(START.getTime() + 1),
          }),
        ),
      );
      expect(first.filter((result) => result.outcome === 'acquired')).toHaveLength(1);
      const now = new Date(START.getTime() + 2);
      const second = await Promise.all(
        range(PARALLEL).map((index) =>
          fresh().claimNextAgentQueuedTurn({
            ...claimInput(turn.queuedTurnId, `second-${index}`),
            now,
            leaseUntil: LATER,
          }),
        ),
      );
      const reclaimed = second.filter((result) => result.outcome === 'acquired');
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].claim?.attempts).toBe(2);
      const [stored] = await storedTurns();
      expect(stored).toMatchObject({
        status: 'claimed',
        admissionSlot: true,
        claimId: reclaimed[0].claim?.claimId,
        attempts: 2,
      });
    });

    it('starts an admission once when its claim begins it twice at the same time', async () => {
      const { claim } = await claimPublished('conversation-1', 'delivery-once');
      const results = await Promise.all(
        range(PARALLEL).map(() =>
          fresh().beginAgentQueuedTurnAdmission({
            ...claim,
            admissionId: 'delivery-once',
            startedAt: START,
          }),
        ),
      );
      expect(results.filter((result) => result.outcome === 'started')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'already_started')).toHaveLength(
        PARALLEL - 1,
      );
    });

    it('leases each indeterminate admission to one reconciler', async () => {
      const conversations = range(6).map((index) => `conversation-r${index}`);
      for (const conversationId of conversations) {
        const { turn, claim } = await claimPublished(conversationId, `delivery-${conversationId}`);
        const started = await fresh().beginAgentQueuedTurnAdmission({
          ...claim,
          admissionId: `delivery-${conversationId}`,
          startedAt: START,
        });
        expect(started.outcome).toBe('started');
        const result = await fresh().deadLetterAgentQueuedTurn({
          ...scope(conversationId),
          queuedTurnId: turn.queuedTurnId,
          deliveryKey: `delivery-${conversationId}`,
          settledAt: START,
          failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
        });
        expect(result.outcome).toBe('admission_indeterminate');
      }
      const leases = await Promise.all(
        range(4).map((index) =>
          fresh().claimQueuedTurnsForAdmissionReconciliation({
            claimId: `reconciliation-${index}`,
            claimBy: `reconciler-${index}`,
            now: LATER,
            leaseUntil: new Date(LATER.getTime() + 60_000),
            limit: conversations.length,
          }),
        ),
      );
      const leased = leases.flatMap((batch, index) =>
        batch.map((turn) => {
          expect(turn.reconciliationClaimId).toBe(`reconciliation-${index}`);
          return turn.queuedTurnId;
        }),
      );
      expect(leased).toHaveLength(conversations.length);
      expect(new Set(leased).size).toBe(conversations.length);
      for (const turn of await storedTurns()) {
        expect(turn.reconciliationAttempts).toBe(1);
      }
    });

    it.each([
      ['claimed turn', { status: 'claimed', claimId: 'c', claimBy: 'w', claimUntil: LATER }],
      ['turn past the admission boundary', { status: 'dead', admissionStartedAt: START }],
      ['admission slot', { status: 'queued', admissionSlot: true }],
      ['sequence', { sequence: 1 }],
      ['active slot', { activeSlot: 7 }],
    ])('keeps one %s per lane against concurrent raw writers', async (_name, fence) => {
      const results = await Promise.allSettled(
        range(PARALLEL).map((index) =>
          harness.seedRaw('agentqueuedturns', [
            rawTurn({ sequence: index + 10, activeSlot: index + 10, ...fence }),
          ]),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(harness.errors.isDuplicateKey(result.reason)).toBe(true);
        }
      }
      expect(await storedTurns()).toHaveLength(1);
    });

    it('leaves no active turn behind when a lane is retired while enqueues race', async () => {
      await fresh().enqueueAgentQueuedTurn(enqueueInput('before'));
      const [enqueues, retired] = await Promise.all([
        Promise.allSettled(
          range(PARALLEL).map((index) =>
            fresh().enqueueAgentQueuedTurn(enqueueInput(`race-${index}`)),
          ),
        ),
        fresh().prepareAgentQueuedTurnConversationDeletion({
          user,
          targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
          settledAt: START,
        }),
      ]);
      expect(retired).toEqual([]);
      for (const result of enqueues) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
        }
      }
      const stored = await storedTurns();
      expect(stored.length).toBe(1 + enqueues.filter((r) => r.status === 'fulfilled').length);
      for (const turn of stored) {
        expect(turn).toMatchObject({
          status: 'cancelled',
          deliveryState: 'retired',
          terminalReceipt: { failure: { code: 'OWNER_DRAINED' } },
        });
      }
      await expect(fresh().enqueueAgentQueuedTurn(enqueueInput('after'))).rejects.toBeInstanceOf(
        AgentQueuedTurnLaneRetiredError,
      );
    });
  });
});
