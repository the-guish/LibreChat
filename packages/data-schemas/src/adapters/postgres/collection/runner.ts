/**
 * How the collection primitive runs SQL (docs/postgres-port/PHASE4.md §3, §4 "Internal
 * transactions"): on the backend's Kysely instance, or on the open transaction a store method was
 * handed (`resolvePostgresExecutor`). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - `query` runs one parameterized statement (`CompiledQuery.raw`), so the Kysely `log` hook still
 *   reports it to the query observer.
 * - `atomic` runs several statements as one unit: in a new transaction, or, inside an open one, in
 *   a savepoint (released on success, rolled back to on failure), so a failed step (a duplicate key
 *   an upsert retries) does not abort the caller's transaction.
 * - `lc_fail` (SQLSTATE `LC001`, the helper tier-1 updates raise MongoDB's refusals with) becomes a
 *   `StoreQueryError` carrying its message, as the reference evaluator raises it.
 */
import { CompiledQuery } from 'kysely';
import type { Kysely } from 'kysely';
import type { CompiledQuerySql } from '../query/sql';
import type { PostgresTables } from '../types';
import { LC_FAIL_SQLSTATE } from '../schema/functions';
import { StoreQueryError } from '~/ports/query';

/** The result of one statement. */
export interface SqlResult<R> {
  rows: R[];
  /** Rows the statement inserted, updated or deleted (0 for a read). */
  rowCount: number;
}

/** Runs the primitive's statements on one Kysely executor. */
export interface SqlRunner {
  /** The executor (the backend's Kysely instance, or a transaction). */
  readonly db: Kysely<PostgresTables>;
  /** Whether the executor is a transaction (so `atomic` uses a savepoint). */
  readonly inTransaction: boolean;
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<R>>;
  /** Runs a compiled statement. */
  run<R = Record<string, unknown>>(statement: CompiledQuerySql): Promise<SqlResult<R>>;
  /** Runs `fn` as one unit: a new transaction, or a savepoint inside the open one. */
  atomic<T>(fn: (runner: SqlRunner) => Promise<T>): Promise<T>;
}

let savepointCounter = 0;

/** `lc_fail`'s error as the `StoreQueryError` it stands for; anything else as it is. */
export function translateSqlError(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === LC_FAIL_SQLSTATE
  ) {
    return new StoreQueryError((error as { message?: string }).message ?? 'update refused');
  }
  return error;
}

/** The runner over `db` (the backend's Kysely instance or a transaction). */
export function createSqlRunner(db: Kysely<PostgresTables>): SqlRunner {
  const query = async <R>(text: string, values: readonly unknown[] = []) => {
    try {
      const result = await db.executeQuery<R>(CompiledQuery.raw(text, [...values]));
      return {
        rows: result.rows as R[],
        rowCount: Number(result.numAffectedRows ?? 0),
      };
    } catch (error) {
      throw translateSqlError(error);
    }
  };
  const runner: SqlRunner = {
    db,
    inTransaction: db.isTransaction,
    query,
    run: (statement) => query(statement.text, statement.values),
    atomic: async (fn) => {
      if (!db.isTransaction) {
        return db.transaction().execute((trx) => fn(createSqlRunner(trx)));
      }
      const name = `lc_sp_${++savepointCounter}`;
      await query(`SAVEPOINT ${name}`);
      let result;
      try {
        result = await fn(runner);
      } catch (error) {
        await query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        await query(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
        throw error;
      }
      await query(`RELEASE SAVEPOINT ${name}`);
      return result;
    },
  };
  return runner;
}
