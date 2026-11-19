/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `CodeEnvironmentStore` contract (`~/ports/codeEnvironment`) for the steps the lifecycle
 * reconciler, the registry's revocation request and the account deletion run on, ported from
 * `methods/codeEnvironment.reconciliation.spec.ts`: the agent reference lookup per tenant, the
 * revocation request, the sweep of expired agent reference reservations (batches up to the bound
 * captured when the sweep began, its durable progress in `code_environment_reconciliation`, a
 * competing sweep never rewinding it), the interrupted removals and committed deletions, the
 * stale registrations with their lease, deferral and delete, the environments whose creator is
 * gone (an anti-join on the users) and their bulk revocation marking, and the leased, retried
 * worker revocations with the account-deletion marking, commit and error record. The listings
 * are asserted in the order each method defines (by id, or earliest due first). The registry,
 * removal and setup methods are `codeEnvironment.contract.ts`. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { idOf, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const MINUTE = 60_000;
const LEASE_MS = 2 * MINUTE;
const CHECKPOINTS = 'code_environment_reconciliation';
const CHECKPOINT_ID = 'agent-reference-cleanup';

export function describeCodeEnvironmentReconciliationContract(harness: ContractHarness): void {
  describe(`CodeEnvironmentStore contract (reconciliation): ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores();
    const environments = () => stores().codeEnvironments;
    const newId = () => harness.ids.generate();
    const storeId = (id: string) => harness.ids.toStoreId(id);
    const ids = (rows: ReadonlyArray<{ _id?: unknown }>) =>
      rows.map((row) => idOf(harness, row._id));
    const past = (ms = MINUTE) => new Date(Date.now() - ms);
    const future = (ms = MINUTE) => new Date(Date.now() + ms);

    /** Seeds raw environments in ascending id order (`record` per environment id); their ids. */
    const seed = async (
      ...entries: Array<[environmentId: string, record?: RawRecord]>
    ): Promise<string[]> => {
      const all = entries.map(() => newId()).sort();
      await harness.seedRaw(
        'codeenvironments',
        entries.map(([environmentId, record = {}], index) => ({
          _id: all[index],
          environmentId,
          name: environmentId,
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
          createdBy: newId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...record,
        })),
      );
      return all;
    };
    const raw = async (id: string) =>
      (await harness.readRaw('codeenvironments')).find((row) => row._id === id);
    const reservations = async (id: string) =>
      (((await raw(id))?.pendingAgentReferences ?? []) as RawRecord[]).map(
        (entry) => entry.reservationId,
      );
    const checkpoint = async () =>
      (await harness.readRaw(CHECKPOINTS)).find((row) => row._id === CHECKPOINT_ID);
    const agent = (id: string, record: RawRecord): RawRecord => ({
      _id: newId(),
      id,
      name: id,
      provider: 'openAI',
      model: 'gpt-4o',
      author: newId(),
      ...record,
    });

    /* ------------------------------------------------------------------ references and requests */

    describe('isCodeEnvironmentReferencedByAgent', () => {
      it('reports whether an agent of the tenant selects the environment, by either field', async () => {
        await harness.seedRaw('agents', [
          agent('agent_single', { code_environment_id: 'env-single' }),
          agent('agent_many', { code_environment_ids: ['env-other', 'env-many'] }),
          agent('agent_tenant', { code_environment_id: 'env-tenant', tenantId: 'tenant-a' }),
        ]);
        const referenced = (environmentId: string, tenantId?: string) =>
          environments().isCodeEnvironmentReferencedByAgent(environmentId, tenantId);
        await expect(referenced('env-single')).resolves.toBe(true);
        await expect(referenced('env-many')).resolves.toBe(true);
        await expect(referenced('env-unused')).resolves.toBe(false);
        // Without a tenant only agents outside every tenant count, and the other way round.
        await expect(referenced('env-many', 'tenant-a')).resolves.toBe(false);
        await expect(referenced('env-tenant')).resolves.toBe(false);
        await expect(referenced('env-tenant', 'tenant-a')).resolves.toBe(true);
        await expect(referenced('env-tenant', 'tenant-b')).resolves.toBe(false);
      });
    });

    describe('requestCodeEnvironmentRevocation', () => {
      it('marks a live environment, counting the attempt, and refuses a committed or absent one', async () => {
        const [live, committed] = await seed(
          [
            'env-live',
            {
              revocationAttempts: 2,
              revocationLastError: 'boom',
              revocationReconcileAfter: future(),
            },
          ],
          ['env-committed', { deletionCommittedAt: past() }],
        );
        const before = Date.now();
        await expect(environments().requestCodeEnvironmentRevocation('env-live')).resolves.toBe(
          true,
        );
        await expect(
          environments().requestCodeEnvironmentRevocation('env-committed'),
        ).resolves.toBe(false);
        await expect(environments().requestCodeEnvironmentRevocation('env-absent')).resolves.toBe(
          false,
        );
        const marked = await raw(live);
        expect(timeOf(marked?.revocationPendingAt)).toBeGreaterThanOrEqual(before);
        expect(marked?.revocationAttempts).toBe(3);
        expect(marked?.revocationLastError).toBeUndefined();
        expect(marked?.revocationReconcileAfter).toBeUndefined();
        expect((await raw(committed))?.revocationPendingAt).toBeUndefined();
      });

      it('starts the attempt count at one', async () => {
        const [id] = await seed(['env-first']);
        await environments().requestCodeEnvironmentRevocation('env-first');
        expect((await raw(id))?.revocationAttempts).toBe(1);
      });
    });

    /* ------------------------------------------------------------------ reference sweep */

    describe('sweepExpiredCodeEnvironmentReferences', () => {
      const references = (): RawRecord[] => [
        { reservationId: 'expired', expiresAt: past() },
        { reservationId: 'live', expiresAt: future() },
      ];

      it('pulls expired reservations batch by batch up to the captured bound, then restarts', async () => {
        const [first, second, third] = await seed(
          ['env-1', { pendingAgentReferences: references() }],
          ['env-2', { pendingAgentReferences: references() }],
          ['env-3', { pendingAgentReferences: references() }],
        );
        await expect(
          environments().sweepExpiredCodeEnvironmentReferences(new Date(), 2),
        ).resolves.toBe(true);
        expect(await checkpoint()).toEqual({ _id: CHECKPOINT_ID, lastId: second, upperId: third });
        expect(await reservations(first)).toEqual(['live']);
        expect(await reservations(second)).toEqual(['live']);
        expect(await reservations(third)).toEqual(['expired', 'live']);

        // An environment created after the bound was captured waits for the next sweep.
        const [later] = await seed(['env-4', { pendingAgentReferences: references() }]);
        await expect(
          environments().sweepExpiredCodeEnvironmentReferences(new Date(), 2),
        ).resolves.toBe(true);
        expect(await checkpoint()).toEqual({ _id: CHECKPOINT_ID, lastId: null, upperId: null });
        expect(await reservations(third)).toEqual(['live']);
        expect(await reservations(later)).toEqual(['expired', 'live']);

        await expect(
          environments().sweepExpiredCodeEnvironmentReferences(new Date(), 10),
        ).resolves.toBe(true);
        expect(await reservations(later)).toEqual(['live']);
      });

      it('expires reservations by the given time, not the clock', async () => {
        const [id] = await seed([
          'env-1',
          {
            pendingAgentReferences: [
              { reservationId: 'a', expiresAt: future(MINUTE) },
              { reservationId: 'b', expiresAt: future(10 * MINUTE) },
            ],
          },
        ]);
        await environments().sweepExpiredCodeEnvironmentReferences(future(5 * MINUTE), 10);
        expect(await reservations(id)).toEqual(['b']);
      });

      it('completes at once without environments', async () => {
        await expect(
          environments().sweepExpiredCodeEnvironmentReferences(new Date(), 5),
        ).resolves.toBe(true);
        expect(await checkpoint()).toEqual({ _id: CHECKPOINT_ID, lastId: null, upperId: null });
      });

      it('resumes from the durable progress an earlier sweep left, keeping its bound', async () => {
        const [a, b] = await seed(
          ['env-1', { pendingAgentReferences: references() }],
          ['env-2', { pendingAgentReferences: references() }],
        );
        // Another leader's sweep captured the bound and stopped before its first batch.
        await harness.seedRaw(CHECKPOINTS, [{ _id: CHECKPOINT_ID, lastId: null, upperId: b }]);
        await expect(
          environments().sweepExpiredCodeEnvironmentReferences(new Date(), 1),
        ).resolves.toBe(true);
        expect(await checkpoint()).toEqual({ _id: CHECKPOINT_ID, lastId: a, upperId: b });
        expect(await reservations(a)).toEqual(['live']);
        expect(await reservations(b)).toEqual(['expired', 'live']);
      });

      it('runs over environments of every tenant', async () => {
        const [a, b] = await seed(
          ['env-1', { tenantId: 'tenant-a', pendingAgentReferences: references() }],
          ['env-2', { tenantId: 'tenant-b', pendingAgentReferences: references() }],
        );
        await environments().sweepExpiredCodeEnvironmentReferences(new Date(), 10);
        expect(await reservations(a)).toEqual(['live']);
        expect(await reservations(b)).toEqual(['live']);
      });
    });

    /* ------------------------------------------------------------------ removals */

    describe('findExpiredCodeEnvironmentRemovals', () => {
      it('lists uncommitted removals whose lease expired, by id, up to the limit', async () => {
        const [expiredA, expiredB] = await seed(
          ['env-a', { deletionLeaseExpiresAt: past() }],
          ['env-b', { deletionLeaseExpiresAt: past() }],
          ['env-c', { deletionLeaseExpiresAt: past() }],
          ['env-leased', { deletionLeaseExpiresAt: future() }],
          ['env-done', { deletionLeaseExpiresAt: past(), deletionCommittedAt: past() }],
          ['env-live'],
        );
        const listed = await environments().findExpiredCodeEnvironmentRemovals(new Date(), 2);
        expect(ids(listed)).toEqual([expiredA, expiredB]);
        expect(Object.keys(listed[0])).toEqual(['_id']);
        expect(
          await environments().findExpiredCodeEnvironmentRemovals(future(2 * MINUTE), 10),
        ).toHaveLength(4);
      });
    });

    describe('findCommittedCodeEnvironmentDeletions', () => {
      it('lists the committed removals, whole, up to the limit', async () => {
        const [committedA, , committedB] = await seed(
          ['env-committed-a', { deletionCommittedAt: past() }],
          ['env-live'],
          ['env-committed-b', { deletionCommittedAt: past() }],
        );
        const listed = await environments().findCommittedCodeEnvironmentDeletions(5);
        expect(ids(listed).sort()).toEqual([committedA, committedB].sort());
        expect(listed.map((row) => row.environmentId).sort()).toEqual([
          'env-committed-a',
          'env-committed-b',
        ]);
        await expect(environments().findCommittedCodeEnvironmentDeletions(1)).resolves.toHaveLength(
          1,
        );
      });
    });

    /* ------------------------------------------------------------------ stale registrations */

    describe('findStaleCodeEnvironmentRegistrations', () => {
      it('lists stale, due, unleased registrations that are no setup reservations, earliest due first', async () => {
        const staleBefore = past(5 * MINUTE);
        const [dueLater, dueFirst, neverDeferred] = await seed(
          [
            'env-due-later',
            { registrationPendingAt: past(10 * MINUTE), registrationReconcileAfter: past() },
          ],
          [
            'env-due-first',
            {
              registrationPendingAt: past(10 * MINUTE),
              registrationReconcileAfter: past(2 * MINUTE),
            },
          ],
          ['env-never-deferred', { registrationPendingAt: past(10 * MINUTE) }],
          ['env-fresh', { registrationPendingAt: past(1_000) }],
          ['env-setup', { registrationPendingAt: past(10 * MINUTE), setupAttemptId: 'attempt' }],
          [
            'env-deferred',
            { registrationPendingAt: past(10 * MINUTE), registrationReconcileAfter: future() },
          ],
          [
            'env-leased',
            { registrationPendingAt: past(10 * MINUTE), registrationLeaseExpiresAt: future() },
          ],
          [
            'env-lease-expired',
            { registrationPendingAt: past(10 * MINUTE), registrationLeaseExpiresAt: past() },
          ],
          ['env-live'],
        );
        const leaseExpired = (await harness.readRaw('codeenvironments')).find(
          (row) => row.environmentId === 'env-lease-expired',
        )?._id;
        const listed = await environments().findStaleCodeEnvironmentRegistrations(
          staleBefore,
          new Date(),
          10,
        );
        // Never-deferred registrations (no retry time) sort first, then by retry time, then id.
        expect(ids(listed)).toEqual([neverDeferred, leaseExpired, dueFirst, dueLater]);
        expect(Object.keys(listed[0])).toEqual(['_id']);
        await expect(
          environments().findStaleCodeEnvironmentRegistrations(staleBefore, new Date(), 1),
        ).resolves.toHaveLength(1);
      });
    });

    describe('stale registration lease', () => {
      it('leases, defers and deletes a stale registration only under its lease', async () => {
        const staleBefore = past(5 * MINUTE);
        const [id] = await seed(['env-stale', { registrationPendingAt: past(10 * MINUTE) }]);
        const leaseId = newId();
        const before = Date.now();

        const claimed = await environments().claimStaleCodeEnvironmentRegistration(
          storeId(id),
          staleBefore,
          leaseId,
          LEASE_MS,
        );
        expect(claimed?.registrationLeaseId).toBe(leaseId);
        expect(timeOf(claimed?.registrationLeaseExpiresAt)).toBeGreaterThanOrEqual(
          before + LEASE_MS,
        );
        await expect(
          environments().claimStaleCodeEnvironmentRegistration(id, staleBefore, 'other', LEASE_MS),
        ).resolves.toBeNull();

        const reconcileAfter = future(5 * MINUTE);
        await environments().deferCodeEnvironmentRegistration(id, 'other', reconcileAfter);
        expect((await raw(id))?.registrationLeaseId).toBe(leaseId);
        await environments().deferCodeEnvironmentRegistration(storeId(id), leaseId, reconcileAfter);
        const deferred = await raw(id);
        expect(timeOf(deferred?.registrationReconcileAfter)).toBe(reconcileAfter.getTime());
        expect(deferred?.registrationLeaseId).toBeUndefined();
        expect(deferred?.registrationLeaseExpiresAt).toBeUndefined();
        // Deferred into the future: no longer claimable.
        await expect(
          environments().claimStaleCodeEnvironmentRegistration(id, staleBefore, leaseId, LEASE_MS),
        ).resolves.toBeNull();

        await environments().deleteStaleCodeEnvironmentRegistration(id, leaseId);
        expect(await raw(id)).toBeDefined();
      });

      it('reclaims after the retry time, and deletes under the new lease only', async () => {
        const staleBefore = past(5 * MINUTE);
        const [id] = await seed([
          'env-stale',
          {
            registrationPendingAt: past(10 * MINUTE),
            registrationReconcileAfter: past(),
            registrationLeaseId: 'expired-lease',
            registrationLeaseExpiresAt: past(),
          },
        ]);
        const reclaimed = await environments().claimStaleCodeEnvironmentRegistration(
          id,
          staleBefore,
          'second-lease',
          LEASE_MS,
        );
        expect(reclaimed?.registrationLeaseId).toBe('second-lease');
        await environments().deleteStaleCodeEnvironmentRegistration(id, 'expired-lease');
        expect(await raw(id)).toBeDefined();
        await environments().deleteStaleCodeEnvironmentRegistration(storeId(id), 'second-lease');
        expect(await raw(id)).toBeUndefined();
      });

      it('does not lease a registration pending since after the stale bound', async () => {
        const [id] = await seed(['env-fresh', { registrationPendingAt: past(1_000) }]);
        await expect(
          environments().claimStaleCodeEnvironmentRegistration(
            id,
            past(5 * MINUTE),
            'lease',
            LEASE_MS,
          ),
        ).resolves.toBeNull();
      });
    });

    /* ------------------------------------------------------------------ orphans */

    describe('findOrphanedCodeEnvironments', () => {
      it('lists live, unmarked environments whose creator is gone, by id, projected', async () => {
        const owner = newId();
        const [goneA, goneB] = [newId(), newId()];
        await harness.seedRaw('users', [
          { _id: owner, email: 'owner@example.com', provider: 'local' },
        ]);
        const [, orphanA, orphanB] = await seed(
          ['env-owned', { createdBy: owner }],
          [
            'env-orphan-a',
            {
              createdBy: goneA,
              workerId: 'worker-a',
              workerPrincipal: { type: 'user', id: 'gone' },
            },
          ],
          ['env-orphan-b', { createdBy: goneB }],
          ['env-orphan-marked', { revocationPendingAt: past() }],
          ['env-orphan-committed', { deletionCommittedAt: past() }],
        );
        const listed = await environments().findOrphanedCodeEnvironments(10);
        expect(
          listed.map((row) => ({
            ...row,
            _id: idOf(harness, row._id),
            createdBy: idOf(harness, row.createdBy),
          })),
        ).toEqual([
          {
            _id: orphanA,
            createdBy: goneA,
            workerId: 'worker-a',
            workerPrincipal: { type: 'user', id: 'gone' },
          },
          { _id: orphanB, createdBy: goneB },
        ]);
        await expect(environments().findOrphanedCodeEnvironments(1)).resolves.toHaveLength(1);
      });

      it('treats a creator in another tenant as present (the anti-join is not tenant-scoped)', async () => {
        const owner = newId();
        await harness.seedRaw('users', [
          { _id: owner, email: 'owner@example.com', provider: 'local', tenantId: 'tenant-b' },
        ]);
        await seed(['env-cross', { createdBy: owner, tenantId: 'tenant-a' }]);
        await expect(environments().findOrphanedCodeEnvironments(10)).resolves.toEqual([]);
      });
    });

    describe('requestOrphanedCodeEnvironmentRevocations', () => {
      it('marks the given environments at the given time, in one bulk write', async () => {
        const [a, b, untouched] = await seed(
          ['env-a', { revocationLastError: 'boom', revocationReconcileAfter: future() }],
          ['env-b', { revocationAttempts: 4 }],
          ['env-untouched'],
        );
        const now = new Date('2026-08-01T00:00:00.000Z');
        await environments().requestOrphanedCodeEnvironmentRevocations([a, storeId(b)], now);
        const markedA = await raw(a);
        expect(markedA?.revocationPendingAt).toEqual(now);
        expect(markedA?.revocationAttempts).toBe(1);
        expect(markedA?.revocationLastError).toBeUndefined();
        expect(markedA?.revocationReconcileAfter).toBeUndefined();
        expect((await raw(b))?.revocationAttempts).toBe(5);
        expect((await raw(untouched))?.revocationPendingAt).toBeUndefined();
        await expect(
          environments().requestOrphanedCodeEnvironmentRevocations([], now),
        ).resolves.toBeUndefined();
      });
    });

    /* ------------------------------------------------------------------ worker revocations */

    describe('findCodeEnvironmentRevocationCandidates', () => {
      it('lists due, unleased revocations, the earliest due first', async () => {
        const [dueLater, dueFirst, neverDeferred] = await seed(
          ['env-due-later', { revocationPendingAt: past(), revocationReconcileAfter: past() }],
          [
            'env-due-first',
            { revocationPendingAt: past(), revocationReconcileAfter: past(2 * MINUTE) },
          ],
          ['env-never-deferred', { revocationPendingAt: past() }],
          ['env-not-pending'],
          ['env-deferred', { revocationPendingAt: past(), revocationReconcileAfter: future() }],
          ['env-leased', { revocationPendingAt: past(), revocationLeaseExpiresAt: future() }],
        );
        const listed = await environments().findCodeEnvironmentRevocationCandidates(new Date(), 10);
        expect(ids(listed)).toEqual([neverDeferred, dueFirst, dueLater]);
        expect(Object.keys(listed[0])).toEqual(['_id']);
        await expect(
          environments().findCodeEnvironmentRevocationCandidates(new Date(), 2),
        ).resolves.toHaveLength(2);
      });

      it('lists every tenant from outside a tenant context', async () => {
        await seed(
          ['env-a', { revocationPendingAt: past(), tenantId: 'tenant-a' }],
          ['env-b', { revocationPendingAt: past(), tenantId: 'tenant-b' }],
        );
        await expect(
          environments().findCodeEnvironmentRevocationCandidates(new Date(), 10),
        ).resolves.toHaveLength(2);
        await expect(
          tenantStorage.run({ tenantId: 'tenant-a' }, () =>
            environments().findCodeEnvironmentRevocationCandidates(new Date(), 10),
          ),
        ).resolves.toHaveLength(1);
      });
    });

    describe('revocation lease', () => {
      it('leases a due revocation, counting the attempt, and defers it under its lease', async () => {
        const [id] = await seed([
          'env-revoke',
          { revocationPendingAt: past(), revocationAttempts: 1 },
        ]);
        const leaseId = newId();
        const before = Date.now();
        const claimed = await environments().claimCodeEnvironmentRevocation(
          storeId(id),
          leaseId,
          LEASE_MS,
        );
        expect(claimed?.revocationLeaseId).toBe(leaseId);
        expect(claimed?.revocationAttempts).toBe(2);
        expect(timeOf(claimed?.revocationLeaseExpiresAt)).toBeGreaterThanOrEqual(before + LEASE_MS);
        await expect(
          environments().claimCodeEnvironmentRevocation(id, 'other', LEASE_MS),
        ).resolves.toBeNull();

        const reconcileAfter = future(5 * MINUTE);
        await environments().deferCodeEnvironmentRevocation(id, 'other', 'lost', reconcileAfter);
        expect((await raw(id))?.revocationLastError).toBeUndefined();
        await environments().deferCodeEnvironmentRevocation(
          storeId(id),
          leaseId,
          'boom',
          reconcileAfter,
        );
        const deferred = await raw(id);
        expect(deferred?.revocationLastError).toBe('boom');
        expect(timeOf(deferred?.revocationReconcileAfter)).toBe(reconcileAfter.getTime());
        expect(deferred?.revocationLeaseId).toBeUndefined();
        expect(deferred?.revocationLeaseExpiresAt).toBeUndefined();
        expect(deferred?.revocationAttempts).toBe(2);
        await expect(
          environments().claimCodeEnvironmentRevocation(id, leaseId, LEASE_MS),
        ).resolves.toBeNull();
      });

      it('reclaims a revocation whose lease expired', async () => {
        const [id] = await seed([
          'env-expired-lease',
          {
            revocationPendingAt: past(),
            revocationLeaseId: 'old',
            revocationLeaseExpiresAt: past(),
            revocationAttempts: 3,
          },
        ]);
        const claimed = await environments().claimCodeEnvironmentRevocation(id, 'new', LEASE_MS);
        expect(claimed).toMatchObject({ revocationLeaseId: 'new', revocationAttempts: 4 });
      });

      it('does not lease an environment not marked for revocation', async () => {
        const [id] = await seed(['env-live']);
        await expect(
          environments().claimCodeEnvironmentRevocation(id, 'lease', LEASE_MS),
        ).resolves.toBeNull();
      });
    });

    describe('account deletion revocations', () => {
      it('marks, commits and records failed revocations', async () => {
        const [revoked, failed, untouched] = await seed(
          ['env-revoked', { revocationLastError: 'earlier', revocationReconcileAfter: future() }],
          ['env-failed'],
          ['env-untouched'],
        );
        const before = Date.now();
        await environments().beginCodeEnvironmentWorkerRevocations([revoked, storeId(failed)]);
        const marked = await raw(revoked);
        expect(timeOf(marked?.revocationPendingAt)).toBeGreaterThanOrEqual(before);
        expect(marked?.revocationAttempts).toBe(1);
        expect(marked?.revocationLastError).toBeUndefined();
        // Unlike the reconciler's orphan marking, the retry time is kept.
        expect(marked?.revocationReconcileAfter).toBeInstanceOf(Date);
        expect((await raw(failed))?.revocationAttempts).toBe(1);
        expect((await raw(untouched))?.revocationPendingAt).toBeUndefined();

        await environments().commitCodeEnvironmentWorkerRevocation(storeId(revoked));
        const committed = await raw(revoked);
        expect(committed?.deletionCommittedAt).toBeInstanceOf(Date);
        expect(committed?.revocationPendingAt).toBeUndefined();
        expect(committed?.revocationAttempts).toBeUndefined();
        expect(committed?.revocationLastError).toBeUndefined();
        expect(committed?.revocationReconcileAfter).toBeUndefined();

        await environments().recordCodeEnvironmentWorkerRevocationError(failed, 'unreachable');
        const recorded = await raw(failed);
        expect(recorded?.revocationLastError).toBe('unreachable');
        expect(recorded?.revocationPendingAt).toBeInstanceOf(Date);
        expect(recorded?.deletionCommittedAt).toBeUndefined();
      });

      it('does nothing for absent environments or no ids', async () => {
        const [id] = await seed(['env-live']);
        await environments().beginCodeEnvironmentWorkerRevocations([]);
        await environments().commitCodeEnvironmentWorkerRevocation(newId());
        await environments().recordCodeEnvironmentWorkerRevocationError(newId(), 'x');
        const stored = await raw(id);
        expect(stored?.revocationPendingAt).toBeUndefined();
        expect(stored?.deletionCommittedAt).toBeUndefined();
        expect(await harness.readRaw('codeenvironments')).toHaveLength(1);
      });
    });
  });
}
