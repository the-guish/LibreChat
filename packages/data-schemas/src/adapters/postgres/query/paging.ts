/**
 * Paging (docs/postgres-port/PHASE4.md §2.3): `StoreQueryOptions`' `limit` and `offset` as
 * `LIMIT`/`OFFSET`. A `limit` of `0` or less means no limit and an `offset` of `0` or less no
 * offset, as with MongoDB's `limit()` and `skip()` (and the reference evaluator). Keyset paging
 * for cursors (§4) belongs to the stores that page by cursor. Must not import `mongoose`,
 * `mongodb` or `bson`.
 */
import type { SqlFragment } from './sql';
import { StoreQueryError } from '~/ports/query';
import { sql } from './sql';

/** The paging part of a read. */
export interface PagingOptions {
  limit?: number | null;
  offset?: number | null;
}

function assertCount(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new StoreQueryError(`The ${name} of a read must be an integer`);
  }
}

/** ` LIMIT n OFFSET m` (the parts that apply), or an empty fragment. */
export function translatePaging(options: PagingOptions = {}): SqlFragment {
  const parts: SqlFragment[] = [];
  if (options.limit !== undefined && options.limit !== null) {
    assertCount('limit', options.limit);
    if (options.limit > 0) {
      parts.push(sql` LIMIT ${sql.lit(options.limit)}`);
    }
  }
  if (options.offset !== undefined && options.offset !== null) {
    assertCount('offset', options.offset);
    if (options.offset > 0) {
      parts.push(sql` OFFSET ${sql.lit(options.offset)}`);
    }
  }
  return parts.length === 0 ? sql`` : sql.join(parts, sql``);
}
