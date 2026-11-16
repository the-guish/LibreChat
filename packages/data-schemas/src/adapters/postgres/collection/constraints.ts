/**
 * The duplicate-key map of a schema descriptor (docs/postgres-port/PHASE4.md §3.6): every unique
 * index and primary key constraint name → the record paths its key covers, in key order. The
 * PostgreSQL store errors (`../storeErrors.ts`) read it to name the fields of a violated key, and
 * the collection primitive to fill a `StoreDuplicateKeyError`'s `keyValue` from the written record.
 * Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - A unique index maps to the document paths of the MongoDB index it serves (`sources[0].fields`:
 *   identical SQL indexes are merged only when their keys are the same, so every source names the
 *   same paths). Tenant-scoped uniques include `tenantId`, as their MongoDB index does.
 * - A primary key maps to its key paths: `_id` for collection and raw tables (MongoDB reports a
 *   duplicate `_id` as `{ _id: ... }`), the key columns of a table keyed by its own columns
 *   (`key_value_entries`). Child and element tables have no unique key a write can break other
 *   than through a parent's, so they are left out.
 */
import type { SchemaDescriptor } from '../schema/descriptor';
import { primaryKeyName } from '../schema/descriptor';

/** Constraint name → the record paths its key covers (`UniqueConstraintFields` of `storeErrors.ts`). */
export type DescriptorUniqueConstraints = ReadonlyMap<string, ReadonlyArray<string>>;

const cache = new WeakMap<SchemaDescriptor, DescriptorUniqueConstraints>();

/** The unique index and primary key names of `descriptor` → the paths their keys cover. */
export function descriptorUniqueConstraints(
  descriptor: SchemaDescriptor,
): DescriptorUniqueConstraints {
  const cached = cache.get(descriptor);
  if (cached) {
    return cached;
  }
  const map = new Map<string, ReadonlyArray<string>>();
  for (const table of descriptor.tables) {
    if (table.kind !== 'collection' && table.kind !== 'raw') {
      continue;
    }
    map.set(primaryKeyName(table), [...table.primaryKey]);
    for (const index of table.indexes) {
      if (!index.unique || index.table !== table.name) {
        continue;
      }
      const source = index.sources[0];
      if (source) {
        map.set(
          index.name,
          source.fields.map(([path]) => path),
        );
      }
    }
  }
  cache.set(descriptor, map);
  return map;
}
