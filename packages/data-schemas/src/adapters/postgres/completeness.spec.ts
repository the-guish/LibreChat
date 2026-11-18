import fs from 'node:fs';
import path from 'node:path';
import type { DataStore } from '~/ports';
import { DATA_STORE_STARTUP_CHECK_METHODS } from '~/ports/startupChecks';
import { DATA_STORE_BACKEND_MEMBERS } from '~/ports/connection';
import { createPostgresDataStoreBackend } from './backend';
import { DATA_STORE_METHODS } from '~/ports';

const SOURCE_ROOT = path.resolve(__dirname, '..', '..');
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]s$/;

/** The non-test TypeScript sources under `dir` (relative to `src/`). */
function sourcesUnder(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.ts$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(path.join(SOURCE_ROOT, dir));
  return files;
}

/**
 * The completeness gate of the PostgreSQL backend (docs/postgres-port/PHASE4.md §8 B1): every
 * store of `DATA_STORE_METHODS` and every backend member is real, no stand-in is left, and the
 * connection no longer has an escape hatch for missing stores.
 */
describe('PostgreSQL backend completeness', () => {
  const backend = createPostgresDataStoreBackend();
  const methods = backend.createMethods();

  it('composes every store of DATA_STORE_METHODS with exactly its port methods, all functions', () => {
    const stores = Object.keys(DATA_STORE_METHODS) as Array<keyof DataStore>;
    expect(Object.keys(methods.stores).sort()).toEqual([...stores].sort());
    for (const store of stores) {
      const members = methods.stores[store] as unknown as Record<string, unknown>;
      const ported = DATA_STORE_METHODS[store] as ReadonlyArray<string>;
      expect({ store, methods: Object.keys(members).sort() }).toEqual({
        store,
        methods: [...ported].sort(),
      });
      for (const method of ported) {
        expect({ store, method, type: typeof members[method] }).toEqual({
          store,
          method,
          type: 'function',
        });
      }
    }
  });

  it('has every DataStoreBackend member, and startup checks with every port method', () => {
    for (const member of DATA_STORE_BACKEND_MEMBERS) {
      expect({ member, defined: backend[member] !== undefined }).toEqual({
        member,
        defined: true,
      });
    }
    const checks = backend.createStartupChecks({ findRoleByIdentifier: async () => null });
    expect(Object.keys(checks).sort()).toEqual([...DATA_STORE_STARTUP_CHECK_METHODS].sort());
    for (const method of DATA_STORE_STARTUP_CHECK_METHODS) {
      expect(typeof checks[method]).toBe('function');
    }
    expect(backend.registerModels()).toBeUndefined();
  });

  it('lists nothing as unimplemented and no longer reads the escape hatch', () => {
    expect('unimplemented' in backend).toBe(false);
    const offenders = sourcesUnder('adapters')
      .concat(sourcesUnder('compose'))
      .filter((file) =>
        /StoreNotImplementedError|createNotImplemented|POSTGRES_ALLOW_INCOMPLETE_STORES|IncompletePostgresBackendError/.test(
          fs.readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(SOURCE_ROOT, file));
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(__dirname, 'notImplemented.ts'))).toBe(false);
  });

  it('connects without any flag: an unreachable server is a connection error, not a refusal', async () => {
    const connection = backend.createConnection({
      env: { POSTGRES_URI: 'postgresql://postgres@127.0.0.1:1/nowhere' },
      cache: { handle: null, promise: null },
    });
    /** `pg` rejects with an error of Node's realm, so it is matched by shape. */
    const error = (await connection.connect().catch((reason: unknown) => reason)) as Error;
    expect(error).toMatchObject({ message: expect.stringMatching(/ECONNREFUSED|connect/i) });
    expect(error.name).not.toBe('IncompletePostgresBackendError');
    expect(connection.getState()).toBe('disconnected');
  });
});
