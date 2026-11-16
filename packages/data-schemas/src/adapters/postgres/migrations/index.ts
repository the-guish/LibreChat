/**
 * The PostgreSQL migrations, in code (docs/postgres-port/PHASE4.md §5): every migration module
 * imported statically and listed here under its name (`<YYYYMMDDHHmm>_<slug>`), because tsdown
 * bundles the package and a migration folder read at run time would not exist in `dist`. The
 * generator (F2/F3, `npm run db:generate`) writes the modules and this list; it never changes a
 * migration that is already checked in. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Empty until F3 adds `0001_initial` (every table, the `lc_object_id` domain and the `lc_*`
 * helper functions): the foundation needs no table of its own. Migrating an empty list still
 * creates Kysely's migration and lock tables, so the migration level of a new database is
 * known.
 */
import type { Migration } from 'kysely';

/** Every migration of the PostgreSQL schema, by name; applied in name order. */
export const POSTGRES_MIGRATIONS: Readonly<Record<string, Migration>> = Object.freeze({});
