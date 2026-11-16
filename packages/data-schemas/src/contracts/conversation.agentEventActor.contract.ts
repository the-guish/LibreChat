/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ConversationStore` contract (`~/ports/conversation`), second part, ported from the
 * "subagent thread leases" cases of `methods/conversation.spec.ts`: subagent threads (reading a
 * child through its exact parent and tenant, the bounded parent index, the one-time reservation
 * with its duplicate-key rejection, the cross-replica lease) and the agent event actor stored on
 * the thread: the private event binding, the actor head committed by a full compare-and-set on
 * its prior state (with the two-checkpoint retention and the invalidation epoch), the SDK
 * suspension fence (store, claim, settle, cancel, the resumed commit), the legacy-turn fence, and
 * the reconciliation journal (an array of subdocuments matched element-wise, updated in place by
 * position and pruned by predicate), with its storage metrics and the bounded expiry sweep of
 * legacy settled receipts that pages across calls on one store instance.
 *
 * The rest of the store is in `conversation.contract.ts` and `conversation.domain.contract.ts`.
 * Not here (they stay in the method spec): cases that interleave a write between a read and the
 * guarded write through spies, that check the update or projection shape sent to the driver
 * (DocumentDB compatibility), or that write the journal past its size through the driver. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import type {
  IAgentEventActorReconciliation,
  IAgentEventActorSuspensionEvidence,
  IAgentEventActorState,
} from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import { readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const DAY = 24 * 60 * 60_000;
const inFuture = (ms = 60 * 60_000) => new Date(Date.now() + ms);
const inPast = (ms = 60 * 60_000) => new Date(Date.now() - ms);

type Checkpoint = { threadId: string; checkpointId: string; checkpointNs: string };

export function describeConversationAgentEventActorContract(harness: ContractHarness): void {
  describe(`ConversationStore contract, subagent threads and event actors: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().conversations;
    const newId = () => harness.ids.generate();
    let sequence = 0;
    const newConversationId = () => `thread-${++sequence}-${newId()}`;
    const lineage = (parentConversationId: string, parentToolCallId = 'parent-tool') => ({
      rootConversationId: parentConversationId,
      parentConversationId,
      parentMessageId: 'parent-message',
      parentToolCallId,
      subagentType: 'researcher',
      subagentKind: 'agent',
      depth: 1,
    });
    const rawConvo = async (conversationId: string): Promise<RawRecord> => {
      const [record] = await readRawWhere(harness, 'conversations', { conversationId });
      return record;
    };
    /** Seeds one conversation raw (no defaults); a key given as `undefined` is left out. */
    const seedConvo = async (record: RawRecord): Promise<string> => {
      const conversationId = (record.conversationId as string | undefined) ?? newConversationId();
      const seeded: RawRecord = {
        _id: newId(),
        conversationId,
        endpoint: 'agents',
        isTemporary: false,
        messages: [],
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
        ...record,
      };
      await harness.seedRaw('conversations', [
        Object.fromEntries(Object.entries(seeded).filter(([, value]) => value !== undefined)),
      ]);
      return conversationId;
    };
    /** Seeds an event-bound actor thread of `user`; returns its owner scope. */
    const seedActor = async (
      user: string,
      record: RawRecord = {},
    ): Promise<{ user: string; conversationId: string; tenantId?: string }> => {
      const conversationId = await seedConvo({
        user,
        agent_id: 'agent-player',
        agentEventBinding: {
          bindingId: `evtbind_${newId()}`,
          sourceKeyId: 'key-a',
          actorId: 'player-a',
        },
        subagentThread: { ...lineage('parent', 'event-binding'), parentAgentId: 'agent-director' },
        ...record,
      });
      const tenantId = record.tenantId as string | undefined;
      return { user, conversationId, ...(tenantId != null && { tenantId }) };
    };
    const checkpointOf =
      (conversationId: string) =>
      (suffix: string): Checkpoint => ({
        threadId: conversationId,
        checkpointId: `checkpoint-${suffix}`,
        checkpointNs: `event-actor/${suffix}`,
      });
    const pending = (
      invocationId: string,
      checkpoint: IAgentEventActorReconciliation['checkpoint'],
      extra: Partial<IAgentEventActorReconciliation> = {},
    ): IAgentEventActorReconciliation => ({
      invocationId,
      status: 'invocation_pending',
      checkpoint,
      action: { toolName: 'submit_move' },
      observedAt: new Date(),
      ...extra,
    });

    describe('subagent threads', () => {
      it('reads a child only through its exact parent and tenant, with its private lease', async () => {
        const user = newId();
        const parent = await seedConvo({ user, tenantId: 'tenant-a' });
        const child = await seedConvo({
          user,
          tenantId: 'tenant-a',
          title: 'Child',
          agent_id: 'agent-child',
          subagentThread: lineage(parent),
          subagentThreadLease: {
            token: 'private-token',
            taskId: 'task-1',
            expiresAt: new Date('2099-08-21T12:00:00.000Z'),
          },
        });
        const read = (input: Partial<{ parentConversationId: string; tenantId: string }>) =>
          stores().getSubagentThreadForParent({
            user,
            parentConversationId: parent,
            conversationId: child,
            tenantId: 'tenant-a',
            ...input,
          });
        const found = await read({});
        expect(found).toMatchObject({
          conversationId: child,
          tenantId: 'tenant-a',
          title: 'Child',
          agent_id: 'agent-child',
          subagentThread: lineage(parent),
          subagentThreadLease: { token: 'private-token', taskId: 'task-1' },
        });
        expect(timeOf(found?.subagentThreadLease?.expiresAt)).toBe(
          Date.parse('2099-08-21T12:00:00.000Z'),
        );
        expect(await read({ parentConversationId: 'another-parent' })).toBeNull();
        expect(await read({ tenantId: 'tenant-b' })).toBeNull();
        expect(await read({ tenantId: undefined })).toBeNull();
        expect(await stores().getConvo(user, child)).not.toHaveProperty('subagentThreadLease');
      });

      it('lists the children of a parent, collapsing a private event binding to the actor id', async () => {
        const user = newId();
        const parent = newConversationId();
        const eventThread = await seedConvo({
          user,
          tenantId: 'tenant-a',
          subagentThread: lineage(parent, 'event-binding:private'),
          subagentThreadLease: {
            token: 'private-token',
            taskId: 'task-live',
            expiresAt: inFuture(),
          },
          agentEventBinding: {
            bindingId: 'evtbind_private',
            sourceKeyId: 'private-key',
            actorId: 'actor-a',
          },
        });
        const toolThread = await seedConvo({
          user,
          tenantId: 'tenant-a',
          subagentThread: lineage(parent, 'tool-call-a'),
        });
        await seedConvo({ user, tenantId: 'tenant-b', subagentThread: lineage(parent) });
        await seedConvo({ user: newId(), tenantId: 'tenant-a', subagentThread: lineage(parent) });
        await seedConvo({ user, tenantId: 'tenant-a', subagentThread: lineage('other-parent') });
        await seedConvo({
          user,
          tenantId: 'tenant-a',
          subagentThread: lineage(parent),
          isTemporary: true,
          expiredAt: inPast(),
        });
        const records = await stores().listSubagentThreadsForParent({
          user,
          tenantId: 'tenant-a',
          parentConversationId: parent,
          limit: 10,
        });
        expect(records.map((record) => record.conversationId).sort()).toEqual(
          [eventThread, toolThread].sort(),
        );
        expect(records.find((record) => record.conversationId === eventThread)).toMatchObject({
          actorId: 'actor-a',
          subagentThreadLease: { taskId: 'task-live' },
        });
        expect(JSON.stringify(records)).not.toContain('private-key');
        expect(JSON.stringify(records)).not.toContain('evtbind_private');
        for (const record of records) {
          expect(record).not.toHaveProperty('agentEventBinding');
          expect(record).not.toHaveProperty('messages');
        }
      });

      it('orders the parent index by updatedAt desc, then conversationId, within the limit', async () => {
        const user = newId();
        const parent = newConversationId();
        const child = (conversationId: string, updatedAt: string) =>
          seedConvo({
            user,
            conversationId,
            subagentThread: lineage(parent, conversationId),
            updatedAt: new Date(updatedAt),
          });
        await child('c-older', '2026-08-20T10:00:00.000Z');
        await child('b-tie', '2026-08-21T10:00:00.000Z');
        await child('a-tie', '2026-08-21T10:00:00.000Z');
        const list = (limit: number) =>
          stores()
            .listSubagentThreadsForParent({ user, parentConversationId: parent, limit })
            .then((records) => records.map((record) => record.conversationId));
        expect(await list(10)).toEqual(['a-tie', 'b-tie', 'c-older']);
        expect(await list(1)).toEqual(['a-tie']);
        /** A new lease stamps the task start, promoting the older child to the top. */
        await stores().acquireSubagentThreadLease({
          user,
          conversationId: 'c-older',
          token: 'token',
          taskId: 'active-task',
          now: new Date('2026-08-22T10:00:00.000Z'),
          expiresAt: new Date('2026-08-22T10:00:30.000Z'),
        });
        expect(await list(1)).toEqual(['c-older']);
      });

      it('reserves a thread once, keeping a concurrent winner, with the store defaults', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const thread = { ...lineage('root'), parentAgentId: 'parent-agent' };
        const reservations = await Promise.all(
          ['First title', 'Second title'].map((title) =>
            stores().reserveSubagentThread({
              user,
              conversationId,
              conversation: { endpoint: 'agents', title, subagentThread: thread as never },
            }),
          ),
        );
        expect(reservations.filter((reservation) => reservation.created)).toHaveLength(1);
        const winner = reservations.find((reservation) => reservation.created);
        expect(winner?.conversation).toMatchObject({
          conversationId,
          user,
          subagentThread: thread,
          messages: [],
          isTemporary: false,
        });
        const saved = await stores().getConvo(user, conversationId);
        expect(saved?.title).toBe(winner?.conversation.title);
        const again = await stores().reserveSubagentThread({
          user,
          conversationId,
          conversation: { endpoint: 'agents', title: 'Third' },
        });
        expect(again.created).toBe(false);
        expect(again.conversation.title).toBe(winner?.conversation.title);
        const untitled = await stores().reserveSubagentThread({
          user,
          conversationId: newConversationId(),
          conversation: { endpoint: 'agents', subagentThread: thread as never },
        });
        expect(untitled.conversation.title).toBe('New Chat');
      });

      it('reserves per tenant, and returns the event binding it stored', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const binding = { bindingId: 'evtbind_reserve', sourceKeyId: 'key-a', actorId: 'actor' };
        const inA = await stores().reserveSubagentThread({
          user,
          conversationId,
          tenantId: 'tenant-a',
          conversation: { endpoint: 'agents', agentEventBinding: binding },
        });
        expect(inA.created).toBe(true);
        expect(inA.conversation.agentEventBinding).toEqual(binding);
        const inB = await stores().reserveSubagentThread({
          user,
          conversationId,
          tenantId: 'tenant-b',
          conversation: { endpoint: 'agents' },
        });
        expect(inB.created).toBe(true);
        expect((await readRawWhere(harness, 'conversations', { conversationId })).length).toBe(2);
      });

      it('rejects a reservation whose event binding another conversation holds', async () => {
        const user = newId();
        const binding = { bindingId: 'evtbind_taken', sourceKeyId: 'key-a', actorId: 'actor' };
        await stores().reserveSubagentThread({
          user,
          conversationId: newConversationId(),
          conversation: { endpoint: 'agents', agentEventBinding: binding },
        });
        const failure = await stores()
          .reserveSubagentThread({
            user,
            conversationId: newConversationId(),
            conversation: { endpoint: 'agents', agentEventBinding: binding },
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
        expect(await harness.readRaw('conversations')).toHaveLength(1);
      });
    });

    describe('subagent thread leases', () => {
      const seedThread = (user: string, record: RawRecord = {}) =>
        seedConvo({ user, subagentThread: lineage('parent'), ...record });
      const now = new Date('2026-08-18T00:00:00.000Z');
      const expiresAt = new Date(now.getTime() + 30_000);

      it('admits one owner across replicas and fences renewal and release by token', async () => {
        const user = newId();
        const conversationId = await seedThread(user);
        const claims = await Promise.all(
          ['token-a', 'token-b'].map((token) =>
            stores().acquireSubagentThreadLease({
              user,
              conversationId,
              token,
              taskId: `task-${token}`,
              now,
              expiresAt,
            }),
          ),
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        const winner = claims[0] ? 'token-a' : 'token-b';
        const loser = winner === 'token-a' ? 'token-b' : 'token-a';
        const stored = await rawConvo(conversationId);
        expect(timeOf(stored.updatedAt)).toBe(now.getTime());
        expect(stored.subagentThreadLease).toMatchObject({
          token: winner,
          taskId: `task-${winner}`,
        });
        expect(await stores().countActiveSubagentThreadLeases({ user, now })).toBe(1);
        expect(await stores().listActiveSubagentThreadLeases({ user, now })).toEqual([
          { conversationId, parentConversationId: 'parent', taskId: `task-${winner}` },
        ]);
        /** The owner re-acquires its own lease. */
        expect(
          await stores().acquireSubagentThreadLease({
            user,
            conversationId,
            token: winner,
            taskId: `task-${winner}`,
            now,
            expiresAt,
          }),
        ).toBe(true);
        const renewed = new Date(expiresAt.getTime() + 30_000);
        const renew = (token: string, at = now) =>
          stores().renewSubagentThreadLease({
            user,
            conversationId,
            token,
            now: at,
            expiresAt: renewed,
          });
        expect(await renew(loser)).toBe(false);
        expect(await renew(winner, expiresAt)).toBe(false);
        expect(await renew(winner)).toBe(true);
        const lease = (await rawConvo(conversationId)).subagentThreadLease as RawRecord;
        expect(timeOf(lease.expiresAt)).toBe(renewed.getTime());
        expect(
          await stores().releaseSubagentThreadLease({ user, conversationId, token: loser }),
        ).toBe(false);
        expect(
          await stores().releaseSubagentThreadLease({ user, conversationId, token: winner }),
        ).toBe(true);
        expect(await rawConvo(conversationId)).not.toHaveProperty('subagentThreadLease');
        expect(await stores().countActiveSubagentThreadLeases({ user, now })).toBe(0);
        expect(
          await stores().releaseSubagentThreadLease({ user, conversationId, token: winner }),
        ).toBe(false);
      });

      it('allows a takeover only once the prior lease has expired', async () => {
        const user = newId();
        const conversationId = await seedThread(user);
        const firstExpiry = new Date(now.getTime() + 1_000);
        await stores().acquireSubagentThreadLease({
          user,
          conversationId,
          token: 'first',
          taskId: 'task-first',
          now,
          expiresAt: firstExpiry,
        });
        const takeover = (at: Date) =>
          stores().acquireSubagentThreadLease({
            user,
            conversationId,
            token: 'second',
            taskId: 'task-second',
            now: at,
            expiresAt: new Date(at.getTime() + 1_000),
          });
        expect(await takeover(new Date(firstExpiry.getTime() - 1))).toBe(false);
        expect(await takeover(firstExpiry)).toBe(true);
      });

      it('leases only a subagent thread of the owner in the named tenant', async () => {
        const user = newId();
        const plain = await seedConvo({ user });
        const inTenant = await seedThread(user, { tenantId: 'tenant-a' });
        const acquire = (
          conversationId: string,
          input: { user?: string; tenantId?: string } = {},
        ) =>
          stores().acquireSubagentThreadLease({
            user,
            conversationId,
            token: 'token',
            taskId: 'task',
            now,
            expiresAt,
            ...input,
          });
        expect(await acquire(plain)).toBe(false);
        expect(await acquire(inTenant)).toBe(false);
        expect(await acquire(inTenant, { tenantId: 'tenant-b' })).toBe(false);
        expect(await acquire(inTenant, { user: newId(), tenantId: 'tenant-a' })).toBe(false);
        expect(await acquire(inTenant, { tenantId: 'tenant-a' })).toBe(true);
        expect(await stores().countActiveSubagentThreadLeases({ user, now })).toBe(0);
        expect(
          await stores().countActiveSubagentThreadLeases({ user, now, tenantId: 'tenant-a' }),
        ).toBe(1);
        expect(
          await stores().listActiveSubagentThreadLeases({ user, now, tenantId: 'tenant-a' }),
        ).toEqual([{ conversationId: inTenant, parentConversationId: 'parent', taskId: 'task' }]);
        expect(
          await stores().countActiveSubagentThreadLeases({
            user,
            now: expiresAt,
            tenantId: 'tenant-a',
          }),
        ).toBe(0);
      });
    });

    describe('getAgentEventBinding', () => {
      it('resolves a binding only through its owner, tenant and source key', async () => {
        const user = newId();
        const owner = await seedActor(user, { tenantId: 'tenant-a', isTemporary: undefined });
        const { bindingId } = (await rawConvo(owner.conversationId)).agentEventBinding as {
          bindingId: string;
        };
        const resolve = (input: Partial<{ user: string; tenantId: string; sourceKeyId: string }>) =>
          stores().getAgentEventBinding({
            user,
            tenantId: 'tenant-a',
            bindingId,
            sourceKeyId: 'key-a',
            ...input,
          });
        expect(await resolve({})).toEqual({
          conversationId: owner.conversationId,
          agentId: 'agent-player',
          tenantId: 'tenant-a',
          binding: { bindingId, sourceKeyId: 'key-a', actorId: 'player-a' },
          lineage: { ...lineage('parent', 'event-binding'), parentAgentId: 'agent-director' },
        });
        expect(await resolve({ sourceKeyId: 'key-b' })).toBeNull();
        expect(await resolve({ tenantId: 'tenant-b' })).toBeNull();
        expect(await resolve({ user: newId() })).toBeNull();
        expect(await stores().getConvo(user, owner.conversationId)).not.toHaveProperty(
          'agentEventBinding',
        );
      });

      it('carries the retention fields, and hides an expired or agentless thread', async () => {
        const user = newId();
        const deadline = inFuture();
        const temporary = await seedActor(user, { isTemporary: true, expiredAt: deadline });
        const expired = await seedActor(user, { expiredAt: inPast() });
        const agentless = await seedActor(user, { agent_id: undefined });
        const resolve = async (owner: { conversationId: string }) => {
          const { bindingId } = (await rawConvo(owner.conversationId)).agentEventBinding as {
            bindingId: string;
          };
          return stores().getAgentEventBinding({ user, bindingId, sourceKeyId: 'key-a' });
        };
        const found = await resolve(temporary);
        expect(found).toMatchObject({ isTemporary: true });
        expect(timeOf(found?.expiredAt)).toBe(deadline.getTime());
        expect(found).not.toHaveProperty('tenantId');
        expect(await resolve(expired)).toBeNull();
        expect(await resolve(agentless)).toBeNull();
      });
    });

    describe('actor head and reconciliation journal', () => {
      it('commits heads by a full compare-and-set, retaining two checkpoints', async () => {
        const owner = await seedActor(newId(), { tenantId: 'tenant-a' });
        const checkpoint = checkpointOf(owner.conversationId);
        const begin = (invocationId: string, at = checkpoint(invocationId)) =>
          stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: pending(invocationId, at),
          });
        const finish = async (invocationId: string, at: Checkpoint) =>
          (await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: { ...pending(invocationId, at), status: 'history_persisted' },
          })) &&
          stores().resolveAgentEventActorReconciliation({
            ...owner,
            invocationId,
            checkpoint: at,
            resolution: 'checkpoint_verified',
          });
        const commit = (
          invocationId: string,
          at: Checkpoint,
          expected?: IAgentEventActorState,
          expectedEpoch = 0,
        ) =>
          stores().commitAgentEventActorState({
            ...owner,
            invocationId,
            expectedEpoch,
            action: { toolName: 'submit_move' },
            ...(expected != null && { expected }),
            checkpoint: at,
          });

        expect(await stores().getAgentEventActorSnapshot(owner)).toEqual({
          state: null,
          reconciliations: [],
          legacyTurn: null,
          suspension: null,
          epoch: 0,
        });
        expect(await begin('one')).toBe(true);
        /** A pending record is an exclusive fence, never an idempotent receipt. */
        expect(await begin('one')).toBe(false);
        expect(await begin('one', checkpoint('different'))).toBe(false);
        expect(await begin('competing', checkpoint('one'))).toBe(false);
        const first = await commit('one', checkpoint('one'));
        expect(first).toEqual({
          status: 'committed',
          state: { generation: 1, checkpoint: checkpoint('one') },
        });
        expect(await stores().getAgentEventActorSnapshot(owner)).toMatchObject({
          state: first.state,
          epoch: 0,
          reconciliations: [
            {
              invocationId: 'one',
              status: 'persistence_pending',
              checkpoint: checkpoint('one'),
              action: { toolName: 'submit_move' },
            },
          ],
        });
        expect(
          await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: {
              ...pending('one', checkpoint('one')),
              status: 'persistence_failed',
              error: 'message write unavailable',
            },
          }),
        ).toBe(true);
        expect(await finish('one', checkpoint('one'))).toBe(true);
        expect(
          (await stores().getAgentEventActorSnapshot(owner))?.reconciliations[0],
        ).toMatchObject({ status: 'settled', resolution: 'checkpoint_verified' });
        expect(
          (await stores().getAgentEventActorSnapshot(owner))?.reconciliations[0],
        ).not.toHaveProperty('error');
        /** A late controller cannot move a settled receipt back. */
        expect(
          await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: { ...pending('one', checkpoint('one')), status: 'persistence_failed' },
          }),
        ).toBe(false);
        expect(await begin('one', checkpoint('one'))).toBe(false);
        /** A commit against an outdated (absent) head is stale and reports the current one. */
        expect(await begin('stale', checkpoint('one'))).toBe(true);
        expect(await commit('stale', checkpoint('stale'))).toEqual({
          status: 'stale',
          state: first.state,
        });
        expect(
          await stores().resolveAgentEventActorReconciliation({
            ...owner,
            invocationId: 'stale',
            checkpoint: checkpoint('one'),
            resolution: 'invocation_abandoned',
          }),
        ).toBe(true);

        expect(await begin('two', checkpoint('one'))).toBe(true);
        const second = await commit('two', checkpoint('two'), first.state);
        expect(second).toEqual({
          status: 'committed',
          state: {
            generation: 2,
            checkpoint: checkpoint('two'),
            previousCheckpoint: checkpoint('one'),
          },
        });
        expect(await finish('two', checkpoint('two'))).toBe(true);
        expect(await begin('three', checkpoint('two'))).toBe(true);
        /** The head read back from the store is a valid expectation too. */
        const current = (await stores().getAgentEventActorSnapshot(owner))?.state ?? undefined;
        const third = await commit('three', checkpoint('three'), current);
        expect(third).toEqual({
          status: 'committed',
          state: {
            generation: 3,
            checkpoint: checkpoint('three'),
            previousCheckpoint: checkpoint('two'),
          },
          prunableCheckpoint: checkpoint('one'),
        });
        expect((await rawConvo(owner.conversationId)).agentEventActorCleanup).toEqual([
          checkpoint('one'),
        ]);
        expect(await finish('three', checkpoint('three'))).toBe(true);
        const settled = await stores().getAgentEventActorSnapshot(owner);
        expect(
          settled?.reconciliations.map(({ invocationId, status }) => [invocationId, status]),
        ).toEqual([
          ['one', 'settled'],
          ['two', 'settled'],
          ['three', 'settled'],
        ]);
        /** Two competing owners of one new invocation: exactly one wins. */
        const competing = await Promise.all([
          begin('four', checkpoint('three')),
          begin('four', checkpoint('three')),
        ]);
        expect([...competing].sort()).toEqual([false, true]);
        expect(
          await stores().getAgentEventActorSnapshot({ ...owner, conversationId: 'missing' }),
        ).toBeUndefined();
        expect(
          await stores().getAgentEventActorSnapshot({ ...owner, tenantId: undefined }),
        ).toBeUndefined();
        const visible = await stores().getConvo(owner.user, owner.conversationId);
        expect(visible).not.toHaveProperty('agentEventActor');
        expect(visible).not.toHaveProperty('agentEventActorReconciliations');
        /** Head and journal writes never touch the conversation's timestamps. */
        expect(timeOf((await rawConvo(owner.conversationId)).updatedAt)).toBe(
          Date.parse('2026-03-01T00:00:00.000Z'),
        );
      });

      it('persists and matches the complete warm-continuation state', async () => {
        const owner = await seedActor(newId());
        const at = checkpointOf(owner.conversationId)('context');
        const warm = {
          contextFingerprint: { algorithm: 'sha256' as const, version: 1, digest: 'context-one' },
          skillManifest: [
            { id: 'skill-1', name: 'analysis', version: 3 },
            { id: 'skill-2', name: 'writing', version: 1, contentDigest: 'digest-2' },
          ],
          discoveredToolNames: ['deferred_lookup', 'deferred_write'],
          summary: { text: 'Earlier compacted context.', tokenCount: 12, version: 1 },
          contextMeta: {
            calibrationRatio: 1.25,
            encoding: 'o200k_base',
            fading: { v: 2 as const, budgetTokens: 20_000, masked: false },
            fadingTiers: [
              { agentId: 'agent-a', v: 2 as const, budgetTokens: 10_000, masked: true },
            ],
          },
          compactionSemanticIndex: {
            version: 1 as const,
            entries: [
              {
                type: 'activity_phase' as const,
                sourceMessageId: 'assistant-history',
                sourceContentIndex: 1,
                revision: 1,
                status: 'committed' as const,
                text: 'Verified the release state',
              },
              {
                type: 'tool_intent' as const,
                sourceMessageId: 'assistant-history',
                sourceContentIndex: 2,
                revision: 0,
                status: 'pending' as const,
                /** A pending entry carries an empty text, kept as given. */
                text: '',
                toolCallId: 'call-1',
              },
            ],
            providedEntryCount: 9,
          },
        };
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('context-one', at),
        });
        const committed = await stores().commitAgentEventActorState({
          ...owner,
          invocationId: 'context-one',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: at,
          ...warm,
        });
        expect(committed).toEqual({
          status: 'committed',
          state: { generation: 1, checkpoint: at, ...warm },
        });
        const snapshot = await stores().getAgentEventActorSnapshot(owner);
        expect(snapshot?.state).toEqual({ generation: 1, checkpoint: at, ...warm });
        /** The stored warm state is an exact expectation for the next commit. */
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: { ...pending('context-one', at), status: 'history_persisted' },
        });
        await stores().resolveAgentEventActorReconciliation({
          ...owner,
          invocationId: 'context-one',
          checkpoint: at,
          resolution: 'checkpoint_verified',
        });
        const next = { ...at, checkpointId: 'checkpoint-next' };
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('context-two', next),
        });
        const changed = { ...snapshot!.state!, summary: { ...warm.summary, tokenCount: 13 } };
        expect(
          await stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'context-two',
            expectedEpoch: 0,
            action: { toolName: 'submit_move' },
            expected: changed,
            checkpoint: next,
          }),
        ).toMatchObject({ status: 'stale' });
        /** Subdocuments compare by value: the expectation's key order does not matter. */
        const reversed = <T extends object>(value: T): T =>
          Object.fromEntries(Object.entries(value).reverse()) as T;
        const reordered = {
          ...snapshot!.state!,
          summary: reversed(snapshot!.state!.summary!),
          contextMeta: reversed(snapshot!.state!.contextMeta!),
          contextFingerprint: reversed(snapshot!.state!.contextFingerprint!),
        };
        const withoutWarmState = await stores().commitAgentEventActorState({
          ...owner,
          invocationId: 'context-two',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          expected: reordered,
          checkpoint: next,
        });
        expect(withoutWarmState).toEqual({
          status: 'committed',
          state: { generation: 2, checkpoint: next, previousCheckpoint: at },
        });
        expect((await stores().getAgentEventActorSnapshot(owner))?.state).toEqual(
          withoutWarmState.state,
        );
      });

      it('refuses invalid warm state before writing', async () => {
        const owner = await seedActor(newId());
        const at = checkpointOf(owner.conversationId)('invalid');
        const commit = (input: Record<string, unknown>) =>
          stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'invalid',
            expectedEpoch: 0,
            action: { toolName: 'submit_move' },
            checkpoint: at,
            ...input,
          });
        await expect(
          commit({
            skillManifest: Array.from({ length: 65 }, (_, index) => ({
              id: `skill-${index}`,
              name: `skill-${index}`,
              version: 1,
            })),
          }),
        ).rejects.toThrow('Event actor Skill manifest exceeds 64');
        await expect(
          commit({ discoveredToolNames: Array.from({ length: 129 }, (_, i) => `tool-${i}`) }),
        ).rejects.toThrow('Event actor discovered-tool state is invalid');
        await expect(commit({ summary: { text: '', tokenCount: 1 } })).rejects.toThrow(
          'Event actor summary state is invalid',
        );
        await expect(commit({ contextMeta: { calibrationRatio: 9 } })).rejects.toThrow(
          'Event actor context calibration is invalid',
        );
        await expect(
          commit({
            contextMeta: {
              calibrationRatio: 1.25,
              fading: { v: 1, budgetTokens: -5, masked: true },
            },
          }),
        ).rejects.toThrow('Event actor context fading tier is invalid');
        await expect(
          commit({ compactionSemanticIndex: { version: 1, entries: [], providedEntryCount: -1 } }),
        ).rejects.toThrow('Event actor compaction semantic index is invalid');
        await expect(commit({ checkpoint: { ...at, threadId: 'another-thread' } })).rejects.toThrow(
          'Event actor checkpoint changed its logical thread',
        );
        expect(await rawConvo(owner.conversationId)).not.toHaveProperty('agentEventActor');
      });

      it('records the reconciliation lifecycle exactly, keeping repaired and compensated receipts', async () => {
        const owner = await seedActor(newId());
        const at = checkpointOf(owner.conversationId);
        const record = (reconciliation: IAgentEventActorReconciliation) =>
          stores().recordAgentEventActorReconciliation({ ...owner, reconciliation });
        const resolve = (
          invocationId: string,
          checkpoint: IAgentEventActorReconciliation['checkpoint'],
          resolution:
            | 'checkpoint_verified'
            | 'action_compensated'
            | 'history_repaired'
            | 'invocation_abandoned',
        ) =>
          stores().resolveAgentEventActorReconciliation({
            ...owner,
            invocationId,
            checkpoint,
            resolution,
          });
        expect(await record(pending('event-one', at('one')))).toBe(true);
        const first = await stores().commitAgentEventActorState({
          ...owner,
          invocationId: 'event-one',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: at('one'),
        });
        await record({ ...pending('event-one', at('one')), status: 'history_persisted' });
        expect(await resolve('event-one', at('one'), 'checkpoint_verified')).toBe(true);

        const conflict: IAgentEventActorReconciliation = {
          invocationId: 'event-conflict',
          status: 'commit_conflict',
          checkpoint: at('conflict'),
          action: { toolName: 'submit_move', toolCallId: 'call-1' },
          error: 'A competing checkpoint advanced the actor head',
          observedAt: new Date('2026-08-25T00:00:00.000Z'),
        };
        expect(await record({ ...conflict, status: 'invocation_pending' })).toBe(true);
        expect(await record(conflict)).toBe(true);
        /** Recording the same state again is an idempotent receipt. */
        expect(await record(conflict)).toBe(true);
        expect(await stores().getAgentEventActorSnapshot(owner)).toEqual({
          state: first.state,
          epoch: 0,
          legacyTurn: null,
          suspension: null,
          reconciliations: [
            expect.objectContaining({ invocationId: 'event-one', status: 'settled' }),
            conflict,
          ],
        });
        /** An active lifecycle blocks every other commit. */
        expect(
          await stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'event-blocked',
            expectedEpoch: 0,
            action: { toolName: 'submit_move' },
            expected: first.state,
            checkpoint: at('two'),
          }),
        ).toEqual({ status: 'stale', state: first.state });
        expect(await resolve('event-conflict', at('conflict'), 'checkpoint_verified')).toBe(false);
        expect(await resolve('event-conflict', at('conflict'), 'action_compensated')).toBe(true);
        expect(await resolve('event-conflict', at('conflict'), 'action_compensated')).toBe(true);

        /** A checkpoint without an id matches only a record without one. */
        const checkpointless = { threadId: owner.conversationId, checkpointNs: 'event-actor/none' };
        expect(await record(pending('event-checkpointless', checkpointless))).toBe(true);
        expect(
          await record({
            ...pending('event-checkpointless', checkpointless),
            status: 'commit_indeterminate',
          }),
        ).toBe(true);
        expect(
          await resolve(
            'event-checkpointless',
            { ...checkpointless, checkpointId: 'x' },
            'history_repaired',
          ),
        ).toBe(false);
        expect(await resolve('event-checkpointless', checkpointless, 'history_repaired')).toBe(
          true,
        );
        const repaired = (await stores().getAgentEventActorSnapshot(owner))?.reconciliations.find(
          (item) => item.invocationId === 'event-checkpointless',
        );
        expect(repaired).toMatchObject({ status: 'settled', resolution: 'history_repaired' });
        expect(repaired?.checkpoint).toEqual(checkpointless);

        const snapshot = await stores().getAgentEventActorSnapshot(owner);
        expect(snapshot?.state).toEqual({ ...first.state, requiresColdStart: true });
        expect(
          snapshot?.reconciliations.map(({ invocationId, status, resolution }) => [
            invocationId,
            status,
            resolution,
          ]),
        ).toEqual([
          ['event-one', 'settled', 'checkpoint_verified'],
          ['event-conflict', 'settled', 'action_compensated'],
          ['event-checkpointless', 'settled', 'history_repaired'],
        ]);
        /** A settled receipt keeps its id out of a new lifecycle; another id is admissible. */
        expect(await record(pending('event-conflict', at('conflict')))).toBe(false);
        expect(await record(pending('event-fresh', at('fresh')))).toBe(true);
        expect(await resolve('event-fresh', at('fresh'), 'invocation_abandoned')).toBe(true);
        expect(
          (await stores().getAgentEventActorSnapshot(owner))?.reconciliations.map(
            (item) => item.invocationId,
          ),
        ).toEqual(['event-one', 'event-conflict', 'event-checkpointless']);
        /** Only a pending record starts a lifecycle; a later state for an unknown id is refused. */
        expect(
          await record({ ...pending('event-unknown', at('x')), status: 'history_persisted' }),
        ).toBe(false);
        await expect(
          record(pending('event-other-thread', { ...at('x'), threadId: 'another-thread' })),
        ).rejects.toThrow('Event actor reconciliation changed its logical thread');
      });

      it('confirms action admission only once, on the exact pending lifecycle', async () => {
        const owner = await seedActor(newId());
        const checkpoint = {
          threadId: owner.conversationId,
          checkpointNs: 'event-actor/admission',
        };
        const record = (reconciliation: IAgentEventActorReconciliation) =>
          stores().recordAgentEventActorReconciliation({ ...owner, reconciliation });
        const base = pending('event-admission', checkpoint);
        expect(await record(base)).toBe(true);
        expect(
          await record({ ...base, actionAdmitted: true, action: { toolName: 'other_tool' } }),
        ).toBe(false);
        expect(await record({ ...base, actionAdmitted: true })).toBe(true);
        expect(await record({ ...base, actionAdmitted: true })).toBe(false);
        expect((await stores().getAgentEventActorSnapshot(owner))?.reconciliations).toEqual([
          expect.objectContaining({
            invocationId: 'event-admission',
            status: 'invocation_pending',
            actionAdmitted: true,
          }),
        ]);
        /** An admitted action cannot be compensated before it passed invocation admission. */
        expect(
          await stores().resolveAgentEventActorReconciliation({
            ...owner,
            invocationId: 'event-admission',
            checkpoint,
            resolution: 'action_compensated',
          }),
        ).toBe(false);
        const abandon = (expectedActionAdmitted: boolean) =>
          stores().resolveAgentEventActorReconciliation({
            ...owner,
            invocationId: 'event-admission',
            checkpoint,
            expectedActionAdmitted,
            resolution: 'invocation_abandoned',
          });
        expect(await abandon(false)).toBe(false);
        expect(await abandon(true)).toBe(true);
        expect((await stores().getAgentEventActorSnapshot(owner))?.reconciliations).toEqual([]);
      });

      it('clears an active or settled lifecycle only on its exact proof', async () => {
        const user = newId();
        const headlessId = newConversationId();
        const headlessCheckpoint = { threadId: headlessId, checkpointNs: 'event-actor/headless' };
        const clearOwner = await seedActor(user, {
          conversationId: headlessId,
          agentEventActorReconciliations: [
            {
              invocationId: 'headless',
              status: 'commit_conflict',
              checkpoint: headlessCheckpoint,
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
          ],
        });
        const clear = (
          owner: typeof clearOwner,
          invocationId: string,
          checkpoint: IAgentEventActorReconciliation['checkpoint'],
          resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired',
        ) =>
          stores().clearAgentEventActorReconciliation({
            ...owner,
            invocationId,
            checkpoint,
            resolution,
          });
        expect(await clear(clearOwner, 'headless', headlessCheckpoint, 'checkpoint_verified')).toBe(
          false,
        );
        expect(await clear(clearOwner, 'headless', headlessCheckpoint, 'action_compensated')).toBe(
          true,
        );
        const stored = await rawConvo(clearOwner.conversationId);
        expect(stored.agentEventActorReconciliations ?? []).toEqual([]);
        expect(stored).not.toHaveProperty('agentEventActor');
        /** A repeat finds no lifecycle and no conflict: the owner exists, so it converges. */
        expect(await clear(clearOwner, 'headless', headlessCheckpoint, 'action_compensated')).toBe(
          true,
        );
        expect(
          await clear(
            { ...clearOwner, conversationId: 'missing' },
            'headless',
            { ...headlessCheckpoint, threadId: 'missing' },
            'action_compensated',
          ),
        ).toBe(false);

        const migrated = newConversationId();
        const checkpoint = checkpointOf(migrated)('migrated');
        const headful = await seedActor(user, {
          conversationId: migrated,
          agentEventActor: { generation: 1, checkpoint },
          agentEventActorReconciliations: [
            {
              invocationId: 'migrated',
              status: 'settled',
              resolution: 'checkpoint_verified',
              checkpoint,
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
            {
              invocationId: 'other-checkpoint',
              status: 'history_persisted',
              checkpoint: { ...checkpoint, checkpointId: 'checkpoint-other' },
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
          ],
        });
        /** Verification needs the head to sit on the checkpoint being verified. */
        expect(
          await clear(
            headful,
            'other-checkpoint',
            { ...checkpoint, checkpointId: 'checkpoint-other' },
            'checkpoint_verified',
          ),
        ).toBe(false);
        expect(await clear(headful, 'migrated', checkpoint, 'action_compensated')).toBe(false);
        expect(await clear(headful, 'migrated', checkpoint, 'checkpoint_verified')).toBe(true);
        expect(
          await clear(
            headful,
            'other-checkpoint',
            { ...checkpoint, checkpointId: 'checkpoint-other' },
            'history_repaired',
          ),
        ).toBe(true);
        const after = await stores().getAgentEventActorSnapshot(headful);
        expect(after?.reconciliations).toEqual([]);
        expect(after?.state).toEqual({ generation: 1, checkpoint, requiresColdStart: true });
      });
    });

    describe('legacy turn fence and epoch', () => {
      it('versions every legacy invalidation so a stale prepared fork cannot commit past it', async () => {
        const owner = await seedActor(newId());
        const checkpoint = checkpointOf(owner.conversationId);
        const begin = (token: string) =>
          stores().beginAgentEventActorLegacyTurn({ ...owner, token });
        const complete = (token: string) =>
          stores().completeAgentEventActorLegacyTurn({ ...owner, token });
        expect(await begin('legacy-a')).toBe(true);
        expect(await begin('legacy-other')).toBe(false);
        const open = await stores().getAgentEventActorSnapshot(owner);
        expect(open).toMatchObject({ state: null, legacyTurn: { token: 'legacy-a' }, epoch: 0 });
        expect(open?.legacyTurn?.startedAt).toBeInstanceOf(Date);
        /** A fork cannot start while the legacy turn is open. */
        expect(
          await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: pending('fork-loses', checkpoint('fork')),
          }),
        ).toBe(false);
        expect(await complete('legacy-other')).toBe(false);
        expect(await complete('legacy-a')).toBe(true);
        expect(await complete('legacy-a')).toBe(false);
        expect(await stores().getAgentEventActorSnapshot(owner)).toMatchObject({
          state: null,
          legacyTurn: null,
          epoch: 1,
        });
        expect(
          await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: pending('event-cold', checkpoint('cold')),
          }),
        ).toBe(true);
        /** A legacy turn cannot start while a fork lifecycle is open. */
        expect(await begin('legacy-loses')).toBe(false);
        const commit = (expectedEpoch: number, expected?: IAgentEventActorState) =>
          stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'event-cold',
            action: { toolName: 'submit_move' },
            expectedEpoch,
            ...(expected != null && { expected }),
            checkpoint: checkpoint('cold'),
          });
        expect(await commit(0)).toEqual({ status: 'stale' });
        expect(await commit(1)).toMatchObject({ status: 'committed', state: { generation: 1 } });
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: {
            ...pending('event-cold', checkpoint('cold')),
            status: 'history_persisted',
          },
        });
        await stores().resolveAgentEventActorReconciliation({
          ...owner,
          invocationId: 'event-cold',
          checkpoint: checkpoint('cold'),
          resolution: 'checkpoint_verified',
        });
        /** Each legacy turn over a head marks it cold and advances the epoch. */
        for (const token of ['legacy-b', 'legacy-c']) {
          expect(await begin(token)).toBe(true);
          expect(await complete(token)).toBe(true);
        }
        const snapshot = await stores().getAgentEventActorSnapshot(owner);
        expect(snapshot).toMatchObject({
          state: { generation: 1, requiresColdStart: true },
          epoch: 3,
          legacyTurn: null,
        });
        expect(
          await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: pending('event-rebuild', checkpoint('rebuild')),
          }),
        ).toBe(true);
        const rebuild = (expectedEpoch: number) =>
          stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'event-rebuild',
            action: { toolName: 'submit_move' },
            expected: snapshot!.state!,
            expectedEpoch,
            checkpoint: checkpoint('rebuild'),
          });
        expect(await rebuild(2)).toMatchObject({ status: 'stale' });
        const rebuilt = await rebuild(3);
        expect(rebuilt).toMatchObject({ status: 'committed', state: { generation: 2 } });
        expect(rebuilt.state).not.toHaveProperty('requiresColdStart');
      });

      it('fences only an event-bound thread of the owner', async () => {
        const user = newId();
        const unbound = await seedConvo({ user, subagentThread: lineage('parent') });
        const owner = await seedActor(user, { tenantId: 'tenant-a' });
        expect(
          await stores().beginAgentEventActorLegacyTurn({
            user,
            conversationId: unbound,
            token: 't',
          }),
        ).toBe(false);
        expect(
          await stores().beginAgentEventActorLegacyTurn({
            ...owner,
            tenantId: undefined,
            token: 't',
          }),
        ).toBe(false);
        expect(
          await stores().beginAgentEventActorLegacyTurn({ ...owner, user: newId(), token: 't' }),
        ).toBe(false);
        expect(await stores().beginAgentEventActorLegacyTurn({ ...owner, token: 't' })).toBe(true);
      });
    });

    describe('suspension fence', () => {
      const suspensionOf =
        (conversationId: string, invocationId: string, fork: Checkpoint) =>
        (suffix: string, attempt: number): IAgentEventActorSuspensionEvidence => ({
          version: 1,
          suspensionId: `suspension-${suffix}`,
          attempt,
          issuedAt: 1_000 + attempt,
          expiresAt: 100_000 + attempt,
          invocation: {
            actorThreadId: conversationId,
            invocationId,
            depth: 1,
            continuation: 'cold',
            base: { actorThreadId: conversationId, generation: 0 },
            fork: { ...fork, invocationId },
          },
          checkpoint: { ...fork, checkpointId: `checkpoint-${suffix}`, invocationId },
          interrupt: {
            id: `interrupt-${suffix}`,
            payload: {
              type: 'ask_user_question',
              actionId: `action-${suffix}`,
              nested: [1, null, { ok: true }],
            },
          },
          suspensionDigest: `digest-${suffix}`,
        });

      it('serializes the suspension through store, claim, re-pause and resumed commit', async () => {
        const owner = await seedActor(newId(), { tenantId: 'tenant-a' });
        const checkpoint = checkpointOf(owner.conversationId);
        const suspension = suspensionOf(owner.conversationId, 'event-pause', checkpoint('fork'));
        const first = suspension('first', 0);
        /** No suspension without the invocation's pending lifecycle. */
        expect(
          await stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: first,
            actionId: 'action-first',
            jobCreatedAt: 123,
          }),
        ).toEqual({ status: 'stale' });
        expect(
          await stores().recordAgentEventActorReconciliation({
            ...owner,
            reconciliation: pending('event-pause', checkpoint('fork'), { actionAdmitted: true }),
          }),
        ).toBe(true);
        await expect(
          stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: {
              ...first,
              interrupt: { ...first.interrupt, payload: { question: 'x'.repeat(65 * 1_024) } },
            },
            actionId: 'action-oversized',
            jobCreatedAt: 123,
          }),
        ).rejects.toThrow('Event actor suspension exceeds maximum payload size');
        await expect(
          stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: { ...first, attempt: 1 },
            actionId: 'action-first',
            jobCreatedAt: 123,
          }),
        ).rejects.toThrow('Event actor suspension evidence is invalid');
        expect(
          await stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: first,
            actionId: 'action-first',
            jobCreatedAt: 123,
          }),
        ).toEqual({ status: 'stored' });
        const stored = await stores().getAgentEventActorSnapshot(owner);
        expect(stored?.suspension).toMatchObject({
          suspension: first,
          kind: 'human_decision',
          handlingGenerationCreatedAt: 123,
          actionId: 'action-first',
          jobCreatedAt: 123,
          status: 'pending',
        });
        expect(stored?.suspension?.observedAt).toBeInstanceOf(Date);
        /** The evidence survives exactly, nested payload included. */
        expect(stored?.suspension?.suspension).toEqual(first);
        expect(
          await stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: { ...first, suspensionId: 'competing-suspension' },
            actionId: 'action-first',
            jobCreatedAt: 123,
          }),
        ).toEqual({ status: 'stale' });

        const claim = {
          ...owner,
          suspensionId: first.suspensionId,
          attempt: first.attempt,
          actionId: 'action-first',
          jobCreatedAt: 123,
          resumeAttemptId: 'resume-one',
        };
        expect(
          await stores().claimAgentEventActorSuspension({ ...claim, actionId: 'other' }),
        ).toEqual({ status: 'stale' });
        const claims = await Promise.all([
          stores().claimAgentEventActorSuspension(claim),
          stores().claimAgentEventActorSuspension({ ...claim, resumeAttemptId: 'resume-two' }),
        ]);
        expect(claims).toEqual(
          expect.arrayContaining([{ status: 'claimed' }, { status: 'stale' }]),
        );
        const winning = claims[0].status === 'claimed' ? 'resume-one' : 'resume-two';
        expect((await stores().getAgentEventActorSnapshot(owner))?.suspension).toMatchObject({
          status: 'claimed',
          resumeAttemptId: winning,
        });
        await expect(
          stores().claimAgentEventActorSuspension({ ...claim, resumeAttemptId: '' }),
        ).rejects.toThrow('Event actor suspension claim is invalid');

        const second = suspension('second', 1);
        expect(
          await stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: second,
            kind: 'internal_completion',
            appliedAction: { toolName: 'submit_move', toolCallId: 'call-1' },
            handlingGenerationCreatedAt: 100,
            actionId: 'action-second',
            jobCreatedAt: 124,
            invalidateHead: true,
            previous: { suspensionId: first.suspensionId, attempt: 0, resumeAttemptId: 'wrong' },
          }),
        ).toEqual({ status: 'stale' });
        expect(
          await stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: second,
            kind: 'internal_completion',
            appliedAction: { toolName: 'submit_move', toolCallId: 'call-1' },
            handlingGenerationCreatedAt: 100,
            actionId: 'action-second',
            jobCreatedAt: 124,
            invalidateHead: true,
            previous: { suspensionId: first.suspensionId, attempt: 0, resumeAttemptId: winning },
          }),
        ).toEqual({ status: 'stored' });
        const replaced = await stores().getAgentEventActorSnapshot(owner);
        expect(replaced?.suspension).toMatchObject({
          suspension: { suspensionId: second.suspensionId },
          kind: 'internal_completion',
          appliedAction: { toolName: 'submit_move', toolCallId: 'call-1' },
          handlingGenerationCreatedAt: 100,
          status: 'pending',
        });
        expect(replaced?.suspension).not.toHaveProperty('resumeAttemptId');
        /** A headless actor publishes the successor without a partial head. */
        expect(replaced?.state).toBeNull();
        expect(
          await stores().claimAgentEventActorSuspension({
            ...owner,
            suspensionId: second.suspensionId,
            attempt: 1,
            actionId: 'action-second',
            jobCreatedAt: 124,
            resumeAttemptId: 'resume-three',
          }),
        ).toEqual({ status: 'claimed' });
        const committed = await stores().commitAgentEventActorState({
          ...owner,
          invocationId: 'event-pause',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          checkpoint: checkpoint('committed'),
          settlementAuthority: {
            suspensionId: second.suspensionId,
            attempt: 1,
            resumeAttemptId: 'resume-three',
          },
        });
        expect(committed).toMatchObject({ status: 'committed' });
        expect(await stores().getAgentEventActorSnapshot(owner)).toMatchObject({
          suspension: { status: 'closed', outcome: 'committed', resumeAttemptId: 'resume-three' },
          state: { generation: 1, checkpoint: checkpoint('committed') },
        });
        /** A replayed resumed commit reads its own closed receipt and the head it committed. */
        expect(
          await stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'event-pause',
            expectedEpoch: 0,
            action: { toolName: 'submit_move' },
            checkpoint: checkpoint('committed'),
            settlementAuthority: {
              suspensionId: second.suspensionId,
              attempt: 1,
              resumeAttemptId: 'resume-three',
            },
          }),
        ).toEqual({ status: 'committed', state: committed.state });
      });

      it('closes a resumed suspension as stale when another head won', async () => {
        const owner = await seedActor(newId());
        const checkpoint = checkpointOf(owner.conversationId);
        const suspension = suspensionOf(
          owner.conversationId,
          'event-stale',
          checkpoint('fork'),
        )('s', 0);
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('event-stale', checkpoint('fork')),
        });
        await stores().storeAgentEventActorSuspension({
          ...owner,
          suspension,
          actionId: 'action',
          jobCreatedAt: 1,
        });
        await stores().claimAgentEventActorSuspension({
          ...owner,
          suspensionId: suspension.suspensionId,
          attempt: 0,
          actionId: 'action',
          jobCreatedAt: 1,
          resumeAttemptId: 'resume',
        });
        const authority = {
          suspensionId: suspension.suspensionId,
          attempt: 0,
          resumeAttemptId: 'resume',
        };
        const result = await stores().commitAgentEventActorState({
          ...owner,
          invocationId: 'event-stale',
          expectedEpoch: 0,
          action: { toolName: 'submit_move' },
          expected: { generation: 4, checkpoint: checkpoint('never') },
          checkpoint: checkpoint('next'),
          settlementAuthority: authority,
        });
        expect(result).toEqual({ status: 'stale' });
        expect((await stores().getAgentEventActorSnapshot(owner))?.suspension).toMatchObject({
          status: 'closed',
          outcome: 'stale',
          resumeAttemptId: 'resume',
        });
        expect(
          await stores().commitAgentEventActorState({
            ...owner,
            invocationId: 'event-stale',
            expectedEpoch: 0,
            action: { toolName: 'submit_move' },
            checkpoint: checkpoint('next'),
            settlementAuthority: authority,
          }),
        ).toEqual({ status: 'stale' });
      });

      it('settles a claimed suspension once, pulling its pending lifecycle', async () => {
        const owner = await seedActor(newId());
        const fork = { threadId: owner.conversationId, checkpointNs: 'event-actor/fork' };
        const evidence = suspensionOf(owner.conversationId, 'event-settle', {
          ...fork,
          checkpointId: 'checkpoint-fork',
        })('settle', 0);
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('event-settle', fork),
        });
        await stores().storeAgentEventActorSuspension({
          ...owner,
          suspension: evidence,
          actionId: 'action',
          jobCreatedAt: 1,
        });
        const settle = (resumeAttemptId: string, checkpoint = fork) =>
          stores().settleAgentEventActorSuspension({
            ...owner,
            suspensionId: evidence.suspensionId,
            attempt: 0,
            resumeAttemptId,
            invocationId: 'event-settle',
            checkpoint,
          });
        expect(await settle('resume')).toEqual({ status: 'stale' });
        await stores().claimAgentEventActorSuspension({
          ...owner,
          suspensionId: evidence.suspensionId,
          attempt: 0,
          actionId: 'action',
          jobCreatedAt: 1,
          resumeAttemptId: 'resume',
        });
        expect(
          await settle('resume', { ...fork, checkpointId: 'checkpoint-fork' } as never),
        ).toEqual({
          status: 'stale',
        });
        expect(await settle('other')).toEqual({ status: 'stale' });
        expect(await settle('resume')).toEqual({ status: 'settled' });
        const snapshot = await stores().getAgentEventActorSnapshot(owner);
        expect(snapshot?.suspension).toMatchObject({ status: 'closed', outcome: 'settled' });
        expect(snapshot?.suspension?.closedAt).toBeInstanceOf(Date);
        expect(snapshot?.reconciliations).toEqual([]);
        expect(await settle('resume')).toEqual({ status: 'settled' });
        expect(await settle('other')).toEqual({ status: 'stale' });
      });

      it('lets a resume and a cancellation race, then cancels an orphaned claim', async () => {
        const owner = await seedActor(newId());
        const checkpoint = checkpointOf(owner.conversationId)('cancel');
        const evidence = suspensionOf(
          owner.conversationId,
          'event-cancel',
          checkpoint,
        )('cancel', 0);
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('event-cancel', checkpoint),
        });
        await stores().storeAgentEventActorSuspension({
          ...owner,
          suspension: evidence,
          actionId: 'action-cancel',
          jobCreatedAt: 124,
        });
        const cancel = (claimedResumeAttemptId?: string) =>
          stores().cancelAgentEventActorSuspension({
            ...owner,
            suspensionId: evidence.suspensionId,
            attempt: 0,
            invocationId: 'event-cancel',
            checkpoint,
            ...(claimedResumeAttemptId != null && { claimedResumeAttemptId }),
          });
        const [resumeRace, cancelRace] = await Promise.all([
          stores().claimAgentEventActorSuspension({
            ...owner,
            suspensionId: evidence.suspensionId,
            attempt: 0,
            actionId: 'action-cancel',
            jobCreatedAt: 124,
            resumeAttemptId: 'resume-race',
          }),
          cancel(),
        ]);
        expect(
          [resumeRace.status, cancelRace.status].filter((status) => status === 'stale'),
        ).toHaveLength(1);
        /** When the resume won, its orphaned claim is cancelled by its exact attempt id; when the
         * cancellation won, the same call replays the closed receipt. */
        const orphanedClaim = resumeRace.status === 'claimed' ? 'resume-race' : undefined;
        expect(await cancel(orphanedClaim)).toEqual({ status: 'cancelled' });
        const snapshot = await stores().getAgentEventActorSnapshot(owner);
        expect(snapshot?.suspension).toMatchObject({ status: 'closed', outcome: 'cancelled' });
        expect(snapshot?.reconciliations).toEqual([]);
        expect(await cancel()).toEqual({ status: 'cancelled' });
      });

      it('cancels a claimed suspension only through its exact resume attempt', async () => {
        const owner = await seedActor(newId());
        const checkpoint = checkpointOf(owner.conversationId)('orphan');
        const evidence = suspensionOf(
          owner.conversationId,
          'event-orphan',
          checkpoint,
        )('orphan', 0);
        await stores().recordAgentEventActorReconciliation({
          ...owner,
          reconciliation: pending('event-orphan', checkpoint),
        });
        await stores().storeAgentEventActorSuspension({
          ...owner,
          suspension: evidence,
          actionId: 'action-orphan',
          jobCreatedAt: 7,
        });
        await stores().claimAgentEventActorSuspension({
          ...owner,
          suspensionId: evidence.suspensionId,
          attempt: 0,
          actionId: 'action-orphan',
          jobCreatedAt: 7,
          resumeAttemptId: 'resume-orphan',
        });
        const cancel = (claimedResumeAttemptId?: string) =>
          stores().cancelAgentEventActorSuspension({
            ...owner,
            suspensionId: evidence.suspensionId,
            attempt: 0,
            invocationId: 'event-orphan',
            checkpoint,
            ...(claimedResumeAttemptId != null && { claimedResumeAttemptId }),
          });
        expect(await cancel()).toEqual({ status: 'stale' });
        expect(await cancel('another-attempt')).toEqual({ status: 'stale' });
        expect((await stores().getAgentEventActorSnapshot(owner))?.suspension?.status).toBe(
          'claimed',
        );
        expect(await cancel('resume-orphan')).toEqual({ status: 'cancelled' });
        expect(await stores().getAgentEventActorSnapshot(owner)).toMatchObject({
          suspension: { status: 'closed', outcome: 'cancelled', resumeAttemptId: 'resume-orphan' },
          reconciliations: [],
        });
      });

      it('stores a first suspension on an expired thread', async () => {
        const user = newId();
        const conversationId = newConversationId();
        const checkpoint = checkpointOf(conversationId)('fork');
        const owner = await seedActor(user, {
          conversationId,
          expiredAt: inPast(),
          agentEventActorReconciliations: [
            {
              invocationId: 'event-expired',
              status: 'invocation_pending',
              checkpoint,
              action: { toolName: 'submit_move' },
              observedAt: new Date(),
            },
          ],
        });
        expect(await stores().getAgentEventActorSnapshot(owner)).toBeUndefined();
        // NOTE(contract): every other actor write treats an expired thread as gone, but the
        // first-suspension predecessor clause (`$or` on a missing or closed suspension) replaces
        // the expiration `$or` in the same filter object, so a first suspension is still stored
        // on an expired thread. Pinned as today's behavior; a successor (`previous`) is refused.
        expect(
          await stores().storeAgentEventActorSuspension({
            ...owner,
            suspension: suspensionOf(conversationId, 'event-expired', checkpoint)('expired', 0),
            actionId: 'action',
            jobCreatedAt: 1,
          }),
        ).toEqual({ status: 'stored' });
        expect(
          ((await rawConvo(conversationId)).agentEventActorSuspension as RawRecord).status,
        ).toBe('pending_owned');
      });
    });

    describe('storage metrics and legacy receipt expiry', () => {
      const receipt = (
        threadId: string,
        invocationId: string,
        status: IAgentEventActorReconciliation['status'],
        observedAt: Date,
      ): RawRecord => ({
        invocationId,
        status,
        ...(status === 'settled' && { resolution: 'action_compensated' }),
        checkpoint: { threadId, checkpointNs: `event-actor/${invocationId}` },
        action: { toolName: 'submit_move' },
        observedAt,
      });
      const seedJournal = (
        user: string,
        receipts: Array<[string, IAgentEventActorReconciliation['status'], Date]>,
        record: RawRecord = {},
      ) => {
        const conversationId = newConversationId();
        return seedConvo({
          user,
          conversationId,
          agentEventActorReconciliations: receipts.map(([id, status, observedAt]) =>
            receipt(conversationId, id, status, observedAt),
          ),
          ...record,
        });
      };
      const journalOf = async (conversationId: string) =>
        (
          (await rawConvo(conversationId)).agentEventActorReconciliations as RawRecord[] | undefined
        )?.map((item) => item.invocationId) ?? [];

      it('counts the unsettled lifecycles across conversations and dates the oldest', async () => {
        const now = new Date('2026-08-25T00:00:30.000Z');
        expect(await stores().getAgentEventActorReconciliationStorageMetrics(now)).toEqual({
          pending: 0,
          oldestPendingAgeSeconds: 0,
        });
        await seedJournal(newId(), [
          ['a', 'invocation_pending', new Date('2026-08-25T00:00:20.000Z')],
          ['b', 'settled', new Date('2026-08-01T00:00:00.000Z')],
          ['c', 'persistence_failed', new Date('2026-08-25T00:00:17.500Z')],
        ]);
        await seedJournal(
          newId(),
          [['d', 'history_persisted', new Date('2026-08-25T00:00:25.000Z')]],
          {
            tenantId: 'tenant-a',
          },
        );
        await seedJournal(newId(), [['e', 'settled', new Date('2026-08-24T00:00:00.000Z')]]);
        await seedJournal(
          newId(),
          [['f', 'commit_conflict', new Date('2026-08-25T00:01:00.000Z')]],
          {
            tenantId: 'tenant-b',
          },
        );
        expect(await stores().getAgentEventActorReconciliationStorageMetrics(now)).toEqual({
          pending: 4,
          oldestPendingAgeSeconds: 12.5,
        });
        expect(
          await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
            stores().getAgentEventActorReconciliationStorageMetrics(now),
          ),
        ).toEqual({ pending: 1, oldestPendingAgeSeconds: 5 });
        /** An observation after `now` never reads as a negative age. */
        expect(
          await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
            stores().getAgentEventActorReconciliationStorageMetrics(now),
          ),
        ).toEqual({ pending: 1, oldestPendingAgeSeconds: 0 });
      });

      it('removes settled receipts older than ninety days, keeping recent and active ones', async () => {
        const now = new Date();
        const old = new Date(now.getTime() - 91 * DAY);
        const recent = new Date(now.getTime() - 89 * DAY);
        const user = newId();
        const mixed = await seedJournal(
          user,
          [
            ['old-settled', 'settled', old],
            ['recent-settled', 'settled', recent],
            ['old-active', 'commit_conflict', old],
          ],
          { updatedAt: new Date('2026-03-01T00:00:00.000Z') },
        );
        const recentOnly = await seedJournal(user, [['recent', 'settled', recent]]);
        const activity = { found: false };
        expect(await stores().expireLegacyAgentEventActorReceipts(now, 100, activity)).toBe(1);
        expect(activity.found).toBe(true);
        expect(await journalOf(mixed)).toEqual(['recent-settled', 'old-active']);
        expect(await journalOf(recentOnly)).toEqual(['recent']);
        expect(timeOf((await rawConvo(mixed)).updatedAt)).toBe(
          Date.parse('2026-03-01T00:00:00.000Z'),
        );
        await expect(
          stores().expireLegacyAgentEventActorReceipts(new Date('not a date')),
        ).rejects.toThrow('now must be a valid date');
      });

      it('keeps a receipt while its delivery is unhandled or its handling has started', async () => {
        const now = new Date();
        const old = new Date(now.getTime() - 91 * DAY);
        const user = newId();
        const unhandled = await seedJournal(user, [['unhandled', 'settled', old]]);
        const started = await seedJournal(user, [['started', 'settled', old]]);
        const applied = await seedJournal(user, [['applied', 'settled', old]]);
        const delivery = (deliveryKey: string, handling?: RawRecord): RawRecord => ({
          _id: newId(),
          deliveryKey,
          fingerprint: `${deliveryKey}-fingerprint`,
          orderingKey: `${deliveryKey}-lane`,
          laneSequence: 1,
          user,
          status: 'succeeded',
          attempts: 1,
          availableAt: now,
          ...(handling != null && { handling }),
        });
        await harness.seedRaw('agenttriggerdeliveries', [
          delivery('unhandled'),
          delivery('started', { status: 'started', conversationId: started, startedAt: now }),
          delivery('applied', {
            status: 'applied',
            conversationId: applied,
            startedAt: now,
            settledAt: now,
          }),
        ]);
        expect(await stores().expireLegacyAgentEventActorReceipts(now)).toBe(1);
        expect(await journalOf(unhandled)).toEqual(['unhandled']);
        expect(await journalOf(started)).toEqual(['started']);
        expect(await journalOf(applied)).toEqual([]);
      });

      it('pages the sweep across calls on one store, oldest conversation first, then restarts', async () => {
        const now = new Date();
        const old = new Date(now.getTime() - 91 * DAY);
        const user = newId();
        const fresh = await seedJournal(user, [['fresh', 'settled', now]]);
        const first = await seedJournal(user, [['first', 'settled', old]]);
        const second = await seedJournal(user, [['second', 'settled', old]]);
        const store = stores();
        const activity = { found: false };
        /** A full page with nothing to remove still reports activity. */
        expect(await store.expireLegacyAgentEventActorReceipts(now, 1, activity)).toBe(0);
        expect(activity.found).toBe(true);
        expect(await store.expireLegacyAgentEventActorReceipts(now, 1)).toBe(1);
        expect(await journalOf(first)).toEqual([]);
        expect(await journalOf(second)).toEqual(['second']);
        expect(await store.expireLegacyAgentEventActorReceipts(now, 1)).toBe(1);
        expect(await journalOf(second)).toEqual([]);
        const idle = { found: false };
        expect(await store.expireLegacyAgentEventActorReceipts(now, 1, idle)).toBe(0);
        expect(idle.found).toBe(false);
        expect(await journalOf(fresh)).toEqual(['fresh']);
        /** The walk restarted: a receipt that ages in is found from the beginning again. */
        const later = new Date(now.getTime() + 91 * DAY);
        expect(await store.expireLegacyAgentEventActorReceipts(later, 1)).toBe(1);
        expect(await journalOf(fresh)).toEqual([]);
      });
    });
  });
}
