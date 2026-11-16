/**
 * What every PostgreSQL store adapter is built with (docs/postgres-port/PHASE4.md §8, Wave 5): the
 * collection primitive over the production tables, the Kysely handle for hand-written SQL, the
 * `transactions` store, and the pieces hand-written SQL needs to follow the primitive's rules.
 * Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The pattern each store module follows (`./<module>.ts`):
 *
 * ```ts
 * export function createPostgresBannerStore(context: PostgresStoreContext): BannerStore {
 *   const banners = () => context.collections().collection<IBanner>('banners');
 *   const store: BannerStore = {
 *     async getBanner(user) { ... await banners().findOne(filter) ... },
 *     ...
 *   };
 *   return store;
 * }
 * ```
 *
 * - Stores reach a collection on each call (`context.collections()`), never at construction: the
 *   primitive and the schema engine are built on first use, and the handle exists only once the
 *   backend's connection is open (every operation rejects with "PostgreSQL is not connected"
 *   before that, like the `transactions` store).
 * - Tier 1 or tier 2 is the primitive's choice; a store states the update as on MongoDB.
 * - Hand-written SQL (`runStoreSql`, `storeWhere`) is for what the primitive cannot say (`GROUP
 *   BY`, advisory locks, comparisons the translator refuses). Its filters go through
 *   `storeWhere`, so they are cast and translated as the primitive's own and, on a tenant-scoped
 *   collection, restricted to the active tenant exactly as the mongoose plugin restricts
 *   `aggregate`. It locks parent rows before writing their child rows, and never reads a parent's
 *   child rows in the statement that locks it (§3.5); a lock-then-write runs in one transaction
 *   (`context.transactions`), its writes through the primitive with `tx`.
 * - Keyset paging (streams, cursors) is a loop of primitive `find`s with `sort` and `limit` in an
 *   async generator; no cursor is held across awaits (§4).
 */
import type { PgCollections, PgFilter, PgRecord, SqlResult, SqlRunner } from '../collection';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { StoreTransaction } from '~/ports/common';
import type { SqlFragment } from '../query/sql';
import type { PostgresKysely } from '../types';
import { resolvePostgresExecutor } from '../storeTransactions';
import { scopeTenantFilter } from '../collection/tenant';
import { createSqlRunner } from '../collection/runner';
import { compileQuerySql } from '../query/sql';

/** What a PostgreSQL store adapter is built with. */
export interface PostgresStoreContext {
  /** The collections in document mode (`collection`) and raw mode (`raw`), built on first use. */
  collections(): PgCollections;
  /** The backend's Kysely instance; throws while the backend is not connected. */
  db(): PostgresKysely;
  /** The `transactions` store of the same backend. */
  readonly transactions: StoreTransactions;
  /** Whether `collection` binds the tenant policy (its schema carries the tenant plugin). */
  isTenantScoped(collection: string): boolean;
}

/** A typed record (an interface without an index signature) as the primitive's record type. */
export function asRecord<T extends object>(value: T): PgRecord {
  return value as unknown as PgRecord;
}

/** The runner of hand-written statements: the backend's handle, or the open transaction `tx`. */
export function storeRunner(context: PostgresStoreContext, tx?: StoreTransaction): SqlRunner {
  return createSqlRunner(resolvePostgresExecutor(context.db(), tx));
}

/**
 * The `WHERE` condition of `filter` over `collection`'s rows (alias `alias`, default `t`), cast
 * as the primitive casts it and, on a tenant-scoped collection, restricted to the active tenant
 * (`operation` names the read in strict mode's refusal, as the plugin's `'Aggregate'`).
 */
export function storeWhere(
  context: PostgresStoreContext,
  collection: string,
  filter: PgFilter,
  options: { alias?: string; operation?: string } = {},
): SqlFragment {
  const scoped = context.isTenantScoped(collection)
    ? scopeTenantFilter(options.operation ?? 'Aggregate', filter)
    : filter;
  return context
    .collections()
    .translator.filter(collection, scoped as Record<string, unknown>, { alias: options.alias });
}

/** Runs one hand-written statement (on `tx` when given). */
export function runStoreSql<R = Record<string, unknown>>(
  context: PostgresStoreContext,
  statement: SqlFragment,
  tx?: StoreTransaction,
): Promise<SqlResult<R>> {
  return storeRunner(context, tx).run<R>(compileQuerySql(statement));
}
