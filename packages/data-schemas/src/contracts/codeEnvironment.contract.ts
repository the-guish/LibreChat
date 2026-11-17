/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `CodeEnvironmentStore` contract (`~/ports/codeEnvironment`) for the registry, its lifecycle
 * and the browser setup reservations, ported from `@librechat/api`'s
 * `code/environments.integration.spec.ts` (the store's callers) and the methods themselves: the
 * create pending registration (the retired ids per tenant in `code_environment_tombstones`, the
 * duplicate environment id through `harness.errors`), the owner slots (legacy environments
 * taking the lowest, concurrent creates for the last slot converging, a full owner refused), the
 * reads and their order (oldest first), the settings write on live environments only, the
 * registration commit, the two-phase removal with its lease and the agent reference reservations
 * (`pendingAgentReferences`: a live one refuses the lease, expired ones are pulled by it), the
 * agent writes that hold those reservations (through the agent store), the account cleanup, and
 * the idempotent setup reservations (replay, collisions, retirement, discard and its fence).
 * Tenant scoping throughout. The reconciliation steps are `codeEnvironment.reconciliation.contract.ts`.
 *
 * Not here: the reference lease renewal (`pendingAgentReferences.$.expiresAt`), which runs on a
 * timer only while an agent write lasts longer than a third of the lease, and index builds made
 * to fail. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import { PrincipalType, ResourceType, PermissionBits } from 'librechat-data-provider';
import type { CodeEnvironmentSetupBinding } from '~/types/codeEnvironmentSetup';
import type { ContractHarness, RawRecord } from './harness';
import type { CreateCodeEnvironmentInput } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

const MINUTE = 60_000;
const REMOVAL_LEASE_MS = 2 * MINUTE;
const TOMBSTONES = 'code_environment_tombstones';

/** The error a store method rejected with, or a failure when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('Expected the call to reject');
}

export function describeCodeEnvironmentContract(harness: ContractHarness): void {
  describe(`CodeEnvironmentStore contract (registry and setup): ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores();
    const environments = () => stores().codeEnvironments;
    const newId = () => harness.ids.generate();
    const storeId = (id: string) => harness.ids.toStoreId(id);
    /** A creator id as the create input takes it (the store's id value). */
    const creator = (id: string) => storeId(id) as CreateCodeEnvironmentInput['createdBy'];
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const ids = (rows: ReadonlyArray<{ _id?: unknown }>) =>
      rows.map((row) => idOf(harness, row._id));
    const past = (ms = MINUTE) => new Date(Date.now() - ms);
    const future = (ms = MINUTE) => new Date(Date.now() + ms);
    const ownerId = newId();

    const input = (
      environmentId: string,
      overrides: Partial<CreateCodeEnvironmentInput> = {},
    ): CreateCodeEnvironmentInput => ({
      environmentId,
      name: `Machine ${environmentId}`,
      type: 'attached',
      baseURL: 'https://code.example.com',
      controlPlaneId: 'shared-code-api',
      createdBy: creator(ownerId),
      ...overrides,
    });
    const create = async (environmentId: string, overrides?: Partial<CreateCodeEnvironmentInput>) =>
      idOf(
        harness,
        (await environments().createCodeEnvironment(input(environmentId, overrides)))._id,
      );
    /** A live environment (registration completed); its id. */
    const createLive = async (
      environmentId: string,
      overrides?: Partial<CreateCodeEnvironmentInput>,
    ) => {
      const id = await create(environmentId, overrides);
      await environments().completeCodeEnvironmentRegistration(id);
      return id;
    };
    /** A raw environment record (live unless `record` says otherwise); its id. */
    const seedEnvironment = async (environmentId: string, record: RawRecord = {}) => {
      const _id = (record._id as string | undefined) ?? newId();
      await harness.seedRaw('codeenvironments', [
        {
          _id,
          environmentId,
          name: environmentId,
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
          createdBy: ownerId,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...record,
        },
      ]);
      return _id;
    };
    const raw = async (id: string) =>
      (await harness.readRaw('codeenvironments')).find((row) => row._id === id);
    const tombstones = () => harness.readRaw(TOMBSTONES);

    /* ------------------------------------------------------------------ create */

    describe('createCodeEnvironment', () => {
      it('creates the environment pending registration, with the creator and timestamps', async () => {
        const before = Date.now();
        const created = await environments().createCodeEnvironment(
          input('env-1', {
            workerId: 'worker-1',
            revocationTokenEnv: 'CODE_REVOKE_TOKEN',
            workerPrincipal: { type: 'user', id: ownerId },
          }),
        );
        expect(created).toMatchObject({
          environmentId: 'env-1',
          name: 'Machine env-1',
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
          workerId: 'worker-1',
          revocationTokenEnv: 'CODE_REVOKE_TOKEN',
          workerPrincipal: { type: 'user', id: ownerId },
        });
        expect(idOf(harness, created.createdBy)).toBe(ownerId);
        expect(timeOf(created.registrationPendingAt)).toBeGreaterThanOrEqual(before);
        const stored = await raw(idOf(harness, created._id));
        expect(stored).toMatchObject({ environmentId: 'env-1', createdBy: ownerId });
        expect(stored?.registrationPendingAt).toBeInstanceOf(Date);
        expect(timeOf(stored?.createdAt)).toBeGreaterThanOrEqual(before);
        expect(stored?.ownerSlot).toBeUndefined();
        expect(stored?.tenantId).toBeUndefined();
      });

      it('rejects a duplicate environment id in the tenant with a duplicate key', async () => {
        await create('env-dup');
        const error = await rejectionOf(environments().createCodeEnvironment(input('env-dup')));
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
        await expect(
          inTenant('tenant-a', () => environments().createCodeEnvironment(input('env-dup'))),
        ).resolves.toMatchObject({ environmentId: 'env-dup', tenantId: 'tenant-a' });
      });

      it('refuses a retired environment id, in its tenant only', async () => {
        const id = await inTenant('tenant-a', () => create('env-retired'));
        await inTenant('tenant-a', () => environments().deleteCodeEnvironmentById(id));
        await expect(
          inTenant('tenant-a', () => environments().createCodeEnvironment(input('env-retired'))),
        ).rejects.toThrow('previously retired');
        await expect(
          inTenant('tenant-b', () => environments().createCodeEnvironment(input('env-retired'))),
        ).resolves.toMatchObject({ tenantId: 'tenant-b' });
        await expect(
          environments().createCodeEnvironment(input('env-retired')),
        ).resolves.toMatchObject({ environmentId: 'env-retired' });
      });
    });

    describe('createCodeEnvironmentWithinOwnerLimit', () => {
      it('takes the lowest free owner slot and refuses a full owner', async () => {
        const first = await environments().createCodeEnvironmentWithinOwnerLimit(input('a'), 2);
        const second = await environments().createCodeEnvironmentWithinOwnerLimit(input('b'), 2);
        expect([first?.ownerSlot, second?.ownerSlot]).toEqual([0, 1]);
        expect(first?.registrationPendingAt).toBeInstanceOf(Date);
        await expect(
          environments().createCodeEnvironmentWithinOwnerLimit(input('c'), 2),
        ).resolves.toBeNull();
        const other = await environments().createCodeEnvironmentWithinOwnerLimit(
          input('d', { createdBy: creator(newId()) }),
          2,
        );
        expect(other?.ownerSlot).toBe(0);
        expect((await harness.readRaw('codeenvironments')).map((row) => row.ownerSlot)).toEqual(
          expect.arrayContaining([0, 1, 0]),
        );
      });

      it('counts environments without a slot, which hold the lowest slots', async () => {
        await create('legacy');
        const created = await environments().createCodeEnvironmentWithinOwnerLimit(
          input('slotted'),
          3,
        );
        expect(created?.ownerSlot).toBe(1);
        await expect(
          environments().createCodeEnvironmentWithinOwnerLimit(input('x'), 1),
        ).resolves.toBeNull();
      });

      it('reuses a freed slot', async () => {
        const first = await environments().createCodeEnvironmentWithinOwnerLimit(input('a'), 2);
        await environments().createCodeEnvironmentWithinOwnerLimit(input('b'), 2);
        await environments().discardCodeEnvironmentById(idOf(harness, first?._id));
        const reused = await environments().createCodeEnvironmentWithinOwnerLimit(input('c'), 2);
        expect(reused?.ownerSlot).toBe(0);
      });

      it('lets one of two concurrent creates take the last slot, the other resolving null', async () => {
        const results = await Promise.all([
          environments().createCodeEnvironmentWithinOwnerLimit(input('race-a'), 1),
          environments().createCodeEnvironmentWithinOwnerLimit(input('race-b'), 1),
        ]);
        expect(results.filter((result) => result != null)).toHaveLength(1);
        expect(await harness.readRaw('codeenvironments')).toHaveLength(1);
      });

      it('rejects a duplicate environment id with a duplicate key, and a retired one', async () => {
        await create('taken', { createdBy: creator(newId()) });
        const error = await rejectionOf(
          environments().createCodeEnvironmentWithinOwnerLimit(input('taken'), 3),
        );
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
        const id = await create('gone');
        await environments().deleteCodeEnvironmentById(id);
        await expect(
          environments().createCodeEnvironmentWithinOwnerLimit(input('gone'), 3),
        ).rejects.toThrow('previously retired');
      });
    });

    /* ------------------------------------------------------------------ reads */

    describe('reads', () => {
      it('findCodeEnvironmentsByIds: the environments with the ids, oldest first', async () => {
        const t0 = new Date('2026-01-01T00:00:00Z');
        const later = new Date('2026-01-02T00:00:00Z');
        const [a, b, c] = Array.from({ length: 3 }, () => newId()).sort();
        await seedEnvironment('env-c', { _id: c, createdAt: t0 });
        await seedEnvironment('env-a', { _id: a, createdAt: later });
        await seedEnvironment('env-b', { _id: b, createdAt: t0 });
        await seedEnvironment('env-other');
        const found = await environments().findCodeEnvironmentsByIds([a, storeId(c), b, newId()]);
        expect(ids(found)).toEqual([b, c, a]);
        await expect(environments().findCodeEnvironmentsByIds([])).resolves.toEqual([]);
      });

      it('findCodeEnvironmentByEnvironmentId: the environment, or null, in the tenant', async () => {
        const id = await seedEnvironment('env-find', { tenantId: 'tenant-a' });
        expect(
          idOf(
            harness,
            (
              await inTenant('tenant-a', () =>
                environments().findCodeEnvironmentByEnvironmentId('env-find'),
              )
            )?._id,
          ),
        ).toBe(id);
        await expect(
          inTenant('tenant-b', () => environments().findCodeEnvironmentByEnvironmentId('env-find')),
        ).resolves.toBeNull();
        await expect(
          environments().findCodeEnvironmentByEnvironmentId('env-missing'),
        ).resolves.toBeNull();
      });

      it('listCodeEnvironmentIds: every stored environment id once', async () => {
        await seedEnvironment('env-1');
        await seedEnvironment('env-2', { tenantId: 'tenant-a' });
        await seedEnvironment('env-1', { tenantId: 'tenant-b' });
        expect((await environments().listCodeEnvironmentIds()).sort()).toEqual(['env-1', 'env-2']);
        expect(await inTenant('tenant-a', () => environments().listCodeEnvironmentIds())).toEqual([
          'env-2',
        ]);
      });

      it('findCodeEnvironmentsByCreator: the creator environments, oldest first', async () => {
        const other = newId();
        const [a, b] = [newId(), newId()].sort();
        await seedEnvironment('env-late', { _id: a, createdAt: new Date('2026-02-01T00:00:00Z') });
        await seedEnvironment('env-early', { _id: b, createdAt: new Date('2026-01-01T00:00:00Z') });
        await seedEnvironment('env-other', { createdBy: other });
        expect(ids(await environments().findCodeEnvironmentsByCreator(ownerId))).toEqual([b, a]);
        expect(
          ids(await environments().findCodeEnvironmentsByCreator(storeId(other))),
        ).toHaveLength(1);
        await expect(environments().findCodeEnvironmentsByCreator(newId())).resolves.toEqual([]);
      });
    });

    /* ------------------------------------------------------------------ settings and registration */

    describe('updateCodeEnvironmentSettings', () => {
      it('sets the given permissions on a live environment and keeps the others', async () => {
        await seedEnvironment('env-live', { settings: { permissions: { fileWrite: 'ask' } } });
        const updated = await environments().updateCodeEnvironmentSettings('env-live', {
          permissions: { commandExecution: 'deny' },
        });
        expect(updated?.settings).toEqual({
          permissions: { fileWrite: 'ask', commandExecution: 'deny' },
        });
        const again = await environments().updateCodeEnvironmentSettings('env-live', {
          permissions: { fileWrite: 'allow' },
        });
        expect(again?.settings).toEqual({
          permissions: { fileWrite: 'allow', commandExecution: 'deny' },
        });
        const [stored] = await harness.readRaw('codeenvironments');
        expect(stored.settings).toEqual({
          permissions: { fileWrite: 'allow', commandExecution: 'deny' },
        });
      });

      it('resolves the live environment unchanged for empty settings', async () => {
        await seedEnvironment('env-live', { updatedAt: new Date('2026-01-01T00:00:00Z') });
        const read = await environments().updateCodeEnvironmentSettings('env-live', {});
        expect(read?.environmentId).toBe('env-live');
        const [stored] = await harness.readRaw('codeenvironments');
        expect(timeOf(stored.updatedAt)).toBe(Date.parse('2026-01-01T00:00:00Z'));
        expect(stored.settings).toBeUndefined();
      });

      it('resolves null while pending registration, being removed or committed, and when absent', async () => {
        await seedEnvironment('env-pending', { registrationPendingAt: past() });
        await seedEnvironment('env-removing', { deletionStartedAt: past() });
        await seedEnvironment('env-committed', { deletionCommittedAt: past() });
        for (const environmentId of ['env-pending', 'env-removing', 'env-committed', 'env-none']) {
          await expect(
            environments().updateCodeEnvironmentSettings(environmentId, {
              permissions: { fileWrite: 'deny' },
            }),
          ).resolves.toBeNull();
          await expect(
            environments().updateCodeEnvironmentSettings(environmentId, {}),
          ).resolves.toBeNull();
        }
        expect(
          (await harness.readRaw('codeenvironments')).every((row) => row.settings === undefined),
        ).toBe(true);
      });

      it('rejects a value outside the permission levels', async () => {
        await seedEnvironment('env-live');
        await expect(
          environments().updateCodeEnvironmentSettings('env-live', {
            permissions: { fileWrite: 'sometimes' as 'ask' },
          }),
        ).rejects.toThrow();
      });
    });

    describe('completeCodeEnvironmentRegistration', () => {
      it('makes the pending environment live, clearing its retry time', async () => {
        const id = await seedEnvironment('env-pending', {
          registrationPendingAt: past(),
          registrationReconcileAfter: future(),
        });
        await environments().completeCodeEnvironmentRegistration(storeId(id));
        const stored = await raw(id);
        expect(stored?.registrationPendingAt).toBeUndefined();
        expect(stored?.registrationReconcileAfter).toBeUndefined();
      });

      it('throws for a live, leased, absent or setup-reserved environment', async () => {
        const live = await seedEnvironment('env-live');
        const leased = await seedEnvironment('env-leased', {
          registrationPendingAt: past(),
          registrationLeaseId: 'lease',
          registrationLeaseExpiresAt: future(),
        });
        const setup = await seedEnvironment('env-setup', {
          registrationPendingAt: past(),
          setupAttemptId: 'attempt',
          setupRequestHash: 'hash',
        });
        for (const id of [live, leased, setup, newId()]) {
          await expect(environments().completeCodeEnvironmentRegistration(id)).rejects.toThrow(
            'could not be committed',
          );
        }
        expect((await raw(leased))?.registrationPendingAt).toBeInstanceOf(Date);
      });
    });

    /* ------------------------------------------------------------------ removal */

    describe('two-phase removal', () => {
      it('claims a removal lease and commits it under the lease', async () => {
        const id = await createLive('env-remove');
        const before = Date.now();
        const claimed = await environments().beginCodeEnvironmentRemoval(id);
        expect(claimed?.deletionLeaseId).toEqual(expect.any(String));
        expect(timeOf(claimed?.deletionStartedAt)).toBeGreaterThanOrEqual(before);
        expect(timeOf(claimed?.deletionLeaseExpiresAt)).toBeGreaterThanOrEqual(
          before + REMOVAL_LEASE_MS,
        );
        expect(timeOf(claimed?.deletionLeaseExpiresAt)).toBeLessThanOrEqual(
          Date.now() + REMOVAL_LEASE_MS,
        );
        await expect(environments().beginCodeEnvironmentRemoval(id)).resolves.toBeNull();

        await expect(
          environments().commitCodeEnvironmentRemoval(id, 'another-lease'),
        ).rejects.toThrow('lease was lost');
        await environments().commitCodeEnvironmentRemoval(storeId(id), claimed!.deletionLeaseId!);
        const stored = await raw(id);
        expect(stored?.deletionCommittedAt).toBeInstanceOf(Date);
        expect(stored?.deletionLeaseExpiresAt).toBeUndefined();
        expect(stored?.deletionLeaseId).toBe(claimed!.deletionLeaseId);
        await expect(environments().beginCodeEnvironmentRemoval(id)).resolves.toBeNull();
      });

      it('cancels the lease only under it, leaving the environment live', async () => {
        const id = await createLive('env-cancel');
        const claimed = await environments().beginCodeEnvironmentRemoval(id);
        await environments().cancelCodeEnvironmentRemoval(id, 'another-lease');
        expect((await raw(id))?.deletionLeaseId).toBe(claimed?.deletionLeaseId);
        await environments().cancelCodeEnvironmentRemoval(storeId(id), claimed!.deletionLeaseId!);
        const stored = await raw(id);
        expect(stored?.deletionStartedAt).toBeUndefined();
        expect(stored?.deletionLeaseId).toBeUndefined();
        expect(stored?.deletionLeaseExpiresAt).toBeUndefined();
        await expect(environments().beginCodeEnvironmentRemoval(id)).resolves.not.toBeNull();
      });

      it('does not cancel a committed removal', async () => {
        const id = await createLive('env-committed');
        const claimed = await environments().beginCodeEnvironmentRemoval(id);
        await environments().commitCodeEnvironmentRemoval(id, claimed!.deletionLeaseId!);
        await environments().cancelCodeEnvironmentRemoval(id, claimed!.deletionLeaseId!);
        expect((await raw(id))?.deletionStartedAt).toBeInstanceOf(Date);
      });

      it('reclaims a removal whose lease expired, under a new lease', async () => {
        const id = await seedEnvironment('env-expired', {
          deletionStartedAt: past(10 * MINUTE),
          deletionLeaseId: 'stale-lease',
          deletionLeaseExpiresAt: past(),
        });
        const claimed = await environments().beginCodeEnvironmentRemoval(id);
        expect(claimed?.deletionLeaseId).not.toBe('stale-lease');
        await expect(
          environments().commitCodeEnvironmentRemoval(id, 'stale-lease'),
        ).rejects.toThrow();
      });

      it('is refused while an agent write holds a live reference, and pulls expired ones', async () => {
        const id = await seedEnvironment('env-referenced', {
          pendingAgentReferences: [
            { reservationId: 'expired', expiresAt: past() },
            { reservationId: 'live', expiresAt: future() },
          ],
        });
        await expect(environments().beginCodeEnvironmentRemoval(id)).resolves.toBeNull();
        expect(
          ((await raw(id))?.pendingAgentReferences as RawRecord[]).map((r) => r.reservationId),
        ).toEqual(['expired', 'live']);

        const expiredOnly = await seedEnvironment('env-expired-reference', {
          pendingAgentReferences: [
            { reservationId: 'old-a', expiresAt: past(2 * MINUTE) },
            { reservationId: 'old-b', expiresAt: past() },
          ],
        });
        const claimed = await environments().beginCodeEnvironmentRemoval(expiredOnly);
        expect(claimed?.pendingAgentReferences ?? []).toEqual([]);
        expect((await raw(expiredOnly))?.pendingAgentReferences ?? []).toEqual([]);
        const empty = await seedEnvironment('env-empty-references', { pendingAgentReferences: [] });
        await expect(environments().beginCodeEnvironmentRemoval(empty)).resolves.not.toBeNull();
      });

      it('resolves null for an absent environment', async () => {
        await expect(environments().beginCodeEnvironmentRemoval(newId())).resolves.toBeNull();
      });
    });

    describe('agent reference reservations (held by the agent store)', () => {
      const agentData = (id: string, record: Record<string, unknown>) => ({
        id,
        name: 'Agent',
        provider: 'openAI',
        model: 'gpt-4o',
        author: ownerId,
        ...record,
      });

      it('holds a reservation on a live environment only while the agent write lasts', async () => {
        const single = await createLive('env-single');
        const many = await createLive('env-many');
        await stores().agents.createAgent(
          agentData('agent_ref', {
            code_environment_id: 'env-single',
            code_environment_ids: ['env-many'],
          }),
        );
        expect(await readRawWhere(harness, 'agents', { id: 'agent_ref' })).toHaveLength(1);
        expect((await raw(single))?.pendingAgentReferences ?? []).toEqual([]);
        expect((await raw(many))?.pendingAgentReferences ?? []).toEqual([]);
        await expect(environments().isCodeEnvironmentReferencedByAgent('env-single')).resolves.toBe(
          true,
        );
      });

      it('lets an agent name an environment the registry does not hold (deployment config)', async () => {
        await expect(
          stores().agents.createAgent(
            agentData('agent_config', { code_environment_id: 'from-yaml' }),
          ),
        ).resolves.toMatchObject({ id: 'agent_config' });
      });

      it('refuses an agent write naming an environment being removed, pending or retired', async () => {
        const removing = await createLive('env-removing');
        await environments().beginCodeEnvironmentRemoval(removing);
        await create('env-pending');
        const retired = await createLive('env-retired');
        await environments().deleteCodeEnvironmentById(retired);

        for (const environmentId of ['env-removing', 'env-pending', 'env-retired']) {
          const error = await rejectionOf(
            stores().agents.createAgent(
              agentData(`agent_${environmentId}`, { code_environment_id: environmentId }),
            ),
          );
          expect(error.name).toBe('CodeEnvironmentReferenceError');
          expect(error.statusCode).toBe(409);
        }
        expect(await harness.readRaw('agents')).toEqual([]);
      });
    });

    describe('deleteCodeEnvironmentById', () => {
      it('retires the ids, deletes the environment and resolves to it', async () => {
        const id = await inTenant('tenant-a', () => createLive('env-delete'));
        const before = Date.now();
        const deleted = await inTenant('tenant-a', () =>
          environments().deleteCodeEnvironmentById(storeId(id)),
        );
        expect(idOf(harness, deleted?._id)).toBe(id);
        expect(deleted?.environmentId).toBe('env-delete');
        expect(await harness.readRaw('codeenvironments')).toEqual([]);
        const [tombstone, ...rest] = await tombstones();
        expect(rest).toEqual([]);
        expect(tombstone).toMatchObject({ tenantId: 'tenant-a', environmentId: 'env-delete' });
        expect(timeOf(tombstone.deletedAt)).toBeGreaterThanOrEqual(before);
        expect(tombstone.setupBinding).toBeUndefined();
      });

      it('records an untenanted retirement with an empty tenant', async () => {
        const id = await createLive('env-untenanted');
        await environments().deleteCodeEnvironmentById(id);
        expect((await tombstones())[0]).toMatchObject({
          tenantId: '',
          environmentId: 'env-untenanted',
        });
      });

      it('resolves null for an absent environment and retires nothing', async () => {
        await expect(environments().deleteCodeEnvironmentById(newId())).resolves.toBeNull();
        expect(await tombstones()).toEqual([]);
      });
    });

    describe('discardCodeEnvironmentById', () => {
      it('deletes a failed registration without retiring its id', async () => {
        const id = await create('env-failed');
        await environments().discardCodeEnvironmentById(storeId(id));
        expect(await harness.readRaw('codeenvironments')).toEqual([]);
        expect(await tombstones()).toEqual([]);
        await expect(create('env-failed')).resolves.toEqual(expect.any(String));
      });

      it('never deletes a setup reservation', async () => {
        const id = await seedEnvironment('env-setup', {
          setupAttemptId: 'attempt',
          setupRequestHash: 'hash',
          registrationPendingAt: past(),
        });
        await environments().discardCodeEnvironmentById(id);
        expect(await raw(id)).toBeDefined();
      });
    });

    describe('deleteUserCodeEnvironments', () => {
      it('deletes the unreferenced environments the user created, with their permissions', async () => {
        const plain = await createLive('env-plain');
        const referenced = await createLive('env-referenced');
        const revoking = await seedEnvironment('env-revoking', { revocationPendingAt: past() });
        const committed = await seedEnvironment('env-committed', { deletionCommittedAt: past() });
        const foreign = await seedEnvironment('env-foreign', { createdBy: newId() });
        await harness.seedRaw('agents', [
          {
            _id: newId(),
            id: 'agent_keeps',
            name: 'Keeps',
            provider: 'openAI',
            model: 'gpt-4o',
            author: newId(),
            code_environment_ids: ['env-referenced'],
          },
        ]);
        for (const id of [plain, referenced, foreign]) {
          await stores().aclEntries.grantPermission(
            PrincipalType.USER,
            storeId(ownerId),
            ResourceType.CODE_ENVIRONMENT,
            storeId(id),
            PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          );
        }

        await expect(environments().deleteUserCodeEnvironments(storeId(ownerId))).resolves.toBe(1);

        const left = (await harness.readRaw('codeenvironments')).map((row) => row._id).sort();
        expect(left).toEqual([referenced, revoking, committed, foreign].sort());
        const referencedRow = await raw(referenced);
        expect(referencedRow?.deletionStartedAt).toBeUndefined();
        expect(referencedRow?.deletionLeaseId).toBeUndefined();
        expect((await harness.readRaw('aclentries')).map((row) => row.resourceId).sort()).toEqual(
          [referenced, foreign].sort(),
        );
        expect((await tombstones()).map((row) => row.environmentId)).toEqual(['env-plain']);
      });

      it('skips an environment leased by an in-flight removal or agent write', async () => {
        await seedEnvironment('env-leased', {
          deletionStartedAt: past(),
          deletionLeaseId: 'lease',
          deletionLeaseExpiresAt: future(),
        });
        await seedEnvironment('env-held', {
          pendingAgentReferences: [{ reservationId: 'write', expiresAt: future() }],
        });
        await expect(environments().deleteUserCodeEnvironments(ownerId)).resolves.toBe(0);
        expect(await harness.readRaw('codeenvironments')).toHaveLength(2);
      });

      it('resolves 0 for a user without environments', async () => {
        await expect(environments().deleteUserCodeEnvironments(newId())).resolves.toBe(0);
      });
    });

    /* ------------------------------------------------------------------ browser setup */

    describe('browser setup reservations', () => {
      const binding = (
        overrides: Partial<CodeEnvironmentSetupBinding> = {},
      ): CodeEnvironmentSetupBinding => ({
        setupAttemptId: 'attempt-1',
        requestHash: createHash('sha256').update('request-1').digest('hex'),
        ownerId,
        environmentId: 'env-setup',
        name: 'Laptop',
        type: 'attached',
        baseURL: 'https://laptop.example.com',
        controlPlaneId: 'shared-code-api',
        workerId: 'worker-setup',
        workerPrincipal: { type: 'user', id: ownerId },
        ...overrides,
      });

      it('ensureSetupEnvironmentIndexes resolves, again on every call', async () => {
        await expect(environments().ensureSetupEnvironmentIndexes()).resolves.toBeUndefined();
        await expect(environments().ensureSetupEnvironmentIndexes()).resolves.toBeUndefined();
      });

      it('reserves the environment pending registration, and replays the reservation', async () => {
        const reserved = await environments().reserveSetupEnvironment(binding());
        expect(reserved).toEqual({
          resourceId: expect.any(String),
          id: 'env-setup',
          name: 'Laptop',
          type: 'attached',
          pending: true,
        });
        const stored = await raw(reserved!.resourceId);
        expect(stored).toMatchObject({
          environmentId: 'env-setup',
          setupAttemptId: 'attempt-1',
          setupRequestHash: binding().requestHash,
          createdBy: ownerId,
          workerId: 'worker-setup',
          workerPrincipal: { type: 'user', id: ownerId },
        });
        expect(stored?.registrationPendingAt).toBeInstanceOf(Date);
        await expect(environments().reserveSetupEnvironment(binding())).resolves.toEqual(reserved);
        await expect(environments().findSetupEnvironment(binding())).resolves.toEqual(reserved);
        expect(await harness.readRaw('codeenvironments')).toHaveLength(1);
      });

      it('makes one reservation for concurrent reservations of one binding', async () => {
        // NOTE(contract): a concurrent replay can reject instead of resolving the reservation:
        // `findSetupEnvironment` reads the live reservation and then the collisions in two reads, so
        // a reservation inserted between them reads as a collision ("binding is unavailable"). The
        // port promises the replay resolves; only one reservation and no other outcome are pinned.
        const results = await Promise.allSettled(
          Array.from({ length: 3 }, () => environments().reserveSetupEnvironment(binding())),
        );
        const reserved = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value?.resourceId] : [],
        );
        expect(reserved.length).toBeGreaterThanOrEqual(1);
        expect(new Set(reserved).size).toBe(1);
        expect(await harness.readRaw('codeenvironments')).toHaveLength(1);
        await expect(environments().reserveSetupEnvironment(binding())).resolves.toMatchObject({
          resourceId: reserved[0],
        });
      });

      it('reserves within the owner limit, resolving null for a full owner', async () => {
        const first = await environments().reserveSetupEnvironment(binding(), 1);
        expect(first?.pending).toBe(true);
        expect((await raw(first!.resourceId))?.ownerSlot).toBe(0);
        await expect(
          environments().reserveSetupEnvironment(
            binding({ setupAttemptId: 'attempt-2', environmentId: 'env-setup-2' }),
            1,
          ),
        ).resolves.toBeNull();
        await expect(environments().reserveSetupEnvironment(binding(), 1)).resolves.toEqual(first);
      });

      it('throws for a binding that collides with another environment or attempt', async () => {
        await environments().reserveSetupEnvironment(binding());
        await expect(
          environments().reserveSetupEnvironment(binding({ name: 'Different name' })),
        ).rejects.toThrow();
        await expect(
          environments().reserveSetupEnvironment(binding({ environmentId: 'env-other' })),
        ).rejects.toThrow();
        await expect(
          environments().findSetupEnvironment(binding({ setupAttemptId: 'attempt-other' })),
        ).rejects.toThrow();
        await create('env-plain');
        await expect(
          environments().reserveSetupEnvironment(
            binding({ setupAttemptId: 'attempt-3', environmentId: 'env-plain' }),
          ),
        ).rejects.toThrow();
      });

      it('findSetupEnvironment resolves null for a binding never reserved', async () => {
        await expect(environments().findSetupEnvironment(binding())).resolves.toBeNull();
      });

      it('completes the reservation, which then replays as live', async () => {
        const reserved = await environments().reserveSetupEnvironment(binding());
        const completed = await environments().completeSetupEnvironment(
          binding(),
          reserved!.resourceId,
        );
        expect(completed).toEqual({ ...reserved, pending: false });
        expect((await raw(reserved!.resourceId))?.registrationPendingAt).toBeUndefined();
        await expect(environments().reserveSetupEnvironment(binding())).resolves.toEqual(completed);
        await expect(environments().completeSetupEnvironment(binding(), newId())).rejects.toThrow(
          'could not be committed',
        );
        await expect(
          environments().completeSetupEnvironment(
            binding({ requestHash: 'f'.repeat(64) }),
            reserved!.resourceId,
          ),
        ).rejects.toThrow();
      });

      it('discards the reservation in two steps, retiring its ids for good', async () => {
        const reserved = await environments().reserveSetupEnvironment(binding());
        const discarded = await environments().beginDiscardSetupEnvironment(binding());
        expect(discarded).toEqual({ ...reserved, pending: true });
        const stored = await raw(reserved!.resourceId);
        expect(stored?.setupDiscardedAt).toBeInstanceOf(Date);
        expect(stored?.registrationPendingAt).toBeInstanceOf(Date);
        const retired = await tombstones();
        expect(retired).toHaveLength(2);
        expect(
          retired.every(
            (row) =>
              row.environmentId === 'env-setup' &&
              row.tenantId === '' &&
              row.setupResourceId === reserved!.resourceId &&
              typeof row.setupBinding === 'string',
          ),
        ).toBe(true);
        await expect(environments().findSetupEnvironment(binding())).rejects.toThrow();
        await expect(
          environments().completeSetupEnvironment(binding(), reserved!.resourceId),
        ).rejects.toThrow();

        await environments().finishDiscardSetupEnvironment(binding(), reserved!.resourceId);
        expect(await harness.readRaw('codeenvironments')).toEqual([]);
        await expect(environments().reserveSetupEnvironment(binding())).rejects.toThrow();
        await expect(environments().createCodeEnvironment(input('env-setup'))).rejects.toThrow(
          'previously retired',
        );
        // A replayed discard after the delete resolves the retired reservation.
        await expect(environments().beginDiscardSetupEnvironment(binding())).resolves.toEqual({
          ...reserved,
          pending: true,
        });
        await expect(
          environments().beginDiscardSetupEnvironment(binding({ name: 'Other' })),
        ).rejects.toThrow('does not match');
      });

      it('fences a binding never reserved, so no later replay can reserve it', async () => {
        await expect(environments().beginDiscardSetupEnvironment(binding())).resolves.toBeNull();
        expect(await tombstones()).toHaveLength(2);
        await expect(environments().reserveSetupEnvironment(binding())).rejects.toThrow();
        expect(await harness.readRaw('codeenvironments')).toEqual([]);
        await expect(environments().beginDiscardSetupEnvironment(binding())).resolves.toBeNull();
      });

      it('deletes only a discarded reservation of the binding', async () => {
        const reserved = await environments().reserveSetupEnvironment(binding());
        await environments().finishDiscardSetupEnvironment(binding(), reserved!.resourceId);
        expect(await harness.readRaw('codeenvironments')).toHaveLength(1);
      });

      it('scopes reservations and their retirement to the tenant', async () => {
        const inA = await inTenant('tenant-a', () =>
          environments().reserveSetupEnvironment(binding()),
        );
        expect((await raw(inA!.resourceId))?.tenantId).toBe('tenant-a');
        await expect(
          inTenant('tenant-b', () => environments().findSetupEnvironment(binding())),
        ).resolves.toBeNull();
        await inTenant('tenant-a', () => environments().beginDiscardSetupEnvironment(binding()));
        expect((await tombstones()).every((row) => row.tenantId === 'tenant-a')).toBe(true);
        const inB = await inTenant('tenant-b', () =>
          environments().reserveSetupEnvironment(binding()),
        );
        expect(inB?.resourceId).not.toBe(inA?.resourceId);
      });
    });
  });
}
