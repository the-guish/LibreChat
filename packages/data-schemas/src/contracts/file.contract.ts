/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `FileStore` contract (`~/ports/file`), ported from `methods/file.spec.ts` and its
 * companions (`file.commit`, `file.ownership`, `file.publication`): the run artifacts (derived
 * ids, publish-once, the run listing), the reads by criteria with the filter, sort, projection
 * and limit shapes callers pass (`text` left out by default and by every hydration read), the
 * project file reads with their cursor, the expiry sweep bookkeeping, the hydration reads with
 * their owner scope, the code-output claim and commit, the writes with their `updatedAt` rule
 * (content writes advance it, bookkeeping does not), the guarded snapshot writes, the TTL hold,
 * the deletes with their chat project cleanup, the two partial unique indexes (code outputs per
 * filename and conversation, run artifacts per identity) and tenant scoping.
 *
 * Not here (they stay in the method specs): cases that make a query fail or spy on driver calls,
 * the index declarations themselves, strict-mode tenant isolation, and the string projection
 * form (`'-text'`), which is outside the port's `StoreProjection`. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { EToolResources, FileContext, FileSources } from 'librechat-data-provider';
import type { CodeEnvRef, RunFileProvenance } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { IMongoFile, RunArtifactScope, RunArtifactContent } from '~/types/file';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';

const BASE = Date.parse('2026-04-01T00:00:00.000Z');
/** A fixed instant `minutes` after {@link BASE}. */
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A code-environment reference of `kind: 'user'` with the given storage file id. */
const codeRef = (file_id: string, extra: Partial<CodeEnvRef> = {}): CodeEnvRef =>
  ({ kind: 'user', id: 'owner', storage_session_id: 'session', file_id, ...extra }) as CodeEnvRef;

/** The partial file record `createFile`/`updateFile` take, from plain fields. */
const asFile = <T extends Record<string, unknown>>(data: T) =>
  data as unknown as Partial<IMongoFile> & { file_id: string };

