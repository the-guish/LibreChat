/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `FileStorageStore` contract (`~/ports/fileStorage`), ported from
 * `methods/fileStorage.spec.ts`: the provisioning and deletion claims on a file record (an
 * owner, tenant and token scoped fence that never upserts), the guarded provisioning commit and
 * the release acknowledgements. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import type { FileStorageClaim, FileProvisionCommit } from '~/types/file';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { timeOf, useContractHarness } from './support';

/** The storage operations of a stored file, with absent and empty values left out. */
function operationsOf(record: RawRecord | undefined): Record<string, unknown> {
  const operations = (record?.storageOperations ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(operations)) {
    if (value == null || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    result[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return result;
}

export function describeFileStorageContract(harness: ContractHarness): void {
  describe(`FileStorageStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const user = harness.ids.generate();
    const updatedAt = new Date('2026-10-20T00:00:00.000Z');
    const claim: FileStorageClaim = {
      file_id: 'storage-fence',
      userId: user,
      tenantId: 'tenant-a',
      token: 'owner-token',
    };
    const deletion = { ...claim, updatedAt };

    /** Seeds the file; an override of `undefined` leaves the field out. */
    const seed = (overrides: Record<string, unknown> = {}) => {
      const record: RawRecord = {
        _id: harness.ids.generate(),
        file_id: claim.file_id,
        user,
        tenantId: claim.tenantId,
        filename: 'notes.txt',
        filepath: '/uploads/notes.txt',
        type: 'text/plain',
        bytes: 100,
        source: 'local',
        object: 'file',
        usage: 0,
        createdAt: updatedAt,
        updatedAt,
        metadata: { futureField: 'preserve-me' },
        ...overrides,
      };
      for (const [key, value] of Object.entries(record)) {
        if (value === undefined) {
          delete record[key];
        }
      }
      return harness.seedRaw('files', [record]);
    };
    const read = async (where: RawRecord = { tenantId: claim.tenantId }) =>
      (await harness.readRaw('files')).find((record) =>
        Object.entries({ file_id: claim.file_id, ...where }).every(
          ([key, value]) => record[key] === value,
        ),
      );
    const stores = () => harness.createStores().fileStorage;

    describe('acquireFileProvision', () => {
      it('adds every concurrent provisioning owner, which blocks deletion until all release', async () => {
        await seed();
        const own = stores();
        const peer = stores();
        const claims = ['code-a', 'code-b', 'search'].map((token) => ({ ...claim, token }));
        expect(await Promise.all(claims.map((item) => own.acquireFileProvision(item)))).toEqual([
          true,
          true,
          true,
        ]);
        expect(await peer.acquireFileProvision(claims[0])).toBe(true);
        expect(operationsOf(await read())).toEqual({
          provisioning: ['code-a', 'code-b', 'search'],
        });
        expect(await peer.acquireFileDeletion(deletion)).toBeNull();
        expect(await own.releaseFileProvision(claims[0])).toBe(true);
        expect(await peer.acquireFileDeletion(deletion)).toBeNull();
        expect(await own.releaseFileProvision(claims[1])).toBe(true);
        expect(await own.releaseFileProvision(claims[2])).toBe(true);
        expect(await peer.acquireFileDeletion(deletion)).toEqual({ resumed: false });
      });

      it('is refused once a deletion holds or awaits the file', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        expect(await fileStorage.acquireFileDeletion(deletion)).toEqual({ resumed: false });
        expect(await fileStorage.acquireFileProvision({ ...claim, token: 'late' })).toBe(false);
        expect(await fileStorage.releaseFileDeletion({ ...claim, retainDeletion: true })).toBe(
          true,
        );
        expect(await fileStorage.acquireFileProvision({ ...claim, token: 'late' })).toBe(false);
      });

      it('clears the expiry and keeps timestamps, content and unknown fields', async () => {
        await seed({
          expiresAt: new Date(Date.now() + 60_000),
          futureField: { value: 'untouched' },
          storageOperations: { futureFence: 'untouched' },
        });
        expect(await stores().acquireFileProvision(claim)).toBe(true);
        const stored = await read();
        expect(stored).not.toHaveProperty('expiresAt');
        expect(timeOf(stored?.updatedAt)).toBe(updatedAt.getTime());
        expect(stored).toMatchObject({
          filename: 'notes.txt',
          bytes: 100,
          metadata: { futureField: 'preserve-me' },
          futureField: { value: 'untouched' },
          storageOperations: { futureFence: 'untouched', provisioning: ['owner-token'] },
        });
      });

      it('never creates a missing file', async () => {
        expect(await stores().acquireFileProvision(claim)).toBe(false);
        expect(await harness.readRaw('files')).toEqual([]);
      });
    });

    describe('releaseFileProvision', () => {
      it('removes only the given token, and acknowledges a token it does not hold', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileProvision(claim);
        expect(await fileStorage.releaseFileProvision({ ...claim, token: 'thief' })).toBe(true);
        expect(operationsOf(await read())).toEqual({ provisioning: [claim.token] });
        expect(await fileStorage.releaseFileProvision(claim)).toBe(true);
        expect(operationsOf(await read())).toEqual({});
      });

      it('resolves false for a missing file and never creates one', async () => {
        expect(await stores().releaseFileProvision(claim)).toBe(false);
        expect(await harness.readRaw('files')).toEqual([]);
      });
    });

    describe('commitFileProvision', () => {
      const code: NonNullable<FileProvisionCommit['code']> = {
        routeKey: 'default',
        ref: { kind: 'user', id: user, storage_session_id: 'session', file_id: 'remote' },
      };

      it('stores a code reference only while the claim is held', async () => {
        await seed({ expiresAt: new Date(Date.now() + 60_000) });
        const { fileStorage } = harness.createStores();
        expect(await fileStorage.commitFileProvision({ claim, code })).toBe(false);
        expect(await fileStorage.acquireFileProvision(claim)).toBe(true);
        expect(
          await fileStorage.commitFileProvision({ claim: { ...claim, token: 'stale' }, code }),
        ).toBe(false);
        expect(await fileStorage.commitFileProvision({ claim, code })).toBe(true);
        const stored = await read();
        expect((stored?.metadata as RawRecord).codeEnvRefs).toEqual({ default: code.ref });
        expect(stored).not.toHaveProperty('expiresAt');
        expect(await fileStorage.releaseFileProvision(claim)).toBe(true);
        expect(await fileStorage.commitFileProvision({ claim, code })).toBe(false);
      });

      it('records an embedding namespace without releasing the claim', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileProvision(claim);
        expect(
          await fileStorage.commitFileProvision({ claim, embedded: true, entityId: 'namespace' }),
        ).toBe(true);
        const stored = await read();
        expect(stored?.embedded).toBe(true);
        expect((stored?.metadata as RawRecord).embeddedEntities).toEqual(['namespace']);
        expect((stored?.metadata as RawRecord).futureField).toBe('preserve-me');
        expect(operationsOf(stored)).toEqual({ provisioning: [claim.token] });
      });

      it('stores generated output of its own file, guarded by dispatch order', async () => {
        await seed({ metadata: { sourceDispatchedAt: 10 } });
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileProvision(claim);
        const file = {
          file_id: claim.file_id,
          user,
          tenantId: 'tenant-a',
          filename: 'out.csv',
          filepath: '/uploads/out.csv',
          bytes: 42,
          type: 'text/csv',
        };
        expect(
          await fileStorage.commitFileProvision({ claim, output: { file, sourceDispatchedAt: 5 } }),
        ).toBe(false);
        expect((await read())?.filename).toBe('notes.txt');
        expect(
          await fileStorage.commitFileProvision({
            claim,
            output: { file, sourceDispatchedAt: 20 },
          }),
        ).toBe(true);
        expect(await read()).toMatchObject({ filename: 'out.csv', bytes: 42, type: 'text/csv' });
      });

      it('throws for output of another file or owner, an invalid route key, or nothing to store', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileProvision(claim);
        const file = {
          file_id: 'other',
          user,
          tenantId: 'tenant-a',
          filename: 'x',
          filepath: '/uploads/x',
          bytes: 1,
          type: 'text/plain',
        };
        await expect(fileStorage.commitFileProvision({ claim, output: { file } })).rejects.toThrow(
          'Generated output does not match its storage claim',
        );
        await expect(
          fileStorage.commitFileProvision({
            claim,
            output: { file: { ...file, file_id: claim.file_id, user: harness.ids.generate() } },
          }),
        ).rejects.toThrow('Generated output does not match its storage claim');
        await expect(
          fileStorage.commitFileProvision({ claim, code: { ...code, routeKey: 'a.b' } }),
        ).rejects.toThrow('Invalid code environment route key');
        await expect(fileStorage.commitFileProvision({ claim })).rejects.toThrow(
          'Missing provisioning result',
        );
        expect((await read())?.filename).toBe('notes.txt');
      });

      it('with releaseOnly, only checks that the claim is still held', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        expect(await fileStorage.commitFileProvision({ claim, releaseOnly: true })).toBe(false);
        await fileStorage.acquireFileProvision(claim);
        const before = await read();
        expect(await fileStorage.commitFileProvision({ claim, releaseOnly: true })).toBe(true);
        expect(await read()).toEqual(before);
      });

      it('cannot complete a stale upload against a recreated file', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileProvision(claim);
        await harness.reset();
        await seed();
        expect(await fileStorage.commitFileProvision({ claim, embedded: true })).toBe(false);
        expect(await read()).not.toHaveProperty('embedded');
      });
    });

    describe('acquireFileDeletion', () => {
      it('takes the deletion claim on an unchanged file and marks the deletion pending', async () => {
        await seed({ expiresAt: new Date(Date.now() + 60_000) });
        expect(await stores().acquireFileDeletion(deletion)).toEqual({ resumed: false });
        const stored = await read();
        expect(operationsOf(stored)).toEqual({ deleting: claim.token, deletionPending: true });
        expect(stored).not.toHaveProperty('expiresAt');
        expect(timeOf(stored?.updatedAt)).toBe(updatedAt.getTime());
      });

      it('admits one claimant at a time, with no takeover', async () => {
        await seed();
        const results = await Promise.all([
          stores().acquireFileDeletion(deletion),
          stores().acquireFileDeletion({ ...deletion, token: 'peer' }),
        ]);
        expect(results.filter((result) => result !== null)).toEqual([{ resumed: false }]);
        expect(await stores().acquireFileDeletion({ ...deletion, token: 'third' })).toBeNull();
      });

      it('chooses exactly one winner in a provision/delete race', async () => {
        await seed();
        const [provisioned, deleted] = await Promise.all([
          stores().acquireFileProvision(claim),
          stores().acquireFileDeletion(deletion),
        ]);
        expect(Number(provisioned) + Number(deleted !== null)).toBe(1);
        expect(operationsOf(await read())).toEqual(
          provisioned
            ? { provisioning: [claim.token] }
            : { deleting: claim.token, deletionPending: true },
        );
      });

      it('requires the content snapshot: a changed or missing updatedAt is refused', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        expect(
          await fileStorage.acquireFileDeletion({ ...deletion, updatedAt: new Date(0) }),
        ).toBeNull();
        expect(await fileStorage.acquireFileDeletion(claim)).toBeNull();
        expect(
          await fileStorage.acquireFileDeletion({
            ...deletion,
            updatedAt: updatedAt.toISOString(),
          }),
        ).toEqual({ resumed: false });
      });

      it('claims a legacy file without updatedAt when no snapshot is given', async () => {
        await seed({ updatedAt: undefined });
        expect(await stores().acquireFileDeletion(claim)).toEqual({ resumed: false });
      });

      it('resumes a pending deletion without reprovisioning', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        expect(await fileStorage.acquireFileDeletion(deletion)).toEqual({ resumed: false });
        expect(await fileStorage.releaseFileDeletion({ ...claim, retainDeletion: true })).toBe(
          true,
        );
        expect(operationsOf(await read())).toEqual({ deletionPending: true });
        expect(await fileStorage.acquireFileDeletion({ ...deletion, token: 'retry' })).toEqual({
          resumed: true,
        });
      });

      it('never creates a missing file', async () => {
        expect(await stores().acquireFileDeletion(deletion)).toBeNull();
        expect(await harness.readRaw('files')).toEqual([]);
      });
    });

    describe('releaseFileDeletion', () => {
      it('clears the pending deletion without retainDeletion, allowing provisioning again', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileDeletion(deletion);
        expect(await fileStorage.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(
          true,
        );
        expect(operationsOf(await read())).toEqual({});
        expect(await fileStorage.acquireFileProvision(claim)).toBe(true);
      });

      it.each([true, false])(
        'acknowledges a repeated release without changing the pending intent (retain %s)',
        async (retainDeletion) => {
          await seed();
          const { fileStorage } = harness.createStores();
          await fileStorage.acquireFileDeletion(deletion);
          expect(await fileStorage.releaseFileDeletion({ ...claim, retainDeletion })).toBe(true);
          expect(
            await fileStorage.releaseFileDeletion({ ...claim, retainDeletion: !retainDeletion }),
          ).toBe(true);
          expect(operationsOf(await read())).toEqual(
            retainDeletion ? { deletionPending: true } : {},
          );
        },
      );

      it("refuses another token's release while it holds the claim", async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileDeletion(deletion);
        expect(
          await fileStorage.releaseFileDeletion({
            ...claim,
            token: 'thief',
            retainDeletion: false,
          }),
        ).toBe(false);
        expect(operationsOf(await read())).toEqual({
          deleting: claim.token,
          deletionPending: true,
        });
      });

      it('never releases a newer deletion token when replaying an old release', async () => {
        await seed();
        const { fileStorage } = harness.createStores();
        await fileStorage.acquireFileDeletion(deletion);
        await fileStorage.releaseFileDeletion({ ...claim, retainDeletion: false });
        expect(
          await fileStorage.acquireFileDeletion({ ...deletion, token: 'new-token' }),
        ).not.toBeNull();
        expect(await fileStorage.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(
          false,
        );
        expect(operationsOf(await read())).toEqual({
          deleting: 'new-token',
          deletionPending: true,
        });
      });

      it('does not acknowledge a release for a missing file, another owner or another tenant', async () => {
        await seed();
        for (const wrong of [
          { ...claim, file_id: 'missing' },
          { ...claim, userId: harness.ids.generate() },
          { ...claim, tenantId: 'other-tenant' },
        ]) {
          expect(await stores().releaseFileDeletion({ ...wrong, retainDeletion: false })).toBe(
            false,
          );
        }
      });
    });

    describe('scope', () => {
      it.each([
        ['another owner', { userId: '0123456789abcdef01234567' }],
        ['another tenant', { tenantId: 'tenant-b' }],
        ['no tenant', { tenantId: undefined }],
        ['a null tenant', { tenantId: null }],
        ['another file', { file_id: 'other-file' }],
      ])('isolates every claim and release from %s', async (_label, scope) => {
        await seed();
        const own = stores();
        const peer = stores();
        const other = { ...claim, ...scope } as FileStorageClaim;
        expect(await runAsSystem(() => peer.acquireFileProvision(other))).toBe(false);
        expect(
          await runAsSystem(() => peer.acquireFileDeletion({ ...other, updatedAt })),
        ).toBeNull();
        expect(await own.acquireFileProvision(claim)).toBe(true);
        expect(await runAsSystem(() => peer.releaseFileProvision(other))).toBe(false);
        expect(await own.releaseFileProvision(claim)).toBe(true);
        expect(await own.acquireFileDeletion(deletion)).toEqual({ resumed: false });
        expect(
          await runAsSystem(() => peer.releaseFileDeletion({ ...other, retainDeletion: false })),
        ).toBe(false);
        expect(operationsOf(await read()).deleting).toBe(claim.token);
      });

      it.each([undefined, null])(
        'scopes a legacy tenant %p explicitly, even in system context',
        async (tenantId) => {
          await seed({ tenantId: undefined });
          await seed({ tenantId: 'tenant-a' });
          const legacy = { ...claim, tenantId };
          const { fileStorage } = harness.createStores();
          expect(await runAsSystem(() => fileStorage.acquireFileProvision(legacy))).toBe(true);
          expect(operationsOf(await read())).toEqual({});
          expect(await runAsSystem(() => fileStorage.releaseFileProvision(legacy))).toBe(true);
          expect(
            await runAsSystem(() => fileStorage.acquireFileDeletion({ ...legacy, updatedAt })),
          ).toEqual({ resumed: false });
          expect(
            await runAsSystem(() =>
              fileStorage.releaseFileDeletion({ ...legacy, retainDeletion: true }),
            ),
          ).toBe(true);
          expect(operationsOf(await read())).toEqual({});
        },
      );

      it('keeps the explicit tenant whatever the ambient tenant', async () => {
        await seed();
        await seed({ tenantId: 'tenant-b' });
        const { fileStorage } = harness.createStores();
        const inTenantB = <T>(run: () => Promise<T>) =>
          tenantStorage.run({ tenantId: 'tenant-b' }, run);
        expect(await inTenantB(() => fileStorage.acquireFileProvision(claim))).toBe(false);
        expect(await inTenantB(() => fileStorage.acquireFileDeletion(deletion))).toBeNull();
        expect(await fileStorage.acquireFileProvision(claim)).toBe(true);
        expect(await inTenantB(() => fileStorage.releaseFileProvision(claim))).toBe(false);
        expect(operationsOf(await read({ tenantId: 'tenant-b' }))).toEqual({});
      });

      it.each([
        { token: '' },
        { token: '   ' },
        { token: null },
        { token: { $ne: '' } },
        { userId: '' },
        { userId: 'not-an-object-id' },
        { userId: { $ne: null } },
        { file_id: '' },
        { tenantId: '' },
      ])('rejects the invalid claim scope %j without writing', async (invalid) => {
        await seed();
        const before = await read();
        const data = { ...claim, ...invalid } as FileStorageClaim;
        const { fileStorage } = harness.createStores();
        await expect(fileStorage.acquireFileProvision(data)).rejects.toThrow('valid file storage');
        await expect(fileStorage.releaseFileProvision(data)).rejects.toThrow('valid file storage');
        await expect(fileStorage.acquireFileDeletion({ ...data, updatedAt })).rejects.toThrow(
          'valid file storage',
        );
        await expect(
          fileStorage.releaseFileDeletion({ ...data, retainDeletion: false }),
        ).rejects.toThrow('valid file storage');
        await expect(
          fileStorage.commitFileProvision({ claim: data, embedded: true }),
        ).rejects.toThrow('valid file storage');
        expect(await read()).toEqual(before);
      });
    });
  });
}
