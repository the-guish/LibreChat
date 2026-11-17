import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { DataStore } from '~/ports';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL prompt and skill stores (docs/postgres-port/PHASE4.md §3.5):
 * parallel calls on separate pool clients take a lease or a lock once, let one writer win a
 * compare-and-set (a skill version, a file revision, an absent path), lose no counter update
 * (prompt use counts, skill versions and file counts bumped by file writes), and let the unique
 * indexes decide racing creates (a skill name, an upload intent). Each case runs with the shadow
 * check off (the production path: one statement per guarded write, rechecked on the locked row)
 * and on (the lock-then-write path the contract suites take).
 */
const PARALLEL = 8;
const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

describePostgres('PostgreSQL prompt and skill stores under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    let stores: DataStore;

    beforeAll(async () => {
      await harness.setup();
      stores = harness.createStores();
    }, 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const authorId = () => harness.ids.generate();
    const skillRaw = async (id: string) =>
      (await harness.readRaw('skills')).find((row) => row._id === id);
    const createSkill = async (name = 'contended-skill') => {
      const { skill } = await stores.skills.createSkill({
        name,
        description: 'A skill several writers contend for.',
        body: '# Body',
        author: authorId(),
        authorName: 'Author',
      });
      return String(skill._id);
    };
    const fileInput = (skillId: string, overrides: Record<string, unknown> = {}) => ({
      skillId,
      relativePath: 'scripts/run.sh',
      file_id: 'file-0',
      filename: 'run.sh',
      filepath: '/uploads/file-0',
      source: 'local',
      mimeType: 'text/x-shellscript',
      bytes: 1,
      author: harness.ids.generate(),
      ...overrides,
    });
    const rawJournal = (skillId: string, overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      skillId,
      author: harness.ids.generate(),
      startedAt: ago(MINUTE),
      ...overrides,
    });
    const rawIntent = (fileId: string, overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      skillId: harness.ids.generate(),
      fileId,
      source: 'local',
      storageKey: `/uploads/${fileId}`,
      author: harness.ids.generate(),
      writerId: 'writer',
      state: 'abandoned',
      ...overrides,
    });

    it('takes a free sync lock, and an expired one, exactly once', async () => {
      const claim = (lockOwner: string, tenantId?: string) =>
        stores.skillSync.tryAcquireSkillSyncLock({
          provider: 'github',
          lockOwner,
          leaseMs: MINUTE,
          tenantId,
        });
      const fresh = await Promise.all(range(PARALLEL).map((index) => claim(`worker-${index}`)));
      expect(fresh.filter(Boolean)).toHaveLength(1);
      await harness.reset();
      await harness.seedRaw('skillsyncstatuses', [
        {
          _id: harness.ids.generate(),
          provider: 'github',
          sourceId: '__global_lock__',
          status: 'running',
          lockOwner: 'gone',
          lockExpiresAt: ago(MINUTE),
        },
      ]);
      const takeover = await Promise.all(range(PARALLEL).map((index) => claim(`worker-${index}`)));
      expect(takeover.filter(Boolean)).toHaveLength(1);
      const rows = await harness.readRaw('skillsyncstatuses');
      expect(rows).toHaveLength(1);
      expect(rows[0].lockOwner).not.toBe('gone');
      const perTenant = await Promise.all(
        range(PARALLEL).map((index) => claim(`worker-${index}`, `tenant-${index % 2}`)),
      );
      expect(perTenant.filter(Boolean)).toHaveLength(2);
    });

    it('lets one worker claim a deletion journal and one an upload cleanup', async () => {
      const skillId = harness.ids.generate();
      await harness.seedRaw('skilldeletions', [
        rawJournal(skillId, { claimOwner: 'gone', claimExpiresAt: ago(MINUTE) }),
      ]);
      await harness.seedRaw('skilluploadintents', [rawIntent('swept')]);
      const deletionClaims = await Promise.all(
        range(PARALLEL).map((index) =>
          stores.skillLifecycle.claimSkillDeletion(skillId, `worker-${index}`, MINUTE),
        ),
      );
      expect(deletionClaims.filter(Boolean)).toHaveLength(1);
      const cleanupClaims = await Promise.all(
        range(PARALLEL).map((index) =>
          stores.skillLifecycle.claimAbandonedSkillUploadIntent('swept', `worker-${index}`, MINUTE),
        ),
      );
      expect(cleanupClaims.filter(Boolean)).toHaveLength(1);
      const [journal] = await harness.readRaw('skilldeletions');
      const [intent] = await harness.readRaw('skilluploadintents');
      expect(journal.claimOwner).toBe(`worker-${deletionClaims.indexOf(true)}`);
      expect(intent.claimOwner).toBe(`worker-${cleanupClaims.indexOf(true)}`);
      expect((journal.claimExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses every claim on a live lease and every renewal by another owner', async () => {
      const skillId = harness.ids.generate();
      await harness.seedRaw('skilldeletions', [
        rawJournal(skillId, { claimOwner: 'holder', claimExpiresAt: ahead(MINUTE) }),
      ]);
      const results = await Promise.all([
        ...range(PARALLEL).map((index) =>
          stores.skillLifecycle.claimSkillDeletion(skillId, `worker-${index}`, MINUTE),
        ),
        stores.skillLifecycle.refreshSkillDeletionClaim(skillId, 'holder', 10 * MINUTE),
      ]);
      expect(results.slice(0, PARALLEL).filter(Boolean)).toHaveLength(0);
      expect(results[PARALLEL]).toBe(true);
      expect((await harness.readRaw('skilldeletions'))[0].claimOwner).toBe('holder');
    });

    it('lets one of the writers at a skill version win', async () => {
      const id = await createSkill();
      const results = await Promise.all(
        range(PARALLEL).map((index) =>
          stores.skills.updateSkill({
            id,
            expectedVersion: 1,
            update: { category: `category-${index}` },
          }),
        ),
      );
      const statuses = results.map((result) => result.status);
      expect(statuses.filter((status) => status === 'updated')).toHaveLength(1);
      expect(statuses.filter((status) => status === 'conflict')).toHaveLength(PARALLEL - 1);
      const stored = await skillRaw(id);
      expect(stored?.version).toBe(2);
      expect(stored?.category).toBe(`category-${statuses.indexOf('updated')}`);
    });

    it('lets one writer replace the expected file revision, and one create an absent path', async () => {
      const id = await createSkill();
      await stores.skills.upsertSkillFile(fileInput(id, { file_id: 'original' }));
      const replacements = await Promise.allSettled(
        range(PARALLEL).map((index) =>
          stores.skills.upsertSkillFile(
            fileInput(id, { file_id: `replacement-${index}`, expectedFileId: 'original' }),
          ),
        ),
      );
      expect(replacements.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of replacements) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
        }
      }
      const creates = await Promise.allSettled(
        range(PARALLEL).map((index) =>
          stores.skills.upsertSkillFile(
            fileInput(id, {
              relativePath: 'assets/new.png',
              file_id: `create-${index}`,
              createOnly: true,
            }),
          ),
        ),
      );
      expect(creates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const files = await harness.readRaw('skillfiles');
      expect(files).toHaveLength(2);
      /** Created (1), the first file (2), one replacement (3), one create (4). */
      expect(await skillRaw(id)).toMatchObject({ version: 4, fileCount: 2 });
    });

    it('loses no version or file count bump of parallel file writes', async () => {
      const id = await createSkill();
      await Promise.all(
        range(PARALLEL).map((index) =>
          stores.skills.upsertSkillFile(
            fileInput(id, { relativePath: `references/${index}.md`, file_id: `file-${index}` }),
          ),
        ),
      );
      expect(await skillRaw(id)).toMatchObject({ version: 1 + PARALLEL, fileCount: PARALLEL });
      await Promise.all(
        range(PARALLEL / 2).map((index) =>
          stores.skills.deleteSkillFile(id, `references/${index}.md`),
        ),
      );
      expect(await skillRaw(id)).toMatchObject({
        version: 1 + PARALLEL + PARALLEL / 2,
        fileCount: PARALLEL / 2,
      });
    });

    it('loses no prompt group use count increment', async () => {
      const { group } = await stores.prompts.createPromptGroup({
        prompt: { prompt: 'counted', type: 'text' },
        group: { name: 'Counted' },
        author: harness.ids.generate(),
        authorName: 'Author',
      });
      const groupId = String(group._id);
      const results = await Promise.all(
        range(3 * PARALLEL).map(() => stores.prompts.incrementPromptGroupUsage(groupId)),
      );
      expect(results.map((result) => result.numberOfGenerations).sort((a, b) => a - b)).toEqual(
        range(3 * PARALLEL).map((index) => index + 1),
      );
      const [stored] = await harness.readRaw('promptgroups');
      expect(stored.numberOfGenerations).toBe(3 * PARALLEL);
    });

    it('lets the unique indexes decide racing skill creates and upload reservations', async () => {
      const author = harness.ids.generate();
      const creates = await Promise.allSettled(
        range(PARALLEL).map(() =>
          stores.skills.createSkill({
            name: 'racing-name',
            description: 'A skill several writers create at once.',
            author,
            authorName: 'Author',
          }),
        ),
      );
      expect(creates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of creates) {
        if (result.status === 'rejected') {
          expect(harness.errors.isDuplicateKey(result.reason)).toBe(true);
          expect((result.reason as Error).message).toBe(
            'A skill with name "racing-name" already exists for this author',
          );
        }
      }
      const skillId = String(
        (
          creates.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{
            skill: { _id: unknown };
          }>
        ).value.skill._id,
      );
      const reservations = await Promise.allSettled(
        range(PARALLEL).map((index) =>
          stores.skillLifecycle.reserveSkillUploadIntent({
            skillId,
            author,
            fileId: 'contended-upload',
            source: 'local',
            storageKey: 'blobs/contended-upload',
            writerId: `writer-${index}`,
          }),
        ),
      );
      expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const intents = await harness.readRaw('skilluploadintents');
      expect(intents).toHaveLength(1);
      expect(intents[0].state).toBe('uploading');
    });
  });
});