export function describeFileContract(harness: ContractHarness): void {
  describe(`FileStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().files;
    const newId = () => harness.ids.generate();
    /** `count` new ids in ascending (insertion) order. */
    const ascendingIds = (count: number) =>
      Array.from({ length: count }, () => newId()).sort() as string[];
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);

    /**
     * Seeds one stored file raw (no defaults): owned by `user`, a local text upload created and
     * updated at `at(0)`, with `record` over it (an `undefined` value leaves the field out).
     * Returns the seeded record.
     */
    const seedFile = async (user: string, record: RawRecord = {}): Promise<RawRecord> => {
      const seeded: RawRecord = {
        _id: newId(),
        file_id: `file-${newId()}`,
        user,
        filename: 'notes.txt',
        filepath: '/uploads/notes.txt',
        type: 'text/plain',
        bytes: 100,
        object: 'file',
        usage: 0,
        source: 'local',
        createdAt: at(0),
        updatedAt: at(0),
        ...record,
      };
      const stored = Object.fromEntries(
        Object.entries(seeded).filter(([, value]) => value !== undefined),
      );
      await harness.seedRaw('files', [stored]);
      return stored;
    };
    const rawFiles = (where: RawRecord = {}) => readRawWhere(harness, 'files', where);
    const rawFile = async (file_id: string, where: RawRecord = {}): Promise<RawRecord> => {
      const [record] = await rawFiles({ file_id, ...where });
      return record;
    };
    const metadataOf = (record: RawRecord | undefined | null) =>
      ((record as RawRecord | null | undefined)?.metadata ?? {}) as RawRecord;
    const fileIds = (files: ReadonlyArray<{ file_id: string }> | null) =>
      (files ?? []).map((file) => file.file_id);
    const sortedIds = (files: ReadonlyArray<{ file_id: string }> | null) => fileIds(files).sort();

    /* ------------------------------------------------------------------ run artifacts */

    describe('run artifacts', () => {
      const user = '0123456789abcdef01234567';
      const scope: RunArtifactScope = {
        userId: user,
        tenantId: null,
        conversationId: 'convo-run',
        runId: 'run-1',
        executionId: 'exec-1',
        agentId: 'agent-1',
        sourceFileId: 'source-1',
      };
      const provenance: RunFileProvenance = {
        runId: 'run-1',
        executionId: 'exec-1',
        agentId: 'agent-1',
        sourceFileId: 'source-1',
        publishedAt: '2026-04-01T00:00:00.000Z',
        inputFileIds: ['input-1'],
      };
      const content: RunArtifactContent = {
        filename: 'report.csv',
        filepath: '/uploads/report.csv',
        bytes: 12,
        type: 'text/csv',
        source: FileSources.local,
        text: 'a,b',
        metadata: { codeEnvRef: codeRef('remote'), routingMimeType: 'text/csv' },
      };

      describe('claimRunArtifactFile', () => {
        it('derives one stable id per scope without storing anything', async () => {
          const first = await stores().claimRunArtifactFile(scope);
          expect(first).toEqual({ file_id: expect.any(String) });
          expect(first.file_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(await stores().claimRunArtifactFile({ ...scope })).toEqual(first);
          const others = await Promise.all(
            [
              { executionId: 'exec-2' },
              { agentId: 'agent-2' },
              { sourceFileId: 'source-2' },
              { tenantId: 'tenant-a' },
              { userId: '0123456789abcdef01234568' },
            ].map((change) => stores().claimRunArtifactFile({ ...scope, ...change })),
          );
          expect(new Set([first.file_id, ...others.map((claim) => claim.file_id)]).size).toBe(6);
          expect(await harness.readRaw('files')).toEqual([]);
        });

        it('returns the published record once there is one', async () => {
          const published = await stores().publishRunArtifactFile({
            scope,
            file: content,
            provenance,
          });
          const claim = await stores().claimRunArtifactFile(scope);
          expect(claim.file_id).toBe(published.file_id);
          expect(claim.file).toMatchObject({ file_id: published.file_id, user });
        });

        it.each([
          ['a blank user', { userId: ' ' }],
          ['a missing conversation', { conversationId: '' }],
          ['a missing run', { runId: '' }],
          ['a missing execution', { executionId: '' }],
          ['a missing agent', { agentId: ' ' }],
          ['a missing source file', { sourceFileId: '' }],
          ['an empty tenant', { tenantId: '  ' }],
        ])('throws for an incomplete scope: %s', async (_label, change) => {
          await expect(stores().claimRunArtifactFile({ ...scope, ...change })).rejects.toThrow(
            /run artifact/,
          );
        });
      });

      describe('publishRunArtifactFile', () => {
        it('stores a durable record with its provenance, never the private source pointers', async () => {
          const before = Date.now();
          const published = await stores().publishRunArtifactFile({
            scope,
            file: content,
            provenance,
          });
          expect(published).toMatchObject({
            file_id: (await stores().claimRunArtifactFile(scope)).file_id,
            user,
            conversationId: 'convo-run',
            context: FileContext.run_artifact,
            object: 'file',
            source: FileSources.local,
            filename: 'report.csv',
            bytes: 12,
            text: 'a,b',
            usage: 1,
            embedded: false,
            embeddingOwnersComplete: true,
            llmDeliveryPath: 'none',
            metadata: {
              routingMimeType: 'text/csv',
              destinationChosen: false,
              runFile: provenance,
            },
          });
          expect(typeof published.user).toBe('string');
          expect(typeof published._id).toBe('string');
          expect(published.metadata).not.toHaveProperty('codeEnvRef');
          const stored = await rawFile(published.file_id);
          /** The upsert stores the filter's `tenantId: null`. */
          expect(stored.tenantId ?? null).toBeNull();
          expect(stored).not.toHaveProperty('expiresAt');
          expect(metadataOf(stored)).not.toHaveProperty('codeEnvRef');
          expect(idOf(harness, stored.user)).toBe(user);
          expect(timeOf(stored.createdAt)).toBe(timeOf(stored.updatedAt));
          expect(timeOf(stored.createdAt)).toBeGreaterThanOrEqual(before);
        });

        it('publishes once: a retry with other content resolves the record already stored', async () => {
          const first = await stores().publishRunArtifactFile({ scope, file: content, provenance });
          const retry = await stores().publishRunArtifactFile({
            scope,
            file: { ...content, filepath: '/uploads/other.csv', bytes: 99 },
            provenance: { ...provenance, publishedAt: '2026-05-01T00:00:00.000Z' },
          });
          expect(retry).toEqual(first);
          expect(await harness.readRaw('files')).toHaveLength(1);
        });

        it('converges concurrent publishes on one record', async () => {
          const results = await Promise.all(
            Array.from({ length: 4 }, (_, index) =>
              stores().publishRunArtifactFile({
                scope,
                file: { ...content, bytes: index },
                provenance,
              }),
            ),
          );
          expect(new Set(results.map((file) => file.file_id)).size).toBe(1);
          expect(new Set(results.map((file) => file.bytes)).size).toBe(1);
          expect(await harness.readRaw('files')).toHaveLength(1);
        });

        it('stores the tenant of the scope', async () => {
          const published = await stores().publishRunArtifactFile({
            scope: { ...scope, tenantId: 'tenant-a' },
            file: content,
            provenance,
          });
          expect(published.tenantId).toBe('tenant-a');
          expect((await rawFile(published.file_id)).tenantId).toBe('tenant-a');
        });

        it.each([
          ['another run', { runId: 'run-2' }],
          ['another execution', { executionId: 'exec-2' }],
          ['another agent', { agentId: 'agent-2' }],
          ['another source', { sourceFileId: 'source-2' }],
          ['an unreadable publication time', { publishedAt: 'not a date' }],
        ])('rejects provenance naming %s', async (_label, change) => {
          await expect(
            stores().publishRunArtifactFile({
              scope,
              file: content,
              provenance: { ...provenance, ...change },
            }),
          ).rejects.toThrow('Run artifact provenance does not match its publication scope');
          expect(await harness.readRaw('files')).toEqual([]);
        });

        it.each([
          ['no path', { filepath: '' }],
          ['no name', { filename: '' }],
          ['no type', { type: '' }],
          ['an execution-sandbox source', { source: FileSources.execute_code }],
          ['negative bytes', { bytes: -1 }],
          ['fractional bytes', { bytes: 1.5 }],
        ])('rejects a file with %s', async (_label, change) => {
          await expect(
            stores().publishRunArtifactFile({ scope, file: { ...content, ...change }, provenance }),
          ).rejects.toThrow('A durable stored file is required to publish a run artifact');
        });
      });

      describe('findRunArtifactFile and listRunArtifacts', () => {
        it('finds the artifact of the exact scope, else null', async () => {
          expect(await stores().findRunArtifactFile(scope)).toBeNull();
          const published = await stores().publishRunArtifactFile({
            scope,
            file: content,
            provenance,
          });
          expect(await stores().findRunArtifactFile(scope)).toEqual(published);
          for (const change of [
            { executionId: 'exec-2' },
            { userId: '0123456789abcdef01234568' },
            { tenantId: 'tenant-a' },
            { conversationId: 'convo-other' },
          ]) {
            expect(await stores().findRunArtifactFile({ ...scope, ...change })).toBeNull();
          }
        });

        it("lists the run's artifacts, oldest first and then by file id", async () => {
          const artifact = (file_id: string, createdAt: Date, runFile: RawRecord = {}) => ({
            file_id,
            context: FileContext.run_artifact,
            conversationId: 'convo-run',
            createdAt,
            metadata: {
              runFile: { ...provenance, executionId: `exec-${file_id}`, ...runFile },
            },
          });
          await seedFile(user, artifact('c', at(2)));
          await seedFile(user, artifact('b', at(1)));
          await seedFile(user, artifact('a', at(2)));
          await seedFile(user, artifact('other-run', at(0), { runId: 'run-2' }));
          await seedFile('0123456789abcdef01234568', artifact('other-user', at(0)));
          await seedFile(user, { ...artifact('other-context', at(0)), context: 'agents' });
          await seedFile(user, { ...artifact('tenanted', at(0)), tenantId: 'tenant-a' });
          const listed = await stores().listRunArtifacts(scope);
          expect(fileIds(listed)).toEqual(['b', 'a', 'c']);
          expect(listed.every((file) => typeof file.user === 'string')).toBe(true);
          expect(
            fileIds(await stores().listRunArtifacts({ ...scope, tenantId: 'tenant-a' })),
          ).toEqual(['tenanted']);
        });

        it('throws for an incomplete run scope', async () => {
          await expect(stores().listRunArtifacts({ ...scope, runId: '' })).rejects.toThrow(
            'A complete run artifact owner scope is required',
          );
          await expect(stores().findRunArtifactFile({ ...scope, agentId: '' })).rejects.toThrow(
            'A complete run artifact execution scope is required',
          );
        });
      });

      describe('getRunFileCandidates', () => {
        it('returns plain records of the listed files of one tenant, any owner', async () => {
          const alice = newId();
          const bob = newId();
          await seedFile(alice, { file_id: 'a', text: 'kept', embedded: true });
          await seedFile(bob, { file_id: 'b' });
          await seedFile(alice, { file_id: 'c' });
          await seedFile(alice, { file_id: 'a', tenantId: 'tenant-a' });
          const candidates = await stores().getRunFileCandidates(['a', 'b', 'missing']);
          expect(sortedIds(candidates)).toEqual(['a', 'b']);
          const a = candidates.find((file) => file.file_id === 'a');
          expect(a).toMatchObject({ user: alice, embedded: true, text: 'kept' });
          expect(typeof a?._id).toBe('string');
          expect(candidates.find((file) => file.file_id === 'b')?.embedded).toBe(false);
          const tenanted = await stores().getRunFileCandidates(['a', 'b'], 'tenant-a');
          expect(tenanted.map((file) => [file.file_id, file.tenantId])).toEqual([
            ['a', 'tenant-a'],
          ]);
          expect(await stores().getRunFileCandidates([])).toEqual([]);
        });
      });
    });

    /* ------------------------------------------------------------------ reads by criteria */

    describe('findFileById', () => {
      it('returns the whole record, text included, or null', async () => {
        const user = newId();
        await seedFile(user, {
          file_id: 'doc',
          text: 'extracted',
          metadata: { codeDestination: true },
        });
        const found = await stores().findFileById('doc');
        expect(found).toMatchObject({ file_id: 'doc', text: 'extracted', filename: 'notes.txt' });
        expect(idOf(harness, found?.user)).toBe(user);
        expect(timeOf(found?.createdAt)).toBe(at(0).getTime());
        expect(await stores().findFileById('missing')).toBeNull();
      });

      it('adds the given conditions to the id match', async () => {
        const user = newId();
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-a' });
        expect(await stores().findFileById('doc', { user })).not.toBeNull();
        expect(await stores().findFileById('doc', { user: newId() })).toBeNull();
        expect(await stores().findFileById('doc', { tenantId: 'tenant-a' })).not.toBeNull();
        expect(await stores().findFileById('doc', { tenantId: { $exists: false } })).toBeNull();
      });
    });

    describe('getFiles', () => {
      const user = '0123456789abcdef0123abcd';
      const seedThree = async () => {
        await seedFile(user, { file_id: 'old', updatedAt: at(1), createdAt: at(3), text: 'o' });
        await seedFile(user, { file_id: 'new', updatedAt: at(3), createdAt: at(1), text: 'n' });
        await seedFile(user, { file_id: 'mid', updatedAt: at(2), createdAt: at(2), text: 'm' });
      };

      it('orders by updatedAt newest first and leaves out text by default', async () => {
        await seedThree();
        const files = await stores().getFiles({ user });
        expect(fileIds(files)).toEqual(['new', 'mid', 'old']);
        for (const file of files ?? []) {
          expect(file).not.toHaveProperty('text');
          expect(file).toHaveProperty('filename', 'notes.txt');
        }
      });

      it('takes the updatedAt direction from the sort, and other keys after it', async () => {
        await seedThree();
        expect(fileIds(await stores().getFiles({ user }, { updatedAt: 1 }))).toEqual([
          'old',
          'mid',
          'new',
        ]);
        /** `createdAt` only breaks ties of `updatedAt`, which stays first. */
        expect(fileIds(await stores().getFiles({ user }, { createdAt: 1 }))).toEqual([
          'new',
          'mid',
          'old',
        ]);
        await seedFile(user, { file_id: 'tie-late', updatedAt: at(5), createdAt: at(9) });
        await seedFile(user, { file_id: 'tie-early', updatedAt: at(5), createdAt: at(8) });
        expect(fileIds(await stores().getFiles({ user }, { createdAt: 1 })).slice(0, 2)).toEqual([
          'tie-early',
          'tie-late',
        ]);
      });

      it('selects with an inclusion, an exclusion, or every field for an empty projection', async () => {
        await seedThree();
        const included = await stores().getFiles({ file_id: 'new' }, null, { file_id: 1, user: 1 });
        expect(included).toHaveLength(1);
        expect(Object.keys(included?.[0] ?? {}).sort()).toEqual(['_id', 'file_id', 'user']);
        const onlyText = await stores().getFiles({ file_id: 'new' }, null, { text: 1 });
        expect(Object.keys(onlyText?.[0] ?? {}).sort()).toEqual(['_id', 'text']);
        const excluded = await stores().getFiles({ file_id: 'new' }, null, { text: 0, bytes: 0 });
        expect(excluded?.[0]).not.toHaveProperty('text');
        expect(excluded?.[0]).not.toHaveProperty('bytes');
        expect(excluded?.[0]).toHaveProperty('filepath');
        const everything = await stores().getFiles({ file_id: 'new' }, null, {});
        expect(everything?.[0]).toMatchObject({ text: 'n', bytes: 100 });
      });

      it('applies a positive limit to the ordered result, and no limit otherwise', async () => {
        await seedThree();
        expect(fileIds(await stores().getFiles({ user }, null, null, 2))).toEqual(['new', 'mid']);
        expect(await stores().getFiles({ user }, null, null, 0)).toHaveLength(3);
        expect(await stores().getFiles({ user }, null, null, -1)).toHaveLength(3);
        expect(await stores().getFiles({ user }, null, null, null)).toHaveLength(3);
      });

      it('matches the operator filters callers pass', async () => {
        const other = newId();
        await seedFile(user, { file_id: 'a', width: 10, height: 20, tenantId: 'tenant-a' });
        await seedFile(user, { file_id: 'b', width: 10 });
        await seedFile(other, { file_id: 'c', filepath: '/avatars/x.png', context: 'avatar' });
        await seedFile(other, { file_id: 'd', filepath: '/avatars/x.png', context: 'avatar' });
        await seedFile(other, { file_id: 'e', filepath: '/avatars/x.png', context: 'avatar' });
        expect(sortedIds(await stores().getFiles({ file_id: { $in: ['a', 'b', 'c'] } }))).toEqual([
          'a',
          'b',
          'c',
        ]);
        expect(
          sortedIds(await stores().getFiles({ file_id: { $in: ['a', 'b', 'c'] }, user })),
        ).toEqual(['a', 'b']);
        expect(
          sortedIds(
            await stores().getFiles({ file_id: { $in: ['a', 'b'] }, tenantId: 'tenant-a' }),
          ),
        ).toEqual(['a']);
        expect(
          sortedIds(
            await stores().getFiles({
              file_id: { $in: ['a', 'b'] },
              height: { $exists: true },
              width: { $exists: true },
            }),
          ),
        ).toEqual(['a']);
        expect(
          await stores().getFiles({ filepath: '/avatars/x.png', context: 'avatar' }, null, null, 2),
        ).toHaveLength(2);
        expect(fileIds(await stores().getFiles({ file_id: 'missing' }))).toEqual([]);
      });

      it('matches the store id as given', async () => {
        const seeded = await seedFile(user, { file_id: 'by-id', text: 'body' });
        const files = await stores().getFiles({ _id: seeded._id as string }, null, { text: 1 });
        expect(files?.map((file) => [idOf(harness, file._id), file.text])).toEqual([
          [seeded._id, 'body'],
        ]);
      });
    });

    /* ------------------------------------------------------------------ project files */

    describe('getProjectFiles', () => {
      const user = '0123456789abcdef0123aaaa';
      const attachment = (record: RawRecord = {}) => ({
        context: FileContext.message_attachment,
        embedded: true,
        text: 'body',
        previewRevision: 'rev',
        status: 'ready',
        storageKey: 'key',
        metadata: { routingMimeType: 'text/plain', codeDestination: true },
        ...record,
      });

      it("lists the owner's searchable attachments, without content unless asked", async () => {
        await seedFile(user, { file_id: 'embedded', ...attachment() });
        await seedFile(user, {
          file_id: 'search',
          ...attachment({ embedded: false, metadata: { searchDestination: true } }),
        });
        await seedFile(user, {
          file_id: 'plain',
          ...attachment({ embedded: false, metadata: {} }),
        });
        await seedFile(user, { file_id: 'agent', ...attachment({ context: 'agents' }) });
        await seedFile(newId(), { file_id: 'foreign', ...attachment() });
        await seedFile(user, { file_id: 'tenanted', ...attachment({ tenantId: 'tenant-a' }) });
        const ids = ['embedded', 'search', 'plain', 'agent', 'foreign', 'tenanted', 'missing'];
        const files = await stores().getProjectFiles({ fileIds: ids, userId: user });
        expect(sortedIds(files)).toEqual(['embedded', 'search']);
        const embedded = files.find((file) => file.file_id === 'embedded');
        expect(embedded).toEqual({
          _id: expect.any(String),
          file_id: 'embedded',
          filename: 'notes.txt',
          filepath: '/uploads/notes.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 100,
          usage: 0,
          embedded: true,
          metadata: { routingMimeType: 'text/plain' },
          source: 'local',
          storageKey: 'key',
          context: FileContext.message_attachment,
          user,
          createdAt: at(0),
          updatedAt: at(0),
          previewRevision: 'rev',
          status: 'ready',
        });
        expect(files.find((file) => file.file_id === 'search')?.metadata).toEqual({
          searchDestination: true,
        });
        const withContent = await stores().getProjectFiles({
          fileIds: ['embedded'],
          userId: user,
          includeContent: true,
        });
        expect(withContent[0]).toMatchObject({ file_id: 'embedded', text: 'body' });
      });

      it('reads the given tenant, and the untenanted files for no tenant or an empty one', async () => {
        await seedFile(user, { file_id: 'tenanted', ...attachment({ tenantId: 'tenant-a' }) });
        await seedFile(user, { file_id: 'legacy', ...attachment() });
        await seedFile(user, { file_id: 'null-tenant', ...attachment({ tenantId: null }) });
        const fileIds = ['tenanted', 'legacy', 'null-tenant'];
        expect(
          sortedIds(
            await stores().getProjectFiles({ fileIds, userId: user, tenantId: 'tenant-a' }),
          ),
        ).toEqual(['tenanted']);
        for (const tenantId of [undefined, null, '']) {
          expect(
            sortedIds(await stores().getProjectFiles({ fileIds, userId: user, tenantId })),
          ).toEqual(['legacy', 'null-tenant']);
        }
      });
    });

    describe('getAvailableProjectFiles', () => {
      const user = '0123456789abcdef0123bbbb';
      const seedAvailable = async (_id: string, file_id: string, record: RawRecord = {}) =>
        seedFile(user, {
          _id,
          file_id,
          context: FileContext.message_attachment,
          embedded: true,
          text: 'never listed',
          ...record,
        });

      it('pages the eligible files newest first with an opaque cursor', async () => {
        const ids = ascendingIds(6);
        for (const [index, id] of ids.entries()) {
          await seedAvailable(id, `f${index}`);
        }
        const first = await stores().getAvailableProjectFiles({ userId: user, limit: 4 });
        expect(fileIds(first.files)).toEqual(['f5', 'f4', 'f3', 'f2']);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await stores().getAvailableProjectFiles({
          userId: user,
          limit: 4,
          cursor: first.nextCursor,
        });
        expect(fileIds(second.files)).toEqual(['f1', 'f0']);
        expect(second.nextCursor).toBeNull();
        const exact = await stores().getAvailableProjectFiles({ userId: user, limit: 6 });
        expect(exact.nextCursor).toBeNull();
        expect(exact.files[0]).toEqual({
          _id: ids[5],
          file_id: 'f5',
          filename: 'notes.txt',
          filepath: '/uploads/notes.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 100,
          usage: 0,
          embedded: true,
          context: FileContext.message_attachment,
          user,
        });
      });

      it('lists only unexpired searchable attachments of the owner that are not excluded', async () => {
        const now = at(100);
        const ids = ascendingIds(8);
        await seedAvailable(ids[0], 'kept');
        await seedAvailable(ids[1], 'search-only', {
          embedded: false,
          metadata: { searchDestination: true, routingMimeType: 'text/markdown' },
        });
        await seedAvailable(ids[2], 'future', { expiredAt: at(101) });
        await seedAvailable(ids[3], 'expired', { expiredAt: at(100) });
        await seedAvailable(ids[4], 'excluded');
        await seedAvailable(ids[5], 'not-searchable', { embedded: false });
        await seedAvailable(ids[6], 'agent-file', { context: 'agents' });
        await seedFile(newId(), {
          _id: ids[7],
          file_id: 'foreign',
          context: FileContext.message_attachment,
          embedded: true,
        });
        const result = await stores().getAvailableProjectFiles({
          userId: user,
          excludedFileIds: ['excluded'],
          now,
        });
        expect(fileIds(result.files)).toEqual(['future', 'search-only', 'kept']);
        expect(result.files[1].metadata).toEqual({
          searchDestination: true,
          routingMimeType: 'text/markdown',
        });
      });

      it('searches the filename literally and in any case', async () => {
        const ids = ascendingIds(3);
        await seedAvailable(ids[0], 'plain', { filename: 'Quarterly Report.pdf' });
        await seedAvailable(ids[1], 'regex', { filename: 'a+b (draft).txt' });
        await seedAvailable(ids[2], 'other', { filename: 'aab draft.txt' });
        const search = async (text: string) =>
          fileIds((await stores().getAvailableProjectFiles({ userId: user, search: text })).files);
        expect(await search('  quarterly REPORT ')).toEqual(['plain']);
        expect(await search('a+b (')).toEqual(['regex']);
        expect(await search('   ')).toEqual(['other', 'regex', 'plain']);
      });

      it('reads the given tenant, and the untenanted files for an empty one', async () => {
        const ids = ascendingIds(2);
        await seedAvailable(ids[0], 'legacy');
        await seedAvailable(ids[1], 'tenanted', { tenantId: 'tenant-a' });
        const list = async (tenantId?: string | null) =>
          fileIds((await stores().getAvailableProjectFiles({ userId: user, tenantId })).files);
        expect(await list('tenant-a')).toEqual(['tenanted']);
        expect(await list('')).toEqual(['legacy']);
        expect(await list(null)).toEqual(['legacy']);
      });

      it.each([0, 51, 1.5])('rejects the limit %p', async (limit) => {
        await expect(stores().getAvailableProjectFiles({ userId: user, limit })).rejects.toThrow(
          RangeError,
        );
      });

      it.each(['not-a-cursor', 'zzzzzzzzzzzzzzzzzzzzzzzz', 'abc'])(
        'rejects the cursor %p',
        async (cursor) => {
          await expect(
            stores().getAvailableProjectFiles({ userId: user, cursor }),
          ).rejects.toMatchObject({ name: 'InvalidAvailableProjectFilesCursorError' });
        },
      );
    });

    /* ------------------------------------------------------------------ expiry sweep */

    describe('expiry sweep', () => {
      const user = '0123456789abcdef0123cccc';

      it('lists files past their deadline and not held back, earliest deadline first', async () => {
        const now = at(100);
        await seedFile(user, { file_id: 'late', expiredAt: at(50) });
        await seedFile(user, { file_id: 'early', expiredAt: at(10) });
        await seedFile(user, { file_id: 'due-now', expiredAt: at(100) });
        await seedFile(user, { file_id: 'future', expiredAt: at(101) });
        await seedFile(user, { file_id: 'never' });
        await seedFile(user, { file_id: 'null', expiredAt: null });
        await seedFile(user, { file_id: 'held', expiredAt: at(5), deletionRetryAt: at(101) });
        await seedFile(user, { file_id: 'released', expiredAt: at(20), deletionRetryAt: at(99) });
        await seedFile(newId(), {
          file_id: 'other-owner',
          expiredAt: at(30),
          tenantId: 'tenant-a',
        });
        const expired = await stores().getExpiredFiles(100, { now });
        expect(fileIds(expired)).toEqual(['early', 'released', 'other-owner', 'late', 'due-now']);
        expect(fileIds(await stores().getExpiredFiles(2, { now }))).toEqual(['early', 'released']);
      });

      it('counts sweep failures and defers only later, without touching updatedAt', async () => {
        await seedFile(user, { file_id: 'stuck', expiredAt: at(1) });
        expect(await stores().incrementFileDeletionAttempts('stuck')).toBe(1);
        expect(await stores().incrementFileDeletionAttempts('stuck')).toBe(2);
        expect(await stores().incrementFileDeletionAttempts('missing')).toBe(0);
        await stores().deferExpiredFile('stuck', at(60));
        await stores().deferExpiredFile('stuck', at(30));
        await stores().deferExpiredFile('missing', at(30));
        const stored = await rawFile('stuck');
        expect(stored.deletionAttempts).toBe(2);
        expect(timeOf(stored.deletionRetryAt)).toBe(at(60).getTime());
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        expect(await harness.readRaw('files')).toHaveLength(1);
        expect(fileIds(await stores().getExpiredFiles(100, { now: at(59) }))).toEqual([]);
        expect(fileIds(await stores().getExpiredFiles(100, { now: at(60) }))).toEqual(['stuck']);
      });

      it('gives concurrent sweeps distinct attempt numbers', async () => {
        await seedFile(user, { file_id: 'raced', expiredAt: at(1) });
        const attempts = await Promise.all(
          Array.from({ length: 5 }, () => stores().incrementFileDeletionAttempts('raced')),
        );
        expect(attempts.sort()).toEqual([1, 2, 3, 4, 5]);
      });
    });

    /* ------------------------------------------------------------------ hydration */

    describe('getToolFilesByIds', () => {
      const user = '0123456789abcdef0123dddd';
      const seedTools = async () => {
        await seedFile(user, { file_id: 'embedded', embedded: true, text: 'e', updatedAt: at(1) });
        await seedFile(user, {
          file_id: 'context',
          context: FileContext.agents,
          text: 'c',
          updatedAt: at(3),
        });
        await seedFile(user, { file_id: 'context-no-text', context: FileContext.agents });
        await seedFile(user, {
          file_id: 'context-null-text',
          context: FileContext.agents,
          text: null,
        });
        await seedFile(user, {
          file_id: 'code-output',
          context: FileContext.execute_code,
          embedded: true,
        });
        await seedFile(user, { file_id: 'plain', updatedAt: at(2) });
      };
      const all = [
        'embedded',
        'context',
        'context-no-text',
        'context-null-text',
        'code-output',
        'plain',
      ];

      it('returns the files serving the requested resources, newest first, without text', async () => {
        await seedTools();
        const both = await stores().getToolFilesByIds(
          all,
          new Set([EToolResources.file_search, EToolResources.context]),
        );
        expect(fileIds(both)).toEqual(['context', 'embedded']);
        expect(both.some((file) => 'text' in file)).toBe(false);
        expect(
          fileIds(await stores().getToolFilesByIds(all, new Set([EToolResources.file_search]))),
        ).toEqual(['embedded']);
        expect(
          fileIds(await stores().getToolFilesByIds(all, new Set([EToolResources.context]))),
        ).toEqual(['context']);
      });

      it('is empty without ids or without a resource it serves', async () => {
        await seedTools();
        expect(await stores().getToolFilesByIds([], new Set([EToolResources.file_search]))).toEqual(
          [],
        );
        expect(await stores().getToolFilesByIds(all)).toEqual([]);
        expect(await stores().getToolFilesByIds(all, new Set())).toEqual([]);
        expect(
          await stores().getToolFilesByIds(all, new Set([EToolResources.execute_code])),
        ).toEqual([]);
      });

      it('limits the files to the owner scope, and to its tenant when it names one', async () => {
        await seedTools();
        await seedFile(newId(), { file_id: 'foreign', embedded: true });
        await seedFile(user, { file_id: 'tenanted', embedded: true, tenantId: 'tenant-a' });
        const ids = [...all, 'foreign', 'tenanted'];
        const search = new Set([EToolResources.file_search]);
        expect(sortedIds(await stores().getToolFilesByIds(ids, search))).toEqual([
          'embedded',
          'foreign',
          'tenanted',
        ]);
        expect(sortedIds(await stores().getToolFilesByIds(ids, search, { userId: user }))).toEqual([
          'embedded',
          'tenanted',
        ]);
        expect(
          sortedIds(
            await stores().getToolFilesByIds(ids, search, { userId: user, tenantId: 'tenant-a' }),
          ),
        ).toEqual(['tenanted']);
      });
    });

    describe('getCodeGeneratedFiles and getUserCodeFiles', () => {
      const user = '0123456789abcdef0123eeee';
      const conversationId = 'convo-code';
      let outputs = 0;
      /** A code output of the conversation; each under its own filename (one per filename). */
      const output = (record: RawRecord = {}) => ({
        context: FileContext.execute_code,
        conversationId,
        filename: `output-${++outputs}.csv`,
        text: 'hidden',
        ...record,
      });
      const seedCode = async () => {
        await seedFile(user, {
          file_id: 'ref',
          ...output({ metadata: { codeEnvRef: codeRef('r') }, createdAt: at(1), updatedAt: at(1) }),
        });
        await seedFile(user, {
          file_id: 'refs',
          ...output({
            metadata: { codeEnvRefs: { default: codeRef('rs') } },
            createdAt: at(2),
            updatedAt: at(2),
          }),
        });
        await seedFile(user, {
          file_id: 'destination',
          ...output({ metadata: { codeDestination: true }, createdAt: at(3), updatedAt: at(3) }),
        });
        await seedFile(user, { file_id: 'bare', ...output() });
        await seedFile(user, {
          file_id: 'other-convo',
          ...output({ conversationId: 'other', metadata: { codeDestination: true } }),
        });
        await seedFile(user, {
          file_id: 'upload',
          context: FileContext.message_attachment,
          conversationId,
          metadata: { codeEnvRef: codeRef('u') },
        });
      };
      const threadIds = ['ref', 'refs', 'destination', 'bare', 'other-convo', 'upload'];

      it("returns the conversation's code outputs referenced by the thread, without text", async () => {
        await seedCode();
        const files = await stores().getCodeGeneratedFiles(conversationId, threadIds);
        // NOTE(contract): the port documents these hydration reads as "oldest first" (they pass
        // `{ createdAt: 1 }`), but `getFiles` always sorts by `updatedAt` first (newest first)
        // and only breaks its ties by `createdAt`, so the order is newest update first.
        expect(fileIds(files)).toEqual(['destination', 'refs', 'ref']);
        expect(files.some((file) => 'text' in file)).toBe(false);
        expect(fileIds(await stores().getCodeGeneratedFiles(conversationId, ['ref']))).toEqual([
          'ref',
        ]);
      });

      it('is empty without a conversation or without thread file ids', async () => {
        await seedCode();
        expect(await stores().getCodeGeneratedFiles(conversationId)).toEqual([]);
        expect(await stores().getCodeGeneratedFiles(conversationId, [])).toEqual([]);
        expect(await stores().getCodeGeneratedFiles('', threadIds)).toEqual([]);
      });

      it('orders by the last update first, whatever the creation order', async () => {
        await seedFile(user, {
          file_id: 'created-first',
          ...output({ metadata: { codeDestination: true }, createdAt: at(1), updatedAt: at(9) }),
        });
        await seedFile(user, {
          file_id: 'created-last',
          ...output({ metadata: { codeDestination: true }, createdAt: at(5), updatedAt: at(6) }),
        });
        // NOTE(contract): see above; `createdAt` order would be the reverse.
        expect(
          fileIds(
            await stores().getCodeGeneratedFiles(conversationId, ['created-last', 'created-first']),
          ),
        ).toEqual(['created-first', 'created-last']);
      });

      it('returns uploads, not code outputs, carrying a code reference or meant for code', async () => {
        await seedCode();
        await seedFile(user, {
          file_id: 'upload-destination',
          context: FileContext.agents,
          metadata: { codeDestination: true },
          text: 'hidden',
        });
        await seedFile(user, { file_id: 'upload-bare', context: FileContext.agents });
        const files = await stores().getUserCodeFiles(
          [...threadIds, 'upload-destination', 'upload-bare'],
          { userId: user },
        );
        expect(sortedIds(files)).toEqual(['upload', 'upload-destination']);
        expect(files.some((file) => 'text' in file)).toBe(false);
        expect(await stores().getUserCodeFiles([], { userId: user })).toEqual([]);
      });

      it('limits both reads to the owner scope and its tenant', async () => {
        await seedCode();
        const stranger = { userId: newId() };
        expect(await stores().getCodeGeneratedFiles(conversationId, threadIds, stranger)).toEqual(
          [],
        );
        expect(await stores().getUserCodeFiles(threadIds, stranger)).toEqual([]);
        expect(
          sortedIds(
            await stores().getCodeGeneratedFiles(conversationId, threadIds, { userId: user }),
          ),
        ).toEqual(['destination', 'ref', 'refs']);
        expect(
          await stores().getUserCodeFiles(threadIds, { userId: user, tenantId: 'tenant-a' }),
        ).toEqual([]);
        expect(
          sortedIds(await stores().getUserCodeFiles(threadIds, { userId: user, tenantId: null })),
        ).toEqual(['upload']);
      });
    });

    describe('getDeferredProvisionFiles', () => {
      const user = '0123456789abcdef0123ffff';
      const owner = { userId: user };
      const seedDeferred = async () => {
        await seedFile(user, { file_id: 'bare', context: FileContext.message_attachment });
        await seedFile(user, {
          file_id: 'embedded',
          context: FileContext.message_attachment,
          embedded: true,
        });
        await seedFile(user, {
          file_id: 'coded',
          context: FileContext.message_attachment,
          metadata: { codeEnvRefs: { default: codeRef('c') } },
        });
        await seedFile(user, {
          file_id: 'both',
          context: FileContext.message_attachment,
          embedded: true,
          metadata: { codeEnvRefs: { default: codeRef('b') } },
        });
        await seedFile(user, {
          file_id: 'output',
          context: FileContext.execute_code,
          text: 'never',
        });
      };
      const ids = ['bare', 'embedded', 'coded', 'both', 'output'];

      it('returns the files lacking any requested result, by default code and search', async () => {
        await seedDeferred();
        expect(sortedIds(await stores().getDeferredProvisionFiles(ids, owner))).toEqual([
          'bare',
          'coded',
          'embedded',
        ]);
        expect(
          sortedIds(await stores().getDeferredProvisionFiles(ids, owner, { code: true })),
        ).toEqual(['bare', 'embedded']);
        expect(
          sortedIds(await stores().getDeferredProvisionFiles(ids, owner, { search: true })),
        ).toEqual(['bare', 'coded']);
        expect(await stores().getDeferredProvisionFiles(ids, owner, {})).toEqual([]);
        expect(await stores().getDeferredProvisionFiles([], owner)).toEqual([]);
      });

      it('returns every eligible file to hydrate when nothing else does', async () => {
        await seedDeferred();
        const files = await stores().getDeferredProvisionFiles(ids, owner, {
          search: true,
          hydrateProvisioned: true,
        });
        expect(sortedIds(files)).toEqual(['bare', 'both', 'coded', 'embedded']);
        expect(files.some((file) => 'text' in file)).toBe(false);
        expect(
          await stores().getDeferredProvisionFiles(ids, owner, { hydrateProvisioned: true }),
        ).toEqual([]);
      });

      it('judges a code reference against the route this turn executes on', async () => {
        const attachment = (file_id: string, metadata: RawRecord) =>
          seedFile(user, { file_id, context: FileContext.message_attachment, metadata });
        await attachment('route-stateful', { codeEnvRefs: { stateful: codeRef('s') } });
        await attachment('legacy-default', { codeEnvRef: codeRef('l') });
        await attachment('legacy-profile', {
          codeEnvRef: codeRef('p', { executionProfile: 'stateful' }),
        });
        await attachment('legacy-route', {
          codeEnvRef: codeRef('r', { executionRouteKey: 'stateful' }),
        });
        const routeIds = ['route-stateful', 'legacy-default', 'legacy-profile', 'legacy-route'];
        expect(
          sortedIds(await stores().getDeferredProvisionFiles(routeIds, owner, { code: true })),
        ).toEqual(['legacy-profile', 'legacy-route', 'route-stateful']);
        expect(
          sortedIds(
            await stores().getDeferredProvisionFiles(routeIds, owner, {
              code: true,
              codeRouteKey: 'stateful',
            }),
          ),
        ).toEqual(['legacy-default']);
      });

      it('judges agent files by the candidate search namespaces', async () => {
        const agentFile = (file_id: string, record: RawRecord) =>
          seedFile(user, { file_id, context: FileContext.agents, ...record });
        await agentFile('in-a', { embedded: true, metadata: { embeddedEntities: ['agent-a'] } });
        await agentFile('in-both', {
          embedded: true,
          metadata: { embeddedEntities: ['agent-a', 'agent-b'] },
        });
        await agentFile('flag-only', { embedded: true });
        await seedFile(user, {
          file_id: 'attachment',
          context: FileContext.message_attachment,
          embedded: true,
        });
        const namespaceIds = ['in-a', 'in-both', 'flag-only', 'attachment'];
        expect(
          sortedIds(
            await stores().getDeferredProvisionFiles(namespaceIds, owner, {
              search: true,
              searchNamespaces: ['agent-a', 'agent-b'],
            }),
          ),
        ).toEqual(['flag-only', 'in-a']);
        expect(
          await stores().getDeferredProvisionFiles(namespaceIds, owner, { search: true }),
        ).toEqual([]);
      });

      it.each(['', 'a.b', '$route'])('rejects the route key %p', async (codeRouteKey) => {
        await expect(
          stores().getDeferredProvisionFiles(['x'], owner, { code: true, codeRouteKey }),
        ).rejects.toThrow('Invalid code environment route key');
      });

      it('stays within the owner scope', async () => {
        await seedDeferred();
        expect(await stores().getDeferredProvisionFiles(ids, { userId: newId() })).toEqual([]);
        expect(
          await stores().getDeferredProvisionFiles(ids, { userId: user, tenantId: 'tenant-a' }),
        ).toEqual([]);
      });
    });

    /* ------------------------------------------------------------------ code outputs */

    describe('claimCodeFile and commitCodeFile', () => {
      const user = '0123456789abcdef01230001';
      const claim = {
        filename: 'out.csv',
        conversationId: 'convo-out',
        file_id: 'claimed',
        user,
        sourceDispatchedAt: 100,
      };
      const output = (record: Record<string, unknown> = {}) => ({
        file_id: 'claimed',
        user,
        filename: 'out.csv',
        conversationId: 'convo-out',
        context: FileContext.execute_code,
        filepath: '/uploads/out.csv',
        type: 'text/csv',
        bytes: 42,
        source: FileSources.local,
        ...record,
      });

      it('inserts a reservation under the given id, as a bookkeeping write without timestamps', async () => {
        const claimed = await stores().claimCodeFile(claim);
        expect(claimed).toMatchObject({
          file_id: 'claimed',
          filename: 'out.csv',
          conversationId: 'convo-out',
          context: FileContext.execute_code,
          embeddingOwnersComplete: true,
          metadata: { sourceDispatchedAt: 100 },
        });
        expect(idOf(harness, claimed.user)).toBe(user);
        const stored = await rawFile('claimed');
        expect(stored.tenantId ?? null).toBeNull();
        expect(stored).not.toHaveProperty('createdAt');
        expect(stored).not.toHaveProperty('updatedAt');
      });

      it('converges later claims of the filename on the first record, unchanged', async () => {
        await stores().claimCodeFile(claim);
        const before = await rawFile('claimed');
        const again = await stores().claimCodeFile({
          ...claim,
          file_id: 'second',
          user: newId(),
          sourceDispatchedAt: 200,
        });
        expect(again.file_id).toBe('claimed');
        expect(await harness.readRaw('files')).toEqual([before]);
      });

      it('keeps one namespace per tenant, null and absent being the untenanted one', async () => {
        await stores().claimCodeFile({ ...claim, tenantId: 'tenant-a', file_id: 'in-a' });
        await stores().claimCodeFile({ ...claim, tenantId: 'tenant-b', file_id: 'in-b' });
        await stores().claimCodeFile({ ...claim, tenantId: null, file_id: 'legacy' });
        expect((await stores().claimCodeFile({ ...claim, file_id: 'legacy-again' })).file_id).toBe(
          'legacy',
        );
        expect(
          (await stores().claimCodeFile({ ...claim, tenantId: 'tenant-a', file_id: 'x' })).file_id,
        ).toBe('in-a');
        expect(sortedIds((await harness.readRaw('files')) as Array<{ file_id: string }>)).toEqual([
          'in-a',
          'in-b',
          'legacy',
        ]);
        expect((await rawFile('in-a')).tenantId).toBe('tenant-a');
      });

      it.each([
        { deletionPending: true },
        { deleting: 'deletion-owner' },
        { provisioning: ['provision-owner'] },
      ])('refuses a claim of a fenced filename: %j', async (storageOperations) => {
        await seedFile(user, {
          file_id: 'fenced',
          filename: 'out.csv',
          conversationId: 'convo-out',
          context: FileContext.execute_code,
          storageOperations,
        });
        await expect(stores().claimCodeFile(claim)).rejects.toMatchObject({
          name: 'FileStorageConflictError',
          code: 'FILE_STORAGE_CONFLICT',
        });
        expect(await harness.readRaw('files')).toHaveLength(1);
        expect(
          (await stores().claimCodeFile({ ...claim, filename: 'other.csv', file_id: 'free' }))
            .file_id,
        ).toBe('free');
      });

      it('commits without a dispatch stamp as a permanent createFile', async () => {
        await stores().claimCodeFile(claim);
        expect(await stores().commitCodeFile(output())).toBe(true);
        const stored = await rawFile('claimed');
        expect(stored).toMatchObject({ bytes: 42, filepath: '/uploads/out.csv' });
        expect(stored).not.toHaveProperty('expiresAt');
        expect(stored).toHaveProperty('updatedAt');
      });

      it('commits with a dispatch stamp only for the newest dispatch of the owner', async () => {
        await stores().claimCodeFile(claim);
        expect(await stores().commitCodeFile(output({ bytes: 1 }), 99)).toBe(false);
        expect(await stores().commitCodeFile(output({ bytes: 2, user: newId() }), 150)).toBe(false);
        expect(await stores().commitCodeFile(output({ bytes: 3, tenantId: 'tenant-a' }), 150)).toBe(
          false,
        );
        expect(await stores().commitCodeFile(output({ bytes: 4 }), 100)).toBe(true);
        expect((await rawFile('claimed')).bytes).toBe(4);
        expect(
          await stores().commitCodeFile(
            output({ bytes: 5, metadata: { sourceDispatchedAt: 300 } }),
            300,
          ),
        ).toBe(true);
        expect(await stores().commitCodeFile(output({ bytes: 6 }), 200)).toBe(false);
        expect((await rawFile('claimed')).bytes).toBe(5);
        expect(await stores().commitCodeFile(output({ file_id: 'missing' }), 500)).toBe(false);
      });

      it('commits a record without a dispatch stamp for any dispatch', async () => {
        await seedFile(user, {
          file_id: 'claimed',
          filename: 'out.csv',
          conversationId: 'convo-out',
          context: FileContext.execute_code,
        });
        expect(await stores().commitCodeFile(output({ bytes: 7 }), 1)).toBe(true);
        expect((await rawFile('claimed')).bytes).toBe(7);
      });

      it.each([
        { deletionPending: true },
        { deleting: 'deletion-owner' },
        { provisioning: ['provision-owner'] },
      ])('refuses commits while a storage operation holds the record: %j', async (operations) => {
        await stores().claimCodeFile(claim);
        await harness.reset();
        await seedFile(user, {
          file_id: 'claimed',
          filename: 'out.csv',
          conversationId: 'convo-out',
          context: FileContext.execute_code,
          metadata: { sourceDispatchedAt: 100 },
          storageOperations: operations,
        });
        const before = await rawFile('claimed');
        await expect(stores().commitCodeFile(output())).rejects.toMatchObject({
          name: 'FileStorageConflictError',
        });
        expect(await stores().commitCodeFile(output(), 200)).toBe(false);
        expect(await harness.readRaw('files')).toEqual([before]);
      });
    });

    /* ------------------------------------------------------------------ writes */

    describe('createFile', () => {
      const user = '0123456789abcdef01230002';
      const upload = (record: Record<string, unknown> = {}) =>
        asFile({
          file_id: 'upload',
          user,
          filename: 'a.txt',
          filepath: '/uploads/a.txt',
          type: 'text/plain',
          bytes: 5,
          object: 'file',
          ...record,
        });

      it('creates the record expiring in an hour, with schema defaults and timestamps', async () => {
        const before = Date.now();
        const created = await stores().createFile(upload());
        expect(created).toMatchObject({
          file_id: 'upload',
          filename: 'a.txt',
          usage: 0,
          source: FileSources.local,
          embeddingOwnersComplete: true,
        });
        expect(idOf(harness, created?.user)).toBe(user);
        const stored = await rawFile('upload');
        expect(timeOf(stored.expiresAt)).toBeGreaterThanOrEqual(before + HOUR - MINUTE);
        expect(timeOf(stored.expiresAt)).toBeLessThanOrEqual(Date.now() + HOUR);
        expect(timeOf(stored.createdAt)).toBeGreaterThanOrEqual(before);
        expect(stored).toHaveProperty('embeddingOwnersTrackedAt');
      });

      it('creates a permanent record with disableTTL', async () => {
        await stores().createFile(upload(), true);
        expect(await rawFile('upload')).not.toHaveProperty('expiresAt');
      });

      it('writes over an existing record, merging metadata and only adding embedding owners', async () => {
        await seedFile(user, {
          file_id: 'upload',
          embeddingOwnersComplete: false,
          metadata: { embeddedEntities: ['agent-a'], routingMimeType: 'text/plain' },
          createdAt: at(0),
          updatedAt: at(0),
        });
        const written = await stores().createFile(
          upload({
            bytes: 9,
            embeddingOwnersComplete: true,
            metadata: { embeddedEntities: ['agent-b'], codeDestination: true },
          }),
          true,
        );
        expect(written?.bytes).toBe(9);
        const stored = await rawFile('upload');
        expect(stored.embeddingOwnersComplete).toBe(false);
        expect(metadataOf(stored)).toEqual({
          embeddedEntities: ['agent-a', 'agent-b'],
          routingMimeType: 'text/plain',
          codeDestination: true,
        });
        expect(timeOf(stored.updatedAt)).toBeGreaterThan(at(0).getTime());
        expect(timeOf(stored.createdAt)).toBe(at(0).getTime());
        expect(await harness.readRaw('files')).toHaveLength(1);
      });

      it('rejects invalid metadata', async () => {
        await expect(stores().createFile(upload({ metadata: { 'a.b': 1 } }))).rejects.toThrow(
          'Invalid file metadata key',
        );
        await expect(stores().createFile(upload({ metadata: [] }))).rejects.toThrow(
          'Invalid file metadata',
        );
        await expect(
          stores().createFile(upload({ metadata: { embeddedEntities: [''] } })),
        ).rejects.toThrow('Invalid file embedding snapshot');
        expect(await harness.readRaw('files')).toEqual([]);
      });

      it("writes a code output only over the owner's unfenced record", async () => {
        const codeOutput = (record: Record<string, unknown> = {}) =>
          upload({
            file_id: 'output',
            filename: 'out.csv',
            conversationId: 'convo-out',
            context: FileContext.execute_code,
            ...record,
          });
        await stores().createFile(codeOutput(), true);
        expect((await stores().createFile(codeOutput({ bytes: 6 }), true))?.bytes).toBe(6);
        await expect(
          stores().createFile(codeOutput({ user: newId(), bytes: 7 }), true),
        ).rejects.toMatchObject({ name: 'FileStorageConflictError' });
        expect((await harness.readRaw('files')).map((record) => record.bytes)).toEqual([6]);
      });
    });

    describe('updateFile', () => {
      const user = '0123456789abcdef01230003';

      it('writes the fields, clears the upload expiry and advances updatedAt', async () => {
        await seedFile(user, {
          file_id: 'doc',
          expiresAt: at(60),
          metadata: { routingMimeType: 'text/plain', embeddedEntities: ['a'] },
        });
        const updated = await stores().updateFile(
          asFile({
            file_id: 'doc',
            filename: 'renamed.txt',
            metadata: { codeDestination: true, embeddedEntities: ['b'] },
          }),
        );
        expect(updated?.filename).toBe('renamed.txt');
        const stored = await rawFile('doc');
        expect(stored).not.toHaveProperty('expiresAt');
        expect(timeOf(stored.updatedAt)).toBeGreaterThan(at(0).getTime());
        expect(metadataOf(stored)).toEqual({
          routingMimeType: 'text/plain',
          codeDestination: true,
          embeddedEntities: ['a', 'b'],
        });
      });

      it('clears the expiry alone without posing as a content write', async () => {
        await seedFile(user, { file_id: 'doc', expiresAt: at(60) });
        const updated = await stores().updateFile({ file_id: 'doc' });
        expect(timeOf(updated?.updatedAt)).toBe(at(0).getTime());
        const stored = await rawFile('doc');
        expect(stored).not.toHaveProperty('expiresAt');
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
      });

      it('writes only while the record matches the extra conditions callers pass', async () => {
        await seedFile(user, {
          file_id: 'preview',
          status: 'pending',
          previewRevision: 'rev-2',
          updatedAt: at(5),
        });
        expect(
          await stores().updateFile(asFile({ file_id: 'preview', status: 'ready' }), {
            previewRevision: 'rev-1',
          }),
        ).toBeNull();
        expect(
          await stores().updateFile(asFile({ file_id: 'preview', status: 'ready' }), {
            status: 'pending',
            updatedAt: at(4),
          }),
        ).toBeNull();
        expect((await rawFile('preview')).status).toBe('pending');
        const committed = await stores().updateFile(
          asFile({ file_id: 'preview', status: 'ready', text: '<p>' }),
          { previewRevision: 'rev-2' },
        );
        expect(committed).toMatchObject({ status: 'ready', text: '<p>' });
        expect(
          await stores().updateFile(asFile({ file_id: 'preview', status: 'failed' }), {
            status: 'ready',
            updatedAt: committed?.updatedAt as Date,
          }),
        ).toMatchObject({ status: 'failed' });
      });

      it('resolves null and creates nothing for a missing file', async () => {
        expect(await stores().updateFile(asFile({ file_id: 'missing', bytes: 1 }))).toBeNull();
        expect(await harness.readRaw('files')).toEqual([]);
      });
    });

    describe('updateFileCodeEnvRef', () => {
      const user = '0123456789abcdef01230004';

      it('stores one route, keeps the others and the rest of the metadata, clears the expiry', async () => {
        await seedFile(user, {
          file_id: 'doc',
          expiresAt: at(60),
          metadata: { codeEnvRefs: { stateful: codeRef('s') }, routingMimeType: 'text/csv' },
        });
        const updated = await stores().updateFileCodeEnvRef({
          file_id: 'doc',
          routeKey: 'default',
          ref: codeRef('d'),
          legacyRef: codeRef('legacy'),
        });
        expect(updated?.metadata?.codeEnvRefs).toEqual({
          stateful: codeRef('s'),
          default: codeRef('d'),
        });
        const stored = await rawFile('doc');
        expect(metadataOf(stored)).toEqual({
          codeEnvRefs: { stateful: codeRef('s'), default: codeRef('d') },
          codeEnvRef: codeRef('legacy'),
          routingMimeType: 'text/csv',
        });
        expect(stored).not.toHaveProperty('expiresAt');
        expect(timeOf(stored.updatedAt)).toBeGreaterThan(at(0).getTime());
      });

      it('resolves null for a missing file and rejects an unsafe route key', async () => {
        expect(
          await stores().updateFileCodeEnvRef({
            file_id: 'x',
            routeKey: 'default',
            ref: codeRef('d'),
          }),
        ).toBeNull();
        await seedFile(user, { file_id: 'doc' });
        await expect(
          stores().updateFileCodeEnvRef({ file_id: 'doc', routeKey: 'a.b', ref: codeRef('d') }),
        ).rejects.toThrow('Invalid code environment route key');
        expect(metadataOf(await rawFile('doc'))).toEqual({});
      });
    });

    describe('clearFileCodeEnvRefs', () => {
      const user = '0123456789abcdef01230005';
      const scope = { file_id: 'doc', userId: user };

      it('removes the routes still holding the given references and marks the file for code', async () => {
        await seedFile(user, {
          file_id: 'doc',
          metadata: {
            codeEnvRefs: { default: codeRef('d'), stateful: codeRef('s') },
            codeEnvRef: codeRef('d'),
            routingMimeType: 'text/csv',
          },
          expiresAt: at(60),
        });
        expect(
          await stores().clearFileCodeEnvRefs({
            ...scope,
            refs: [{ routeKey: 'default', ref: codeRef('d') }],
          }),
        ).toBe(true);
        const stored = await rawFile('doc');
        expect(metadataOf(stored)).toEqual({
          codeEnvRefs: { stateful: codeRef('s') },
          codeDestination: true,
          routingMimeType: 'text/csv',
        });
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        expect(timeOf(stored.expiresAt)).toBe(at(60).getTime());
        expect(await stores().clearFileCodeEnvRefs({ ...scope, refs: [] })).toBe(false);
      });

      it('keeps a reference replaced since the snapshot, and reports the route as held', async () => {
        await seedFile(user, {
          file_id: 'doc',
          metadata: { codeEnvRefs: { default: codeRef('new') } },
        });
        expect(
          await stores().clearFileCodeEnvRefs({
            ...scope,
            refs: [{ routeKey: 'default', ref: codeRef('old') }],
          }),
        ).toBe(false);
        expect(metadataOf(await rawFile('doc')).codeEnvRefs).toEqual({ default: codeRef('new') });
      });

      it('compares every field of the reference, absent optional fields included, in any key order', async () => {
        await seedFile(user, {
          file_id: 'doc',
          metadata: {
            codeEnvRefs: {
              default: {
                provisionedAt: 5,
                file_id: 'd',
                storage_session_id: 'session',
                id: 'owner',
                kind: 'user',
              },
              stateful: codeRef('s', { provisionedAt: 9 }),
            },
          },
        });
        expect(
          await stores().clearFileCodeEnvRefs({
            ...scope,
            refs: [
              { routeKey: 'default', ref: codeRef('d', { provisionedAt: 5 }) },
              { routeKey: 'stateful', ref: codeRef('s') },
            ],
          }),
        ).toBe(false);
        expect(metadataOf(await rawFile('doc')).codeEnvRefs).toEqual({
          stateful: codeRef('s', { provisionedAt: 9 }),
        });
      });

      it('confirms absence of every route with no references, and is false for another owner', async () => {
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-a' });
        expect(
          await stores().clearFileCodeEnvRefs({ ...scope, tenantId: 'tenant-a', refs: [] }),
        ).toBe(true);
        expect(await stores().clearFileCodeEnvRefs({ ...scope, refs: [] })).toBe(false);
        expect(
          await stores().clearFileCodeEnvRefs({
            ...scope,
            userId: newId(),
            tenantId: 'tenant-a',
            refs: [],
          }),
        ).toBe(false);
        await expect(
          stores().clearFileCodeEnvRefs({
            ...scope,
            refs: [{ routeKey: '$bad', ref: codeRef('x') }],
          }),
        ).rejects.toThrow('Invalid code environment route key');
      });
    });

    describe('addFileEmbeddedEntity and adoptLegacySearchEmbeddings', () => {
      const user = '0123456789abcdef01230006';

      it('records a namespace once, marks the file embedded and clears the expiry', async () => {
        await seedFile(user, { file_id: 'doc', expiresAt: at(60) });
        await stores().addFileEmbeddedEntity({ file_id: 'doc', entityId: 'agent-a' });
        const updated = await stores().addFileEmbeddedEntity({
          file_id: 'doc',
          entityId: 'agent-a',
        });
        expect(updated?.embedded).toBe(true);
        await stores().addFileEmbeddedEntity({ file_id: 'doc', entityId: 'agent-b' });
        const stored = await rawFile('doc');
        expect(metadataOf(stored).embeddedEntities).toEqual(['agent-a', 'agent-b']);
        expect(stored).not.toHaveProperty('expiresAt');
        expect(timeOf(stored.updatedAt)).toBeGreaterThan(at(0).getTime());
        expect(await stores().addFileEmbeddedEntity({ file_id: 'x', entityId: 'a' })).toBeNull();
      });

      it("records the agent's namespace on the owner's embedded agent files only", async () => {
        const other = newId();
        const agentFile = (owner: string, record: RawRecord) =>
          seedFile(owner, { context: FileContext.agents, embedded: true, ...record });
        await agentFile(user, { file_id: 'legacy', metadata: { embeddedEntities: ['old'] } });
        await agentFile(user, { file_id: 'legacy', tenantId: 'tenant-a' });
        await agentFile(other, { file_id: 'foreign' });
        await agentFile(user, { file_id: 'unembedded', embedded: false });
        await seedFile(user, { file_id: 'attachment', embedded: true });
        const adopted = await stores().adoptLegacySearchEmbeddings({
          agentId: 'agent-x',
          files: [
            { file_id: 'legacy', user },
            { file_id: 'foreign', user },
            { file_id: 'unembedded', user },
            { file_id: 'attachment', user },
            { file_id: 'missing', user },
          ],
        });
        expect(adopted).toEqual(['legacy']);
        expect(
          metadataOf(await rawFile('legacy', { tenantId: undefined })).embeddedEntities,
        ).toEqual(['old', 'agent-x']);
        expect(metadataOf(await rawFile('legacy', { tenantId: 'tenant-a' }))).toEqual({});
        expect(
          await stores().adoptLegacySearchEmbeddings({
            agentId: 'agent-y',
            files: [{ file_id: 'legacy', user, tenantId: 'tenant-a' }],
          }),
        ).toEqual(['legacy']);
        expect(await stores().adoptLegacySearchEmbeddings({ agentId: 'a', files: [] })).toEqual([]);
      });
    });

    describe('recordFileWorkspaceImport', () => {
      const user = '0123456789abcdef01230007';
      const key = 'a'.repeat(32);
      const target = { sha256: 'b'.repeat(64), path: 'src/a.txt' };

      it('records copies and the digest beside the existing ones, as bookkeeping', async () => {
        await seedFile(user, {
          file_id: 'doc',
          metadata: {
            routingMimeType: 'text/plain',
            workspaceImports: { targets: { ['c'.repeat(32)]: { sha256: 'c', path: 'c' } } },
          },
        });
        expect(
          await stores().recordFileWorkspaceImport({ file_id: 'doc', user, copy: { key, target } }),
        ).toBe(true);
        const digest = { source: 'storage', sha256: 'd'.repeat(64), bytes: 100 };
        expect(await stores().recordFileWorkspaceImport({ file_id: 'doc', user, digest })).toBe(
          true,
        );
        const stored = await rawFile('doc');
        expect(metadataOf(stored)).toEqual({
          routingMimeType: 'text/plain',
          workspaceImports: {
            targets: { ['c'.repeat(32)]: { sha256: 'c', path: 'c' }, [key]: target },
            digest,
          },
        });
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
      });

      it('never marks another owner or tenant, and records nothing without a copy or digest', async () => {
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-a' });
        const copy = { key, target };
        expect(await stores().recordFileWorkspaceImport({ file_id: 'doc', user, copy })).toBe(
          false,
        );
        expect(
          await stores().recordFileWorkspaceImport({
            file_id: 'doc',
            user: newId(),
            tenantId: 'tenant-a',
            copy,
          }),
        ).toBe(false);
        expect(
          await stores().recordFileWorkspaceImport({ file_id: 'doc', user, tenantId: 'tenant-a' }),
        ).toBe(false);
        expect(metadataOf(await rawFile('doc'))).toEqual({});
        expect(
          await stores().recordFileWorkspaceImport({
            file_id: 'doc',
            user,
            tenantId: 'tenant-a',
            copy,
          }),
        ).toBe(true);
      });

      it.each(['short', 'A'.repeat(32), `${'a'.repeat(32)}.x`])(
        'rejects the copy key %p',
        async (badKey) => {
          await seedFile(user, { file_id: 'doc' });
          await expect(
            stores().recordFileWorkspaceImport({
              file_id: 'doc',
              user,
              copy: { key: badKey, target },
            }),
          ).rejects.toThrow('Workspace import keys must be hex digests');
        },
      );
    });

    describe('clearFileEmbeddings and isFileStorageClean', () => {
      const user = '0123456789abcdef01230008';
      const tracked = new Date(Date.now() - HOUR);

      it('clears the embedding snapshot whose vectors were deleted', async () => {
        await seedFile(user, {
          file_id: 'doc',
          embedded: true,
          embeddingOwnersComplete: true,
          embeddingOwnersTrackedAt: tracked,
          metadata: { embeddedEntities: ['agent-a'], codeEnvRef: codeRef('c') },
          updatedAt: at(3),
          expiresAt: at(60),
        });
        const snapshot = {
          file_id: 'doc',
          userId: user,
          updatedAt: at(3),
          embeddedEntities: ['agent-a'],
          ownershipTrackingStart: new Date(tracked.getTime() - MINUTE).toISOString(),
        };
        expect(await stores().clearFileEmbeddings({ ...snapshot, updatedAt: at(4) })).toBe(false);
        expect(await stores().clearFileEmbeddings({ ...snapshot, embeddedEntities: ['b'] })).toBe(
          false,
        );
        expect(
          await stores().clearFileEmbeddings({
            ...snapshot,
            ownershipTrackingStart: new Date(tracked.getTime() + MINUTE).toISOString(),
          }),
        ).toBe(false);
        expect(await stores().clearFileEmbeddings({ ...snapshot, userId: newId() })).toBe(false);
        expect(await stores().clearFileEmbeddings(snapshot)).toBe(true);
        const stored = await rawFile('doc');
        expect(stored.embedded).toBe(false);
        expect(metadataOf(stored)).toEqual({ searchDestination: true, codeEnvRef: codeRef('c') });
        expect(timeOf(stored.updatedAt)).toBe(at(3).getTime());
        expect(timeOf(stored.expiresAt)).toBe(at(60).getTime());
      });

      it('confirms an already cleared record, and nothing for an untracked embedded one', async () => {
        await seedFile(user, { file_id: 'cleared', embedded: false, updatedAt: at(1) });
        await seedFile(user, { file_id: 'untracked', embedded: true, updatedAt: at(1) });
        expect(
          await stores().clearFileEmbeddings({
            file_id: 'cleared',
            userId: user,
            updatedAt: at(1),
          }),
        ).toBe(true);
        expect(
          await stores().clearFileEmbeddings({
            file_id: 'untracked',
            userId: user,
            updatedAt: at(1),
          }),
        ).toBe(false);
      });

      it('reports clean storage only for the unchanged snapshot without provisioning results', async () => {
        await seedFile(user, { file_id: 'clean', updatedAt: at(1), source: 'local' });
        await seedFile(user, {
          file_id: 'coded',
          updatedAt: at(1),
          metadata: { codeEnvRefs: { default: codeRef('c') } },
        });
        await seedFile(user, {
          file_id: 'provisioning',
          updatedAt: at(1),
          storageOperations: { provisioning: ['token'] },
        });
        await seedFile(user, {
          file_id: 'deleting',
          updatedAt: at(1),
          storageOperations: { deleting: 't' },
        });
        await seedFile(user, { file_id: 'embedded', updatedAt: at(1), embedded: true });
        await seedFile(user, {
          file_id: 'vectors',
          updatedAt: at(1),
          source: FileSources.vectordb,
          embedded: true,
          metadata: { embeddedEntities: ['agent-a'] },
        });
        const clean = (file_id: string, extra: Record<string, unknown> = {}) =>
          stores().isFileStorageClean({ file_id, userId: user, updatedAt: at(1), ...extra });
        expect(await clean('clean')).toBe(true);
        expect(await clean('clean', { updatedAt: at(2) })).toBe(false);
        expect(await clean('clean', { userId: newId() })).toBe(false);
        expect(await clean('clean', { tenantId: 'tenant-a' })).toBe(false);
        expect(await clean('coded')).toBe(false);
        expect(await clean('provisioning')).toBe(false);
        expect(await clean('deleting')).toBe(true);
        expect(await clean('embedded')).toBe(false);
        expect(
          await clean('vectors', {
            source: FileSources.vectordb,
            embedded: true,
            embeddedEntities: ['agent-a'],
          }),
        ).toBe(true);
        expect(
          await clean('vectors', {
            source: FileSources.vectordb,
            embedded: true,
            embeddedEntities: ['x'],
          }),
        ).toBe(false);
      });

      it('accepts a missing record only for provider-hosted files that allow it', async () => {
        const missing = { file_id: 'gone', userId: user, allowMissingFileRecord: true };
        expect(await stores().isFileStorageClean({ ...missing, source: FileSources.openai })).toBe(
          true,
        );
        expect(await stores().isFileStorageClean({ ...missing, source: FileSources.azure })).toBe(
          true,
        );
        expect(await stores().isFileStorageClean({ ...missing, source: FileSources.local })).toBe(
          false,
        );
        expect(
          await stores().isFileStorageClean({
            file_id: 'gone',
            userId: user,
            source: FileSources.openai,
          }),
        ).toBe(false);
        await seedFile(user, { file_id: 'gone', source: FileSources.openai, embedded: true });
        expect(await stores().isFileStorageClean({ ...missing, source: FileSources.openai })).toBe(
          false,
        );
      });
    });

    describe('updateFileUsage and updateFilesUsage', () => {
      const user = '0123456789abcdef01230009';

      it('counts usage and clears the upload expiry and temporary id, as bookkeeping', async () => {
        await seedFile(user, { file_id: 'doc', usage: 2, expiresAt: at(60), temp_file_id: 'tmp' });
        const updated = await stores().updateFileUsage({ file_id: 'doc' });
        expect(updated?.usage).toBe(3);
        expect((await stores().updateFileUsage({ file_id: 'doc', inc: 5 }))?.usage).toBe(8);
        const stored = await rawFile('doc');
        expect(stored).not.toHaveProperty('expiresAt');
        expect(stored).not.toHaveProperty('temp_file_id');
        expect(timeOf(stored.updatedAt)).toBe(at(0).getTime());
        expect(await stores().updateFileUsage({ file_id: 'missing' })).toBeNull();
      });

      it("touches only the owner's file, in its tenant when it names one", async () => {
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-a', expiresAt: at(60) });
        expect(await stores().updateFileUsage({ file_id: 'doc', user: newId() })).toBeNull();
        expect(
          await stores().updateFileUsage({ file_id: 'doc', user, tenantId: 'tenant-b' }),
        ).toBeNull();
        expect(await rawFile('doc')).toMatchObject({ usage: 0 });
        expect((await rawFile('doc')).expiresAt).toBeDefined();
        expect((await stores().updateFileUsage({ file_id: 'doc', user }))?.usage).toBe(1);
        expect(
          (await stores().updateFileUsage({ file_id: 'doc', user, tenantId: 'tenant-a' }))?.usage,
        ).toBe(2);
      });

      it('counts each distinct id once across both lists and skips missing files', async () => {
        await seedFile(user, { file_id: 'a' });
        await seedFile(user, { file_id: 'b' });
        await seedFile(newId(), { file_id: 'c' });
        const updated = await stores().updateFilesUsage(
          [{ file_id: 'a' }, { file_id: 'a' }, { file_id: 'missing' }],
          ['a', 'b', 'c', 'b'],
          { user },
        );
        expect(sortedIds(updated)).toEqual(['a', 'b']);
        expect((await rawFiles()).map((record) => [record.file_id, record.usage])).toEqual([
          ['a', 1],
          ['b', 1],
          ['c', 0],
        ]);
        expect(sortedIds(await stores().updateFilesUsage([{ file_id: 'c' }]))).toEqual(['c']);
        expect(await stores().updateFilesUsage([])).toEqual([]);
      });
    });

    describe('batchUpdateFiles', () => {
      const user = '0123456789abcdef0123000a';

      it('points each file at its new path, storage key and region, as bookkeeping', async () => {
        await seedFile(user, { file_id: 'a', storageKey: 'old-key', storageRegion: 'old-region' });
        await seedFile(user, { file_id: 'b', storageKey: 'kept-key' });
        await stores().batchUpdateFiles([
          { file_id: 'a', filepath: '/s3/a', storageKey: 'new-key', storageRegion: 'eu' },
          { file_id: 'b', filepath: '/s3/b' },
          { file_id: 'missing', filepath: '/s3/x' },
        ]);
        await stores().batchUpdateFiles([]);
        const [a, b] = await rawFiles();
        expect(a).toMatchObject({ filepath: '/s3/a', storageKey: 'new-key', storageRegion: 'eu' });
        expect(b).toMatchObject({ filepath: '/s3/b', storageKey: 'kept-key' });
        expect(b).not.toHaveProperty('storageRegion');
        expect(timeOf(a.updatedAt)).toBe(at(0).getTime());
        expect(await harness.readRaw('files')).toHaveLength(2);
      });
    });

    describe('extendFilesTTL', () => {
      const user = '0123456789abcdef0123000b';
      const hold = { renewMs: 10 * MINUTE, maxLifetimeMs: 6 * HOUR };

      it('widens still-expiring holds toward now + renewMs, capped by the lifetime', async () => {
        const now = Date.now();
        await seedFile(user, {
          file_id: 'young',
          createdAt: new Date(now - HOUR),
          expiresAt: new Date(now + MINUTE),
        });
        await seedFile(user, {
          file_id: 'old',
          createdAt: new Date(now - 6 * HOUR + 5 * MINUTE),
          expiresAt: new Date(now + MINUTE),
        });
        await seedFile(user, {
          file_id: 'long',
          createdAt: new Date(now - HOUR),
          expiresAt: new Date(now + HOUR),
        });
        await seedFile(user, { file_id: 'released', createdAt: new Date(now - HOUR) });
        await seedFile(user, {
          file_id: 'no-anchor',
          createdAt: undefined,
          expiresAt: new Date(now + MINUTE),
        });
        await seedFile(newId(), {
          file_id: 'foreign',
          createdAt: new Date(now - HOUR),
          expiresAt: new Date(now + MINUTE),
        });
        const ids = ['young', 'old', 'long', 'released', 'no-anchor', 'foreign', 'young'];
        expect(await stores().extendFilesTTL(ids, hold, { user })).toBe(2);
        const expiry = async (file_id: string) => {
          const record = await rawFile(file_id);
          return record.expiresAt == null ? undefined : timeOf(record.expiresAt);
        };
        expect(await expiry('young')).toBeGreaterThanOrEqual(now + 10 * MINUTE);
        expect(await expiry('young')).toBeLessThanOrEqual(Date.now() + 10 * MINUTE);
        expect(await expiry('old')).toBe(now + 5 * MINUTE);
        expect(await expiry('long')).toBe(now + HOUR);
        expect(await expiry('released')).toBeUndefined();
        expect(await expiry('no-anchor')).toBe(now + MINUTE);
        expect(await expiry('foreign')).toBe(now + MINUTE);
        expect(timeOf((await rawFile('young')).updatedAt)).toBe(at(0).getTime());
        expect(await stores().extendFilesTTL(['old'], hold, { user })).toBe(0);
      });

      it('is a no-op without ids, an owner or a positive hold', async () => {
        const now = Date.now();
        await seedFile(user, {
          file_id: 'doc',
          createdAt: new Date(now),
          expiresAt: new Date(now + MINUTE),
        });
        expect(await stores().extendFilesTTL([], hold, { user })).toBe(0);
        expect(await stores().extendFilesTTL(['doc'], hold, { user: '' })).toBe(0);
        expect(await stores().extendFilesTTL(['doc'], { ...hold, renewMs: 0 }, { user })).toBe(0);
        expect(
          await stores().extendFilesTTL(['doc'], { ...hold, maxLifetimeMs: -1 }, { user }),
        ).toBe(0);
        expect(await stores().extendFilesTTL(['doc'], hold, { user, tenantId: 'tenant-a' })).toBe(
          0,
        );
        expect(timeOf((await rawFile('doc')).expiresAt)).toBe(now + MINUTE);
      });
    });

    describe('sweepOrphanedPreviews', () => {
      const user = '0123456789abcdef0123000c';

      it('fails the pending previews not updated within the cutoff', async () => {
        const now = Date.now();
        await seedFile(user, {
          file_id: 'stale',
          status: 'pending',
          updatedAt: new Date(now - 10 * MINUTE),
        });
        await seedFile(user, {
          file_id: 'fresh',
          status: 'pending',
          updatedAt: new Date(now - MINUTE),
        });
        await seedFile(user, {
          file_id: 'ready',
          status: 'ready',
          updatedAt: new Date(now - HOUR),
        });
        await seedFile(user, { file_id: 'legacy', updatedAt: new Date(now - HOUR) });
        expect(await stores().sweepOrphanedPreviews()).toBe(1);
        const stale = await rawFile('stale');
        expect(stale).toMatchObject({ status: 'failed', previewError: 'orphaned' });
        expect(timeOf(stale.updatedAt)).toBeGreaterThanOrEqual(now);
        expect((await rawFile('fresh')).status).toBe('pending');
        expect(await rawFile('legacy')).not.toHaveProperty('status');
        expect(await stores().sweepOrphanedPreviews()).toBe(0);
        expect(await stores().sweepOrphanedPreviews(30_000)).toBe(1);
        expect((await rawFile('fresh')).status).toBe('failed');
      });
    });

    /* ------------------------------------------------------------------ deletes */

    describe('deletes', () => {
      const user = '0123456789abcdef0123000d';
      const seedProject = async (owner: string, file_ids: string[], record: RawRecord = {}) => {
        const _id = newId();
        await harness.seedRaw('chatprojects', [
          {
            _id,
            name: 'Project',
            user: owner,
            file_ids,
            contextRevision: 0,
            createdAt: at(0),
            updatedAt: at(0),
            ...record,
          },
        ]);
        return _id;
      };
      const project = async (_id: string) =>
        (await readRawWhere(harness, 'chatprojects', { _id }))[0];

      it('deleteFile removes the first file with the id and detaches it from the owner projects', async () => {
        await seedFile(user, { file_id: 'doc', text: 'gone' });
        const own = await seedProject(user, ['doc', 'kept']);
        const foreign = await seedProject(newId(), ['doc']);
        const tenanted = await seedProject(user, ['doc'], { tenantId: 'tenant-a' });
        const deleted = await stores().deleteFile('doc');
        expect(deleted).toMatchObject({ file_id: 'doc', text: 'gone' });
        expect(await harness.readRaw('files')).toEqual([]);
        expect(await project(own)).toMatchObject({ file_ids: ['kept'], contextRevision: 1 });
        expect(await project(foreign)).toMatchObject({ file_ids: ['doc'], contextRevision: 0 });
        expect(await project(tenanted)).toMatchObject({ file_ids: ['doc'], contextRevision: 0 });
        expect(await stores().deleteFile('doc')).toBeNull();
      });

      it('deleteFileByFilter deletes the first match of the filter shapes callers pass', async () => {
        await seedFile(user, { file_id: 'a', filepath: '/avatars/a.png' });
        await seedFile(user, { file_id: 'b', filepath: '/avatars/b.png' });
        const own = await seedProject(user, ['a', 'b']);
        expect(
          await stores().deleteFileByFilter({ user: newId(), filepath: '/avatars/a.png' }),
        ).toBeNull();
        expect(
          (await stores().deleteFileByFilter({ user, filepath: '/avatars/a.png' }))?.file_id,
        ).toBe('a');
        expect(
          (await stores().deleteFileByFilter({ file_id: 'b', filepath: '/avatars/b.png', user }))
            ?.file_id,
        ).toBe('b');
        expect(await harness.readRaw('files')).toEqual([]);
        expect(await project(own)).toMatchObject({ file_ids: [], contextRevision: 2 });
      });

      it('deleteFiles removes the listed files of any owner', async () => {
        const other = newId();
        await seedFile(user, { file_id: 'a' });
        await seedFile(other, { file_id: 'b' });
        await seedFile(user, { file_id: 'c' });
        const own = await seedProject(user, ['a', 'c']);
        const theirs = await seedProject(other, ['b']);
        expect(await stores().deleteFiles(['a', 'b', 'missing'])).toMatchObject({
          deletedCount: 2,
        });
        expect(fileIds((await harness.readRaw('files')) as Array<{ file_id: string }>)).toEqual([
          'c',
        ]);
        expect(await project(own)).toMatchObject({ file_ids: ['c'], contextRevision: 1 });
        expect(await project(theirs)).toMatchObject({ file_ids: [], contextRevision: 1 });
      });

      it('deleteFiles with a user removes every file of that user, whatever the list', async () => {
        const other = newId();
        await seedFile(user, { file_id: 'a' });
        await seedFile(user, { file_id: 'b', tenantId: 'tenant-a' });
        await seedFile(other, { file_id: 'c' });
        const own = await seedProject(user, ['a', 'z']);
        const empty = await seedProject(user, []);
        expect(await stores().deleteFiles(['c'], user)).toMatchObject({ deletedCount: 2 });
        expect(fileIds((await harness.readRaw('files')) as Array<{ file_id: string }>)).toEqual([
          'c',
        ]);
        expect(await project(own)).toMatchObject({ file_ids: [], contextRevision: 1 });
        expect(await project(empty)).toMatchObject({ file_ids: [], contextRevision: 0 });
      });

      it('deleteFiles with snapshots deletes only the files still matching them', async () => {
        await seedFile(user, { file_id: 'clean', updatedAt: at(1) });
        await seedFile(user, { file_id: 'changed', updatedAt: at(2) });
        await seedFile(user, {
          file_id: 'provisioned',
          updatedAt: at(1),
          metadata: { codeEnvRefs: { default: codeRef('p') } },
        });
        await seedFile(user, {
          file_id: 'deleting',
          updatedAt: at(1),
          storageOperations: { deleting: 'tok' },
        });
        const own = await seedProject(user, ['clean', 'changed']);
        const snapshot = (file_id: string) => ({ file_id, updatedAt: at(1) });
        const result = await stores().deleteFiles(
          ['clean', 'changed', 'provisioned', 'deleting', 'gone'],
          undefined,
          {
            userId: user,
            files: ['clean', 'changed', 'provisioned', 'deleting', 'gone'].map(snapshot),
          },
        );
        expect(result).toEqual({
          deletedCount: 1,
          deletedFileIds: ['clean', 'gone'],
          failedFileIds: ['changed', 'provisioned', 'deleting'],
        });
        expect(sortedIds((await harness.readRaw('files')) as Array<{ file_id: string }>)).toEqual([
          'changed',
          'deleting',
          'provisioned',
        ]);
        expect(await project(own)).toMatchObject({ file_ids: ['changed'], contextRevision: 1 });
      });

      it('deleteFiles with snapshots takes the owner from each snapshot, and requires one per id', async () => {
        const other = newId();
        await seedFile(other, { file_id: 'theirs', updatedAt: at(1), tenantId: 'tenant-a' });
        expect(
          await stores().deleteFiles(['theirs'], undefined, {
            userId: user,
            files: [
              {
                file_id: 'theirs',
                updatedAt: at(1),
                user: { toString: () => other },
                tenantId: 'tenant-a',
              },
            ],
          }),
        ).toEqual({ deletedCount: 1, deletedFileIds: ['theirs'], failedFileIds: [] });
        await expect(
          stores().deleteFiles(['x', 'y'], undefined, { userId: user, files: [{ file_id: 'x' }] }),
        ).rejects.toThrow('Missing file deletion snapshot');
        expect(await stores().deleteFiles([], undefined, { userId: user, files: [] })).toEqual({
          deletedCount: 0,
          deletedFileIds: [],
          failedFileIds: [],
        });
      });
    });

    /* ------------------------------------------------------------------ indexes */

    describe('partial unique indexes', () => {
      const user = '0123456789abcdef0123000e';

      it('allows one code output per filename, conversation and tenant', async () => {
        const output = (file_id: string, record: RawRecord = {}) =>
          seedFile(user, {
            file_id,
            filename: 'out.csv',
            conversationId: 'convo',
            context: FileContext.execute_code,
            ...record,
          });
        await output('first');
        let rejection: unknown;
        try {
          await output('second');
        } catch (error) {
          rejection = error;
        }
        expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
        await output('other-tenant', { tenantId: 'tenant-a' });
        await output('other-conversation', { conversationId: 'convo-2' });
        await seedFile(user, {
          file_id: 'attachment',
          filename: 'out.csv',
          conversationId: 'convo',
          context: FileContext.message_attachment,
        });
        await seedFile(user, {
          file_id: 'attachment-2',
          filename: 'out.csv',
          conversationId: 'convo',
          context: FileContext.message_attachment,
        });
        expect(await harness.readRaw('files')).toHaveLength(5);
      });

      it('allows one run artifact per identity', async () => {
        const runFile = {
          runId: 'run',
          executionId: 'exec',
          agentId: 'agent',
          sourceFileId: 'source',
          publishedAt: '2026-04-01T00:00:00.000Z',
          inputFileIds: [],
        };
        const artifact = (file_id: string, record: RawRecord = {}) =>
          seedFile(user, {
            file_id,
            conversationId: 'convo',
            context: FileContext.run_artifact,
            metadata: { runFile },
            ...record,
          });
        await artifact('first');
        let rejection: unknown;
        try {
          await artifact('second');
        } catch (error) {
          rejection = error;
        }
        expect(harness.errors.isDuplicateKey(rejection)).toBe(true);
        await artifact('other-execution', {
          metadata: { runFile: { ...runFile, executionId: 'e2' } },
        });
        await artifact('other-owner', { user: newId() });
        await artifact('not-an-artifact', { context: FileContext.agents });
        expect(await harness.readRaw('files')).toHaveLength(4);
      });
    });

    /* ------------------------------------------------------------------ tenants */

    describe('tenant scoping', () => {
      const user = '0123456789abcdef0123000f';

      it('stamps writes with the ambient tenant and reads only its files', async () => {
        await inTenant('tenant-a', () =>
          stores().createFile(
            asFile({
              file_id: 'doc',
              user,
              filename: 'a.txt',
              filepath: '/a',
              type: 'text/plain',
              bytes: 1,
            }),
            true,
          ),
        );
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-b' });
        await seedFile(user, { file_id: 'legacy' });
        expect((await rawFile('doc', { tenantId: 'tenant-a' })).filename).toBe('a.txt');
        expect(sortedIds(await inTenant('tenant-a', () => stores().getFiles({ user })))).toEqual([
          'doc',
        ]);
        expect((await inTenant('tenant-b', () => stores().findFileById('doc')))?.tenantId).toBe(
          'tenant-b',
        );
        expect(await inTenant('tenant-b', () => stores().findFileById('legacy'))).toBeNull();
        expect(sortedIds(await stores().getFiles({ user }))).toEqual(['doc', 'doc', 'legacy']);
        expect(sortedIds(await runAsSystem(() => stores().getFiles({ user })))).toEqual([
          'doc',
          'doc',
          'legacy',
        ]);
      });

      it('keeps writes and deletes inside the ambient tenant', async () => {
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-a', usage: 0 });
        await seedFile(user, { file_id: 'doc', tenantId: 'tenant-b', usage: 0 });
        expect(
          (await inTenant('tenant-b', () => stores().updateFileUsage({ file_id: 'doc' })))
            ?.tenantId,
        ).toBe('tenant-b');
        expect((await rawFile('doc', { tenantId: 'tenant-a' })).usage).toBe(0);
        expect(await inTenant('tenant-c', () => stores().deleteFile('doc'))).toBeNull();
        expect((await inTenant('tenant-a', () => stores().deleteFile('doc')))?.tenantId).toBe(
          'tenant-a',
        );
        expect((await harness.readRaw('files')).map((record) => record.tenantId)).toEqual([
          'tenant-b',
        ]);
      });

      it('lets the ambient tenant override an explicit tenant of the owner-scoped reads', async () => {
        await seedFile(user, {
          file_id: 'doc',
          tenantId: 'tenant-a',
          context: FileContext.message_attachment,
          embedded: true,
        });
        expect(
          await inTenant('tenant-b', () =>
            stores().getProjectFiles({ fileIds: ['doc'], userId: user, tenantId: 'tenant-a' }),
          ),
        ).toEqual([]);
        expect(
          sortedIds(
            await inTenant('tenant-a', () =>
              stores().getToolFilesByIds(['doc'], new Set([EToolResources.file_search]), {
                userId: user,
              }),
            ),
          ),
        ).toEqual(['doc']);
      });
    });
  });
}
