/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SkillSyncStore` contract (`~/ports/skillSync`), ported from `methods/skillSync.spec.ts`:
 * provider credentials (the token stored encrypted with a hash, handed back decrypted by the token
 * read only, summaries with a fingerprint), the per-source run statuses with their skip lists
 * (skipped skills and files, a repository-root path included), timestamps and errors, kept apart
 * per tenant (or no tenant), and the lease lock on the status collection (claims, renewals,
 * releases, expiry, a concurrent claim, per tenant, never listed as a source). A backend's spec for
 * this contract imports `./credentialsEnv` first. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import { createHash } from 'crypto';
import type { ContractHarness, RawRecord } from './harness';
import type { SkillSyncLockInput, SkillSyncStatusInput } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

const LOCK_SOURCE_ID = '__global_lock__';

export function describeSkillSyncContract(harness: ContractHarness): void {
  describe(`SkillSyncStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const adminId = harness.ids.generate();
    const otherAdminId = harness.ids.generate();
    const sync = () => harness.createStores().skillSync;
    const credentialRaw = (credentialKey: string) =>
      readRawWhere(harness, 'skillsynccredentials', { credentialKey }).then((rows) => rows[0]);
    const statusRows = (where: RawRecord = {}) => readRawWhere(harness, 'skillsyncstatuses', where);
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    const lock = (overrides: Partial<SkillSyncLockInput> = {}): SkillSyncLockInput => ({
      provider: 'github',
      lockOwner: 'worker-a',
      leaseMs: 60_000,
      ...overrides,
    });
    const status = (overrides: Partial<SkillSyncStatusInput> = {}): SkillSyncStatusInput => ({
      provider: 'github',
      sourceId: 'librechat-skills',
      status: 'succeeded',
      ...overrides,
    });
    const rawLock = (overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      provider: 'github',
      sourceId: LOCK_SOURCE_ID,
      status: 'running',
      lockOwner: 'worker-a',
      lockExpiresAt: new Date(Date.now() - 1_000),
      syncedSkillCount: 0,
      syncedFileCount: 0,
      deletedSkillCount: 0,
      deletedFileCount: 0,
      skippedSkillCount: 0,
      skippedFileCount: 0,
      ...overrides,
    });

    describe('upsertSkillSyncCredential', () => {
      it('stores the token encrypted with its hash, and summarizes it with a fingerprint', async () => {
        const summary = await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'github-skills-prod',
          token: 'ghp_secret',
          userId: harness.ids.toStoreId(adminId),
        });
        expect(summary).toEqual({
          provider: 'github',
          credentialKey: 'github-skills-prod',
          credentialPresent: true,
          tokenFingerprint: sha256('ghp_secret').slice(0, 12),
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        });
        expect(JSON.stringify(summary)).not.toContain('ghp_secret');
        const stored = await credentialRaw('github-skills-prod');
        expect(stored).toMatchObject({
          provider: 'github',
          tokenHash: sha256('ghp_secret'),
          createdBy: adminId,
          updatedBy: adminId,
        });
        expect(typeof stored.encryptedToken).toBe('string');
        expect(stored.encryptedToken).not.toContain('ghp_secret');
      });

      it('replaces the token of an existing key, keeping who created it', async () => {
        const first = await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'rotating',
          token: 'old-token',
          userId: adminId,
        });
        const second = await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'rotating',
          token: 'new-token',
          userId: otherAdminId,
        });
        expect(second.tokenFingerprint).toBe(sha256('new-token').slice(0, 12));
        expect(timeOf(second.createdAt)).toBe(timeOf(first.createdAt));
        expect(await harness.readRaw('skillsynccredentials')).toHaveLength(1);
        expect(await credentialRaw('rotating')).toMatchObject({
          tokenHash: sha256('new-token'),
          createdBy: adminId,
          updatedBy: otherAdminId,
        });
        expect(await sync().getSkillSyncCredentialToken('github', 'rotating')).toBe('new-token');
      });

      it('stores a credential without a writing user', async () => {
        await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'anonymous',
          token: 'token',
        });
        const stored = await credentialRaw('anonymous');
        expect(stored.createdBy ?? null).toBeNull();
      });
    });

    describe('getSkillSyncCredentialToken', () => {
      it('hands back the decrypted token, or null', async () => {
        await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'github-skills-prod',
          token: 'github_pat_secret',
        });
        expect(await sync().getSkillSyncCredentialToken('github', 'github-skills-prod')).toBe(
          'github_pat_secret',
        );
        expect(await sync().getSkillSyncCredentialToken('github', 'missing')).toBeNull();
      });
    });

    describe('getSkillSyncCredentialSummary and listSkillSyncCredentials', () => {
      it('summarizes one credential or all of them by key, never with token material', async () => {
        for (const credentialKey of ['zeta', 'alpha', 'mid']) {
          await sync().upsertSkillSyncCredential({
            provider: 'github',
            credentialKey,
            token: `token-${credentialKey}`,
          });
        }
        const listed = await sync().listSkillSyncCredentials('github');
        expect(listed.map((summary) => summary.credentialKey)).toEqual(['alpha', 'mid', 'zeta']);
        expect(listed[0]).toEqual({
          provider: 'github',
          credentialKey: 'alpha',
          credentialPresent: true,
          tokenFingerprint: sha256('token-alpha').slice(0, 12),
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        });
        expect(JSON.stringify(listed)).not.toContain('token-');
        expect(await sync().getSkillSyncCredentialSummary('github', 'mid')).toEqual(listed[1]);
        expect(await sync().getSkillSyncCredentialSummary('github', 'missing')).toBeNull();
      });

      it('lists nothing without credentials', async () => {
        expect(await sync().listSkillSyncCredentials('github')).toEqual([]);
      });
    });

    describe('deleteSkillSyncCredential', () => {
      it('deletes the credential and reports whether there was one', async () => {
        await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'doomed',
          token: 'token',
        });
        await sync().upsertSkillSyncCredential({
          provider: 'github',
          credentialKey: 'kept',
          token: 'token',
        });
        expect(await sync().deleteSkillSyncCredential('github', 'doomed')).toEqual({
          deleted: true,
        });
        expect(await sync().deleteSkillSyncCredential('github', 'doomed')).toEqual({
          deleted: false,
        });
        expect(
          (await harness.readRaw('skillsynccredentials')).map((row) => row.credentialKey),
        ).toEqual(['kept']);
      });
    });

    describe('upsertSkillSyncStatus', () => {
      it('creates the status with zero counts for the ones left out, and a success time', async () => {
        const finishedAt = new Date('2026-01-01T00:05:00Z');
        const row = await sync().upsertSkillSyncStatus(
          status({
            credentialKey: 'github-skills-prod',
            owner: 'danny-avila',
            repo: 'skills',
            ref: 'main',
            paths: ['skills/', 'more/'],
            startedAt: new Date('2026-01-01T00:00:00Z'),
            finishedAt,
            syncedSkillCount: 3,
          }),
        );
        expect(row).toMatchObject({
          provider: 'github',
          sourceId: 'librechat-skills',
          status: 'succeeded',
          credentialKey: 'github-skills-prod',
          owner: 'danny-avila',
          repo: 'skills',
          ref: 'main',
          paths: ['skills/', 'more/'],
          syncedSkillCount: 3,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
          skippedSkillCount: 0,
          skippedSkills: [],
          skippedFileCount: 0,
          skippedFiles: [],
        });
        expect(timeOf(row.lastSuccessAt)).toBe(finishedAt.getTime());
        expect(row.lastFailureAt).toBeUndefined();
        expect(row.tenantId).toBeUndefined();
        const [stored] = await statusRows();
        expect(stored).not.toHaveProperty('tenantId');
        expect(stored).not.toHaveProperty('errorCode');
      });

      it('records a failure with its error and time, and clears the error on the next success', async () => {
        const failed = await sync().upsertSkillSyncStatus(
          status({ status: 'failed', errorCode: 'SKILL_PARSE_FAILED', errorMessage: 'bad' }),
        );
        expect(failed).toMatchObject({
          status: 'failed',
          errorCode: 'SKILL_PARSE_FAILED',
          errorMessage: 'bad',
        });
        expect(failed.lastFailureAt).toBeInstanceOf(Date);
        expect(failed.lastSuccessAt).toBeUndefined();
        const success = await sync().upsertSkillSyncStatus(status({ syncedFileCount: 2 }));
        expect(success.errorCode).toBeUndefined();
        expect(success.errorMessage).toBeUndefined();
        expect(timeOf(success.lastFailureAt)).toBe(timeOf(failed.lastFailureAt));
        expect(success.lastSuccessAt).toBeInstanceOf(Date);
        expect(await statusRows()).toHaveLength(1);
      });

      it('clears the error without touching the times for a run that is neither', async () => {
        await sync().upsertSkillSyncStatus(
          status({ status: 'failed', errorCode: 'E', errorMessage: 'm' }),
        );
        const running = await sync().upsertSkillSyncStatus(status({ status: 'running' }));
        expect(running.status).toBe('running');
        expect(running.errorCode).toBeUndefined();
        expect(running.lastSuccessAt).toBeUndefined();
        expect(running.lastFailureAt).toBeInstanceOf(Date);
      });

      it('stores the skip lists of a partial run, a root path included, and replaces them on the next run', async () => {
        const skippedSkills = [
          {
            path: 'skills/broken',
            name: 'broken',
            errorCode: 'SKILL_PARSE_FAILED',
            errorMessage: 'skills/broken/SKILL.md: malformed frontmatter',
          },
          {
            path: '',
            name: 'root-skill',
            errorCode: 'DUPLICATE_SKILL_NAME',
            errorMessage: 'multiple skills named "root"',
          },
        ];
        const skippedFiles = [
          {
            path: 'skills/pdf/big.bin',
            skillPath: 'skills/pdf',
            errorCode: 'FILE_TOO_LARGE',
            errorMessage: 'big.bin is too large',
          },
          { path: 'a.txt', skillPath: '', errorCode: 'X', errorMessage: 'root file' },
        ];
        const finishedAt = new Date('2026-01-01T00:00:00Z');
        const partial = await sync().upsertSkillSyncStatus(
          status({
            status: 'partial',
            finishedAt,
            syncedSkillCount: 11,
            skippedSkillCount: 2,
            skippedSkills,
            skippedFileCount: 2,
            skippedFiles,
          }),
        );
        expect(partial).toMatchObject({ status: 'partial', skippedSkills, skippedFiles });
        expect(timeOf(partial.lastSuccessAt)).toBe(finishedAt.getTime());
        expect((await statusRows())[0]).toMatchObject({ skippedSkills, skippedFiles });
        expect((await sync().listSkillSyncStatuses('github'))[0]).toMatchObject({
          skippedSkills,
          skippedFiles,
        });

        const clean = await sync().upsertSkillSyncStatus(status({ syncedSkillCount: 13 }));
        expect(clean).toMatchObject({
          skippedSkillCount: 0,
          skippedSkills: [],
          skippedFileCount: 0,
          skippedFiles: [],
        });
      });

      it('keeps a status per tenant, and one for no tenant, for the same source', async () => {
        await sync().upsertSkillSyncStatus(status({ tenantId: 'tenant-a', syncedSkillCount: 1 }));
        await sync().upsertSkillSyncStatus(
          status({ tenantId: 'tenant-b', status: 'failed', errorCode: 'TENANT_B_FAILURE' }),
        );
        await sync().upsertSkillSyncStatus(status({ syncedSkillCount: 7 }));
        await sync().upsertSkillSyncStatus(status({ tenantId: 'tenant-a', syncedSkillCount: 2 }));
        const rows = await statusRows();
        expect(rows).toHaveLength(3);
        expect(rows.find((row) => row.tenantId === 'tenant-a')).toMatchObject({
          status: 'succeeded',
          syncedSkillCount: 2,
        });
        expect(rows.find((row) => row.tenantId === 'tenant-b')).toMatchObject({
          status: 'failed',
          errorCode: 'TENANT_B_FAILURE',
        });
        expect(rows.find((row) => row.tenantId == null)).toMatchObject({ syncedSkillCount: 7 });
      });
    });

    describe('listSkillSyncStatuses', () => {
      it("lists the provider's source statuses by source id, of every tenant, never the lock", async () => {
        await sync().upsertSkillSyncStatus(status({ sourceId: 'zeta' }));
        await sync().upsertSkillSyncStatus(status({ sourceId: 'alpha', tenantId: 'tenant-a' }));
        await sync().upsertSkillSyncStatus(status({ sourceId: 'mid' }));
        expect(await sync().tryAcquireSkillSyncLock(lock())).toBe(true);
        const rows = await sync().listSkillSyncStatuses('github');
        expect(rows.map((row) => row.sourceId)).toEqual(['alpha', 'mid', 'zeta']);
        expect(rows[0].tenantId).toBe('tenant-a');
        expect(idOf(harness, (rows[0] as { _id?: unknown })._id)).toHaveLength(24);
      });
    });

    describe('tryAcquireSkillSyncLock', () => {
      it('claims a free lock once; a live lease refuses every claimant, its owner included', async () => {
        expect(await sync().tryAcquireSkillSyncLock(lock())).toBe(true);
        expect(await sync().tryAcquireSkillSyncLock(lock())).toBe(false);
        expect(await sync().tryAcquireSkillSyncLock(lock({ lockOwner: 'worker-b' }))).toBe(false);
        const [row] = await statusRows({ sourceId: LOCK_SOURCE_ID });
        expect(row).toMatchObject({ status: 'running', lockOwner: 'worker-a' });
        expect(timeOf(row.lockExpiresAt)).toBeGreaterThan(Date.now());
        expect(row.startedAt).toBeInstanceOf(Date);
      });

      it('takes over an expired lease, or a released lock', async () => {
        await harness.seedRaw('skillsyncstatuses', [rawLock()]);
        expect(await sync().tryAcquireSkillSyncLock(lock({ lockOwner: 'worker-b' }))).toBe(true);
        expect((await statusRows({ sourceId: LOCK_SOURCE_ID }))[0].lockOwner).toBe('worker-b');
        await sync().releaseSkillSyncLock({ provider: 'github', lockOwner: 'worker-b' });
        expect(await sync().tryAcquireSkillSyncLock(lock({ lockOwner: 'worker-c' }))).toBe(true);
        expect(await statusRows({ sourceId: LOCK_SOURCE_ID })).toHaveLength(1);
      });

      it('lets exactly one of two concurrent claimants win', async () => {
        const results = await Promise.all(
          ['worker-a', 'worker-b', 'worker-c'].map((lockOwner) =>
            sync().tryAcquireSkillSyncLock(lock({ lockOwner })),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await statusRows({ sourceId: LOCK_SOURCE_ID })).toHaveLength(1);
      });

      it('keeps a lock per tenant', async () => {
        expect(await sync().tryAcquireSkillSyncLock(lock({ tenantId: 'tenant-a' }))).toBe(true);
        expect(
          await sync().tryAcquireSkillSyncLock(
            lock({ tenantId: 'tenant-b', lockOwner: 'worker-b' }),
          ),
        ).toBe(true);
        expect(await sync().tryAcquireSkillSyncLock(lock({ lockOwner: 'worker-c' }))).toBe(true);
        expect(
          await sync().tryAcquireSkillSyncLock(
            lock({ tenantId: 'tenant-a', lockOwner: 'worker-d' }),
          ),
        ).toBe(false);
        expect(await statusRows({ sourceId: LOCK_SOURCE_ID })).toHaveLength(3);
      });
    });

    describe('refreshSkillSyncLock', () => {
      it("renews only the owner's live lease", async () => {
        expect(await sync().tryAcquireSkillSyncLock(lock({ leaseMs: 5_000 }))).toBe(true);
        const before = (await statusRows({ sourceId: LOCK_SOURCE_ID }))[0];
        expect(await sync().refreshSkillSyncLock(lock({ leaseMs: 600_000 }))).toBe(true);
        const after = (await statusRows({ sourceId: LOCK_SOURCE_ID }))[0];
        expect(timeOf(after.lockExpiresAt)).toBeGreaterThan(timeOf(before.lockExpiresAt));
        expect(await sync().refreshSkillSyncLock(lock({ lockOwner: 'worker-b' }))).toBe(false);
        expect(await sync().refreshSkillSyncLock(lock({ tenantId: 'tenant-a' }))).toBe(false);
      });

      it('refuses to renew an expired lease or a missing lock', async () => {
        expect(await sync().refreshSkillSyncLock(lock())).toBe(false);
        await harness.seedRaw('skillsyncstatuses', [rawLock()]);
        expect(await sync().refreshSkillSyncLock(lock())).toBe(false);
      });
    });

    describe('releaseSkillSyncLock', () => {
      it("gives up the owner's lock, leaving it idle, and ignores other owners", async () => {
        expect(await sync().tryAcquireSkillSyncLock(lock())).toBe(true);
        await sync().releaseSkillSyncLock({ provider: 'github', lockOwner: 'worker-b' });
        expect((await statusRows({ sourceId: LOCK_SOURCE_ID }))[0].lockOwner).toBe('worker-a');
        await sync().releaseSkillSyncLock({ provider: 'github', lockOwner: 'worker-a' });
        const [row] = await statusRows({ sourceId: LOCK_SOURCE_ID });
        expect(row.status).toBe('idle');
        expect(row.finishedAt).toBeInstanceOf(Date);
        expect(row).not.toHaveProperty('lockOwner');
        expect(row).not.toHaveProperty('lockExpiresAt');
        await expect(
          sync().releaseSkillSyncLock({ provider: 'github', lockOwner: 'nobody', tenantId: 'x' }),
        ).resolves.toBeUndefined();
      });
    });
  });
}
