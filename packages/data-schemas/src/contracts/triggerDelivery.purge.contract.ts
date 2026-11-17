/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TriggerDeliveryStore` contract (`~/ports/triggerDelivery`), fifth part: deletion, ported
 * from `methods/triggerDelivery.spec.ts`. The account purge (the marker armed only while the
 * owner's user record holds the deletion fence, admissions closed on every delivery and reopened
 * by the exact owner's cancel, the recovery sweep that never destroys an active user's data,
 * disarms an abandoned attempt, rotates markers so a committed purge is not starved and finishes
 * it, the owner's queued turns included), the immediate deletion, and the conversation result
 * erasure with its fence (a late producer cannot restore an erased result; the sweep erases the
 * results of conversations since deleted and keeps those of live ones).
 *
 * The sweeps read the owner's user record and whether a conversation still exists: those records
 * are seeded raw (`users`, `conversations`), and the owner's queued turns too (`agentqueuedturns`,
 * which the composition purges through the queued-turn store).
 *
 * Not here (they stay in the method spec): the queued-turn purge made to fail through an injected
 * callback, and the read-preference spies. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import { AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2 } from '~/types';
import type { ContractHarness } from './harness';
import {
  BACKGROUND_SOURCE,
  CONVERSATIONS,
  DELIVERIES,
  LANES,
  PURGES,
  QUEUED_TURNS,
  START,
  USERS,
  createTriggerDeliveryFixtures,
} from './triggerDelivery.fixtures';
import { timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const RECEIPT_V2 = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2;

export function describeTriggerDeliveryPurgeContract(harness: ContractHarness): void {
  describe(`TriggerDeliveryStore contract (deletion): ${harness.name}`, () => {
    useContractHarness(harness);

    const f = createTriggerDeliveryFixtures(harness);
    const store = () => f.store();
    const ofUser = async (collection: string, user: string) =>
      (await harness.readRaw(collection)).filter((row) => row.user === user);
    const deleteUser = (user: string) => f.dropRaw(USERS, (row) => row._id === user);
    const seedQueuedTurn = async (user: string, conversationId: string) => {
      await harness.seedRaw(QUEUED_TURNS, [
        {
          _id: harness.ids.generate(),
          user,
          conversationId,
          agentId: 'agent-1',
          parentMessageId: 'parent-1',
          clientRequestId: `request-${conversationId}`,
          fingerprint: 'f'.repeat(43),
          laneId: `lane-${conversationId}`,
          status: 'cancelled',
          priority: false,
          text: 'follow up',
          attempts: 0,
          availableAt: START,
          deliveryState: 'retired',
          createdAt: START,
          updatedAt: START,
        },
      ]);
    };
    const bindingDelivery = (user: string) =>
      f.enqueue({ user, envelope: { mode: 'continue', target: { bindingId: 'binding-purge' } } });

    /* ------------------------------------------------------------------ purge markers */

    describe('prepareAgentTriggerUserPurge and cancelAgentTriggerUserPurge', () => {
      it('arms a marker only while the user record holds the fence', async () => {
        const user = f.newUser();
        await expect(store().prepareAgentTriggerUserPurge(user, START)).rejects.toThrow(
          'Cannot prepare trigger purge without owning the user deletion fence',
        );
        await f.seedUser(user, START);
        await expect(store().prepareAgentTriggerUserPurge(user, f.at(1))).rejects.toThrow(
          'Cannot prepare trigger purge without owning the user deletion fence',
        );
        expect(await harness.readRaw(PURGES)).toEqual([]);

        await expect(
          store().prepareAgentTriggerUserPurge(user, START, 'tenant-1'),
        ).resolves.toBeUndefined();
        const marker = await f.purgeMarker(user);
        /** NOTE(contract): the `tenantId` argument is not stored outside a tenant context: the
         * tenant-isolation policy strips `tenantId` from the marker upsert's `$set`. */
        expect(marker).toMatchObject({ _id: user });
        expect(marker).not.toHaveProperty('tenantId');
        expect(timeOf(marker?.fenceStartedAt)).toBe(START.getTime());
        await expect(
          store().prepareAgentTriggerUserPurge(f.storeId(user), START),
        ).resolves.toBeUndefined();
        expect(await harness.readRaw(PURGES)).toHaveLength(1);
        await expect(
          store().prepareAgentTriggerUserPurge(user, new Date(Number.NaN)),
        ).rejects.toBeInstanceOf(TypeError);
      });

      it('stamps the marker with the tenant in context', async () => {
        const user = f.newUser();
        await harness.seedRaw(USERS, [
          {
            _id: user,
            email: 'tenant-purge@example.com',
            provider: 'local',
            tenantId: 'tenant-a',
            agentTriggerDeletionStartedAt: START,
            createdAt: START,
            updatedAt: START,
          },
        ]);
        await expect(
          tenantStorage.run({ tenantId: 'tenant-b' }, () =>
            store().prepareAgentTriggerUserPurge(user, START),
          ),
        ).rejects.toThrow('Cannot prepare trigger purge without owning the user deletion fence');
        await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          store().prepareAgentTriggerUserPurge(user, START),
        );
        expect(await f.purgeMarker(user)).toMatchObject({ _id: user, tenantId: 'tenant-a' });
      });

      it('closes admissions on every delivery of the owner and reopens them on cancel', async () => {
        const user = f.newUser();
        await f.seedUser(user, START);
        const first = await bindingDelivery(user);
        const second = await bindingDelivery(user);
        const bystander = await bindingDelivery(f.newUser());
        await f.rewrite((collections) => {
          for (const row of collections[DELIVERIES]) row.status = 'succeeded';
        });
        const admission = {
          deliveryKey: first.delivery.deliveryKey,
          user,
          tenantId: 'tenant-1',
          bindingId: 'binding-purge',
          conversationId: 'conversation-purge',
          admittedAt: START,
          admissionId: 'admission-before-purge',
        };
        await expect(store().admitAgentEventActorAction(admission)).resolves.toBe(true);
        await store().prepareAgentTriggerUserPurge(user, START);

        await expect(
          store().countActiveAgentTriggerDeliveriesByUser(user, f.at(60_001)),
        ).resolves.toBe(1);
        await expect(
          store().admitAgentEventActorAction({
            ...admission,
            deliveryKey: second.delivery.deliveryKey,
            admissionId: 'admission-after-purge',
          }),
        ).resolves.toBe(false);
        const closed = (await ofUser(DELIVERIES, user)).map((row) =>
          timeOf(row.actorActionAdmissionClosedAt),
        );
        expect(closed).toEqual([START.getTime(), START.getTime()]);
        expect(await f.raw(bystander.delivery.id)).not.toHaveProperty(
          'actorActionAdmissionClosedAt',
        );

        await expect(store().cancelAgentTriggerUserPurge(user, f.at(1))).resolves.toBe(false);
        expect(await f.purgeMarker(user)).toBeDefined();
        await expect(store().cancelAgentTriggerUserPurge(user, START)).resolves.toBe(true);
        expect(await f.purgeMarker(user)).toBeUndefined();
        for (const row of await ofUser(DELIVERIES, user)) {
          expect(row).not.toHaveProperty('actorActionAdmissionClosedAt');
        }
        await expect(
          store().admitAgentEventActorAction({
            ...admission,
            deliveryKey: second.delivery.deliveryKey,
            admissionId: 'admission-after-cancel',
          }),
        ).resolves.toBe(true);
      });

      it('cannot disarm a purge once the user deletion committed', async () => {
        const user = f.newUser();
        await f.seedUser(user, START);
        await store().prepareAgentTriggerUserPurge(user, START);
        await deleteUser(user);
        await expect(store().cancelAgentTriggerUserPurge(user, START)).resolves.toBe(false);
        expect(await f.purgeMarker(user)).toBeDefined();
        await expect(
          store().cancelAgentTriggerUserPurge(user, new Date(Number.NaN)),
        ).rejects.toBeInstanceOf(TypeError);
      });
    });

    /* ------------------------------------------------------------------ recovery */

    describe('recoverAgentTriggerUserPurges', () => {
      it('never purges an owner whose deletion is still pending, and finishes it once committed', async () => {
        const user = f.newUser();
        const other = f.newUser();
        await f.seedUser(user, START);
        await f.enqueue({ user, orderingKey: 'purged-lane' });
        await f.enqueue({ user: other, orderingKey: 'kept-lane' });
        await seedQueuedTurn(user, 'conversation-purged');
        await seedQueuedTurn(other, 'conversation-kept');
        await store().prepareAgentTriggerUserPurge(user, START, 'tenant-1');

        const activity = { found: false };
        await expect(store().recoverAgentTriggerUserPurges(25, activity)).resolves.toBe(0);
        expect(activity.found).toBe(true);
        expect(await ofUser(DELIVERIES, user)).toHaveLength(1);
        expect(await f.purgeMarker(user)).toBeDefined();
        expect(await ofUser(QUEUED_TURNS, user)).toHaveLength(1);

        await deleteUser(user);
        await expect(store().recoverAgentTriggerUserPurges()).resolves.toBe(1);
        expect(await ofUser(DELIVERIES, user)).toEqual([]);
        expect(await ofUser(LANES, user)).toEqual([]);
        expect(await f.purgeMarker(user)).toBeUndefined();
        expect(await ofUser(QUEUED_TURNS, user)).toEqual([]);
        expect(await ofUser(DELIVERIES, other)).toHaveLength(1);
        expect(await ofUser(LANES, other)).toHaveLength(1);
        expect(await ofUser(QUEUED_TURNS, other)).toHaveLength(1);

        const idle = { found: false };
        await expect(store().recoverAgentTriggerUserPurges(25, idle)).resolves.toBe(0);
        expect(idle.found).toBe(false);
      });

      it('disarms a marker whose deletion attempt was abandoned, keeping the deliveries', async () => {
        const user = f.newUser();
        await f.seedUser(user, START);
        await f.enqueue({ user });
        await store().prepareAgentTriggerUserPurge(user, START);
        await f.rewrite((collections) => {
          delete collections[USERS].find((row) => row._id === user)!.agentTriggerDeletionStartedAt;
        });

        await expect(store().recoverAgentTriggerUserPurges()).resolves.toBe(0);
        const rows = await ofUser(DELIVERIES, user);
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty('actorActionAdmissionClosedAt');
        expect(await f.purgeMarker(user)).toBeUndefined();
      });

      it('disarms a marker of an older attempt when a newer one holds the fence', async () => {
        const user = f.newUser();
        await f.seedUser(user, START);
        await f.enqueue({ user });
        await store().prepareAgentTriggerUserPurge(user, START);
        await f.rewrite((collections) => {
          collections[USERS].find((row) => row._id === user)!.agentTriggerDeletionStartedAt =
            f.at(1);
        });
        await expect(store().recoverAgentTriggerUserPurges()).resolves.toBe(0);
        expect(await f.purgeMarker(user)).toBeUndefined();
        expect(await ofUser(DELIVERIES, user)).toHaveLength(1);
      });

      it('rotates active markers so a later committed purge is recovered', async () => {
        const users = [f.newUser(), f.newUser(), f.newUser()];
        for (const user of users) {
          await f.seedUser(user, START);
          await store().prepareAgentTriggerUserPurge(user, START);
        }
        await f.rewrite((collections) => {
          for (const [index, user] of users.entries()) {
            collections[PURGES].find((row) => row._id === user)!.updatedAt = f.at(index);
          }
        });
        await f.seedDelivery({ user: users[2], orderingKey: 'committed-purge-lane' });
        await deleteUser(users[2]);

        await expect(store().recoverAgentTriggerUserPurges(2)).resolves.toBe(0);
        await expect(store().recoverAgentTriggerUserPurges(2)).resolves.toBe(1);
        expect(await f.purgeMarker(users[2])).toBeUndefined();
        expect(await ofUser(DELIVERIES, users[2])).toEqual([]);
        expect(await f.purgeMarker(users[0])).toBeDefined();
        expect(await f.purgeMarker(users[1])).toBeDefined();
      });

      it('erases the pending results of a deleted conversation and keeps a live one', async () => {
        const user = f.newUser();
        const completion = (conversationId: string) =>
          f.enqueue({
            user,
            orderingKey: `lane-${conversationId}`,
            envelope: { event: { source: BACKGROUND_SOURCE }, target: { conversationId } },
            requiredWorkerCapability: RECEIPT_V2,
          });
        const persist = (deliveryKey: string, output: string) =>
          store().persistAgentBackgroundToolResult({
            deliveryKey,
            sourceId: BACKGROUND_SOURCE.id,
            result: { status: 'completed', output, settledAt: START },
          });
        const deleted = await completion('deleted-child');
        const live = await completion('live-child');
        await persist(deleted.delivery.deliveryKey, 'private child output');
        await persist(live.delivery.deliveryKey, 'private live output');
        await store().prepareAgentTriggerConversationResultErasure(user, [
          'deleted-child',
          'live-child',
        ]);
        await harness.seedRaw(CONVERSATIONS, [
          {
            _id: harness.ids.generate(),
            conversationId: 'live-child',
            user,
            endpoint: 'agents',
            createdAt: START,
            updatedAt: START,
          },
        ]);
        const livePendingBefore = (await f.raw(live.delivery.id))
          ?.backgroundToolResultDeletionPendingAt;
        expect(livePendingBefore).toBeInstanceOf(Date);
        await f.patchDelivery(live.delivery.id, { backgroundToolResultDeletionPendingAt: START });

        const activity = { found: false };
        await store().recoverAgentTriggerUserPurges(25, activity);
        expect(activity.found).toBe(true);
        const lookup = (deliveryKey: string) =>
          store().getAgentBackgroundToolResult({ deliveryKey, sourceId: BACKGROUND_SOURCE.id });
        await expect(lookup(deleted.delivery.deliveryKey)).resolves.toBeNull();
        await expect(lookup(live.delivery.deliveryKey)).resolves.toMatchObject({
          output: 'private live output',
        });
        const erased = await f.raw(deleted.delivery.id);
        expect(erased).not.toHaveProperty('backgroundToolResultDeletionPendingAt');
        expect(erased?.backgroundToolResultErasedAt).toBeInstanceOf(Date);
        /** A live conversation's fence moves behind the scan. */
        expect(
          timeOf((await f.raw(live.delivery.id))?.backgroundToolResultDeletionPendingAt),
        ).toBeGreaterThan(START.getTime());
        await expect(persist(deleted.delivery.deliveryKey, 'late write')).resolves.toBe(false);
      });

      it('refuses a limit that is not a positive integer', async () => {
        for (const limit of [0, -1, 1.5]) {
          await expect(store().recoverAgentTriggerUserPurges(limit)).rejects.toBeInstanceOf(
            TypeError,
          );
        }
      });
    });

    /* ------------------------------------------------------------------ deletion */

    describe('deleteAgentTriggerDeliveriesByUser', () => {
      it('deletes every delivery, lane, marker and queued turn of the owner only', async () => {
        const user = f.newUser();
        const other = f.newUser();
        await f.seedUser(user, START);
        await f.enqueue({ user, orderingKey: 'ordering-erased' });
        await f.enqueue({ user, orderingKey: 'ordering-erased' });
        await f.enqueue({ user: other, orderingKey: 'ordering-other' });
        await seedQueuedTurn(user, 'conversation-1');
        await seedQueuedTurn(other, 'conversation-2');
        await store().prepareAgentTriggerUserPurge(user, START);
        await deleteUser(user);

        await expect(store().deleteAgentTriggerDeliveriesByUser(user)).resolves.toBeUndefined();
        expect(await ofUser(DELIVERIES, user)).toEqual([]);
        expect(await harness.readRaw(DELIVERIES)).toHaveLength(1);
        expect(await ofUser(LANES, user)).toEqual([]);
        expect(await harness.readRaw(LANES)).toHaveLength(1);
        expect(await f.purgeMarker(user)).toBeUndefined();
        expect(await ofUser(QUEUED_TURNS, user)).toEqual([]);
        expect(await ofUser(QUEUED_TURNS, other)).toHaveLength(1);

        await expect(
          store().deleteAgentTriggerDeliveriesByUser(f.storeId(other)),
        ).resolves.toBeUndefined();
        expect(await harness.readRaw(DELIVERIES)).toEqual([]);
      });
    });

    describe('eraseAgentTriggerDeliveryConversationResults and prepareAgentTriggerConversationResultErasure', () => {
      const completion = (user: string, conversationId: string, overrides = {}) =>
        f.enqueue({
          user,
          orderingKey: `lane-${conversationId}-${f.newUser()}`,
          envelope: { event: { source: BACKGROUND_SOURCE }, target: { conversationId } },
          requiredWorkerCapability: RECEIPT_V2,
          ...overrides,
        });
      const persist = (deliveryKey: string, output = 'private output') =>
        store().persistAgentBackgroundToolResult({
          deliveryKey,
          sourceId: BACKGROUND_SOURCE.id,
          result: { status: 'completed', output, settledAt: START },
        });

      it('erases the results of the named conversations and fences a late producer', async () => {
        const user = f.newUser();
        const erased = await completion(user, 'conversation-to-delete');
        const kept = await completion(user, 'conversation-kept');
        const otherUser = await completion(f.newUser(), 'conversation-to-delete');
        for (const queued of [erased, kept, otherUser]) {
          await persist(queued.delivery.deliveryKey);
        }
        const updatedAt = (await f.raw(erased.delivery.id))?.updatedAt;

        await store().eraseAgentTriggerDeliveryConversationResults(user, [
          'conversation-to-delete',
        ]);

        const lookup = (deliveryKey: string) =>
          store().getAgentBackgroundToolResult({ deliveryKey, sourceId: BACKGROUND_SOURCE.id });
        await expect(lookup(erased.delivery.deliveryKey)).resolves.toBeNull();
        await expect(lookup(kept.delivery.deliveryKey)).resolves.not.toBeNull();
        await expect(lookup(otherUser.delivery.deliveryKey)).resolves.not.toBeNull();
        const row = await f.raw(erased.delivery.id);
        expect(row?.backgroundToolResultErasedAt).toBeInstanceOf(Date);
        expect(timeOf(row?.updatedAt)).toBe(timeOf(updatedAt));
        await expect(persist(erased.delivery.deliveryKey, 'late private output')).resolves.toBe(
          false,
        );
      });

      it('fences only undelivered receipt-capability results not yet erased', async () => {
        const user = f.newUser();
        const receipt = await completion(user, 'conversation-1');
        const ordinary = await completion(user, 'conversation-1', {
          requiredWorkerCapability: undefined,
        });
        const elsewhere = await completion(user, 'conversation-2');
        const erased = await completion(user, 'conversation-3');
        await store().eraseAgentTriggerDeliveryConversationResults(user, ['conversation-3']);

        await store().prepareAgentTriggerConversationResultErasure(f.storeId(user), [
          'conversation-1',
          'conversation-3',
        ]);
        expect(
          (await f.raw(receipt.delivery.id))?.backgroundToolResultDeletionPendingAt,
        ).toBeInstanceOf(Date);
        for (const queued of [ordinary, elsewhere, erased]) {
          expect(await f.raw(queued.delivery.id)).not.toHaveProperty(
            'backgroundToolResultDeletionPendingAt',
          );
        }
        await store().eraseAgentTriggerDeliveryConversationResults(user, ['conversation-1']);
        expect(await f.raw(receipt.delivery.id)).not.toHaveProperty(
          'backgroundToolResultDeletionPendingAt',
        );
      });

      it('does nothing for an owner that is not a store id, or for no conversations', async () => {
        const user = f.newUser();
        const queued = await completion(user, 'conversation');
        await persist(queued.delivery.deliveryKey);
        await expect(
          store().prepareAgentTriggerConversationResultErasure('legacy-user', ['conversation']),
        ).resolves.toBeUndefined();
        await expect(
          store().eraseAgentTriggerDeliveryConversationResults('legacy-user', ['conversation']),
        ).resolves.toBeUndefined();
        await store().prepareAgentTriggerConversationResultErasure(user, []);
        await store().eraseAgentTriggerDeliveryConversationResults(user, []);
        const row = await f.raw(queued.delivery.id);
        expect(row).toHaveProperty('backgroundToolResult');
        expect(row).not.toHaveProperty('backgroundToolResultDeletionPendingAt');
        expect(row).not.toHaveProperty('backgroundToolResultErasedAt');
      });
    });
  });
}
