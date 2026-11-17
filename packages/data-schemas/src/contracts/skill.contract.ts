/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SkillStore` contract (`~/ports/skill`) for the skill records, ported from
 * `methods/skill.spec.ts`: creates (validation errors and warnings, the canonical frontmatter
 * keys, the derived structured columns, the always-apply cascade over the explicit flag, the
 * frontmatter and the SKILL.md body, the duplicate name per author and tenant through
 * `harness.errors`), the reads that prime skills into a turn (the newest match by name with the
 * invocation preferences, the legacy backfill from frontmatter, the author lookup per tenant),
 * the keyset listings over update time and id with their filters and projections, the sync
 * source lookups, the versioned update with its compare-and-set and conflicts, and tenant
 * scoping. Files, deletion and the agent allowlists are `skill.files.contract.ts`. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import { SKILL_BODY_MAX_LENGTH } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { SkillStoreCreateInput } from '~/ports/skill';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, timeOf, useContractHarness } from './support';

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

export function describeSkillContract(harness: ContractHarness): void {
  describe(`SkillStore contract (skills): ${harness.name}`, () => {
    useContractHarness(harness);

    const authorId = harness.ids.generate();
    const otherAuthorId = harness.ids.generate();
    const skills = () => harness.createStores().skills;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const ids = (rows: ReadonlyArray<{ _id?: unknown }>) =>
      rows.map((row) => idOf(harness, row._id));
    const skillRaw = (id: string) =>
      harness.readRaw('skills').then((rows) => rows.find((row) => row._id === id));

    const input = (overrides: Partial<SkillStoreCreateInput> = {}): SkillStoreCreateInput => ({
      name: 'demo-skill',
      description: 'A small demo skill used in tests.',
      body: '# Demo\n\nBody content',
      frontmatter: { name: 'demo-skill', description: 'A small demo skill used in tests.' },
      author: authorId,
      authorName: 'Skill Author',
      ...overrides,
    });
    const create = async (overrides: Partial<SkillStoreCreateInput> = {}) => {
      const { skill } = await skills().createSkill(input(overrides));
      return idOf(harness, skill._id);
    };
    /** A raw skill record (no defaults, validators or derived columns). */
    const rawSkill = (overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      name: 'raw-skill',
      description: 'A raw skill seeded for the contract.',
      body: 'raw body',
      frontmatter: {},
      category: '',
      author: authorId,
      authorName: 'Skill Author',
      version: 1,
      source: 'inline',
      fileCount: 0,
      alwaysApply: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    });

    describe('createSkill', () => {
      it('creates the skill at version 1 with its defaults and no warnings', async () => {
        const { skill, warnings } = await skills().createSkill(input());
        expect(warnings).toEqual([]);
        expect(skill).toMatchObject({
          name: 'demo-skill',
          description: 'A small demo skill used in tests.',
          body: '# Demo\n\nBody content',
          category: '',
          authorName: 'Skill Author',
          version: 1,
          source: 'inline',
          fileCount: 0,
          alwaysApply: false,
          disableModelInvocation: false,
          userInvocable: true,
        });
        expect(skill.allowedTools).toBeUndefined();
        expect(idOf(harness, skill.author)).toBe(authorId);
        expect(skill.createdAt).toBeInstanceOf(Date);
        const stored = await skillRaw(idOf(harness, skill._id));
        expect(stored).toMatchObject({ name: 'demo-skill', author: authorId, version: 1 });
        expect(stored).not.toHaveProperty('deletingAt');
      });

      it('accepts the author as a store id and keeps the given tenant, source and metadata', async () => {
        const { skill } = await skills().createSkill(
          input({
            author: harness.ids.toStoreId(authorId),
            tenantId: 'tenant-a',
            source: 'github',
            sourceMetadata: { sourceId: 'repo-1', upstreamId: 'skills/demo' },
            displayTitle: 'Demo Skill',
            category: 'tools',
          }),
        );
        expect(await skillRaw(idOf(harness, skill._id))).toMatchObject({
          author: authorId,
          tenantId: 'tenant-a',
          source: 'github',
          sourceMetadata: { sourceId: 'repo-1', upstreamId: 'skills/demo' },
          displayTitle: 'Demo Skill',
          category: 'tools',
        });
      });

      it('stores an empty body and frontmatter when none are given', async () => {
        const id = await create({ body: undefined, frontmatter: undefined });
        const stored = await skillRaw(id);
        expect(stored?.body).toBe('');
        /** An empty frontmatter object may be stored as such or left out (mongoose minimizes it). */
        expect(stored?.frontmatter ?? {}).toEqual({});
      });

      it('creates with warnings for a short description and an unknown frontmatter key', async () => {
        const { skill, warnings } = await skills().createSkill(
          input({ description: 'Too short.', frontmatter: { 'x-custom': { level: 1 } } }),
        );
        expect(warnings.map((warning) => warning.code).sort()).toEqual([
          'TOO_SHORT',
          'UNKNOWN_KEY',
        ]);
        expect(warnings.every((warning) => warning.severity === 'warning')).toBe(true);
        expect((await skillRaw(idOf(harness, skill._id)))?.frontmatter).toEqual({
          'x-custom': { level: 1 },
        });
      });

      it('stores recognized frontmatter keys canonically and derives the structured columns', async () => {
        const { skill } = await skills().createSkill(
          input({
            frontmatter: {
              'User-Invocable': false,
              'DISABLE-MODEL-INVOCATION': true,
              'Allowed-Tools': 'web_search',
              references: ['a.md', { path: 'b.md' }],
            },
          }),
        );
        const stored = await skillRaw(idOf(harness, skill._id));
        expect(stored?.frontmatter).toEqual({
          'user-invocable': false,
          'disable-model-invocation': true,
          'allowed-tools': 'web_search',
          references: ['a.md', { path: 'b.md' }],
        });
        expect(stored).toMatchObject({
          userInvocable: false,
          disableModelInvocation: true,
          allowedTools: ['web_search'],
        });
      });

      it('drops empty and non-string allowed tools from an array', async () => {
        const id = await create({ frontmatter: { 'allowed-tools': ['read_file', '', 'shell'] } });
        expect((await skillRaw(id))?.allowedTools).toEqual(['read_file', 'shell']);
      });

      it.each([
        ['a reserved brand prefix', { name: 'anthropic-helper' }, 'name', 'RESERVED_PREFIX'],
        ['a reserved CLI word', { name: 'help' }, 'name', 'RESERVED_WORD'],
        ['a name that is not kebab-case', { name: 'Not_Kebab' }, 'name', 'INVALID_FORMAT'],
        ['a name over 64 characters', { name: 'a'.repeat(65) }, 'name', 'TOO_LONG'],
        ['a missing description', { description: '   ' }, 'description', 'REQUIRED'],
        ['an author that is not an id', { author: 'not-an-id' }, 'author', 'INVALID_FORMAT'],
        ['a non-boolean alwaysApply', { alwaysApply: 'true' }, 'alwaysApply', 'INVALID_TYPE'],
        ['an oversized body', { body: 'x'.repeat(SKILL_BODY_MAX_LENGTH + 1) }, 'body', 'TOO_LONG'],
        [
          'case-colliding frontmatter keys',
          { frontmatter: { 'user-invocable': true, 'User-Invocable': false } },
          'frontmatter',
          'DUPLICATE_KEY',
        ],
        [
          'a frontmatter value of the wrong type',
          { frontmatter: { 'user-invocable': 'yes' } },
          'frontmatter.user-invocable',
          'INVALID_TYPE',
        ],
      ])('rejects %s with the validation issues', async (_label, overrides, field, code) => {
        const error = await rejectionOf(
          skills().createSkill(input(overrides as Partial<SkillStoreCreateInput>)),
        );
        expect(error.message).toBe('Skill validation failed');
        expect(error.code).toBe('SKILL_VALIDATION_FAILED');
        expect(error.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ field, code })]),
        );
        expect(await harness.readRaw('skills')).toEqual([]);
      });

      it('accepts names that merely contain reserved words', async () => {
        await create({ name: 'research-anthropic-helper' });
        await create({ name: 'help-desk' });
        expect((await harness.readRaw('skills')).map((row) => row.name).sort()).toEqual([
          'help-desk',
          'research-anthropic-helper',
        ]);
      });

      it('rejects a name the author already uses in the tenant with a duplicate-key error', async () => {
        await create();
        for (const author of [authorId, harness.ids.toStoreId(authorId)]) {
          const error = await rejectionOf(skills().createSkill(input({ author })));
          expect(harness.errors.isDuplicateKey(error)).toBe(true);
          expect(error.message).toContain('already exists');
        }
        expect(await harness.readRaw('skills')).toHaveLength(1);
      });

      it('allows the same name for another author or another tenant', async () => {
        await create();
        await create({ author: otherAuthorId });
        await inTenant('tenant-a', () => create({ tenantId: 'tenant-a' }));
        await inTenant('tenant-b', () => create({ tenantId: 'tenant-b' }));
        const error = await inTenant('tenant-a', () =>
          rejectionOf(skills().createSkill(input({ tenantId: 'tenant-a' }))),
        );
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
        expect(await harness.readRaw('skills')).toHaveLength(4);
      });

      it.each([
        ['an explicit flag', { alwaysApply: true, frontmatter: { 'always-apply': false } }, true],
        ['the frontmatter flag', { frontmatter: { 'always-apply': true } }, true],
        ['the camel-case frontmatter alias', { frontmatter: { alwaysApply: true } }, true],
        [
          'the canonical frontmatter spelling over the alias',
          { frontmatter: { 'always-apply': false, alwaysApply: true } },
          false,
        ],
        [
          'the SKILL.md body frontmatter',
          { frontmatter: undefined, body: '---\nalways-apply: "TRUE" # inline\n---\n# Body' },
          true,
        ],
        ['nothing (false)', {}, false],
      ])('derives alwaysApply from %s', async (_label, overrides, expected) => {
        const id = await create(overrides as Partial<SkillStoreCreateInput>);
        expect((await skillRaw(id))?.alwaysApply).toBe(expected);
      });

      it('rejects an always-apply typo in the body unless a higher source overrides it', async () => {
        const body = '---\nalways-apply: tru\n---\n# Body';
        const error = await rejectionOf(
          skills().createSkill(input({ body, frontmatter: undefined })),
        );
        expect(error.issues).toEqual([
          expect.objectContaining({ field: 'body.frontmatter.alwaysApply', code: 'INVALID_TYPE' }),
        ]);
        const id = await create({ body, frontmatter: undefined, alwaysApply: false });
        expect((await skillRaw(id))?.alwaysApply).toBe(false);
      });
    });

    describe('getSkillById', () => {
      it('reads the skill by string or store id', async () => {
        const id = await create();
        expect(idOf(harness, (await skills().getSkillById(id))?._id)).toBe(id);
        expect((await skills().getSkillById(harness.ids.toStoreId(id)))?.name).toBe('demo-skill');
      });

      it('reads null for a malformed, unknown or deleting skill', async () => {
        const deleting = rawSkill({ deletingAt: new Date() });
        await harness.seedRaw('skills', [deleting]);
        expect(await skills().getSkillById('not-an-id')).toBeNull();
        expect(await skills().getSkillById(harness.ids.generate())).toBeNull();
        expect(await skills().getSkillById(deleting._id as string)).toBeNull();
      });
    });

    describe('getSkillByName', () => {
      it('reads the most recently updated accessible match that is not being deleted', async () => {
        const older = rawSkill({ name: 'shared', updatedAt: new Date('2026-01-01T00:00:00Z') });
        const newer = rawSkill({
          name: 'shared',
          author: otherAuthorId,
          updatedAt: new Date('2026-02-01T00:00:00Z'),
        });
        const hidden = rawSkill({
          name: 'shared',
          author: harness.ids.generate(),
          updatedAt: new Date('2026-03-01T00:00:00Z'),
        });
        const deleting = rawSkill({
          name: 'shared',
          author: harness.ids.generate(),
          updatedAt: new Date('2026-04-01T00:00:00Z'),
          deletingAt: new Date(),
        });
        await harness.seedRaw('skills', [older, newer, hidden, deleting]);
        const accessible = [older._id, newer._id, deleting._id].map((id) =>
          harness.ids.toStoreId(id),
        );
        expect(idOf(harness, (await skills().getSkillByName('shared', accessible))?._id)).toBe(
          newer._id,
        );
        expect(await skills().getSkillByName('missing', accessible)).toBeNull();
        expect(await skills().getSkillByName('shared', [])).toBeNull();
      });

      it('prefers a user-invocable or model-invocable match, falling back to the newest', async () => {
        const userOnly = rawSkill({
          name: 'dup',
          disableModelInvocation: true,
          userInvocable: true,
          updatedAt: new Date('2026-03-01T00:00:00Z'),
        });
        const modelOnly = rawSkill({
          name: 'dup',
          author: otherAuthorId,
          disableModelInvocation: false,
          userInvocable: false,
          updatedAt: new Date('2026-02-01T00:00:00Z'),
        });
        await harness.seedRaw('skills', [userOnly, modelOnly]);
        const accessible = [userOnly._id, modelOnly._id] as string[];
        const pick = async (options?: object) =>
          idOf(harness, (await skills().getSkillByName('dup', accessible, options))?._id);
        expect(await pick()).toBe(userOnly._id);
        expect(await pick({ preferModelInvocable: true })).toBe(modelOnly._id);
        expect(await pick({ preferUserInvocable: true })).toBe(userOnly._id);
        expect(await pick({ preferUserInvocable: true, preferModelInvocable: true })).toBe(
          userOnly._id,
        );
        expect(await pick({ preferModelInvocable: true, preferUserInvocable: false })).toBe(
          modelOnly._id,
        );
        const onlyDisabled = [userOnly._id as string];
        expect(
          idOf(
            harness,
            (await skills().getSkillByName('dup', onlyDisabled, { preferModelInvocable: true }))
              ?._id,
          ),
        ).toBe(userOnly._id);
      });

      it('fills unset structured columns of a legacy skill from its frontmatter, columns winning', async () => {
        const legacy = rawSkill({
          name: 'legacy',
          frontmatter: {
            'disable-model-invocation': true,
            'user-invocable': false,
            'allowed-tools': ['shell'],
          },
        });
        const explicit = rawSkill({
          name: 'explicit',
          frontmatter: { 'user-invocable': false, 'allowed-tools': 'web_search' },
          userInvocable: true,
          allowedTools: [],
        });
        await harness.seedRaw('skills', [legacy, explicit]);
        for (const options of [undefined, { preferUserInvocable: true }]) {
          const read = await skills().getSkillByName('legacy', [legacy._id as string], options);
          expect(read).toMatchObject({
            disableModelInvocation: true,
            userInvocable: false,
            allowedTools: ['shell'],
          });
        }
        const read = await skills().getSkillByName('explicit', [explicit._id as string]);
        expect(read).toMatchObject({ userInvocable: true, allowedTools: [] });
        expect(await skillRaw(legacy._id as string)).not.toHaveProperty('userInvocable');
      });
    });

    describe('getAuthorSkillByName', () => {
      it("reads the author's newest skill of the name in the tenant, or in no tenant", async () => {
        const noTenant = rawSkill({ name: 'mine' });
        const tenantA = rawSkill({ name: 'mine', tenantId: 'tenant-a' });
        const otherAuthor = rawSkill({ name: 'mine', author: otherAuthorId });
        const deleting = rawSkill({ name: 'gone', deletingAt: new Date() });
        await harness.seedRaw('skills', [noTenant, tenantA, otherAuthor, deleting]);
        const read = (params: { name: string; author: string; tenantId?: string | null }) =>
          skills()
            .getAuthorSkillByName(params)
            .then((skill) => (skill ? idOf(harness, skill._id) : null));
        expect(await read({ name: 'mine', author: authorId })).toBe(noTenant._id);
        expect(await read({ name: 'mine', author: authorId, tenantId: null })).toBe(noTenant._id);
        expect(await read({ name: 'mine', author: otherAuthorId })).toBe(otherAuthor._id);
        expect(
          await inTenant('tenant-a', () =>
            read({ name: 'mine', author: authorId, tenantId: 'tenant-a' }),
          ),
        ).toBe(tenantA._id);
        expect(await read({ name: 'gone', author: authorId })).toBeNull();
        expect(await read({ name: 'missing', author: authorId })).toBeNull();
      });

      it('fills unset structured columns from the frontmatter', async () => {
        await harness.seedRaw('skills', [
          rawSkill({ name: 'legacy', frontmatter: { 'user-invocable': false } }),
        ]);
        expect(
          await skills().getAuthorSkillByName({ name: 'legacy', author: authorId }),
        ).toMatchObject({ userInvocable: false });
      });
    });

    describe('listSkillsByAccess', () => {
      it('lists the accessible skills not being deleted, most recently updated first, as summaries', async () => {
        const older = rawSkill({ name: 'older', updatedAt: new Date('2026-01-01T00:00:00Z') });
        const newer = rawSkill({
          name: 'newer',
          updatedAt: new Date('2026-02-01T00:00:00Z'),
          disableModelInvocation: true,
          userInvocable: false,
          allowedTools: ['shell'],
          sourceMetadata: { sourceId: 'repo' },
        });
        const hidden = rawSkill({ name: 'hidden' });
        const deleting = rawSkill({ name: 'deleting', deletingAt: new Date() });
        await harness.seedRaw('skills', [older, newer, hidden, deleting]);
        const result = await skills().listSkillsByAccess({
          accessibleIds: [older._id, newer._id, deleting._id].map((id) =>
            harness.ids.toStoreId(id),
          ),
          limit: 20,
        });
        expect(ids(result.skills)).toEqual([newer._id, older._id]);
        expect(result).toMatchObject({ has_more: false, after: null });
        const [summary] = result.skills;
        expect(summary).toMatchObject({
          name: 'newer',
          description: 'A raw skill seeded for the contract.',
          version: 1,
          fileCount: 0,
          alwaysApply: false,
          disableModelInvocation: true,
          userInvocable: false,
          allowedTools: ['shell'],
          sourceMetadata: { sourceId: 'repo' },
          authorName: 'Skill Author',
        });
        expect(idOf(harness, summary.author)).toBe(authorId);
        expect(summary).not.toHaveProperty('body');
        expect(summary).not.toHaveProperty('frontmatter');
        expect(summary.updatedAt).toBeInstanceOf(Date);
      });

      it('pages by cursor over update time and id, ties included', async () => {
        const skillIds = Array.from({ length: 5 }, () => harness.ids.generate()).sort();
        const tied = new Date('2026-02-01T00:00:00Z');
        await harness.seedRaw('skills', [
          rawSkill({ _id: skillIds[3], name: 'tie-a', updatedAt: tied }),
          rawSkill({
            _id: skillIds[0],
            name: 'oldest',
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          }),
          rawSkill({
            _id: skillIds[4],
            name: 'newest',
            updatedAt: new Date('2026-03-01T00:00:00Z'),
          }),
          rawSkill({ _id: skillIds[1], name: 'tie-b', updatedAt: tied }),
          rawSkill({ _id: skillIds[2], name: 'tie-c', updatedAt: tied }),
        ]);
        const pages: string[][] = [];
        let cursor: string | null = null;
        do {
          const page: Awaited<ReturnType<ReturnType<typeof skills>['listSkillsByAccess']>> =
            await skills().listSkillsByAccess({ accessibleIds: skillIds, limit: 2, cursor });
          pages.push(ids(page.skills));
          expect(page.has_more).toBe(page.after !== null);
          cursor = page.after;
        } while (cursor);
        expect(pages).toEqual([
          [skillIds[4], skillIds[1]],
          [skillIds[2], skillIds[3]],
          [skillIds[0]],
        ]);
      });

      it('clamps the page size to 1..100, reading 0 as 20, and ignores a malformed cursor', async () => {
        const skillIds = Array.from({ length: 101 }, () => harness.ids.generate());
        await harness.seedRaw(
          'skills',
          skillIds.map((_id, index) => rawSkill({ _id, name: `skill-${index}` })),
        );
        const size = async (limit: number, cursor?: string) =>
          (await skills().listSkillsByAccess({ accessibleIds: skillIds, limit, cursor })).skills
            .length;
        expect(await size(500)).toBe(100);
        expect(await size(0)).toBe(20);
        expect(await size(-5)).toBe(1);
        expect(await size(3, 'not-a-cursor')).toBe(3);
        expect(
          await size(
            3,
            Buffer.from(JSON.stringify({ updatedAt: 'x', _id: 'y' })).toString('base64'),
          ),
        ).toBe(3);
      });

      it('filters by category and by a literal, case-insensitive search of name, description and title', async () => {
        const byName = rawSkill({ name: 'pdf-tools', category: 'docs' });
        const byDescription = rawSkill({ name: 'other', description: 'Handles PDF (v2) files.' });
        const byTitle = rawSkill({ name: 'third', displayTitle: 'The PDF helper' });
        const unrelated = rawSkill({ name: 'unrelated', category: 'docs' });
        const records = [byName, byDescription, byTitle, unrelated];
        await harness.seedRaw('skills', records);
        const accessibleIds = records.map((record) => record._id as string);
        const list = async (params: { category?: string; search?: string }) =>
          ids(
            (await skills().listSkillsByAccess({ accessibleIds, limit: 20, ...params })).skills,
          ).sort();
        expect(await list({ search: 'pdf' })).toEqual(
          [byName._id, byDescription._id, byTitle._id].sort(),
        );
        expect(await list({ search: 'PDF (V2' })).toEqual([byDescription._id]);
        expect(await list({ category: 'docs' })).toEqual([byName._id, unrelated._id].sort());
        expect(await list({ category: 'docs', search: 'pdf' })).toEqual([byName._id]);
        expect(await list({ category: '', search: '' })).toEqual(accessibleIds.sort());
      });

      it('lists every skill of the managed tenant, whatever the accessible ids', async () => {
        const inA = rawSkill({ name: 'in-a', tenantId: 'tenant-a' });
        const inB = rawSkill({ name: 'in-b', tenantId: 'tenant-b' });
        await harness.seedRaw('skills', [inA, inB]);
        const result = await skills().listSkillsByAccess({
          accessibleIds: [],
          manageTenantId: 'tenant-a',
          limit: 20,
        });
        expect(ids(result.skills)).toEqual([inA._id]);
        expect(result.skills[0].tenantId).toBe('tenant-a');
      });
    });

    describe('listAlwaysApplySkills', () => {
      it('lists the accessible always-apply skills with their bodies', async () => {
        const applied = rawSkill({
          name: 'applied',
          alwaysApply: true,
          body: 'always body',
          frontmatter: { 'always-apply': true },
          allowedTools: ['shell'],
          version: 3,
        });
        const plain = rawSkill({ name: 'plain-applied', alwaysApply: true });
        const notApplied = rawSkill({ name: 'not-applied' });
        const inaccessible = rawSkill({ name: 'inaccessible', alwaysApply: true });
        const deleting = rawSkill({ name: 'deleting', alwaysApply: true, deletingAt: new Date() });
        await harness.seedRaw('skills', [applied, plain, notApplied, inaccessible, deleting]);
        const result = await skills().listAlwaysApplySkills({
          accessibleIds: [applied, plain, notApplied, deleting].map((row) =>
            harness.ids.toStoreId(row._id),
          ),
          limit: 20,
        });
        expect(ids(result.skills).sort()).toEqual([applied._id, plain._id].sort());
        const appliedRow = result.skills.find((row) => idOf(harness, row._id) === applied._id);
        expect(Object.keys(appliedRow ?? {}).sort()).toEqual([
          '_id',
          'allowedTools',
          'author',
          'body',
          'frontmatter',
          'name',
          'version',
        ]);
        expect(appliedRow).toMatchObject({
          name: 'applied',
          body: 'always body',
          version: 3,
          frontmatter: { 'always-apply': true },
          allowedTools: ['shell'],
        });
        expect(idOf(harness, appliedRow?.author)).toBe(authorId);
        const plainRow = result.skills.find((row) => idOf(harness, row._id) === plain._id);
        expect(plainRow).not.toHaveProperty('allowedTools');
      });

      it('reads an empty page for no ids, and an empty body for a skill without one', async () => {
        const bodiless = rawSkill({ name: 'bodiless', alwaysApply: true });
        delete bodiless.body;
        await harness.seedRaw('skills', [bodiless]);
        expect(await skills().listAlwaysApplySkills({ accessibleIds: [], limit: 20 })).toEqual({
          skills: [],
          has_more: false,
          after: null,
        });
        const result = await skills().listAlwaysApplySkills({
          accessibleIds: [bodiless._id as string],
          limit: 20,
        });
        expect(result.skills[0].body).toBe('');
      });

      it('pages by cursor over update time and id without duplicates', async () => {
        const skillIds = Array.from({ length: 5 }, () => harness.ids.generate()).sort();
        const tied = new Date('2026-02-01T00:00:00Z');
        await harness.seedRaw(
          'skills',
          skillIds.map((_id, index) =>
            rawSkill({
              _id,
              name: `applied-${index}`,
              alwaysApply: true,
              updatedAt: index === 4 ? new Date('2026-03-01T00:00:00Z') : tied,
            }),
          ),
        );
        const first = await skills().listAlwaysApplySkills({ accessibleIds: skillIds, limit: 2 });
        expect(first.has_more).toBe(true);
        expect(ids(first.skills)).toEqual([skillIds[4], skillIds[0]]);
        const second = await skills().listAlwaysApplySkills({
          accessibleIds: skillIds,
          limit: 2,
          cursor: first.after,
        });
        expect(ids(second.skills)).toEqual([skillIds[1], skillIds[2]]);
        const third = await skills().listAlwaysApplySkills({
          accessibleIds: skillIds,
          limit: 2,
          cursor: second.after,
        });
        expect(ids(third.skills)).toEqual([skillIds[3]]);
        expect(third).toMatchObject({ has_more: false, after: null });
      });
    });

    describe('findSkillBySourceIdentity', () => {
      it('reads the mirror of the upstream item in the requested tenant bucket only', async () => {
        const metadata = { sourceId: 'repo-1', upstreamId: 'skills/pdf' };
        const noTenant = rawSkill({ name: 'pdf', source: 'github', sourceMetadata: metadata });
        const nullTenant = rawSkill({
          name: 'pdf-null',
          source: 'github',
          tenantId: null,
          sourceMetadata: { ...metadata, upstreamId: 'skills/null' },
        });
        const tenantA = rawSkill({
          name: 'pdf',
          source: 'github',
          tenantId: 'tenant-a',
          sourceMetadata: metadata,
        });
        await harness.seedRaw('skills', [noTenant, nullTenant, tenantA]);
        const find = (upstreamId: string, tenantId?: string) =>
          skills()
            .findSkillBySourceIdentity({ source: 'github', upstreamId, tenantId })
            .then((skill) => (skill ? idOf(harness, skill._id) : null));
        expect(await find('skills/pdf')).toBe(noTenant._id);
        expect(await find('skills/null')).toBe(nullTenant._id);
        expect(await find('skills/pdf', 'tenant-a')).toBe(tenantA._id);
        expect(await find('skills/pdf', 'tenant-b')).toBeNull();
        expect(
          await skills().findSkillBySourceIdentity({ source: 'notion', upstreamId: 'skills/pdf' }),
        ).toBeNull();
      });

      it('does not read a mirror that is being deleted', async () => {
        await harness.seedRaw('skills', [
          rawSkill({
            source: 'github',
            sourceMetadata: { upstreamId: 'skills/gone' },
            deletingAt: new Date(),
          }),
        ]);
        expect(
          await skills().findSkillBySourceIdentity({ source: 'github', upstreamId: 'skills/gone' }),
        ).toBeNull();
      });
    });

    describe('listSkillsBySource', () => {
      it('lists the mirrors of the sync source that are not being deleted', async () => {
        const first = rawSkill({
          name: 'first',
          source: 'github',
          sourceMetadata: { sourceId: 'repo-1', upstreamId: 'a' },
        });
        const second = rawSkill({
          name: 'second',
          source: 'github',
          sourceMetadata: { sourceId: 'repo-1', upstreamId: 'b' },
        });
        const otherSource = rawSkill({
          name: 'other',
          source: 'github',
          sourceMetadata: { sourceId: 'repo-2' },
        });
        const otherProvider = rawSkill({
          name: 'notion',
          source: 'notion',
          sourceMetadata: { sourceId: 'repo-1' },
        });
        const deleting = rawSkill({
          name: 'deleting',
          source: 'github',
          sourceMetadata: { sourceId: 'repo-1' },
          deletingAt: new Date(),
        });
        await harness.seedRaw('skills', [first, second, otherSource, otherProvider, deleting]);
        const rows = await skills().listSkillsBySource({ source: 'github', sourceId: 'repo-1' });
        expect(ids(rows).sort()).toEqual([first._id, second._id].sort());
        expect(rows.find((row) => row.name === 'first')?.body).toBe('raw body');
        expect(await skills().listSkillsBySource({ source: 'github', sourceId: 'none' })).toEqual(
          [],
        );
      });
    });

    describe('updateSkill', () => {
      it('applies the update at the expected version and bumps it', async () => {
        const id = await create();
        const before = await skillRaw(id);
        const result = await skills().updateSkill({
          id,
          expectedVersion: 1,
          update: {
            displayTitle: 'Renamed Title',
            description: 'An updated description for the skill.',
            category: 'writing',
            source: 'github',
            sourceMetadata: { sourceId: 'repo-1' },
          },
        });
        expect(result).toMatchObject({ status: 'updated', warnings: [] });
        expect((result as { skill?: unknown }).skill).toMatchObject({
          version: 2,
          displayTitle: 'Renamed Title',
          category: 'writing',
          source: 'github',
          name: 'demo-skill',
        });
        const after = await skillRaw(id);
        expect(after).toMatchObject({ version: 2, sourceMetadata: { sourceId: 'repo-1' } });
        expect(timeOf(after?.updatedAt)).toBeGreaterThanOrEqual(timeOf(before?.updatedAt));
      });

      it('resolves a conflict with the current skill at a stale version', async () => {
        const id = await create();
        await skills().updateSkill({ id, expectedVersion: 1, update: { category: 'first' } });
        const result = await skills().updateSkill({
          id,
          expectedVersion: 1,
          update: { category: 'second' },
        });
        expect(result).toMatchObject({
          status: 'conflict',
          current: { version: 2, category: 'first' },
        });
        expect((await skillRaw(id))?.category).toBe('first');
      });

      it('resolves not_found for a malformed, unknown or deleting skill', async () => {
        const deleting = rawSkill({ deletingAt: new Date() });
        await harness.seedRaw('skills', [deleting]);
        for (const id of ['not-an-id', harness.ids.generate(), deleting._id as string]) {
          expect(
            await skills().updateSkill({ id, expectedVersion: 1, update: { category: 'x' } }),
          ).toEqual({ status: 'not_found' });
        }
        expect((await skillRaw(deleting._id as string))?.version).toBe(1);
      });

      it('lets exactly one of two writers at the same version win', async () => {
        const id = await create();
        const results = await Promise.all(
          ['a', 'b'].map((category) =>
            skills().updateSkill({ id, expectedVersion: 1, update: { category } }),
          ),
        );
        expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'updated']);
        expect((await skillRaw(id))?.version).toBe(2);
      });

      it('re-derives the structured columns from new frontmatter, unsetting omitted ones', async () => {
        const id = await create({
          frontmatter: {
            'disable-model-invocation': true,
            'user-invocable': false,
            'allowed-tools': ['shell'],
          },
        });
        await skills().updateSkill({
          id,
          expectedVersion: 1,
          update: { frontmatter: { 'User-Invocable': true } },
        });
        const stored = await skillRaw(id);
        expect(stored?.frontmatter).toEqual({ 'user-invocable': true });
        expect(stored?.userInvocable).toBe(true);
        expect(stored).not.toHaveProperty('disableModelInvocation');
        expect(stored).not.toHaveProperty('allowedTools');
      });

      it('rejects a rename to a name the author already uses with a duplicate-key error', async () => {
        await create({ name: 'taken' });
        const id = await create({ name: 'free' });
        const error = await rejectionOf(
          skills().updateSkill({ id, expectedVersion: 1, update: { name: 'taken' } }),
        );
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
        expect(await skillRaw(id)).toMatchObject({ name: 'free', version: 1 });
      });

      it('rejects invalid fields and a null alwaysApply with the validation issues', async () => {
        const id = await create();
        for (const [update, field] of [
          [{ name: 'claude-thing' }, 'name'],
          [{ description: '' }, 'description'],
          [{ alwaysApply: null }, 'alwaysApply'],
          [{ body: 42 }, 'body'],
          [{ frontmatter: 'not-an-object' }, 'frontmatter'],
        ] as const) {
          const error = await rejectionOf(
            skills().updateSkill({ id, expectedVersion: 1, update: update as never }),
          );
          expect(error.code).toBe('SKILL_VALIDATION_FAILED');
          expect(error.issues).toEqual([expect.objectContaining({ field })]);
        }
        expect((await skillRaw(id))?.version).toBe(1);
      });

      it('returns the warnings of the update', async () => {
        const id = await create();
        const result = await skills().updateSkill({
          id,
          expectedVersion: 1,
          update: { description: 'Short one.' },
        });
        expect(result).toMatchObject({
          status: 'updated',
          warnings: [expect.objectContaining({ code: 'TOO_SHORT', severity: 'warning' })],
        });
      });

      it.each([
        [
          'an explicit flag over the frontmatter',
          { alwaysApply: false, frontmatter: { 'always-apply': true } },
          true,
          false,
        ],
        ['the frontmatter flag', { frontmatter: { 'always-apply': true } }, false, true],
        ['the camel-case frontmatter alias', { frontmatter: { alwaysApply: true } }, false, true],
        ['frontmatter without a flag (unchanged)', { frontmatter: { license: 'MIT' } }, true, true],
        [
          'a body that sets the flag inline',
          { body: '---\nalwaysApply: true\n---\n# Body' },
          false,
          true,
        ],
        [
          'a body that removes the flag',
          { body: '---\nname: demo-skill\n---\n# Body' },
          true,
          false,
        ],
        ['a body without a frontmatter block', { body: '# Just a body' }, true, false],
        ['an explicit flag over a body', { alwaysApply: true, body: '# Just a body' }, true, true],
        ['an untouched body (unchanged)', { category: 'other' }, true, true],
      ])('keeps the alwaysApply column in step with %s', async (_label, update, before, after) => {
        const id = await create({ alwaysApply: before });
        const result = await skills().updateSkill({ id, expectedVersion: 1, update });
        expect(result.status).toBe('updated');
        expect((await skillRaw(id))?.alwaysApply).toBe(after);
      });

      it('rejects a body always-apply typo unless a higher source overrides it', async () => {
        const id = await create();
        const body = '---\nalways-apply: yes\n---\n# Body';
        const error = await rejectionOf(
          skills().updateSkill({ id, expectedVersion: 1, update: { body } }),
        );
        expect(error.issues).toEqual([
          expect.objectContaining({ field: 'body.frontmatter.alwaysApply' }),
        ]);
        expect(
          await skills().updateSkill({
            id,
            expectedVersion: 1,
            update: { body, frontmatter: { 'always-apply': true } },
          }),
        ).toMatchObject({ status: 'updated', skill: { alwaysApply: true } });
      });
    });

    describe('tenant scoping', () => {
      it("reads, lists and updates only the active tenant's skills", async () => {
        const inA = await inTenant('tenant-a', () =>
          create({ tenantId: 'tenant-a', name: 'in-a' }),
        );
        const inB = await inTenant('tenant-b', () =>
          create({ tenantId: 'tenant-b', name: 'in-b' }),
        );
        await inTenant('tenant-a', async () => {
          expect(await skills().getSkillById(inB)).toBeNull();
          expect(idOf(harness, (await skills().getSkillById(inA))?._id)).toBe(inA);
          expect(await skills().getSkillByName('in-b', [inA, inB])).toBeNull();
          const listed = await skills().listSkillsByAccess({
            accessibleIds: [inA, inB],
            limit: 20,
          });
          expect(ids(listed.skills)).toEqual([inA]);
          const applied = await skills().listAlwaysApplySkills({
            accessibleIds: [inA, inB],
            limit: 20,
          });
          expect(applied.skills).toEqual([]);
          expect(
            await skills().updateSkill({ id: inB, expectedVersion: 1, update: { category: 'x' } }),
          ).toEqual({ status: 'not_found' });
        });
        expect((await skillRaw(inA))?.tenantId).toBe('tenant-a');
        expect((await skillRaw(inB))?.category).toBe('');
      });

      it('stamps the active tenant on a skill created without one', async () => {
        const id = await inTenant('tenant-a', () => create());
        expect((await skillRaw(id))?.tenantId).toBe('tenant-a');
      });
    });
  });
}
