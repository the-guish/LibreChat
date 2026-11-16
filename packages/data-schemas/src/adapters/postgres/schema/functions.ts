/**
 * The `lc_*` SQL helper functions of the PostgreSQL schema (docs/postgres-port/PHASE4.md §2.3,
 * §3.3, §5): created by `0001_initial` after the `lc_object_id` domain, before the tables, for the
 * SQL the translator (Q1) and the collection primitive (C1, C2) write. A change to one of them
 * needs a hand-written migration (`CREATE OR REPLACE FUNCTION`): the snapshot diff does not track
 * them, but drift spec 2 (`drift.postgres.spec.ts`) compares the migrated functions with these
 * definitions. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - `lc_fail(message)` and `lc_fail(message, sample)`: raise SQLSTATE {@link LC_FAIL_SQLSTATE}
 *   with `message`. The first returns `boolean` (for predicates), the second the type of `sample`
 *   (`lc_fail('...', NULL::double precision)`), so it can stand in a `CASE` branch of any type, as
 *   in `$inc` on an explicit null (§3.3). Volatile, so the planner never folds a call it may not
 *   reach.
 * - `lc_nulls_set(nulls, path, is_null)`: `_nulls` with `path` listed when `is_null` (appended
 *   once, existing order kept) or removed otherwise; `NULL` when the list ends up empty (the
 *   convention of §1.2: `NULL` when no path is explicitly null).
 * - `lc_nulls_clear(nulls, path)`: `_nulls` without `path` and every path beneath it
 *   (`path.<...>`), for an object path assigned or unset as a whole; `NULL` when empty.
 * - `lc_sort_key(value, ascending)`: a sort key for a `json` value (§2.3) that orders as MongoDB
 *   sorts: by type rank first (empty array, then null or missing, numbers, strings, objects,
 *   arrays, binaries, booleans, dates), then by value within the type. A top-level array sorts by
 *   its minimum element key ascending and its maximum descending; an empty array sorts first.
 *   The key is ASCII-prefixed text, compared in code point order: callers compare it with
 *   `COLLATE "C"` (`ORDER BY lc_sort_key(c::jsonb #> '{a}', true) COLLATE "C"`). Numbers are
 *   compared numerically (as `double precision`, `-0` equal to `0`), strings in code point order,
 *   booleans `false` first, dates (`{"$date"}`, fixed-width ISO text) chronologically. Objects,
 *   nested arrays and binaries are ordered by their `jsonb` text, an approximation of MongoDB's
 *   field-by-field comparison that no method relies on.
 *   `lc_sort_key_value(value)` is the key of one value (no array unwrapping) and
 *   `lc_sort_number(n)` the order-preserving hex text of a number.
 */

/** The SQLSTATE `lc_fail` raises. */
export const LC_FAIL_SQLSTATE = 'LC001';

/** The names of the helper functions, as `0001_initial` creates them. */
export const HELPER_FUNCTION_NAMES: readonly string[] = [
  'lc_fail',
  'lc_nulls_set',
  'lc_nulls_clear',
  'lc_sort_number',
  'lc_sort_key_value',
  'lc_sort_key',
];

/** The statements creating the helper functions, in dependency order. */
export const HELPER_FUNCTIONS_DDL: readonly string[] = [
  `CREATE FUNCTION lc_fail(message text) RETURNS boolean
LANGUAGE plpgsql VOLATILE
AS $lc$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '${LC_FAIL_SQLSTATE}', MESSAGE = message;
END
$lc$`,
  `CREATE FUNCTION lc_fail(message text, sample anyelement) RETURNS anyelement
LANGUAGE plpgsql VOLATILE
AS $lc$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '${LC_FAIL_SQLSTATE}', MESSAGE = message;
END
$lc$`,
  `CREATE FUNCTION lc_nulls_set(nulls text[], path text, is_null boolean) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $lc$
  SELECT CASE
    WHEN is_null THEN
      CASE WHEN path = ANY (coalesce(nulls, '{}')) THEN nulls ELSE coalesce(nulls, '{}') || path END
    ELSE NULLIF(array_remove(nulls, path), '{}')
  END
$lc$`,
  `CREATE FUNCTION lc_nulls_clear(nulls text[], path text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $lc$
  SELECT NULLIF(ARRAY(
    SELECT u.entry FROM unnest(nulls) WITH ORDINALITY AS u (entry, position)
    WHERE NOT (u.entry = path OR starts_with(u.entry, path || '.'))
    ORDER BY u.position
  ), '{}')
$lc$`,
  `CREATE FUNCTION lc_sort_number(value double precision) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $lc$
  SELECT lpad(to_hex(CASE WHEN b.bits < 0 THEN ~b.bits ELSE b.bits # (-9223372036854775808)::bigint END), 16, '0')
  FROM (SELECT ('x' || encode(float8send(value + 0), 'hex'))::bit(64)::bigint AS bits) AS b
$lc$`,
  `CREATE FUNCTION lc_sort_key_value(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $lc$
  SELECT CASE jsonb_typeof(value)
    WHEN 'number' THEN '2' || lc_sort_number((value #>> '{}')::double precision)
    WHEN 'string' THEN '3' || (value #>> '{}')
    WHEN 'object' THEN CASE
      WHEN value ? '$date' AND jsonb_typeof(value -> '$date') = 'string'
        AND (SELECT count(*) FROM jsonb_object_keys(value)) = 1 THEN '9' || (value ->> '$date')
      WHEN value ? '$binary' AND jsonb_typeof(value -> '$binary') = 'string'
        AND (SELECT count(*) FROM jsonb_object_keys(value)) = 1 THEN '6' || (value ->> '$binary')
      ELSE '4' || value::text
    END
    WHEN 'array' THEN '5' || value::text
    WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN '81' ELSE '80' END
    ELSE '1'
  END
$lc$`,
  `CREATE FUNCTION lc_sort_key(value jsonb, ascending boolean) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $lc$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' OR value IS NULL THEN lc_sort_key_value(value)
    WHEN jsonb_array_length(value) = 0 THEN '0'
    WHEN coalesce(ascending, true) THEN
      (SELECT min(lc_sort_key_value(e.element) COLLATE "C") FROM jsonb_array_elements(value) AS e (element))
    ELSE
      (SELECT max(lc_sort_key_value(e.element) COLLATE "C") FROM jsonb_array_elements(value) AS e (element))
  END
$lc$`,
];
