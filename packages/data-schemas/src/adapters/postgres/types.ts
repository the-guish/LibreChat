/**
 * Types shared by the PostgreSQL adapter. Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { Kysely } from 'kysely';
import type { Pool } from 'pg';

/**
 * The tables Kysely is typed with. Untyped until the generator emits `db.generated.ts` (F2/F3):
 * the foundation's SQL is raw `sql` templates.
 */
export type PostgresTables = Record<string, Record<string, unknown>>;

/** A Kysely instance over the PostgreSQL backend's pool. */
export type PostgresKysely = Kysely<PostgresTables>;

/**
 * What the PostgreSQL connection's `connect` resolves to: the Kysely instance the stores query
 * through, the `pg` pool under it (shared with `PostgresSaver`, I2) and the schema the tables
 * live in.
 */
export interface PostgresHandle {
  readonly db: PostgresKysely;
  readonly pool: Pool;
  readonly schema: string;
}
