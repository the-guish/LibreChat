/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `MCPServerStore` contract (`~/ports/mcpServer`), ported from `methods/mcpServer.spec.ts`
 * and `methods/mcpServer.deletionReads.spec.ts`: the server name derived from the title (the
 * slug, the `-N` suffix over stored and reserved names, the random fallback, concurrent creates
 * converging on distinct names), the normalized name every write stores (a collection hook on
 * PostgreSQL) and its unique index per tenant through `harness.errors`, the reads by name and id,
 * the id listing with its order (most recently updated first, ties by id), cursor paging over
 * ties, limit clamps and the `StoreFilter` criteria, the config update and the deletes (with and
 * without the ACL entries), the account-erasure read over sole-owned and legacy servers, the
 * removal reads (OAuth token holders with an explicit or the ambient tenant, the view ACL by bit
 * superset and by `$bitsAnySet`, the viewer users through groups) and tenant scoping.
 *
 * Not here (they stay in the method specs): the read and erasure paths without a registered
 * model, and a delete made to fail by a driver spy. ACL entries are written through the
 * `aclEntries` store (its principal ids as `harness.ids.toStoreId`), the rest raw. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import {
  PrincipalType,
  ResourceType,
  PermissionBits,
  normalizeServerName,
} from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { MCPServerStore } from '~/ports/mcpServer';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';
import { tenantStorage } from '~/config/tenantContext';

type ServerPage = Awaited<ReturnType<MCPServerStore['getListMCPServersByIds']>>;

const BASE = Date.parse('2026-05-01T00:00:00.000Z');
/** A fixed instant `minutes` after {@link BASE}. */
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const OWNER_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

