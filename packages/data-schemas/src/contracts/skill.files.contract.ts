/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SkillStore` contract (`~/ports/skill`) for skill files, deletion and the agent allowlists,
 * ported from `methods/skill.spec.ts` and `methods/skill.existingIds.spec.ts`: the file rows with
 * their version and file-count bumps, the conditional writes (`expectedFileId`, `createOnly`,
 * concurrent writers), the cleanup reference a replaced blob leaves behind (with its hold), the
 * cached content and code-environment references per route key; the deletion mark that frees the
 * name and journals the deletion, the finalization once the file rows are drained, which removes
 * the permissions and prunes the agents' `skills` allowlists (an allowlist made only of deleted
 * ids, by `skills_scope`, against one that keeps other ids); the account wipe of sole-owned
 * skills; and the existence check of candidate ids. Agents are seeded raw, as the agent store's
 * contract is not this one's. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { ResourceType, PrincipalType, PermissionBits } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { SkillStoreFileInput } from '~/ports/skill';
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

const OWNER_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

export function describeSkillFilesContract(harness: ContractHarness): void {
  describe(`SkillStore contract (files and deletion): ${harness.name}`, () => {
    useContractHarness(harness);

    const authorId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const skills = () => harness.createStores().skills;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const skillRaw = (id: string) =>
      harness.readRaw('skills').then((rows) => rows.find((row) => row._id === id));
    const filesOf = (skillId: string) => readRawWhere(harness, 'skillfiles', { skillId });
    const intentOf = (fileId: string) =>
      readRawWhere(harness, 'skilluploadintents', { fileId }).then((rows) => rows[0]);

    const createSkill = async (name = 'demo-skill', tenantId?: string) => {
      const { skill } = await skills().createSkill({
        name,
        description: 'A small demo skill used in tests.',
        body: '# Demo',
        author: authorId,
        authorName: 'Skill Author',
        tenantId,
      });
      return idOf(harness, skill._id);
    };
    const fileInput = (
      skillId: string,
      overrides: Partial<SkillStoreFileInput> = {},
    ): SkillStoreFileInput => ({
      skillId,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-1',
      filename: 'parse.sh',
      filepath: '/uploads/file-1',
      source: 'local',
      mimeType: 'text/x-shellscript',
      bytes: 42,
      author: authorId,
      ...overrides,
    });
    const versionOf = async (skillId: string) => {
      const stored = await skillRaw(skillId);
      return { version: stored?.version, fileCount: stored?.fileCount };
    };
    const grantOwner = (userId: string, skillId: string) =>
      harness
        .createStores()
        .aclEntries.grantPermission(
          PrincipalType.USER,
          harness.ids.toStoreId(userId),
          ResourceType.SKILL,
          skillId,
          OWNER_BITS,
        );
    const rawAgent = (skillIds: string[], overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      id: `agent_${harness.ids.generate()}`,
      name: 'Allowlist Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
      skills: skillIds,
      skills_enabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    });
    const agentRaw = (id: unknown) =>
      harness.readRaw('agents').then((rows) => rows.find((row) => row._id === id));

    describe('upsertSkillFile', () => {
      it('creates the file row, inferring its category, and bumps the version and file count', async () => {
        const skillId = await createSkill();
        const file = await skills().upsertSkillFile(
          fileInput(skillId, { sourceMetadata: { sha: 'abc' }, storageKey: 'k/1' }),
        );
        expect(file).toMatchObject({
          relativePath: 'scripts/parse.sh',
          file_id: 'file-1',
          filename: 'parse.sh',
          category: 'script',
          isExecutable: false,
          bytes: 42,
          storageKey: 'k/1',
          sourceMetadata: { sha: 'abc' },
        });
        expect(idOf(harness, file.skillId)).toBe(skillId);
        expect(idOf(harness, file.author)).toBe(authorId);
        expect(await versionOf(skillId)).toEqual({ version: 2, fileCount: 1 });
        for (const [relativePath, category] of [
          ['references/guide.md', 'reference'],
          ['assets/logo.png', 'asset'],
          ['notes.txt', 'other'],
        ]) {
          const row = await skills().upsertSkillFile(
            fileInput(skillId, { relativePath, file_id: relativePath }),
          );
          expect(row.category).toBe(category);
        }
        expect(await versionOf(skillId)).toEqual({ version: 5, fileCount: 4 });
      });

      it('replaces the file at the path in place, clearing its cache, without changing the file count', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().updateSkillFileContent(skillId, 'scripts/parse.sh', {
          content: 'echo hi',
          isBinary: false,
        });
        await skills().updateSkillFileCodeEnvIds([
          {
            skillId,
            relativePath: 'scripts/parse.sh',
            codeEnvRef: {
              kind: 'skill',
              id: skillId,
              storage_session_id: 's',
              file_id: 'f',
              version: 1,
            },
          },
        ]);
        const replaced = await skills().upsertSkillFile(
          fileInput(skillId, { bytes: 7, isExecutable: true }),
        );
        expect(replaced).toMatchObject({ bytes: 7, isExecutable: true });
        const [stored] = await filesOf(skillId);
        expect(stored).toMatchObject({ bytes: 7, isExecutable: true });
        for (const cleared of ['content', 'isBinary', 'codeEnvRef', 'codeEnvRefs']) {
          expect(stored).not.toHaveProperty(cleared);
        }
        expect(await versionOf(skillId)).toEqual({ version: 3, fileCount: 1 });
        expect(await harness.readRaw('skilluploadintents')).toEqual([]);
      });

      it('queues the replaced blob for cleanup, by its storage key or else its path', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().upsertSkillFile(
          fileInput(skillId, { file_id: 'file-2', filepath: '/u/2', storageKey: 'blobs/2' }),
        );
        await skills().upsertSkillFile(
          fileInput(skillId, { file_id: 'file-3', filepath: '/u/3', cleanupHoldOwner: 'writer-1' }),
        );
        expect(await intentOf('file-1')).toMatchObject({
          skillId,
          fileId: 'file-1',
          source: 'local',
          storageKey: '/uploads/file-1',
          author: authorId,
          writerId: 'legacy-replacement',
          state: 'committed',
        });
        expect((await intentOf('file-1')).cleanupRequestedAt).toBeInstanceOf(Date);
        expect(await intentOf('file-2')).toMatchObject({
          storageKey: 'blobs/2',
          state: 'committed',
          cleanupHoldOwner: 'writer-1',
        });
        expect((await filesOf(skillId)).map((row) => row.file_id)).toEqual(['file-3']);
        expect(await versionOf(skillId)).toEqual({ version: 4, fileCount: 1 });
      });

      it('keeps the previous storage key and region when a replacement gives none', async () => {
        // NOTE(contract): a replacement writes its fields with `$set`, and fields left undefined
        // (`storageKey`, `storageRegion`) are dropped from the update instead of cleared, so the
        // new file row keeps the replaced blob's storage key and region. A later replacement then
        // queues that old key for cleanup instead of the new file's path. Pinned as today's
        // behavior; callers that store blobs by key pass the key on every write.
        const skillId = await createSkill();
        await skills().upsertSkillFile(
          fileInput(skillId, { storageKey: 'blobs/original', storageRegion: 'eu' }),
        );
        await skills().upsertSkillFile(fileInput(skillId, { file_id: 'file-2', filepath: '/u/2' }));
        expect((await filesOf(skillId))[0]).toMatchObject({
          file_id: 'file-2',
          filepath: '/u/2',
          storageKey: 'blobs/original',
          storageRegion: 'eu',
        });
        await skills().upsertSkillFile(fileInput(skillId, { file_id: 'file-3', filepath: '/u/3' }));
        expect((await intentOf('file-2')).storageKey).toBe('blobs/original');
      });

      it('refuses to move a file id to another storage location', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        for (const moved of [{ filepath: '/elsewhere' }, { source: 's3' }, { storageKey: 'k' }]) {
          const error = await rejectionOf(skills().upsertSkillFile(fileInput(skillId, moved)));
          expect(error).toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
        }
        expect((await filesOf(skillId))[0].filepath).toBe('/uploads/file-1');
        expect(await versionOf(skillId)).toEqual({ version: 2, fileCount: 1 });
      });

      it('lets exactly one writer replace the expected revision, and never recreates a deleted one', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId, { file_id: 'original' }));
        const results = await Promise.allSettled(
          ['a', 'b'].map((file_id) =>
            skills().upsertSkillFile(fileInput(skillId, { expectedFileId: 'original', file_id })),
          ),
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
          reason: { code: 'SKILL_FILE_CONFLICT' },
        });
        const [current] = await filesOf(skillId);
        expect(['a', 'b']).toContain(current.file_id);
        expect(await versionOf(skillId)).toEqual({ version: 3, fileCount: 1 });

        await skills().deleteSkillFile(skillId, 'scripts/parse.sh');
        const error = await rejectionOf(
          skills().upsertSkillFile(
            fileInput(skillId, { expectedFileId: current.file_id as string, file_id: 'revived' }),
          ),
        );
        expect(error.code).toBe('SKILL_FILE_CONFLICT');
        expect(await filesOf(skillId)).toEqual([]);
      });

      it('creates only an absent path with createOnly, leaving the winner of a race intact', async () => {
        const skillId = await createSkill();
        const results = await Promise.allSettled(
          ['first', 'second'].map((file_id) =>
            skills().upsertSkillFile(fileInput(skillId, { createOnly: true, file_id })),
          ),
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
          reason: { code: 'SKILL_FILE_CONFLICT' },
        });
        expect(await filesOf(skillId)).toHaveLength(1);
        expect(await versionOf(skillId)).toEqual({ version: 2, fileCount: 1 });
        await expect(
          skills().upsertSkillFile(
            fileInput(skillId, { createOnly: true, expectedFileId: 'first' }),
          ),
        ).rejects.toThrow('A file cannot require both an absent path and an existing revision');
      });

      it('rejects a held replacement while the old blob is claimed for cleanup', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await harness.seedRaw('skilluploadintents', [
          {
            _id: harness.ids.generate(),
            skillId,
            fileId: 'file-1',
            source: 'local',
            storageKey: '/uploads/file-1',
            author: authorId,
            writerId: 'writer-0',
            state: 'committed',
            claimOwner: 'sweeper',
            claimExpiresAt: new Date(Date.now() + 60_000),
          },
        ]);
        const error = await rejectionOf(
          skills().upsertSkillFile(
            fileInput(skillId, { file_id: 'file-2', cleanupHoldOwner: 'writer-1' }),
          ),
        );
        expect(error.code).toBe('SKILL_FILE_CONFLICT');
        expect((await filesOf(skillId))[0].file_id).toBe('file-1');
        expect(await intentOf('file-1')).not.toHaveProperty('cleanupHoldOwner');
      });

      it.each([
        ['../escape.sh', 'TRAVERSAL'],
        ['/absolute.sh', 'ABSOLUTE_PATH'],
        ['SKILL.md', 'RESERVED'],
        ['bad path!.sh', 'INVALID_CHARS'],
        ['', 'REQUIRED'],
      ])('rejects the path %j with the validation issues', async (relativePath, code) => {
        const skillId = await createSkill();
        const error = await rejectionOf(
          skills().upsertSkillFile(fileInput(skillId, { relativePath })),
        );
        expect(error.code).toBe('SKILL_FILE_VALIDATION_FAILED');
        expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
        expect(await filesOf(skillId)).toEqual([]);
      });

      it('rejects writes to a skill being deleted or absent', async () => {
        const skillId = await createSkill();
        await skills().deleteSkill(skillId);
        for (const id of [skillId, harness.ids.generate()]) {
          const error = await rejectionOf(skills().upsertSkillFile(fileInput(id)));
          expect(error).toMatchObject({
            code: 'SKILL_DELETING',
            message: 'Skill is being deleted',
          });
        }
        expect(await harness.readRaw('skillfiles')).toEqual([]);
      });
    });

    describe('listSkillFiles and getSkillFileByPath', () => {
      it('lists the files by path without their cached content, and reads one with it', async () => {
        const skillId = await createSkill();
        const otherSkillId = await createSkill('other-skill');
        for (const relativePath of ['scripts/z.sh', 'assets/a.png', 'references/m.md']) {
          await skills().upsertSkillFile(
            fileInput(skillId, { relativePath, file_id: relativePath }),
          );
        }
        await skills().upsertSkillFile(fileInput(otherSkillId, { file_id: 'other' }));
        await skills().updateSkillFileContent(skillId, 'references/m.md', { content: '# M' });
        const listed = await skills().listSkillFiles(harness.ids.toStoreId(skillId));
        expect(listed.map((row) => row.relativePath)).toEqual([
          'assets/a.png',
          'references/m.md',
          'scripts/z.sh',
        ]);
        expect(listed.every((row) => !('content' in row))).toBe(true);
        const read = await skills().getSkillFileByPath(skillId, 'references/m.md');
        expect(read).toMatchObject({ file_id: 'references/m.md', content: '# M' });
        expect(await skills().getSkillFileByPath(skillId, 'missing.md')).toBeNull();
        expect(await skills().listSkillFiles(harness.ids.generate())).toEqual([]);
      });
    });

    describe('deleteSkillFile', () => {
      it('deletes the file and bumps the version, decrementing the file count', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().upsertSkillFile(fileInput(skillId, { relativePath: 'b.md', file_id: 'b' }));
        expect(await skills().deleteSkillFile(skillId, 'scripts/parse.sh')).toEqual({
          deleted: true,
        });
        expect((await filesOf(skillId)).map((row) => row.relativePath)).toEqual(['b.md']);
        expect(await versionOf(skillId)).toEqual({ version: 4, fileCount: 1 });
      });

      it('keeps a file replaced since it was read, and reports a missing one, without a bump', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId, { file_id: 'current' }));
        expect(await skills().deleteSkillFile(skillId, 'scripts/parse.sh', 'stale')).toEqual({
          deleted: false,
        });
        expect(await skills().deleteSkillFile(skillId, 'missing.sh')).toEqual({ deleted: false });
        expect(await filesOf(skillId)).toHaveLength(1);
        expect(await versionOf(skillId)).toEqual({ version: 2, fileCount: 1 });
        expect(await skills().deleteSkillFile(skillId, 'scripts/parse.sh', 'current')).toEqual({
          deleted: true,
        });
      });

      it('rejects a delete on a skill being deleted', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().deleteSkill(skillId);
        const error = await rejectionOf(skills().deleteSkillFile(skillId, 'scripts/parse.sh'));
        expect(error.code).toBe('SKILL_DELETING');
        expect(await filesOf(skillId)).toHaveLength(1);
      });
    });

    describe('deleteSkillFileAfterBlob', () => {
      it('deletes the file row by its file id without a version bump, once', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        expect(await skills().deleteSkillFileAfterBlob(skillId, 'other')).toBe(false);
        expect(await skills().deleteSkillFileAfterBlob(skillId, 'file-1')).toBe(true);
        expect(await skills().deleteSkillFileAfterBlob(skillId, 'file-1')).toBe(false);
        expect(await filesOf(skillId)).toEqual([]);
        expect(await versionOf(skillId)).toEqual({ version: 2, fileCount: 1 });
      });
    });

    describe('updateSkillFileContent', () => {
      it('caches the content or binary flag, only while the file is the expected one', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().updateSkillFileContent(skillId, 'scripts/parse.sh', { content: 'old' });
        await skills().updateSkillFileContent(
          skillId,
          'scripts/parse.sh',
          { content: 'stale' },
          'replaced-file',
        );
        expect((await filesOf(skillId))[0].content).toBe('old');
        await skills().updateSkillFileContent(
          skillId,
          'scripts/parse.sh',
          { isBinary: true },
          'file-1',
        );
        expect((await filesOf(skillId))[0]).toMatchObject({ content: 'old', isBinary: true });
        await skills().updateSkillFileContent(skillId, 'missing.sh', { content: 'x' });
        expect(await filesOf(skillId)).toHaveLength(1);
        expect(await versionOf(skillId)).toEqual({ version: 2, fileCount: 1 });
      });
    });

    describe('updateSkillFileCodeEnvIds', () => {
      it('records each reference singly and per route key, and reports the counts', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().upsertSkillFile(fileInput(skillId, { relativePath: 'b.md', file_id: 'b' }));
        const base = { kind: 'skill' as const, id: skillId, version: 1 };
        const result = await skills().updateSkillFileCodeEnvIds([
          {
            skillId,
            relativePath: 'scripts/parse.sh',
            codeEnvRef: { ...base, storage_session_id: 'default', file_id: 'f-default' },
          },
          {
            skillId: harness.ids.toStoreId(skillId),
            relativePath: 'scripts/parse.sh',
            codeEnvRef: {
              ...base,
              storage_session_id: 'stateful',
              file_id: 'f-stateful',
              executionProfile: 'stateful',
            },
          },
          {
            skillId,
            relativePath: 'b.md',
            codeEnvRef: {
              ...base,
              storage_session_id: 'deploy',
              file_id: 'f-deploy',
              executionProfile: 'stateful',
              executionRouteKey: 'stateful:abc123',
              provisionedAt: 1700000000000,
              sandboxFilename: 'b.md',
            },
          },
          {
            skillId,
            relativePath: 'missing.md',
            codeEnvRef: { ...base, storage_session_id: 'x', file_id: 'x' },
          },
        ]);
        expect(result).toEqual({ matchedCount: 3, modifiedCount: 3 });
        const [b, parse] = await skills().listSkillFiles(skillId);
        expect(parse.codeEnvRef).toMatchObject({
          file_id: 'f-stateful',
          executionProfile: 'stateful',
        });
        expect(parse.codeEnvRefs?.default).toMatchObject({ file_id: 'f-default' });
        expect(parse.codeEnvRefs?.stateful).toMatchObject({ file_id: 'f-stateful' });
        expect(b.codeEnvRefs?.['stateful:abc123']).toMatchObject({
          file_id: 'f-deploy',
          executionRouteKey: 'stateful:abc123',
          provisionedAt: 1700000000000,
          sandboxFilename: 'b.md',
        });
        expect(await versionOf(skillId)).toEqual({ version: 3, fileCount: 2 });
      });

      it('resolves zero counts for no updates and for files that do not match', async () => {
        expect(await skills().updateSkillFileCodeEnvIds([])).toEqual({
          matchedCount: 0,
          modifiedCount: 0,
        });
        expect(
          await skills().updateSkillFileCodeEnvIds([
            {
              skillId: harness.ids.generate(),
              relativePath: 'a.sh',
              codeEnvRef: {
                kind: 'skill',
                id: 'x',
                storage_session_id: 's',
                file_id: 'f',
                version: 1,
              },
            },
          ]),
        ).toEqual({ matchedCount: 0, modifiedCount: 0 });
      });
    });

    describe('deleteSkill', () => {
      it('marks the skill deleting, frees its name and journals the deletion', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        expect(await skills().deleteSkill(skillId)).toEqual({
          deleted: false,
          skillAbsent: false,
          cleanupComplete: false,
          failedCleanupSteps: ['skill_files'],
        });
        const stored = await skillRaw(skillId);
        expect(stored?.name).toBe(`__deleted__${skillId}`);
        expect(stored?.deletingAt).toBeInstanceOf(Date);
        expect(stored).not.toHaveProperty('deletionNeedsJournal');
        const [journal] = await harness.readRaw('skilldeletions');
        expect(journal).toMatchObject({ skillId, author: authorId });
        expect(timeOf(journal.startedAt)).toBe(timeOf(stored?.deletingAt));
        expect(await skills().getSkillById(skillId)).toBeNull();
        expect(await filesOf(skillId)).toHaveLength(1);
        expect(await intentOf('file-1')).toMatchObject({
          skillId,
          writerId: 'legacy-backfill',
          state: 'committed',
          storageKey: '/uploads/file-1',
        });
        await createSkill();
        expect(await harness.readRaw('skills')).toHaveLength(2);
      });

      it('is idempotent on retry, with one journal and the agent allowlists untouched', async () => {
        const skillId = await createSkill();
        const agent = rawAgent([skillId]);
        await harness.seedRaw('agents', [agent]);
        await skills().deleteSkill(skillId);
        expect(await skills().deleteSkill(skillId)).toMatchObject({
          cleanupComplete: false,
          failedCleanupSteps: ['skill_files'],
        });
        expect(await harness.readRaw('skilldeletions')).toHaveLength(1);
        expect(await harness.readRaw('skills')).toHaveLength(1);
        expect(await agentRaw(agent._id)).toMatchObject({
          skills: [skillId],
          skills_enabled: true,
        });
      });

      it('reports an unknown skill as absent and a malformed id as nothing done', async () => {
        expect(await skills().deleteSkill(harness.ids.generate())).toEqual({
          deleted: false,
          skillAbsent: true,
          cleanupComplete: true,
          failedCleanupSteps: [],
        });
        expect(await skills().deleteSkill('not-an-id')).toEqual({
          deleted: false,
          skillAbsent: false,
          cleanupComplete: false,
          failedCleanupSteps: [],
        });
        expect(await harness.readRaw('skilldeletions')).toEqual([]);
      });

      it('accepts an upper-case id', async () => {
        // NOTE(contract): the reserved name keeps the id as given, so an upper-case id renames
        // the skill to `__deleted__<UPPER-CASE ID>`. Pinned as today's behavior; the name is only
        // a placeholder that frees the public one.
        const skillId = await createSkill();
        await skills().deleteSkill(skillId.toUpperCase());
        expect((await skillRaw(skillId))?.name).toBe(`__deleted__${skillId.toUpperCase()}`);
        expect(await harness.readRaw('skilldeletions')).toHaveLength(1);
      });
    });

    describe('finalizeSkillDeletion', () => {
      it('refuses a skill whose deletion has not begun, or whose file rows remain', async () => {
        const skillId = await createSkill();
        await skills().upsertSkillFile(fileInput(skillId));
        const refused = {
          deleted: false,
          skillAbsent: false,
          cleanupComplete: false,
          failedCleanupSteps: ['skill_files'],
        };
        expect(await skills().finalizeSkillDeletion(skillId)).toEqual(refused);
        await skills().deleteSkill(skillId);
        expect(await skills().finalizeSkillDeletion(skillId)).toEqual(refused);
        expect(await harness.readRaw('skills')).toHaveLength(1);
      });

      it('removes the skill and its permissions once its files are drained', async () => {
        const skillId = await createSkill();
        const keptSkillId = await createSkill('kept-skill');
        await grantOwner(authorId, skillId);
        await grantOwner(authorId, keptSkillId);
        await skills().upsertSkillFile(fileInput(skillId));
        await skills().deleteSkill(skillId);
        expect(await skills().deleteSkillFileAfterBlob(skillId, 'file-1')).toBe(true);
        expect(await skills().finalizeSkillDeletion(skillId)).toEqual({
          deleted: true,
          skillAbsent: true,
          cleanupComplete: true,
          failedCleanupSteps: [],
        });
        expect((await harness.readRaw('skills')).map((row) => row._id)).toEqual([keptSkillId]);
        expect(await readRawWhere(harness, 'aclentries', { resourceId: skillId })).toEqual([]);
        expect(await readRawWhere(harness, 'aclentries', { resourceId: keptSkillId })).toHaveLength(
          1,
        );
        expect(await harness.readRaw('skilldeletions')).toHaveLength(1);
        expect(await skills().finalizeSkillDeletion(skillId)).toEqual({
          deleted: false,
          skillAbsent: true,
          cleanupComplete: true,
          failedCleanupSteps: [],
        });
      });

      it("prunes the deleted id from agents' allowlists, keeping their other ids and update times", async () => {
        const doomed = await createSkill('doomed-skill');
        const kept = await createSkill('kept-skill');
        const mixed = rawAgent([doomed, kept]);
        const untouched = rawAgent([kept]);
        const unrelated = rawAgent([], { skills_enabled: false });
        await harness.seedRaw('agents', [mixed, untouched, unrelated]);
        await skills().deleteSkill(doomed);
        await skills().finalizeSkillDeletion(doomed);
        expect(await agentRaw(mixed._id)).toMatchObject({ skills: [kept], skills_enabled: true });
        expect(await agentRaw(untouched._id)).toMatchObject({
          skills: [kept],
          skills_enabled: true,
        });
        expect(await agentRaw(unrelated._id)).toMatchObject({ skills: [], skills_enabled: false });
        expect(timeOf((await agentRaw(mixed._id))?.updatedAt)).toBe(timeOf(mixed.updatedAt));
      });

      it.each([
        ['no scope (legacy)', {}, false],
        ['scope none', { skills_scope: 'none' }, false],
        ['scope all', { skills_scope: 'all' }, true],
        ['scope selected', { skills_scope: 'selected' }, true],
      ])(
        'empties an allowlist made only of the deleted id, with %s, keeping skills enabled: %s',
        async (_label, scope, enabled) => {
          const doomed = await createSkill('only-skill');
          const agent = rawAgent([doomed, doomed], scope);
          await harness.seedRaw('agents', [agent]);
          await skills().deleteSkill(doomed);
          expect((await skills().finalizeSkillDeletion(doomed)).cleanupComplete).toBe(true);
          const after = await agentRaw(agent._id);
          expect(after).toMatchObject({ skills: [], skills_enabled: enabled, ...scope });
          expect(timeOf(after?.updatedAt)).toBe(timeOf(agent.updatedAt));
        },
      );

      it('matches upper-case ids in a deletion against the lower-case allowlist entries', async () => {
        const doomed = await createSkill('only-skill');
        const agent = rawAgent([doomed]);
        await harness.seedRaw('agents', [agent]);
        await skills().deleteSkill(doomed.toUpperCase());
        expect((await skills().finalizeSkillDeletion(doomed)).cleanupComplete).toBe(true);
        expect(await agentRaw(agent._id)).toMatchObject({ skills: [], skills_enabled: false });
      });
    });

    describe('deleteUserSkills', () => {
      it('marks only the skills the user owns alone, freeing their names, and counts them', async () => {
        const soleOwned = await createSkill('sole-owned');
        const shared = await createSkill('shared');
        const foreign = await createSkill('foreign');
        await grantOwner(authorId, soleOwned);
        await grantOwner(authorId, shared);
        await grantOwner(otherUserId, shared);
        await grantOwner(otherUserId, foreign);
        const agent = rawAgent([soleOwned]);
        await harness.seedRaw('agents', [agent]);

        expect(await skills().deleteUserSkills(authorId)).toBe(1);

        const marked = await skillRaw(soleOwned);
        expect(marked).toMatchObject({
          name: `__deleted__${soleOwned}`,
          deletionNeedsJournal: true,
        });
        expect(marked?.deletingAt).toBeInstanceOf(Date);
        expect(await skillRaw(shared)).not.toHaveProperty('deletingAt');
        expect(await skillRaw(foreign)).not.toHaveProperty('deletingAt');
        expect(await harness.readRaw('skilldeletions')).toEqual([]);
        expect(await agentRaw(agent._id)).toMatchObject({ skills: [soleOwned] });
        expect(await skills().deleteUserSkills(harness.ids.toStoreId(authorId))).toBe(0);
        await createSkill('sole-owned');
      });

      it('resolves zero when the user owns nothing', async () => {
        await createSkill();
        expect(await skills().deleteUserSkills(otherUserId)).toBe(0);
        expect((await harness.readRaw('skills'))[0]).not.toHaveProperty('deletingAt');
      });
    });

    describe('findExistingSkillIds', () => {
      it('keeps the stored, undeleted and external ids, lower-cased, each once, in order', async () => {
        const stored = await createSkill('stored');
        const deleting = await createSkill('deleting');
        await skills().deleteSkill(deleting);
        const external = harness.ids.generate();
        const unknown = harness.ids.generate();
        const result = await skills().findExistingSkillIds(
          [unknown, external, stored.toUpperCase(), 'not-an-id', stored, deleting],
          (id) => id === external,
        );
        expect(result).toEqual([external, stored]);
        expect(await skills().findExistingSkillIds([])).toEqual([]);
        expect(await skills().findExistingSkillIds([unknown, 'bad'])).toEqual([]);
      });
    });

    describe('tenant scoping', () => {
      it("writes and reads only the active tenant's files", async () => {
        const inA = await inTenant('tenant-a', () => createSkill('in-a', 'tenant-a'));
        await inTenant('tenant-a', () =>
          skills().upsertSkillFile(fileInput(inA, { tenantId: 'tenant-a' })),
        );
        expect((await filesOf(inA))[0].tenantId).toBe('tenant-a');
        await inTenant('tenant-b', async () => {
          expect(await skills().listSkillFiles(inA)).toEqual([]);
          expect(await skills().getSkillFileByPath(inA, 'scripts/parse.sh')).toBeNull();
          const error = await rejectionOf(
            skills().upsertSkillFile(fileInput(inA, { file_id: 'x' })),
          );
          expect(error.code).toBe('SKILL_DELETING');
          expect(await skills().findExistingSkillIds([inA])).toEqual([]);
        });
        await inTenant('tenant-a', async () => {
          expect(await skills().findExistingSkillIds([inA])).toEqual([inA]);
        });
      });
    });
  });
}
