/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SubagentContentStore` contract (`~/ports/subagentContent`), ported from
 * `methods/subagentContent.recovery.spec.ts` and the method bodies it covers: numbered batches
 * committed under the thread's lease and read back in revision order (whole, through a pinned
 * revision, or from the batch holding a sequence), retries with the same bytes changing nothing
 * and with other bytes rejected, every scope field isolating a run, and the content living only as
 * long as its seed message (`<taskId>:user`), its parent conversation and its thread.
 *
 * The cases that inspect the storage encoding (fragment boundaries, the index plans and the
 * documents a seek examines, corrupted or missing fragments written through the driver, a dropped
 * index) stay in the method specs. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { SubagentContentBatch, SubagentContentScope } from '~/types';
import { useContractHarness } from './support';

const GONE = { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };

export function describeSubagentContentContract(harness: ContractHarness): void {
  describe(`SubagentContentStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().subagentContent;
    const newId = () => harness.ids.generate();
    const scope: SubagentContentScope = {
      tenantId: 'tenant',
      user: 'owner',
      parentConversationId: 'parent',
      conversationId: 'child',
      taskId: 'task',
    };
    const leaseToken = 'lease-token';

    /** The seed message, the parent conversation and the child thread holding a live lease. */
    const seedRun = async (
      target: SubagentContentScope = scope,
      overrides: {
        seed?: RawRecord | null;
        parent?: RawRecord | null;
        child?: RawRecord | null;
      } = {},
    ) => {
      const owner = {
        user: target.user,
        ...(target.tenantId == null ? {} : { tenantId: target.tenantId }),
      };
      if (overrides.seed !== null) {
        await harness.seedRaw('messages', [
          {
            _id: newId(),
            ...owner,
            conversationId: target.conversationId,
            messageId: `${target.taskId}:user`,
            isCreatedByUser: true,
            text: 'Investigate',
            subagentContent: { version: 1, throughSequence: 0 },
            ...overrides.seed,
          },
        ]);
      }
      if (overrides.parent !== null) {
        await harness.seedRaw('conversations', [
          {
            _id: newId(),
            ...owner,
            conversationId: target.parentConversationId,
            endpoint: 'agents',
            ...overrides.parent,
          },
        ]);
      }
      if (overrides.child !== null) {
        await harness.seedRaw('conversations', [
          {
            _id: newId(),
            ...owner,
            conversationId: target.conversationId,
            endpoint: 'agents',
            subagentThread: {
              rootConversationId: target.parentConversationId,
              parentConversationId: target.parentConversationId,
              parentMessageId: 'parent-message',
              parentToolCallId: 'parent-tool',
              subagentType: 'researcher',
              subagentKind: 'agent',
              depth: 1,
            },
            subagentThreadLease: {
              token: leaseToken,
              taskId: target.taskId,
              expiresAt: new Date(Date.now() + 3_600_000),
            },
            ...overrides.child,
          },
        ]);
      }
    };
    const batch = (revision: number, eventsJson?: string): SubagentContentBatch => ({
      revision,
      fromSequence: revision * 3 - 3,
      throughSequence: revision * 3 - 1,
      eventsJson:
        eventsJson ??
        JSON.stringify([{ sequence: revision * 3 - 3 }, { sequence: revision * 3 - 1 }]),
    });
    const append = (revision: number, target = scope, eventsJson?: string) =>
      stores().appendSubagentContentBatch({
        ...target,
        ...batch(revision, eventsJson),
        leaseToken,
      });
    const read = async (throughRevision: number, afterSequence?: number, target = scope) => {
      const batches: SubagentContentBatch[] = [];
      for await (const item of stores().streamSubagentContentBatches(
        target,
        throughRevision,
        afterSequence,
      )) {
        batches.push(item);
      }
      return batches;
    };
    const revisions = async (throughRevision: number, afterSequence?: number, target = scope) =>
      (await read(throughRevision, afterSequence, target)).map(({ revision }) => revision);

    describe('appendSubagentContentBatch, getSubagentContentHead and streamSubagentContentBatches', () => {
      it('commits batches and reads them back exactly, in revision order', async () => {
        await seedRun();
        const large = JSON.stringify([
          { sequence: 3, text: `${'x'.repeat(128 * 1024 - 1)}😀${'y'.repeat(128 * 1024)}𐐷` },
        ]);
        expect(await append(1)).toEqual({ ok: true });
        expect(await append(2, scope, large)).toEqual({ ok: true });
        expect(await stores().getSubagentContentHead(scope)).toEqual({
          revision: 2,
          throughSequence: 5,
        });
        expect(await read(2)).toEqual([batch(1), batch(2, large)]);
      });

      it('pins reads to a revision and resumes from the batch holding a sequence', async () => {
        await seedRun();
        for (const revision of [1, 2, 3]) {
          await append(revision);
        }
        expect(await stores().getSubagentContentHead(scope, 2)).toEqual({
          revision: 2,
          throughSequence: 5,
        });
        expect(await stores().getSubagentContentHead(scope, 0)).toBeNull();
        expect(await revisions(3)).toEqual([1, 2, 3]);
        expect(await revisions(2)).toEqual([1, 2]);
        expect(await revisions(3, -1)).toEqual([1, 2, 3]);
        expect(await revisions(3, 2)).toEqual([2, 3]);
        /** Inside the last pinned batch, not only at a batch boundary. */
        expect(await revisions(2, 3)).toEqual([2]);
        expect(await revisions(2, 5)).toEqual([]);
        expect(await revisions(3, 8)).toEqual([]);
        expect(await revisions(0)).toEqual([]);
      });

      it('changes nothing on a retry with the same bytes and rejects one with other bytes', async () => {
        await seedRun();
        expect(await append(1)).toEqual({ ok: true });
        expect(await append(1)).toEqual({ ok: true });
        expect(await read(1)).toEqual([batch(1)]);
        await expect(append(1, scope, '[{"sequence":0,"changed":true}]')).rejects.toThrow();
        expect(await read(1)).toEqual([batch(1)]);
      });

      it('rejects a revision below 1 and sequences that are not a range', async () => {
        await seedRun();
        for (const invalid of [
          { revision: 0, fromSequence: 0, throughSequence: 1 },
          { revision: 1.5, fromSequence: 0, throughSequence: 1 },
          { revision: 1, fromSequence: -1, throughSequence: 1 },
          { revision: 1, fromSequence: 2, throughSequence: 1 },
        ]) {
          await expect(
            stores().appendSubagentContentBatch({
              ...scope,
              ...invalid,
              eventsJson: '[]',
              leaseToken,
            }),
          ).rejects.toThrow('Invalid subagent content batch');
        }
        expect(await stores().getSubagentContentHead(scope)).toBeNull();
      });

      it('isolates a run by every scope field', async () => {
        /** Runs of the same thread in another tenant, of another user, and outside any tenant. */
        const neighbors: SubagentContentScope[] = [
          { ...scope, tenantId: 'foreign' },
          { ...scope, user: 'foreign' },
          { ...scope, tenantId: undefined },
        ];
        await seedRun();
        await append(1);
        await append(2);
        for (const neighbor of neighbors) {
          await seedRun(neighbor);
          expect(await append(1, neighbor)).toEqual({ ok: true });
        }
        expect(await revisions(2)).toEqual([1, 2]);
        for (const neighbor of neighbors) {
          expect(await revisions(2, -1, neighbor)).toEqual([1]);
          expect(await stores().getSubagentContentHead(neighbor)).toEqual({
            revision: 1,
            throughSequence: 2,
          });
        }
        for (const foreign of [
          { ...scope, taskId: 'foreign' },
          { ...scope, parentConversationId: 'foreign' },
          { ...scope, conversationId: 'foreign' },
        ]) {
          expect(await revisions(2, -1, foreign)).toEqual([]);
          expect(await stores().getSubagentContentHead(foreign)).toBeNull();
        }
      });

      it('commits nothing without the live lease, and the content stays', async () => {
        await seedRun();
        await append(1);
        expect(
          await stores().appendSubagentContentBatch({
            ...scope,
            ...batch(2),
            leaseToken: 'another-lease',
          }),
        ).toEqual(GONE);
        expect(await revisions(2)).toEqual([1]);
        expect(await stores().appendSubagentContentBatch({ ...scope, ...batch(2) })).toEqual({
          ok: true,
        });
        expect(await revisions(2)).toEqual([1, 2]);
      });

      it('commits nothing once the lease expired or belongs to another task', async () => {
        await seedRun(scope, {
          child: {
            subagentThreadLease: {
              token: leaseToken,
              taskId: scope.taskId,
              expiresAt: new Date(Date.now() - 1000),
            },
          },
        });
        expect(await append(1)).toEqual(GONE);
        expect(await stores().getSubagentContentHead(scope)).toBeNull();
        const other = {
          ...scope,
          conversationId: 'child-2',
          parentConversationId: 'parent-2',
          taskId: 'task-2',
        };
        await seedRun(other, {
          child: {
            subagentThreadLease: {
              token: leaseToken,
              taskId: 'other-task',
              expiresAt: new Date(Date.now() + 60_000),
            },
          },
        });
        expect(await append(1, other)).toEqual(GONE);
        expect(await stores().getSubagentContentHead(other)).toBeNull();
      });

      it('never reads content whose seed message has expired', async () => {
        await seedRun(scope, { seed: { expiredAt: new Date(Date.now() + 1500) } });
        expect(await append(1)).toEqual({ ok: true });
        expect(await revisions(1)).toEqual([1]);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(await stores().getSubagentContentHead(scope)).toBeNull();
        expect(await revisions(1)).toEqual([]);
      });
    });

    describe('reconcileSubagentContent', () => {
      it('keeps the content while the seed, the parent and the thread exist, needing no lease', async () => {
        await seedRun(scope, {
          child: { subagentThreadLease: undefined },
        });
        expect(await stores().reconcileSubagentContent(scope)).toEqual({ ok: true });
      });

      it.each([
        ['the seed message is gone', { seed: null }],
        [
          'the seed message is marked deleted',
          { seed: { subagentContent: { version: 1, deleted: true } } },
        ],
        ['the seed message expired', { seed: { expiredAt: new Date(Date.now() - 1000) } }],
        ['the parent conversation is gone', { parent: null }],
        ['the parent conversation expired', { parent: { expiredAt: new Date(Date.now() - 1000) } }],
        ['the thread is gone', { child: null }],
        [
          'the thread belongs to another parent',
          { child: { subagentThread: { parentConversationId: 'elsewhere' } } },
        ],
      ] as Array<[string, Parameters<typeof seedRun>[1]]>)(
        'discards the content once %s, and appends report it gone',
        async (_case, overrides) => {
          await seedRun();
          await append(1);
          await append(2);
          await harness.reset();
          await seedRun(scope, overrides);
          expect(await stores().reconcileSubagentContent(scope)).toEqual(GONE);
          expect(await stores().getSubagentContentHead(scope)).toBeNull();
          expect(await revisions(2)).toEqual([]);
          expect(await append(3)).toEqual(GONE);
          expect(await stores().getSubagentContentHead(scope)).toBeNull();
        },
      );

      it('loses its content when the messages delete removes its seed', async () => {
        const other = { ...scope, taskId: 'other-task' };
        await seedRun();
        await harness.seedRaw('messages', [
          {
            _id: newId(),
            user: scope.user,
            tenantId: scope.tenantId,
            conversationId: scope.conversationId,
            messageId: 'other-task:user',
            isCreatedByUser: true,
          },
        ]);
        await append(1);
        expect(await stores().appendSubagentContentBatch({ ...other, ...batch(1) })).toEqual(GONE);
        await stores().appendSubagentContentBatch({ ...scope, ...batch(2), leaseToken });
        await harness.createStores().messages.deleteMessages({
          user: scope.user,
          conversationId: scope.conversationId,
          messageId: `${scope.taskId}:user`,
        });
        expect(await stores().reconcileSubagentContent(scope)).toEqual(GONE);
        expect(await revisions(2)).toEqual([]);
      });
    });
  });
}