/** The error a store method rejected with, or a failure when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

const sse = (title?: string, description?: string): MCPOptions => ({
  type: 'sse',
  url: 'https://example.com/mcp',
  ...(title != null ? { title } : {}),
  ...(description != null ? { description } : {}),
});

export function describeMCPServerContract(harness: ContractHarness): void {
  describe(`MCPServerStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores();
    const servers = () => stores().mcpServers;
    const newId = () => harness.ids.generate();
    const storeId = (id: string) => harness.ids.toStoreId(id);
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const ids = (rows: ReadonlyArray<{ _id?: unknown }>) =>
      rows.map((row) => idOf(harness, row._id));
    const authorId = newId();

    const create = (title?: string, extra: { reservedServerNames?: string[] } = {}) =>
      servers().createMCPServer({ config: sse(title), author: storeId(authorId), ...extra });

    /** A raw server record (no hooks: its normalized name is given), `record` over it. */
    const rawServer = (serverName: string, record: RawRecord = {}): RawRecord => ({
      _id: newId(),
      serverName,
      normalizedServerName: normalizeServerName(serverName),
      config: sse(serverName),
      author: authorId,
      createdAt: at(0),
      updatedAt: at(0),
      ...record,
    });
    const seedServers = (...records: RawRecord[]) => harness.seedRaw('mcpservers', records);

    /** Grants `bits` on `resourceId` to the principal through the ACL entry store. */
    const grant = (
      principalType: string,
      principalId: string | null,
      resourceId: string,
      bits: number,
      resourceType: string = ResourceType.MCPSERVER,
    ) =>
      stores().aclEntries.grantPermission(
        principalType,
        principalId == null ? null : storeId(principalId),
        resourceType,
        storeId(resourceId),
        bits,
      );

    /* ------------------------------------------------------------------ createMCPServer */

    describe('createMCPServer', () => {
      it('derives the name from the title and stores the config, author and timestamps', async () => {
        const before = Date.now();
        const server = await servers().createMCPServer({
          config: sse('My Test Server', 'A test server'),
          author: storeId(authorId),
        });
        expect(server.serverName).toBe('my-test-server');
        expect(server.config).toEqual(sse('My Test Server', 'A test server'));
        expect(idOf(harness, server.author)).toBe(authorId);
        expect(timeOf(server.createdAt)).toBeGreaterThanOrEqual(before);
        expect(timeOf(server.updatedAt)).toBe(timeOf(server.createdAt));

        const [stored] = await harness.readRaw('mcpservers');
        expect(stored).toMatchObject({
          _id: idOf(harness, server._id),
          serverName: 'my-test-server',
          normalizedServerName: 'my-test-server',
          config: sse('My Test Server', 'A test server'),
          author: authorId,
        });
        expect(stored.tenantId).toBeUndefined();
      });

      it('takes the author as a hex string too', async () => {
        const server = await servers().createMCPServer({
          config: sse('String Author'),
          author: authorId,
        });
        expect(idOf(harness, server.author)).toBe(authorId);
        expect((await harness.readRaw('mcpservers'))[0].author).toBe(authorId);
      });

      it.each([
        ['My @#$% Server!!! 123', 'my-server-123'],
        ['   @#$%   ', 'mcp-server'],
        ['   ', 'mcp-server'],
        ['My    Multiple   Spaces   Server', 'my-multiple-spaces-server'],
        ['Serveur Français 日本語', 'serveur-franais'],
        [`${'A'.repeat(200)} Server`, `${'a'.repeat(200)}-server`],
      ])('slugs the title %j to %j', async (title, serverName) => {
        expect((await create(title)).serverName).toBe(serverName);
      });

      it('falls back to a random name without a title, or with an empty one', async () => {
        const untitled = await create();
        const empty = await create('');
        expect(untitled.serverName).toMatch(/^mcp-[a-zA-Z0-9_-]{16}$/);
        expect(empty.serverName).toMatch(/^mcp-[a-zA-Z0-9_-]{16}$/);
        expect(untitled.serverName).not.toBe(empty.serverName);
        expect(untitled.config.title).toBeUndefined();
      });

      it('keeps a stdio config as given', async () => {
        const config: MCPOptions = {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          title: 'Stdio Server',
        };
        const server = await servers().createMCPServer({ config, author: storeId(authorId) });
        expect(server.serverName).toBe('stdio-server');
        expect((await harness.readRaw('mcpservers'))[0].config).toEqual(config);
      });

      it('suffixes past the highest stored or reserved number, ignoring other names', async () => {
        await seedServers(
          rawServer('test-server'),
          rawServer('test-server-2'),
          rawServer('test-server-5'),
          rawServer('my-test-server-9'),
          rawServer('test-server-extra'),
          rawServer('Test-Server-7'),
        );
        expect((await create('Test Server')).serverName).toBe('test-server-6');
        expect(
          (await create('Test Server', { reservedServerNames: ['test-server-8', 'other-10'] }))
            .serverName,
        ).toBe('test-server-9');
      });

      it('uses the base name when only unrelated names exist, and -2 after it', async () => {
        await seedServers(rawServer('other-server'), rawServer('test-serverx'));
        expect((await create('Test Server')).serverName).toBe('test-server');
        expect((await create('Test Server')).serverName).toBe('test-server-2');
      });

      it('skips a reserved base name', async () => {
        expect(
          (await create('Test Server', { reservedServerNames: ['test-server'] })).serverName,
        ).toBe('test-server-2');
      });

      it('numbers sequential creates of one title', async () => {
        const names: string[] = [];
        for (let i = 0; i < 4; i++) {
          names.push((await create('Sequential')).serverName);
        }
        expect(names).toEqual(['sequential', 'sequential-2', 'sequential-3', 'sequential-4']);
      });

      it('gives concurrent creates of one title distinct names (retrying on collisions)', async () => {
        const results = await Promise.all(Array.from({ length: 5 }, () => create('Concurrent')));
        const names = results.map((server) => server.serverName);
        expect(new Set(names).size).toBe(5);
        expect(names.every((name) => /^concurrent(-\d+)?$/.test(name))).toBe(true);
        expect(await harness.readRaw('mcpservers')).toHaveLength(5);
      });

      it('rejects with a duplicate key when only the normalized name collides', async () => {
        // NOTE(contract): the name allocation looks at stored names only, so a stored server whose
        // name differs but normalizes to the slug (`my-server ` normalizes to `my-server`) makes
        // every retry pick the same name; the create gives up with the unique index's duplicate-key
        // error instead of moving to `my-server-2`.
        await seedServers(rawServer('my-server '));
        expect(normalizeServerName('my-server ')).toBe('my-server');
        const error = await rejectionOf(create('My Server'));
        expect(harness.errors.isDuplicateKey(error)).toBe(true);
        expect(await harness.readRaw('mcpservers')).toHaveLength(1);
      });

      it('derives names per tenant and stamps the ambient tenant', async () => {
        const a = await inTenant('tenant-a', () => create('Shared Title'));
        const b = await inTenant('tenant-b', () => create('Shared Title'));
        const a2 = await inTenant('tenant-a', () => create('Shared Title'));
        expect([a.serverName, b.serverName, a2.serverName]).toEqual([
          'shared-title',
          'shared-title',
          'shared-title-2',
        ]);
        const stored = await harness.readRaw('mcpservers');
        expect(stored.map((row) => [row.serverName, row.tenantId])).toEqual([
          ['shared-title', 'tenant-a'],
          ['shared-title', 'tenant-b'],
          ['shared-title-2', 'tenant-a'],
        ]);
      });
    });

    /* ------------------------------------------------------------------ single reads */

    describe('findMCPServerByServerName', () => {
      it('finds the server by its exact name, or null', async () => {
        const created = await create('Find Me');
        const found = await servers().findMCPServerByServerName('find-me');
        expect(idOf(harness, found?._id)).toBe(idOf(harness, created._id));
        expect(found).toMatchObject({ serverName: 'find-me', config: sse('Find Me') });
        expect(await servers().findMCPServerByServerName('Find-Me')).toBeNull();
        expect(await servers().findMCPServerByServerName('missing')).toBeNull();
      });

      it('reads in the ambient tenant only', async () => {
        await inTenant('tenant-a', () => create('Scoped'));
        expect(
          await inTenant('tenant-a', () => servers().findMCPServerByServerName('scoped')),
        ).not.toBeNull();
        expect(
          await inTenant('tenant-b', () => servers().findMCPServerByServerName('scoped')),
        ).toBeNull();
      });
    });

    describe('findMCPServerByObjectId', () => {
      it('finds the server by a store id or its hex string, or null', async () => {
        const created = await create('By Id');
        const id = idOf(harness, created._id);
        expect((await servers().findMCPServerByObjectId(storeId(id)))?.serverName).toBe('by-id');
        expect((await servers().findMCPServerByObjectId(id))?.serverName).toBe('by-id');
        expect(await servers().findMCPServerByObjectId(newId())).toBeNull();
      });

      it('rejects a value that is not an id of the store', async () => {
        await expect(servers().findMCPServerByObjectId('invalid-id')).rejects.toThrow();
      });
    });

    /* ------------------------------------------------------------------ listings */

    describe('getListMCPServersByIds', () => {
      it('lists the servers with the ids, most recently updated first, ties by id', async () => {
        const [a, b, c, d, e] = Array.from({ length: 5 }, () => newId()).sort();
        await seedServers(
          rawServer('s-a', { _id: a, updatedAt: at(1) }),
          rawServer('s-b', { _id: b, updatedAt: at(3) }),
          rawServer('s-c', { _id: c, updatedAt: at(1) }),
          rawServer('s-d', { _id: d, updatedAt: at(3) }),
          rawServer('s-e', { _id: e, updatedAt: at(2) }),
          rawServer('not-listed'),
        );
        const result = await servers().getListMCPServersByIds({
          ids: [e, d, c, b, a].map(storeId),
        });
        expect(ids(result.data)).toEqual([b, d, e, a, c]);
        expect(result).toMatchObject({ has_more: false, after: null });
      });

      it('takes the ids as hex strings too, and lists nothing without ids', async () => {
        const id = newId();
        await seedServers(rawServer('hex', { _id: id }));
        expect(ids((await servers().getListMCPServersByIds({ ids: [id] })).data)).toEqual([id]);
        await expect(servers().getListMCPServersByIds({ ids: [] })).resolves.toEqual({
          data: [],
          has_more: false,
          after: null,
        });
        await expect(servers().getListMCPServersByIds({})).resolves.toEqual({
          data: [],
          has_more: false,
          after: null,
        });
      });

      it('pages with the cursor across update-time ties, without gaps or repeats', async () => {
        const all = Array.from({ length: 7 }, () => newId()).sort();
        await seedServers(
          ...all.map((id, index) =>
            rawServer(`page-${index}`, { _id: id, updatedAt: at(index < 4 ? 5 : 1) }),
          ),
        );
        const expected = [...all.slice(0, 4), ...all.slice(4)];
        const seen: string[] = [];
        let after: string | null = null;
        let pages = 0;
        do {
          const page: ServerPage = await servers().getListMCPServersByIds({
            ids: all.map(storeId),
            limit: 3,
            after,
          });
          seen.push(...ids(page.data));
          expect(page.has_more).toBe(page.after != null);
          after = page.after;
          pages++;
        } while (after != null);
        expect(seen).toEqual(expected);
        expect(pages).toBe(3);
      });

      it('reports has_more and a cursor only when more servers follow', async () => {
        const all = Array.from({ length: 3 }, () => newId());
        await seedServers(...all.map((id, i) => rawServer(`more-${i}`, { _id: id })));
        const full = await servers().getListMCPServersByIds({ ids: all, limit: 3 });
        expect(full.data).toHaveLength(3);
        expect(full).toMatchObject({ has_more: false, after: null });
        const partial = await servers().getListMCPServersByIds({ ids: all, limit: 2 });
        expect(partial.data).toHaveLength(2);
        expect(partial.has_more).toBe(true);
        expect(typeof partial.after).toBe('string');
      });

      it('ignores an unreadable cursor', async () => {
        const all = Array.from({ length: 2 }, () => newId());
        await seedServers(...all.map((id, i) => rawServer(`cursor-${i}`, { _id: id })));
        for (const after of [
          'invalid-cursor',
          Buffer.from(JSON.stringify({ updatedAt: at(0), _id: 'not-an-id' })).toString('base64'),
        ]) {
          const result = await servers().getListMCPServersByIds({ ids: all, after });
          expect(result.data).toHaveLength(2);
        }
      });

      it('clamps the limit to 1..100, with 0 meaning the default page of 20', async () => {
        const all = Array.from({ length: 101 }, () => newId());
        await seedServers(...all.map((id, i) => rawServer(`clamp-${i}`, { _id: id })));
        const page = (limit: number | null) =>
          servers().getListMCPServersByIds({ ids: all, limit });
        expect((await page(200)).data).toHaveLength(100);
        expect((await page(200)).has_more).toBe(true);
        expect((await page(-5)).data).toHaveLength(1);
        // NOTE(contract): the port says the limit is clamped to 1..100, but `0` is read as "no
        // number" (`parseInt('0') || 20`) and gives the default page of 20, not 1.
        expect((await page(0)).data).toHaveLength(20);
        const unpaged = await page(null);
        expect(unpaged.data).toHaveLength(101);
        expect(unpaged).toMatchObject({ has_more: false, after: null });
      });

      it('adds the other criteria to the id condition', async () => {
        const [plain, described, otherAuthor] = [newId(), newId(), newId()];
        const otherAuthorId = newId();
        await seedServers(
          rawServer('plain', { _id: plain }),
          rawServer('described', {
            _id: described,
            config: sse('Described', 'Has description'),
          }),
          rawServer('other-author', {
            _id: otherAuthor,
            author: otherAuthorId,
            config: sse('Other', 'Has description'),
          }),
        );
        const all = [plain, described, otherAuthor];
        const byDescription = await servers().getListMCPServersByIds({
          ids: all,
          otherParams: { 'config.description': 'Has description' },
        });
        expect(ids(byDescription.data).sort()).toEqual([described, otherAuthor].sort());
        const byAuthor = await servers().getListMCPServersByIds({
          ids: all,
          otherParams: { 'config.description': 'Has description', author: otherAuthorId },
        });
        expect(ids(byAuthor.data)).toEqual([otherAuthor]);
        const byName = await servers().getListMCPServersByIds({
          ids: all,
          otherParams: { serverName: { $in: ['plain', 'described'] } },
          limit: 1,
        });
        expect(byName.data).toHaveLength(1);
        expect(byName.has_more).toBe(true);
        const rest = await servers().getListMCPServersByIds({
          ids: all,
          otherParams: { serverName: { $in: ['plain', 'described'] } },
          limit: 1,
          after: byName.after,
        });
        expect(ids([...byName.data, ...rest.data]).sort()).toEqual([plain, described].sort());
        expect(rest.has_more).toBe(false);
      });

      it('lists in the ambient tenant only', async () => {
        const [mine, theirs] = [newId(), newId()];
        await seedServers(
          rawServer('mine', { _id: mine, tenantId: 'tenant-a' }),
          rawServer('theirs', { _id: theirs, tenantId: 'tenant-b' }),
        );
        const listed = await inTenant('tenant-a', () =>
          servers().getListMCPServersByIds({ ids: [mine, theirs] }),
        );
        expect(ids(listed.data)).toEqual([mine]);
      });
    });

    describe('getListMCPServersByNames', () => {
      it('lists the existing servers with the names, each once', async () => {
        await seedServers(rawServer('one'), rawServer('two'), rawServer('three'));
        const result = await servers().getListMCPServersByNames({
          names: ['one', 'two', 'two', 'missing'],
        });
        expect(result.data.map((server) => server.serverName).sort()).toEqual(['one', 'two']);
        expect(Object.keys(result)).toEqual(['data']);
      });

      it('lists nothing for no names', async () => {
        await seedServers(rawServer('one'));
        await expect(servers().getListMCPServersByNames({ names: [] })).resolves.toEqual({
          data: [],
        });
      });

      it('lists in the ambient tenant only', async () => {
        await seedServers(
          rawServer('one', { tenantId: 'tenant-a' }),
          rawServer('one', { tenantId: 'tenant-b', config: sse('B') }),
        );
        const listed = await inTenant('tenant-b', () =>
          servers().getListMCPServersByNames({ names: ['one'] }),
        );
        expect(listed.data.map((server) => server.config.title)).toEqual(['B']);
      });
    });

    /* ------------------------------------------------------------------ writes */

    describe('updateMCPServer', () => {
      it('replaces the config, keeps the name and advances the update time', async () => {
        await seedServers(
          rawServer('update-me', {
            config: { ...sse('Update Me', 'Original'), iconPath: '/old.png' },
            updatedAt: at(0),
          }),
        );
        const updated = await servers().updateMCPServer('update-me', {
          config: sse('Update Me', 'Updated'),
        });
        expect(updated).toMatchObject({
          serverName: 'update-me',
          normalizedServerName: 'update-me',
          config: sse('Update Me', 'Updated'),
        });
        expect(updated?.config).not.toHaveProperty('iconPath');
        expect(timeOf(updated?.updatedAt)).toBeGreaterThan(at(0).getTime());
        const [stored] = await harness.readRaw('mcpservers');
        expect(stored.config).toEqual(sse('Update Me', 'Updated'));
        expect(timeOf(stored.createdAt)).toBe(at(0).getTime());
      });

      it('resolves null for an unknown name and writes nothing', async () => {
        await expect(
          servers().updateMCPServer('missing', { config: sse('Missing') }),
        ).resolves.toBeNull();
        expect(await harness.readRaw('mcpservers')).toEqual([]);
      });

      it('updates in the ambient tenant only', async () => {
        await seedServers(rawServer('scoped', { tenantId: 'tenant-a' }));
        await expect(
          inTenant('tenant-b', () => servers().updateMCPServer('scoped', { config: sse('X') })),
        ).resolves.toBeNull();
        expect((await harness.readRaw('mcpservers'))[0].config).toEqual(sse('scoped'));
      });
    });

    describe('deleteMCPServer', () => {
      it('deletes the server, resolves to it, and leaves its ACL entries', async () => {
        const id = newId();
        await seedServers(rawServer('delete-me', { _id: id, config: sse('Delete', 'Gone') }));
        await grant(PrincipalType.USER, authorId, id, OWNER_BITS);
        const deleted = await servers().deleteMCPServer('delete-me');
        expect(idOf(harness, deleted?._id)).toBe(id);
        expect(deleted?.config.description).toBe('Gone');
        expect(await harness.readRaw('mcpservers')).toEqual([]);
        expect(await harness.readRaw('aclentries')).toHaveLength(1);
        await expect(servers().deleteMCPServer('delete-me')).resolves.toBeNull();
      });
    });

    describe('deleteMCPServersWithAcl', () => {
      it('deletes the servers and their MCP server ACL entries; resolves how many', async () => {
        const [a, b, kept] = [newId(), newId(), newId()];
        await seedServers(
          rawServer('a', { _id: a }),
          rawServer('b', { _id: b }),
          rawServer('k', { _id: kept }),
        );
        await grant(PrincipalType.USER, authorId, a, OWNER_BITS);
        await grant(PrincipalType.USER, newId(), b, PermissionBits.VIEW);
        await grant(PrincipalType.USER, authorId, kept, OWNER_BITS);
        await grant(PrincipalType.USER, authorId, a, OWNER_BITS, ResourceType.AGENT);

        await expect(servers().deleteMCPServersWithAcl([a, b, newId()])).resolves.toBe(2);

        expect((await harness.readRaw('mcpservers')).map((row) => row._id)).toEqual([kept]);
        const entries = await harness.readRaw('aclentries');
        expect(entries.map((row) => [row.resourceType, row.resourceId]).sort()).toEqual(
          [
            [ResourceType.MCPSERVER, kept],
            [ResourceType.AGENT, a],
          ].sort(),
        );
      });

      it('resolves 0 for no ids', async () => {
        await seedServers(rawServer('a'));
        await expect(servers().deleteMCPServersWithAcl([])).resolves.toBe(0);
        expect(await harness.readRaw('mcpservers')).toHaveLength(1);
      });

      it('cleans the ACL entries of a server already gone, for a retried erasure', async () => {
        const gone = newId();
        await grant(PrincipalType.USER, authorId, gone, OWNER_BITS);
        await expect(servers().deleteMCPServersWithAcl([gone])).resolves.toBe(0);
        expect(await harness.readRaw('aclentries')).toEqual([]);
      });
    });

    /* ------------------------------------------------------------------ erasure and removal reads */

    describe('findUserErasableMCPServers', () => {
      it('returns sole-owned and legacy authored servers, a gone one with an empty name', async () => {
        const userId = newId();
        const otherOwner = newId();
        const [sole, shared, legacy, migrated, gone, viewOnly] = Array.from({ length: 6 }, () =>
          newId(),
        );
        await seedServers(
          rawServer('sole', { _id: sole }),
          rawServer('shared', { _id: shared }),
          rawServer('legacy', { _id: legacy, author: userId }),
          rawServer('migrated', { _id: migrated, author: userId }),
          rawServer('view-only', { _id: viewOnly }),
        );
        await grant(PrincipalType.USER, userId, sole, OWNER_BITS);
        await grant(PrincipalType.USER, userId, shared, OWNER_BITS);
        await grant(PrincipalType.USER, otherOwner, shared, OWNER_BITS);
        await grant(PrincipalType.USER, otherOwner, migrated, OWNER_BITS);
        await grant(PrincipalType.USER, userId, gone, OWNER_BITS);
        await grant(PrincipalType.USER, userId, viewOnly, PermissionBits.VIEW);

        const erasable = await servers().findUserErasableMCPServers(userId);
        const byId = (rows: Array<{ id: string; serverName: string }>) =>
          [...rows].sort((x, y) => x.id.localeCompare(y.id));
        expect(byId(erasable)).toEqual(
          byId([
            { id: sole, serverName: 'sole' },
            { id: legacy, serverName: 'legacy' },
            { id: gone, serverName: '' },
          ]),
        );
      });

      it('treats a group owner as another owner', async () => {
        const userId = newId();
        const server = newId();
        await seedServers(rawServer('group-owned', { _id: server }));
        await grant(PrincipalType.USER, userId, server, OWNER_BITS);
        await grant(PrincipalType.GROUP, newId(), server, OWNER_BITS);
        await expect(servers().findUserErasableMCPServers(userId)).resolves.toEqual([]);
      });

      it('returns none for a user with nothing to erase', async () => {
        await seedServers(rawServer('someone-else'));
        await expect(servers().findUserErasableMCPServers(newId())).resolves.toEqual([]);
      });

      it('finds the server again after a partial erasure, until it is deleted', async () => {
        const userId = newId();
        const server = newId();
        await seedServers(rawServer('retry', { _id: server }));
        await grant(PrincipalType.USER, userId, server, OWNER_BITS);
        expect((await servers().findUserErasableMCPServers(userId)).map((s) => s.id)).toEqual([
          server,
        ]);
        await servers().deleteMCPServersWithAcl([server]);
        await expect(servers().findUserErasableMCPServers(userId)).resolves.toEqual([]);
      });
    });

    describe('findMCPServerOAuthTokenUserIds', () => {
      const token = (userId: string, identifier: string, tenantId?: string): RawRecord => ({
        _id: newId(),
        userId,
        identifier,
        token: `token-${newId()}`,
        createdAt: at(0),
        expiresAt: at(60),
        ...(tenantId != null ? { tenantId } : {}),
      });

      it('returns the distinct holders of the server, client and refresh records', async () => {
        const [a, b, c, d] = [newId(), newId(), newId(), newId()];
        await harness.seedRaw('tokens', [
          token(a, 'mcp:github'),
          token(a, 'mcp:github:refresh'),
          token(b, 'mcp:github:client'),
          token(c, 'mcp:github:other'),
          token(d, 'mcp:gitlab'),
          token(c, 'mcp:git'),
        ]);
        const holders = await servers().findMCPServerOAuthTokenUserIds('github');
        expect(holders.map((id) => idOf(harness, id)).sort()).toEqual([a, b].sort());
        expect(holders.every((id) => typeof id === 'string')).toBe(true);
      });

      it('reads the given tenant, or tenantless records only', async () => {
        const [inA, inB, none] = [newId(), newId(), newId()];
        await harness.seedRaw('tokens', [
          token(inA, 'mcp:github', 'tenant-a'),
          token(inB, 'mcp:github', 'tenant-b'),
          token(none, 'mcp:github'),
          { ...token(none, 'mcp:github:refresh'), tenantId: null },
        ]);
        expect(
          (await servers().findMCPServerOAuthTokenUserIds('github', 'tenant-a')).map((id) =>
            idOf(harness, id),
          ),
        ).toEqual([inA]);
        expect(
          (await servers().findMCPServerOAuthTokenUserIds('github')).map((id) => idOf(harness, id)),
        ).toEqual([none]);
      });
    });

    describe('findMCPServerTokenHolderIds', () => {
      const token = (userId: string, identifier: string, tenantId?: string): RawRecord => ({
        _id: newId(),
        userId,
        identifier,
        token: `token-${newId()}`,
        createdAt: at(0),
        expiresAt: at(60),
        ...(tenantId != null ? { tenantId } : {}),
      });

      it('returns the distinct holders as store ids, with no tenant criterion of its own', async () => {
        const [a, b, c] = [newId(), newId(), newId()];
        await harness.seedRaw('tokens', [
          token(a, 'mcp:github', 'tenant-a'),
          token(a, 'mcp:github:client', 'tenant-a'),
          token(b, 'mcp:github:refresh', 'tenant-b'),
          token(c, 'mcp:github'),
          token(c, 'mcp:github:other'),
        ]);
        const all = await servers().findMCPServerTokenHolderIds('github');
        expect(all.map((id) => idOf(harness, id)).sort()).toEqual([a, b, c].sort());
        expect(all.every((id) => harness.ids.isValid(id))).toBe(true);
        const scoped = await inTenant('tenant-a', () =>
          servers().findMCPServerTokenHolderIds('github'),
        );
        expect(scoped.map((id) => idOf(harness, id))).toEqual([a]);
        await expect(servers().findMCPServerTokenHolderIds('none')).resolves.toEqual([]);
      });
    });

    describe('findMCPServerViewerEntries', () => {
      it('returns the principals whose bits include view on the server', async () => {
        const server = newId();
        const [viewer, editor, editOnly, group] = [newId(), newId(), newId(), newId()];
        await grant(PrincipalType.USER, viewer, server, PermissionBits.VIEW);
        await grant(PrincipalType.USER, editor, server, PermissionBits.VIEW | PermissionBits.EDIT);
        await grant(PrincipalType.USER, editOnly, server, PermissionBits.EDIT);
        await grant(PrincipalType.GROUP, group, server, PermissionBits.VIEW);
        await grant(PrincipalType.PUBLIC, null, server, PermissionBits.VIEW);
        await grant(PrincipalType.USER, viewer, newId(), PermissionBits.VIEW);
        await grant(PrincipalType.USER, editor, server, PermissionBits.VIEW, ResourceType.AGENT);

        const entries = await servers().findMCPServerViewerEntries(server);
        const key = (entry: { principalType: string; principalId?: string }) =>
          `${entry.principalType}:${entry.principalId ?? ''}`;
        expect(entries.map(key).sort()).toEqual(
          [
            `${PrincipalType.USER}:${viewer}`,
            `${PrincipalType.USER}:${editor}`,
            `${PrincipalType.GROUP}:${group}`,
            `${PrincipalType.PUBLIC}:`,
          ].sort(),
        );
        expect(
          entries.find((e) => e.principalType === PrincipalType.PUBLIC)?.principalId,
        ).toBeUndefined();
      });
    });

    describe('findMCPServerViewAclEntries', () => {
      it('returns the whole entries on the server with any view bit set', async () => {
        const server = newId();
        await grant(PrincipalType.USER, newId(), server, PermissionBits.VIEW);
        await grant(PrincipalType.USER, newId(), server, PermissionBits.VIEW | PermissionBits.EDIT);
        await grant(PrincipalType.USER, newId(), server, PermissionBits.EDIT);
        await grant(PrincipalType.USER, newId(), server, 0);
        await grant(PrincipalType.USER, newId(), server, PermissionBits.VIEW, ResourceType.AGENT);
        await grant(PrincipalType.USER, newId(), newId(), PermissionBits.VIEW);
        await grant(PrincipalType.PUBLIC, null, server, PermissionBits.VIEW);

        const entries = await servers().findMCPServerViewAclEntries(server);
        expect(entries).toHaveLength(3);
        expect(entries.every((e) => idOf(harness, e.resourceId) === server)).toBe(true);
        expect(entries.every((e) => (e.permBits & PermissionBits.VIEW) !== 0)).toBe(true);
        expect(entries.every((e) => e.resourceType === ResourceType.MCPSERVER)).toBe(true);
        const stored = await readRawWhere(harness, 'aclentries', {
          resourceType: ResourceType.MCPSERVER,
          resourceId: server,
        });
        const viewIds = stored
          .filter((row) => ((row.permBits as number) & PermissionBits.VIEW) !== 0)
          .map((row) => row._id)
          .sort();
        expect(entries.map((e) => idOf(harness, e._id)).sort()).toEqual(viewIds);
        expect(entries[0]).toHaveProperty('grantedAt');
        await expect(servers().findMCPServerViewAclEntries(storeId(server))).resolves.toHaveLength(
          3,
        );
      });

      it('rejects a value that is not an id of the store', async () => {
        await expect(servers().findMCPServerViewAclEntries('not-an-id')).rejects.toThrow();
      });
    });

    describe('findMCPServerViewerUserIds', () => {
      it('expands direct and group viewers to user ids, external members by source id', async () => {
        const [direct, localMember, externalMember, group, emptyGroup] = Array.from(
          { length: 5 },
          () => newId(),
        );
        await harness.seedRaw('users', [
          { _id: localMember, email: 'local@example.com' },
          { _id: externalMember, email: 'external@example.com', idOnTheSource: 'entra-7' },
        ]);
        await harness.seedRaw('groups', [
          {
            _id: group,
            name: 'Viewers',
            source: 'local',
            memberIds: [localMember, 'entra-7', 'entra-unknown'],
          },
          { _id: emptyGroup, name: 'Empty', source: 'local', memberIds: [] },
        ]);

        const userIds = await servers().findMCPServerViewerUserIds([
          { principalType: PrincipalType.USER, principalId: storeId(direct) },
          { principalType: PrincipalType.GROUP, principalId: group },
          { principalType: PrincipalType.GROUP, principalId: emptyGroup },
          { principalType: PrincipalType.GROUP, principalId: 'not-a-group-id' },
          { principalType: PrincipalType.ROLE, principalId: 'USER' },
          { principalType: PrincipalType.PUBLIC },
        ]);
        expect([...userIds].sort()).toEqual([direct, localMember, externalMember].sort());
      });

      it('returns the direct users without reading groups, each once', async () => {
        const direct = newId();
        await expect(
          servers().findMCPServerViewerUserIds([
            { principalType: PrincipalType.USER, principalId: direct },
            { principalType: PrincipalType.USER, principalId: direct },
            { principalType: PrincipalType.USER },
          ]),
        ).resolves.toEqual([direct]);
        await expect(servers().findMCPServerViewerUserIds([])).resolves.toEqual([]);
      });
    });
  });
}
