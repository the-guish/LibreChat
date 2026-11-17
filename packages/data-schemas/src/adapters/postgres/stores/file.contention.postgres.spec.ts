import { FileContext, FileSources } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { RunArtifactScope } from '~/types/file';
import type { DataStore } from '~/ports';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL file store (docs/postgres-port/PHASE4.md §3.5): parallel
 * calls on separate pool clients converge on one code-output record and one published run
 * artifact (the partial unique indexes), hand every sweep a distinct attempt number, keep the
 * latest deferral, and lose none of the concurrent route, workspace-copy and embedding writes
 * into `metadata` (tier 2, read-modify-write under the row lock). Each case runs with the shadow
 * check off (the production path) and on (the lock-then-write path the contract suites take).
 */
describePostgres('PostgreSQL file store under contention', () => {
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

    const newId = () => harness.ids.generate();
    const user = '0123456789abcdef0123c000';
    const seedFile = async (record: RawRecord = {}): Promise<string> => {
      const file_id = `file-${newId()}`;
      await harness.seedRaw('files', [
        {
          _id: newId(),
          file_id,
          user,
          filename: 'notes.txt',
          filepath: '/uploads/notes.txt',
          type: 'text/plain',
          bytes: 1,
          object: 'file',
          usage: 0,
          source: 'local',
          createdAt: new Date(),
          updatedAt: new Date(),
          ...record,
        },
      ]);
      return file_id;
    };
    const rawFile = async (file_id: string) =>
      (await harness.readRaw('files')).find((file) => file.file_id === file_id) as RawRecord;
    const metadataOf = async (file_id: string) => (await rawFile(file_id)).metadata as RawRecord;

    it('converges 12 parallel claims of one code output on one record', async () => {
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          stores.files.claimCodeFile({
            filename: 'out.csv',
            conversationId: 'convo',
            file_id: `claim-${index}`,
            user,
            tenantId: null,
          }),
        ),
      );
      expect(new Set(claims.map((claim) => claim.file_id)).size).toBe(1);
      const stored = (await harness.readRaw('files')).filter(
        (file) => file.context === FileContext.execute_code,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0].file_id).toBe(claims[0].file_id);
    });

    it('publishes one run artifact for 8 parallel publications of one scope', async () => {
      const scope: RunArtifactScope = {
        userId: user,
        tenantId: null,
        conversationId: 'convo',
        runId: 'run',
        executionId: 'exec',
        agentId: 'agent',
        sourceFileId: 'source',
      };
      const published = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          stores.files.publishRunArtifactFile({
            scope,
            file: {
              filename: `report-${index}.csv`,
              filepath: `/uploads/report-${index}.csv`,
              bytes: index,
              type: 'text/csv',
              source: FileSources.local,
            },
            provenance: {
              runId: 'run',
              executionId: 'exec',
              agentId: 'agent',
              sourceFileId: 'source',
              publishedAt: new Date().toISOString(),
              inputFileIds: [],
            },
          }),
        ),
      );
      expect(new Set(published.map((file) => file.file_id)).size).toBe(1);
      expect(new Set(published.map((file) => file.filename)).size).toBe(1);
      expect(await harness.readRaw('files')).toHaveLength(1);
    });

    it('hands 10 parallel sweeps distinct attempt numbers and keeps the latest deferral', async () => {
      const file_id = await seedFile();
      const attempts = await Promise.all(
        Array.from({ length: 10 }, () => stores.files.incrementFileDeletionAttempts(file_id)),
      );
      expect([...attempts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const base = Date.now();
      await Promise.all(
        [5, 9, 1, 7, 3].map((hours) =>
          stores.files.deferExpiredFile(file_id, new Date(base + hours * 3_600_000)),
        ),
      );
      const stored = await rawFile(file_id);
      expect(stored.deletionAttempts).toBe(10);
      expect((stored.deletionRetryAt as Date).getTime()).toBe(base + 9 * 3_600_000);
    });

    it('keeps every one of 8 parallel route writes, workspace copies and embedding owners', async () => {
      const file_id = await seedFile({ metadata: { codeEnvRefs: { seed: { kind: 'user' } } } });
      const routes = Array.from({ length: 8 }, (_, index) => `route${index}`);
      await Promise.all([
        ...routes.map((routeKey) =>
          stores.files.updateFileCodeEnvRef({
            file_id,
            routeKey,
            ref: { kind: 'user', id: routeKey, storage_session_id: 's', file_id: 'f' } as never,
          }),
        ),
        ...routes.map((_, index) =>
          stores.files.recordFileWorkspaceImport({
            file_id,
            user,
            copy: {
              key: `${index}`.padStart(32, 'a'),
              target: { sha256: 'a'.repeat(64), path: `/w/${index}` },
            },
          }),
        ),
        ...routes.map((routeKey) =>
          stores.files.addFileEmbeddedEntity({ file_id, entityId: `agent-${routeKey}` }),
        ),
      ]);
      const metadata = await metadataOf(file_id);
      expect(Object.keys(metadata.codeEnvRefs as RawRecord).sort()).toEqual(
        ['seed', ...routes].sort(),
      );
      expect(
        Object.keys((metadata.workspaceImports as { targets: RawRecord }).targets),
      ).toHaveLength(8);
      expect([...(metadata.embeddedEntities as string[])].sort()).toEqual(
        routes.map((routeKey) => `agent-${routeKey}`).sort(),
      );
    });
  });
});
