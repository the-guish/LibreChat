import path from 'path';
import { test } from '@playwright/test';
import { getE2EDatabaseBackend } from '../../setup/database';

/**
 * The mock specs that skip under `E2E_DATABASE_BACKEND=postgres` (docs/postgres-port/PHASE4.md
 * §7, E1): the ones that reach MongoDB past `db.ts` (their own `MongoClient` or mongoose
 * connection, ObjectId values and driver types in their assertions, CLI scripts run against
 * `MONGO_URI`), keyed by their path under `e2e/specs/mock/`. Every one calls
 * `skipOnPostgres(__filename)` once, at file scope; on MongoDB the call does nothing.
 *
 * E2 shrinks this list: a spec moved onto `db.ts` (or found to pass on PostgreSQL, which
 * `E2E_POSTGRES_RUN_SKIPPED=true` runs anyway) loses its entry and its call together.
 */
export const POSTGRES_SKIPPED_SPECS: Readonly<Record<string, string>> = {
  'agent-file-ownership.spec.ts':
    'imports mongodb for ObjectId owners and the Db/WithId driver types it asserts with',
  'agent-management-files.spec.ts':
    'connects mongoose to MONGO_URI to update users and lists collections with listCollections',
  'content-filters.persisted.spec.ts':
    'asserts stored ids are ObjectIds (ObjectId.isValid) and builds driver Filter<Document> queries',
  'model-spec-skills.spec.ts':
    'opens its own MongoClient on MONGO_URI to seed skills and ACL entries',
  'permissions.spec.ts': 'opens its own MongoClient on MONGO_URI to edit roles and ACL entries',
  'shared-links.spec.ts':
    'opens its own MongoClient on MONGO_URI and reads shares and messages as ObjectId documents',
  'skill-lifecycle-live.spec.ts':
    'connects mongoose to MONGO_URI and seeds and reads skill files through mongoose models',
  'skill-management-delete.spec.ts':
    'connects mongoose to MONGO_URI to update users and lists collections with listCollections',
  'scenarios/auth-path-reads.spec.ts':
    'seeds agents and ACL entries with ObjectId values from the mongodb package',
  'scenarios/credential-encryption.spec.ts':
    'reads stored keys by ObjectId user ids built with the mongodb package',
  'scenarios/dead-letter-retention.spec.ts':
    'seeds its deliveries with ObjectId users from the mongodb package',
  'scenarios/delete-user-cli.spec.ts':
    'runs config/delete-user.js against MONGO_URI with no-auto-index.cjs (a mongoose preload)',
  'scenarios/marketplace-mine.spec.ts':
    'seeds agents and ACL entries with ObjectId ids from the mongodb package',
  'scenarios/people-search-tokens.spec.ts':
    'runs config/migrate-search-tokens.js, a MongoDB-only legacy script, against MONGO_URI',
  'scenarios/principal-type-labels.spec.ts':
    'seeds users with ObjectId ids from the mongodb package',
  'scenarios/project-access.spec.ts':
    'types users and files as ObjectId documents and queries both id forms ($or of hex and ObjectId)',
  'scenarios/project-files-ui.spec.ts':
    'seeds and updates projects and files by ObjectId ids from the mongodb package',
  'scenarios/project-policy.spec.ts':
    'deletes balances by an ObjectId user, the MongoDB storage type, from the mongodb package',
  'scenarios/project-resume.spec.ts': 'seeds files with ObjectId ids from the mongodb package',
  'scenarios/reply-read-state.spec.ts':
    'connects mongoose to MONGO_URI and builds MongoDB models and methods of its own',
  'scenarios/reset-password.spec.ts':
    'runs config/reset-password.js against MONGO_URI with no-auto-index.cjs (a mongoose preload)',
  'scenarios/resource-acl-audit.spec.ts': 'seeds users with ObjectId ids from the mongodb package',
};

/** Runs the skipped specs on PostgreSQL anyway (E2's triage), when `true`. */
const RUN_SKIPPED = process.env.E2E_POSTGRES_RUN_SKIPPED === 'true';

/**
 * Skips every test of the calling spec file under `E2E_DATABASE_BACKEND=postgres`, with its
 * reason from {@link POSTGRES_SKIPPED_SPECS}. Call once at file scope with `__filename`; a file
 * missing from the list throws, so the list stays the one place that says what skips.
 */
export function skipOnPostgres(specFile: string): void {
  const key = path.relative(__dirname, specFile).split(path.sep).join('/');
  const reason = POSTGRES_SKIPPED_SPECS[key];
  if (reason === undefined) {
    throw new Error(`${key} calls skipOnPostgres() but is not listed in POSTGRES_SKIPPED_SPECS`);
  }
  test.skip(
    getE2EDatabaseBackend() === 'postgres' && !RUN_SKIPPED,
    `MongoDB only (PostgreSQL skip list, e2e/specs/mock/postgres-skips.ts): ${reason}`,
  );
}
