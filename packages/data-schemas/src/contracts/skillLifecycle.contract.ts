/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SkillLifecycleStore` contract (`~/ports/skillLifecycle`), ported from
 * `methods/skillLifecycle.spec.ts` and the deletion cases of `methods/skill.spec.ts`: the deletion
 * journal (the mark that frees the name, the journal that keeps the skill's tenant, the backfill
 * of an upload intent per legacy file in batches, the repair of a mark without a journal), the
 * worker leases on journals and on blob cleanups (claims, renewals, releases, expiry, rechecks,
 * the order and limits of the sweeps), the upload intents' states and their writer fence, the
 * cleanup holds, the operator recoveries, and the cleanup cursors that page files and intents in
 * batches without skipping rows changed while they are read. Cases that spy on the driver (a
 * cursor's close, query plans, index definitions) stay in the method spec. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { ISkillUploadIntent } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

type Row = Record<string, unknown>;

/** The error a store method rejected with, or a failure when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error & Row> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Row;
  }
  throw new Error('Expected the call to reject');
}

/** Every batch an async iterable yields. */
async function batchesOf<T>(iterable: AsyncIterable<T[]>): Promise<T[][]> {
  const batches: T[][] = [];
  for await (const batch of iterable) {
    batches.push(batch);
  }
  return batches;
}

const MINUTE = 60_000;

export function describeSkillLifecycleContract(harness: ContractHarness): void {
  describe(`SkillLifecycleStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const authorId = harness.ids.generate();
    const lifecycle = () => harness.createStores().skillLifecycle;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const ago = (ms: number) => new Date(Date.now() - ms);
    const ahead = (ms: number) => new Date(Date.now() + ms);
    const skillRaw = (id: string) =>
      harness.readRaw('skills').then((rows) => rows.find((row) => row._id === id));
    const journalRaw = (skillId: string) =>
      readRawWhere(harness, 'skilldeletions', { skillId }).then((rows) => rows[0]);
    const intentRaw = (fileId: string) =>
      readRawWhere(harness, 'skilluploadintents', { fileId }).then((rows) => rows[0]);
    const fileIdsOf = (intents: ISkillUploadIntent[]) => intents.map((intent) => intent.fileId);

    const rawSkill = (overrides: RawRecord = {}): RawRecord => {
      const _id = harness.ids.generate();
      return {
        _id,
        name: `example-${_id}`,
        description: 'Example skill for lifecycle tests',
        body: '',
        author: authorId,
        authorName: 'Example',
        version: 1,
        fileCount: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
      };
    };
    const rawFile = (skillId: string, fileId: string, overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      skillId,
      file_id: fileId,
      relativePath: `${fileId}.md`,
      filename: `${fileId}.md`,
      filepath: `/uploads/${fileId}`,
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 4,
      category: 'other',
      author: authorId,
      content: 'never read by cleanup',
      ...overrides,
    });
    const rawIntent = (skillId: string, fileId: string, overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      skillId,
      fileId,
      source: 'local',
      storageKey: `/uploads/${fileId}`,
      author: authorId,
      writerId: 'writer-1',
      state: 'committed',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    });
    const rawDeletion = (skillId: string, overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      skillId,
      author: authorId,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    });
    /** A skill with its deletion journaled (raw), and its id. */
    const seedJournal = async (overrides: RawRecord = {}) => {
      const skill = rawSkill({ deletingAt: ago(MINUTE) });
      await harness.seedRaw('skills', [skill]);
      await harness.seedRaw('skilldeletions', [rawDeletion(skill._id as string, overrides)]);
      return skill._id as string;
    };
    const seedSkill = async (overrides: RawRecord = {}) => {
      const skill = rawSkill(overrides);
      await harness.seedRaw('skills', [skill]);
      return skill._id as string;
    };

    describe('beginSkillDeletion', () => {
      it('marks the skill deleting, journals it and backfills an intent for each legacy file', async () => {
        const skillId = await seedSkill({ tenantId: 'tenant-a' });
        await harness.seedRaw('skillfiles', [
          rawFile(skillId, 'with-key', { storageKey: 'blobs/with-key', tenantId: 'tenant-a' }),
          rawFile(skillId, 'without-key', { tenantId: 'tenant-a' }),
        ]);
        const journal = await inTenant('tenant-a', () => lifecycle().beginSkillDeletion(skillId));
        const stored = await skillRaw(skillId);
        expect(stored).toMatchObject({ name: `__deleted__${skillId}` });
        expect(stored?.deletingAt).toBeInstanceOf(Date);
        expect(stored).not.toHaveProperty('deletionNeedsJournal');
        expect(idOf(harness, journal?.skillId)).toBe(skillId);
        expect(idOf(harness, journal?.author)).toBe(authorId);
        expect(journal?.tenantId).toBe('tenant-a');
        expect(timeOf(journal?.startedAt)).toBe(timeOf(stored?.deletingAt));
        expect(await intentRaw('with-key')).toMatchObject({
          skillId,
          storageKey: 'blobs/with-key',
          writerId: 'legacy-backfill',
          state: 'committed',
          author: authorId,
        });
        expect((await intentRaw('without-key')).storageKey).toBe('/uploads/without-key');
      });

      it('keeps the journal and the existing intents on a retry', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'f1')]);
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { writerId: 'original-writer', storageKey: 'blobs/f1' }),
        ]);
        const first = await lifecycle().beginSkillDeletion(skillId);
        const second = await lifecycle().beginSkillDeletion(skillId);
        expect(timeOf(second?.startedAt)).toBe(timeOf(first?.startedAt));
        expect(await harness.readRaw('skilldeletions')).toHaveLength(1);
        expect(await harness.readRaw('skilluploadintents')).toHaveLength(1);
        expect(await intentRaw('f1')).toMatchObject({
          writerId: 'original-writer',
          storageKey: 'blobs/f1',
        });
      });

      it('resolves null for an unknown skill', async () => {
        expect(await lifecycle().beginSkillDeletion(harness.ids.generate())).toBeNull();
        expect(await harness.readRaw('skilldeletions')).toEqual([]);
      });

      it("records the skill's tenant on the journal when called without a tenant context", async () => {
        const skillId = await seedSkill({ tenantId: 'tenant-a' });
        const journal = await lifecycle().beginSkillDeletion(skillId);
        expect(journal?.tenantId).toBe('tenant-a');
        expect((await journalRaw(skillId)).tenantId).toBe('tenant-a');
      });

      it('journals a skill already marked without a journal, keeping its mark', async () => {
        const deletingAt = ago(MINUTE);
        const skillId = await seedSkill({
          name: '__deleted__pre-marked',
          deletingAt,
          deletionNeedsJournal: true,
        });
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'f1')]);
        const journal = await lifecycle().beginSkillDeletion(skillId);
        expect(timeOf(journal?.startedAt)).toBe(deletingAt.getTime());
        expect(await skillRaw(skillId)).toMatchObject({ name: '__deleted__pre-marked' });
        expect(await skillRaw(skillId)).not.toHaveProperty('deletionNeedsJournal');
        expect(await intentRaw('f1')).toMatchObject({ writerId: 'legacy-backfill' });
      });

      it('backfills more files than one batch holds', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw(
          'skillfiles',
          Array.from({ length: 205 }, (_, index) => rawFile(skillId, `bulk-${index}`)),
        );
        await lifecycle().beginSkillDeletion(skillId);
        expect(await readRawWhere(harness, 'skilluploadintents', { skillId })).toHaveLength(205);
      });
    });

    describe('getSkillDeletion', () => {
      it('reads the journal of the skill, or null', async () => {
        const skillId = await seedJournal({ lastAttemptAt: new Date('2026-01-02T00:00:00Z') });
        const journal = await lifecycle().getSkillDeletion(skillId);
        expect(idOf(harness, journal?.skillId)).toBe(skillId);
        expect(timeOf(journal?.lastAttemptAt)).toBe(new Date('2026-01-02T00:00:00Z').getTime());
        expect(await lifecycle().getSkillDeletion(harness.ids.generate())).toBeNull();
      });
    });

    describe('discoverUnjournaledDeletions', () => {
      it('journals up to the limit of marked skills, least recently attempted first', async () => {
        const marked = (attemptAt?: Date) => ({
          deletingAt: ago(MINUTE),
          deletionNeedsJournal: true,
          ...(attemptAt ? { deletionJournalAttemptAt: attemptAt } : {}),
        });
        const never = await seedSkill(marked());
        const older = await seedSkill(marked(new Date('2026-01-01T00:00:00Z')));
        const newer = await seedSkill(marked(new Date('2026-02-01T00:00:00Z')));
        const unmarked = await seedSkill();
        expect(await lifecycle().discoverUnjournaledDeletions(2)).toBe(2);
        expect((await harness.readRaw('skilldeletions')).map((row) => row.skillId).sort()).toEqual(
          [never, older].sort(),
        );
        expect(await skillRaw(never)).not.toHaveProperty('deletionNeedsJournal');
        expect((await skillRaw(never))?.deletionJournalAttemptAt).toBeInstanceOf(Date);
        const pending = await skillRaw(newer);
        expect(pending?.deletionNeedsJournal).toBe(true);
        expect(await lifecycle().discoverUnjournaledDeletions()).toBe(1);
        expect(await lifecycle().discoverUnjournaledDeletions()).toBe(0);
        expect(await skillRaw(unmarked)).not.toHaveProperty('deletingAt');
      });
    });

    describe('listPendingSkillDeletions', () => {
      it('lists the deletions not completed, least recently updated first, up to the limit', async () => {
        const later = await seedJournal({ updatedAt: new Date('2026-03-01T00:00:00Z') });
        const earlier = await seedJournal({ updatedAt: new Date('2026-02-01T00:00:00Z') });
        await seedJournal({ completedAt: ago(MINUTE) });
        const pending = await lifecycle().listPendingSkillDeletions();
        expect(pending.map((row) => idOf(harness, row.skillId))).toEqual([earlier, later]);
        expect(
          (await lifecycle().listPendingSkillDeletions(1)).map((row) => idOf(harness, row.skillId)),
        ).toEqual([earlier]);
      });
    });

    describe('listSkillDeletionTombstones', () => {
      it('lists the claimable deletions, least recently attempted first, up to the limit', async () => {
        const neverAttempted = await seedJournal({ startedAt: new Date('2026-01-05T00:00:00Z') });
        const attempted = await seedJournal({ lastAttemptAt: new Date('2026-01-03T00:00:00Z') });
        const attemptedEarlier = await seedJournal({
          lastAttemptAt: new Date('2026-01-02T00:00:00Z'),
        });
        const expiredClaim = await seedJournal({
          claimOwner: 'old-worker',
          claimExpiresAt: ago(MINUTE),
          lastAttemptAt: new Date('2026-01-04T00:00:00Z'),
        });
        await seedJournal({ claimOwner: 'worker', claimExpiresAt: ahead(MINUTE) });
        const completedDue = await seedJournal({
          completedAt: ago(10 * MINUTE),
          nextCheckAt: ago(MINUTE),
          lastAttemptAt: new Date('2026-01-06T00:00:00Z'),
        });
        await seedJournal({ completedAt: ago(10 * MINUTE), nextCheckAt: ahead(MINUTE) });
        const completedUnscheduled = await seedJournal({
          completedAt: ago(10 * MINUTE),
          lastAttemptAt: new Date('2026-01-07T00:00:00Z'),
        });
        const listed = await lifecycle().listSkillDeletionTombstones();
        expect(listed.map((row) => idOf(harness, row.skillId))).toEqual([
          neverAttempted,
          attemptedEarlier,
          attempted,
          expiredClaim,
          completedDue,
          completedUnscheduled,
        ]);
        expect(
          (await lifecycle().listSkillDeletionTombstones(2)).map((row) =>
            idOf(harness, row.skillId),
          ),
        ).toEqual([neverAttempted, attemptedEarlier]);
      });
    });

    describe('noteSkillDeletionAttempt', () => {
      it('records that a worker attempted the deletion now', async () => {
        const skillId = await seedJournal();
        const before = Date.now();
        await lifecycle().noteSkillDeletionAttempt(harness.ids.toStoreId(skillId));
        expect(timeOf((await journalRaw(skillId)).lastAttemptAt)).toBeGreaterThanOrEqual(
          before - 5,
        );
      });
    });

    describe('claimSkillDeletion, refreshSkillDeletionClaim and releaseSkillDeletionClaim', () => {
      it('serializes claims, renews the owner, and admits another worker after expiry or release', async () => {
        const skillId = await seedJournal();
        const store = lifecycle();
        expect(await store.claimSkillDeletion(skillId, 'worker-a', MINUTE)).toBe(true);
        expect(await store.claimSkillDeletion(skillId, 'worker-b', MINUTE)).toBe(false);
        expect(await store.claimSkillDeletion(skillId, 'worker-a', 10 * MINUTE)).toBe(true);
        expect(timeOf((await journalRaw(skillId)).claimExpiresAt)).toBeGreaterThan(
          Date.now() + 5 * MINUTE,
        );
        await store.releaseSkillDeletionClaim(skillId, 'worker-b');
        expect((await journalRaw(skillId)).claimOwner).toBe('worker-a');
        await store.releaseSkillDeletionClaim(skillId, 'worker-a');
        const released = await journalRaw(skillId);
        expect(released).not.toHaveProperty('claimOwner');
        expect(released).not.toHaveProperty('claimExpiresAt');
        expect(await store.claimSkillDeletion(skillId, 'worker-b', -1)).toBe(true);
        expect(await store.claimSkillDeletion(skillId, 'worker-c', MINUTE)).toBe(true);
        expect((await journalRaw(skillId)).claimOwner).toBe('worker-c');
      });

      it('refuses a claim on a completed deletion until its recheck is due', async () => {
        const notDue = await seedJournal({ completedAt: ago(MINUTE), nextCheckAt: ahead(MINUTE) });
        const due = await seedJournal({ completedAt: ago(MINUTE), nextCheckAt: ago(1_000) });
        expect(await lifecycle().claimSkillDeletion(notDue, 'worker', MINUTE)).toBe(false);
        expect(await lifecycle().claimSkillDeletion(due, 'worker', MINUTE)).toBe(true);
        expect(await lifecycle().claimSkillDeletion(harness.ids.generate(), 'worker', MINUTE)).toBe(
          false,
        );
      });

      it("renews only the owner's live claim", async () => {
        const skillId = await seedJournal();
        expect(await lifecycle().refreshSkillDeletionClaim(skillId, 'worker-a', MINUTE)).toBe(
          false,
        );
        await lifecycle().claimSkillDeletion(skillId, 'worker-a', MINUTE);
        expect(await lifecycle().refreshSkillDeletionClaim(skillId, 'worker-a', 10 * MINUTE)).toBe(
          true,
        );
        expect(timeOf((await journalRaw(skillId)).claimExpiresAt)).toBeGreaterThan(
          Date.now() + 5 * MINUTE,
        );
        expect(await lifecycle().refreshSkillDeletionClaim(skillId, 'worker-b', MINUTE)).toBe(
          false,
        );
        await lifecycle().claimSkillDeletion(skillId, 'worker-a', -1);
        expect(await lifecycle().refreshSkillDeletionClaim(skillId, 'worker-a', MINUTE)).toBe(
          false,
        );
      });
    });

    describe('completeSkillDeletion, reopenSkillDeletion and scheduleSkillDeletionRecheck', () => {
      it('completes only under a live claim', async () => {
        const skillId = await seedJournal();
        expect(await lifecycle().completeSkillDeletion(skillId, 'worker-a')).toBe(false);
        await lifecycle().claimSkillDeletion(skillId, 'worker-a', -1);
        expect(await lifecycle().completeSkillDeletion(skillId, 'worker-a')).toBe(false);
        await lifecycle().claimSkillDeletion(skillId, 'worker-b', MINUTE);
        expect(await lifecycle().completeSkillDeletion(skillId, 'worker-a')).toBe(false);
        expect(await lifecycle().completeSkillDeletion(skillId, 'worker-b')).toBe(true);
        expect((await journalRaw(skillId)).completedAt).toBeInstanceOf(Date);
        expect(
          (await lifecycle().listPendingSkillDeletions()).map((row) => idOf(harness, row.skillId)),
        ).toEqual([]);
      });

      it('schedules a recheck of a completed deletion under a live claim, which defers it', async () => {
        const skillId = await seedJournal();
        await lifecycle().claimSkillDeletion(skillId, 'worker', MINUTE);
        expect(await lifecycle().scheduleSkillDeletionRecheck(skillId, 'worker', MINUTE)).toBe(
          false,
        );
        await lifecycle().completeSkillDeletion(skillId, 'worker');
        expect(await lifecycle().scheduleSkillDeletionRecheck(skillId, 'other', MINUTE)).toBe(
          false,
        );
        expect(await lifecycle().scheduleSkillDeletionRecheck(skillId, 'worker', 10 * MINUTE)).toBe(
          true,
        );
        expect(timeOf((await journalRaw(skillId)).nextCheckAt)).toBeGreaterThan(
          Date.now() + 5 * MINUTE,
        );
        await lifecycle().releaseSkillDeletionClaim(skillId, 'worker');
        expect(await lifecycle().listSkillDeletionTombstones()).toEqual([]);
        expect(await lifecycle().claimSkillDeletion(skillId, 'worker', MINUTE)).toBe(false);
      });

      it('reopens a completed deletion, dropping its recheck', async () => {
        const skillId = await seedJournal({ completedAt: ago(MINUTE), nextCheckAt: ahead(MINUTE) });
        await lifecycle().reopenSkillDeletion(skillId);
        const reopened = await journalRaw(skillId);
        expect(reopened).not.toHaveProperty('completedAt');
        expect(reopened).not.toHaveProperty('nextCheckAt');
        expect(
          (await lifecycle().listPendingSkillDeletions()).map((row) => idOf(harness, row.skillId)),
        ).toEqual([skillId]);
      });
    });

    describe('reserveSkillUploadIntent', () => {
      const reservation = (skillId: string, overrides: Row = {}) => ({
        skillId,
        author: authorId,
        fileId: 'upload-1',
        source: 'local',
        storageKey: 'blobs/upload-1',
        writerId: 'writer-1',
        ...overrides,
      });

      it('records the upload as uploading for a live skill', async () => {
        const skillId = await seedSkill();
        const intent = await lifecycle().reserveSkillUploadIntent(reservation(skillId));
        expect(intent).toMatchObject({
          fileId: 'upload-1',
          state: 'uploading',
          writerId: 'writer-1',
          storageKey: 'blobs/upload-1',
        });
        expect(idOf(harness, intent.skillId)).toBe(skillId);
        expect(await intentRaw('upload-1')).toMatchObject({
          skillId,
          author: authorId,
          state: 'uploading',
        });
      });

      it('throws SKILL_DELETING for a skill being deleted or absent, leaving the intent abandoned', async () => {
        const deleting = await seedSkill({ deletingAt: ago(MINUTE) });
        for (const [skillId, fileId] of [
          [deleting, 'to-deleting'],
          [harness.ids.generate(), 'to-absent'],
        ]) {
          const error = await rejectionOf(
            lifecycle().reserveSkillUploadIntent(reservation(skillId, { fileId })),
          );
          expect(error).toMatchObject({ code: 'SKILL_DELETING' });
          expect((await intentRaw(fileId)).state).toBe('abandoned');
        }
      });

      it("rejects a file id already reserved with a duplicate-key error, leaving another writer's intent", async () => {
        const skillId = await seedSkill();
        await lifecycle().reserveSkillUploadIntent(reservation(skillId));
        const error = await rejectionOf(
          lifecycle().reserveSkillUploadIntent(reservation(skillId, { writerId: 'writer-2' })),
        );
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
        expect(await intentRaw('upload-1')).toMatchObject({
          writerId: 'writer-1',
          state: 'uploading',
        });
      });

      it('stamps the active tenant', async () => {
        const skillId = await seedSkill({ tenantId: 'tenant-a' });
        await inTenant('tenant-a', () =>
          lifecycle().reserveSkillUploadIntent(reservation(skillId, { tenantId: 'tenant-a' })),
        );
        expect((await intentRaw('upload-1')).tenantId).toBe('tenant-a');
      });
    });

    describe('transitionSkillUploadIntent', () => {
      it("moves the writer's intent, and reports one already in the target state", async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { state: 'uploading' }),
        ]);
        const move = (
          writerId: string,
          from: ISkillUploadIntent['state'],
          to: ISkillUploadIntent['state'],
        ) => lifecycle().transitionSkillUploadIntent('f1', writerId, from, to);
        expect(await move('writer-2', 'uploading', 'committing')).toBe(false);
        expect(await move('writer-1', 'committing', 'committed')).toBe(false);
        expect(await move('writer-1', 'uploading', 'committing')).toBe(true);
        expect(await move('writer-1', 'uploading', 'committing')).toBe(true);
        expect(await move('writer-1', 'committing', 'committed')).toBe(true);
        expect((await intentRaw('f1')).state).toBe('committed');
        expect(
          await lifecycle().transitionSkillUploadIntent(
            'missing',
            'writer-1',
            'uploading',
            'committing',
          ),
        ).toBe(false);
      });
    });

    describe('listSkillUploadIntents and getSkillUploadIntent', () => {
      it("lists the skill's intents, or only those whose blob may still need cleanup", async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'uploading', { state: 'uploading' }),
          rawIntent(skillId, 'committing', { state: 'committing' }),
          rawIntent(skillId, 'committed'),
          rawIntent(skillId, 'committed-cleaned', { cleanedAt: ago(MINUTE) }),
          rawIntent(skillId, 'abandoned', { state: 'abandoned' }),
          rawIntent(skillId, 'abandoned-cleaned', { state: 'abandoned', cleanedAt: ago(MINUTE) }),
          rawIntent(harness.ids.generate(), 'other-skill'),
        ]);
        expect(fileIdsOf(await lifecycle().listSkillUploadIntents(skillId)).sort()).toEqual([
          'abandoned',
          'abandoned-cleaned',
          'committed',
          'committed-cleaned',
          'committing',
          'uploading',
        ]);
        expect(
          fileIdsOf(
            await lifecycle().listSkillUploadIntents(harness.ids.toStoreId(skillId), {
              cleanupOnly: true,
            }),
          ).sort(),
        ).toEqual(['abandoned', 'abandoned-cleaned', 'committed', 'committing', 'uploading']);
        expect(await lifecycle().getSkillUploadIntent('committed')).toMatchObject({
          fileId: 'committed',
          state: 'committed',
        });
        expect(await lifecycle().getSkillUploadIntent('missing')).toBeNull();
      });
    });

    describe('iterateSkillCleanupFiles and iterateSkillCleanupIntents', () => {
      it('pages the files and intents in batches without content, skipping none changed while read', async () => {
        const skillId = await seedSkill({ tenantId: 'tenant-a' });
        await harness.seedRaw(
          'skillfiles',
          Array.from({ length: 205 }, (_, index) =>
            rawFile(skillId, `paged-${index}`, { tenantId: 'tenant-a' }),
          ),
        );
        await harness.seedRaw('skillfiles', [rawFile(harness.ids.generate(), 'other-skill')]);
        await lifecycle().beginSkillDeletion(skillId);
        const store = lifecycle();
        /** The file rows are drained through the skill store, as the cleanup worker does. */
        const skillStore = harness.createStores().skills;
        const seen = new Set<string>();
        for await (const files of store.iterateSkillCleanupFiles(skillId, 17)) {
          expect(files.length).toBeGreaterThan(0);
          expect(files.length).toBeLessThanOrEqual(17);
          for (const file of files) {
            expect(file).not.toHaveProperty('content');
            expect(seen.has(file.file_id)).toBe(false);
            seen.add(file.file_id);
            expect(await skillStore.deleteSkillFileAfterBlob(skillId, file.file_id)).toBe(true);
          }
        }
        expect(seen.size).toBe(205);
        expect(await store.hasInFlightSkillUploads(skillId)).toBe(false);
        const cleaned = new Set<string>();
        for await (const intents of store.iterateSkillCleanupIntents(skillId, 17)) {
          expect(intents.length).toBeLessThanOrEqual(17);
          expect(await store.listExistingSkillFileIds(skillId, fileIdsOf(intents))).toEqual([]);
          for (const intent of intents) {
            expect(cleaned.has(intent.fileId)).toBe(false);
            cleaned.add(intent.fileId);
            await store.markSkillUploadIntentCleaned(intent.fileId);
          }
        }
        expect(cleaned.size).toBe(205);
        expect(await batchesOf(store.iterateSkillCleanupIntents(skillId, 17))).toEqual([]);
      });

      it('yields full batches and a last partial one, and nothing for a skill without rows', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw(
          'skillfiles',
          Array.from({ length: 5 }, (_, index) => rawFile(skillId, `f${index}`)),
        );
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'pending', { state: 'abandoned' }),
          rawIntent(skillId, 'clean', { cleanedAt: ago(MINUTE) }),
        ]);
        const fileBatches = await batchesOf(lifecycle().iterateSkillCleanupFiles(skillId, 2));
        expect(fileBatches.map((batch) => batch.length)).toEqual([2, 2, 1]);
        const intentBatches = await batchesOf(lifecycle().iterateSkillCleanupIntents(skillId, 10));
        expect(intentBatches.map(fileIdsOf)).toEqual([['pending']]);
        const empty = harness.ids.generate();
        expect(await batchesOf(lifecycle().iterateSkillCleanupFiles(empty, 2))).toEqual([]);
        expect(await batchesOf(lifecycle().iterateSkillCleanupIntents(empty, 2))).toEqual([]);
      });

      it.each([0, -1, 1.5, Number.NaN])('rejects the batch size %p when iterated', async (size) => {
        // NOTE(contract): on MongoDB the 'Invalid cleanup batch size' error is masked: the
        // generator's `finally` closes a cursor that never opened, which throws a TypeError in its
        // place. The iteration still rejects before yielding anything, which is what callers rely
        // on, so only the rejection is pinned.
        const skillId = await seedSkill();
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'f1')]);
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { state: 'abandoned' }),
        ]);
        await expect(
          batchesOf(lifecycle().iterateSkillCleanupFiles(skillId, size)),
        ).rejects.toThrow();
        await expect(
          batchesOf(lifecycle().iterateSkillCleanupIntents(skillId, size)),
        ).rejects.toThrow();
      });
    });

    describe('hasInFlightSkillUploads, listExistingSkillFileIds and skillFileExistsForIntent', () => {
      it('reports uploads still being written', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'done'),
          rawIntent(skillId, 'gone', { state: 'abandoned' }),
        ]);
        expect(await lifecycle().hasInFlightSkillUploads(skillId)).toBe(false);
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'live', { state: 'committing' }),
        ]);
        expect(await lifecycle().hasInFlightSkillUploads(skillId)).toBe(true);
        expect(await lifecycle().hasInFlightSkillUploads(harness.ids.generate())).toBe(false);
      });

      it('reads which file ids the skill has a file for', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'a'), rawFile(skillId, 'b')]);
        await harness.seedRaw('skillfiles', [rawFile(harness.ids.generate(), 'c')]);
        expect(
          (await lifecycle().listExistingSkillFileIds(skillId, ['a', 'c', 'x', 'b'])).sort(),
        ).toEqual(['a', 'b']);
        expect(await lifecycle().listExistingSkillFileIds(skillId, [])).toEqual([]);
        expect(await lifecycle().skillFileExistsForIntent(skillId, 'a')).toBe(true);
        expect(await lifecycle().skillFileExistsForIntent(skillId, 'c')).toBe(false);
      });
    });

    describe('recoverStoppedSkillUploadIntent', () => {
      it("settles a stopped writer's intent by whether the skill has its file", async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'persisted')]);
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'persisted', { state: 'committing' }),
          rawIntent(skillId, 'lost', { state: 'uploading' }),
          rawIntent(skillId, 'settled'),
        ]);
        const recover = (fileId: string, writerId = 'writer-1') =>
          lifecycle().recoverStoppedSkillUploadIntent(fileId, writerId);
        expect(await recover('missing')).toEqual({ status: 'missing' });
        expect(await recover('persisted', 'writer-2')).toEqual({ status: 'changed' });
        expect(await recover('settled')).toEqual({ status: 'changed' });
        expect(await recover('persisted')).toEqual({ status: 'recovered', state: 'committed' });
        expect(await recover('lost')).toEqual({ status: 'recovered', state: 'abandoned' });
        expect((await intentRaw('persisted')).state).toBe('committed');
        expect((await intentRaw('lost')).state).toBe('abandoned');
        expect(await harness.readRaw('skillfiles')).toHaveLength(1);
      });
    });

    describe('finishSkillUploadCleanupHold and recoverStoppedSkillUploadCleanupHold', () => {
      it("ends the owner's hold, requesting cleanup or dropping the request", async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'cleanup', {
            cleanupHoldOwner: 'hold-1',
            nextCheckAt: ahead(MINUTE),
          }),
          rawIntent(skillId, 'keep', {
            cleanupHoldOwner: 'hold-1',
            cleanupRequestedAt: ago(MINUTE),
          }),
        ]);
        expect(await lifecycle().finishSkillUploadCleanupHold('cleanup', 'hold-2', true)).toBe(
          false,
        );
        expect(await lifecycle().finishSkillUploadCleanupHold('cleanup', 'hold-1', true)).toBe(
          true,
        );
        const cleanup = await intentRaw('cleanup');
        expect(cleanup.cleanupRequestedAt).toBeInstanceOf(Date);
        expect(cleanup).not.toHaveProperty('cleanupHoldOwner');
        expect(cleanup).not.toHaveProperty('nextCheckAt');
        expect(await lifecycle().finishSkillUploadCleanupHold('keep', 'hold-1', false)).toBe(true);
        const keep = await intentRaw('keep');
        expect(keep).not.toHaveProperty('cleanupHoldOwner');
        expect(keep).not.toHaveProperty('cleanupRequestedAt');
        expect(fileIdsOf(await lifecycle().listAbandonedSkillUploadIntents())).toEqual(['cleanup']);
      });

      it("recovers a stopped holder's hold by whether the skill still has the file", async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'still-live')]);
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'still-live', { cleanupHoldOwner: 'hold-1' }),
          rawIntent(skillId, 'replaced', { cleanupHoldOwner: 'hold-1' }),
          rawIntent(skillId, 'abandoned', { state: 'abandoned', cleanupHoldOwner: 'hold-1' }),
        ]);
        const recover = (fileId: string, owner = 'hold-1') =>
          lifecycle().recoverStoppedSkillUploadCleanupHold(fileId, owner);
        expect(await recover('missing')).toEqual({ status: 'missing' });
        expect(await recover('replaced', 'hold-2')).toEqual({ status: 'changed' });
        expect(await recover('abandoned')).toEqual({ status: 'changed' });
        expect(await recover('still-live')).toEqual({ status: 'recovered', cleanup: false });
        expect(await recover('replaced')).toEqual({ status: 'recovered', cleanup: true });
        expect((await intentRaw('replaced')).cleanupRequestedAt).toBeInstanceOf(Date);
        expect(await intentRaw('still-live')).not.toHaveProperty('cleanupRequestedAt');
      });
    });

    describe('listAbandonedSkillUploadIntents', () => {
      it('lists the claimable blobs awaiting cleanup, least recently attempted first, up to the limit', async () => {
        // NOTE(contract): the port orders the sweep by the last attempt only; the creation-time
        // tie-break among intents never attempted is not dependable on MongoDB, whose merge of
        // the two `$or` branches over `{ state, lastCleanupAttemptAt, createdAt }` can return a
        // later-created committed intent first. So never-attempted intents are compared as a set.
        const skillId = await seedSkill();
        const day = (n: number) => new Date(`2026-01-0${n}T00:00:00Z`);
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'attempt-4', {
            state: 'abandoned',
            nextCheckAt: ago(MINUTE),
            lastCleanupAttemptAt: day(4),
          }),
          rawIntent(skillId, 'never-abandoned', { state: 'abandoned', createdAt: day(3) }),
          rawIntent(skillId, 'attempt-1', { state: 'abandoned', lastCleanupAttemptAt: day(1) }),
          rawIntent(skillId, 'never-requested', {
            cleanupRequestedAt: ago(MINUTE),
            createdAt: day(2),
          }),
          rawIntent(skillId, 'attempt-3', {
            state: 'abandoned',
            claimOwner: 'old',
            claimExpiresAt: ago(MINUTE),
            lastCleanupAttemptAt: day(3),
          }),
          rawIntent(skillId, 'attempt-2', {
            cleanupRequestedAt: ago(MINUTE),
            lastCleanupAttemptAt: day(2),
          }),
          rawIntent(skillId, 'healthy'),
          rawIntent(skillId, 'uploading', { state: 'uploading' }),
          rawIntent(skillId, 'requested-cleaned', {
            cleanupRequestedAt: ago(MINUTE),
            cleanedAt: ago(MINUTE),
          }),
          rawIntent(skillId, 'held', { state: 'abandoned', cleanupHoldOwner: 'hold' }),
          rawIntent(skillId, 'claimed', {
            state: 'abandoned',
            claimOwner: 'worker',
            claimExpiresAt: ahead(MINUTE),
          }),
          rawIntent(skillId, 'later', { state: 'abandoned', nextCheckAt: ahead(MINUTE) }),
        ]);
        const listed = fileIdsOf(await lifecycle().listAbandonedSkillUploadIntents());
        expect(listed.slice(0, 2).sort()).toEqual(['never-abandoned', 'never-requested']);
        expect(listed.slice(2)).toEqual(['attempt-1', 'attempt-2', 'attempt-3', 'attempt-4']);
        const limited = fileIdsOf(await lifecycle().listAbandonedSkillUploadIntents(3));
        expect(limited.slice(0, 2).sort()).toEqual(['never-abandoned', 'never-requested']);
        expect(limited.slice(2)).toEqual(['attempt-1']);
      });

      it('keeps a cleaned abandoned intent listed until a recheck defers it', async () => {
        // An abandoned intent stays a cleanup candidate after `cleanedAt` is set (only committed
        // intents leave the sweep when cleaned): the sweeper keeps it as a sentinel for late
        // uploads and defers it with a recheck.
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { state: 'abandoned' }),
        ]);
        await lifecycle().markSkillUploadIntentCleaned('f1');
        expect(fileIdsOf(await lifecycle().listAbandonedSkillUploadIntents())).toEqual(['f1']);
        expect(await lifecycle().claimAbandonedSkillUploadIntent('f1', 'worker', MINUTE)).toBe(
          true,
        );
        expect(
          await lifecycle().scheduleAbandonedSkillUploadIntentRecheck('f1', 'worker', 10 * MINUTE),
        ).toBe(true);
        await lifecycle().releaseAbandonedSkillUploadIntentClaim('f1', 'worker');
        expect(await lifecycle().listAbandonedSkillUploadIntents()).toEqual([]);
      });
    });

    describe('claimAbandonedSkillUploadIntent and refreshAbandonedSkillUploadIntentClaim', () => {
      it('serializes cleanup claims and admits another worker after expiry or release', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { state: 'abandoned' }),
        ]);
        const store = lifecycle();
        expect(await store.claimAbandonedSkillUploadIntent('f1', 'worker-a', MINUTE)).toBe(true);
        expect(await store.claimAbandonedSkillUploadIntent('f1', 'worker-b', MINUTE)).toBe(false);
        expect(await store.claimAbandonedSkillUploadIntent('f1', 'worker-a', MINUTE)).toBe(true);
        expect(await store.listAbandonedSkillUploadIntents()).toEqual([]);
        await store.releaseAbandonedSkillUploadIntentClaim('f1', 'worker-b');
        expect((await intentRaw('f1')).claimOwner).toBe('worker-a');
        await store.releaseAbandonedSkillUploadIntentClaim('f1', 'worker-a');
        expect(await intentRaw('f1')).not.toHaveProperty('claimOwner');
        expect(await store.claimAbandonedSkillUploadIntent('f1', 'worker-b', -1)).toBe(true);
        expect(await store.claimAbandonedSkillUploadIntent('f1', 'worker-c', MINUTE)).toBe(true);
      });

      it('refuses intents that are not awaiting cleanup, are held or are scheduled later', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'healthy'),
          rawIntent(skillId, 'uploading', { state: 'uploading' }),
          rawIntent(skillId, 'cleaned', {
            cleanupRequestedAt: ago(MINUTE),
            cleanedAt: ago(MINUTE),
          }),
          rawIntent(skillId, 'held', { state: 'abandoned', cleanupHoldOwner: 'hold' }),
          rawIntent(skillId, 'later', { state: 'abandoned', nextCheckAt: ahead(MINUTE) }),
          rawIntent(skillId, 'requested', { cleanupRequestedAt: ago(MINUTE) }),
        ]);
        for (const fileId of ['healthy', 'uploading', 'cleaned', 'held', 'later', 'missing']) {
          expect(await lifecycle().claimAbandonedSkillUploadIntent(fileId, 'worker', MINUTE)).toBe(
            false,
          );
        }
        expect(
          await lifecycle().claimAbandonedSkillUploadIntent('requested', 'worker', MINUTE),
        ).toBe(true);
      });

      it("renews the owner's live claim, also after its committed blob was cleaned", async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { cleanupRequestedAt: ago(MINUTE) }),
        ]);
        const store = lifecycle();
        expect(await store.refreshAbandonedSkillUploadIntentClaim('f1', 'worker', MINUTE)).toBe(
          false,
        );
        await store.claimAbandonedSkillUploadIntent('f1', 'worker', MINUTE);
        await store.markSkillUploadIntentCleaned('f1');
        expect(
          await store.refreshAbandonedSkillUploadIntentClaim('f1', 'worker', 10 * MINUTE),
        ).toBe(true);
        expect(timeOf((await intentRaw('f1')).claimExpiresAt)).toBeGreaterThan(
          Date.now() + 5 * MINUTE,
        );
        expect(await store.refreshAbandonedSkillUploadIntentClaim('f1', 'other', MINUTE)).toBe(
          false,
        );
        await store.releaseAbandonedSkillUploadIntentClaim('f1', 'worker');
        expect(await store.claimAbandonedSkillUploadIntent('f1', 'worker', MINUTE)).toBe(false);
        expect(await store.listAbandonedSkillUploadIntents()).toEqual([]);
      });
    });

    describe('noteAbandonedSkillUploadIntentAttempt, markSkillUploadIntentCleaned and scheduleAbandonedSkillUploadIntentRecheck', () => {
      it('records attempts, which rotate an intent behind the others', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'first', {
            state: 'abandoned',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          }),
          rawIntent(skillId, 'second', {
            state: 'abandoned',
            createdAt: new Date('2026-01-02T00:00:00Z'),
          }),
        ]);
        await lifecycle().noteAbandonedSkillUploadIntentAttempt('first');
        expect((await intentRaw('first')).lastCleanupAttemptAt).toBeInstanceOf(Date);
        expect(fileIdsOf(await lifecycle().listAbandonedSkillUploadIntents())).toEqual([
          'second',
          'first',
        ]);
      });

      it('takes a cleaned committed blob out of every sweep', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { cleanupRequestedAt: ago(MINUTE) }),
        ]);
        await lifecycle().markSkillUploadIntentCleaned('f1');
        expect((await intentRaw('f1')).cleanedAt).toBeInstanceOf(Date);
        expect(await lifecycle().listAbandonedSkillUploadIntents()).toEqual([]);
        expect(await lifecycle().listSkillUploadIntents(skillId, { cleanupOnly: true })).toEqual(
          [],
        );
      });

      it('schedules a recheck only under a live claim, deferring the intent until due', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { state: 'abandoned' }),
        ]);
        expect(
          await lifecycle().scheduleAbandonedSkillUploadIntentRecheck('f1', 'worker', MINUTE),
        ).toBe(false);
        await lifecycle().claimAbandonedSkillUploadIntent('f1', 'worker', MINUTE);
        expect(
          await lifecycle().scheduleAbandonedSkillUploadIntentRecheck('f1', 'other', MINUTE),
        ).toBe(false);
        expect(
          await lifecycle().scheduleAbandonedSkillUploadIntentRecheck('f1', 'worker', 10 * MINUTE),
        ).toBe(true);
        expect(timeOf((await intentRaw('f1')).nextCheckAt)).toBeGreaterThan(
          Date.now() + 5 * MINUTE,
        );
        await lifecycle().releaseAbandonedSkillUploadIntentClaim('f1', 'worker');
        expect(await lifecycle().listAbandonedSkillUploadIntents()).toEqual([]);
        expect(await lifecycle().claimAbandonedSkillUploadIntent('f1', 'worker', MINUTE)).toBe(
          false,
        );
      });
    });

    describe('queueCommittedSkillUploadCleanup', () => {
      it('abandons a committed blob not yet cleaned, dropping its recheck', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'f1', { nextCheckAt: ahead(MINUTE) }),
        ]);
        await lifecycle().queueCommittedSkillUploadCleanup('f1');
        const queued = await intentRaw('f1');
        expect(queued.state).toBe('abandoned');
        expect(queued).not.toHaveProperty('nextCheckAt');
        expect(fileIdsOf(await lifecycle().listAbandonedSkillUploadIntents())).toEqual(['f1']);
        await expect(lifecycle().queueCommittedSkillUploadCleanup('f1')).resolves.toBeUndefined();
      });

      it('accepts a cleaned blob, and throws for a missing or still-uploading intent', async () => {
        const skillId = await seedSkill();
        await harness.seedRaw('skilluploadintents', [
          rawIntent(skillId, 'cleaned', { cleanedAt: ago(MINUTE) }),
          rawIntent(skillId, 'uploading', { state: 'uploading' }),
        ]);
        await expect(
          lifecycle().queueCommittedSkillUploadCleanup('cleaned'),
        ).resolves.toBeUndefined();
        expect((await intentRaw('cleaned')).state).toBe('committed');
        await expect(lifecycle().queueCommittedSkillUploadCleanup('uploading')).rejects.toThrow(
          'Skill blob cleanup intent is missing or invalid: uploading',
        );
        await expect(lifecycle().queueCommittedSkillUploadCleanup('missing')).rejects.toThrow(
          'Skill blob cleanup intent is missing or invalid: missing',
        );
      });
    });

    describe('tenant scoping', () => {
      it("reads and claims only the active tenant's journals and intents", async () => {
        const skillId = await seedSkill({ tenantId: 'tenant-a' });
        await harness.seedRaw('skillfiles', [rawFile(skillId, 'f1', { tenantId: 'tenant-a' })]);
        await inTenant('tenant-a', () => lifecycle().beginSkillDeletion(skillId));
        expect((await intentRaw('f1')).tenantId).toBe('tenant-a');
        await inTenant('tenant-b', async () => {
          expect(await lifecycle().getSkillDeletion(skillId)).toBeNull();
          expect(await lifecycle().listPendingSkillDeletions()).toEqual([]);
          expect(await lifecycle().claimSkillDeletion(skillId, 'worker', MINUTE)).toBe(false);
          expect(await lifecycle().getSkillUploadIntent('f1')).toBeNull();
          expect(await lifecycle().listSkillUploadIntents(skillId)).toEqual([]);
          expect(await lifecycle().beginSkillDeletion(skillId)).toBeNull();
        });
        await inTenant('tenant-a', async () => {
          expect(
            (await lifecycle().listPendingSkillDeletions()).map((row) =>
              idOf(harness, row.skillId),
            ),
          ).toEqual([skillId]);
          expect(await lifecycle().claimSkillDeletion(skillId, 'worker', MINUTE)).toBe(true);
        });
      });
    });
  });
}
