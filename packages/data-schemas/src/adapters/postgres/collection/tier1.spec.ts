import { Schema } from 'mongoose';
import type { Tier1Plan } from './updates';
import {
  updateCaseFilter,
  EXTENDED_UPDATES,
  EXTENDED_CORPUS_COLLECTION,
  extendedCorpusSchemaDefinition,
} from '../evaluator/corpusC';
import { createSchemaEngineForSchemas } from '../schema/engine';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { indexArrayFilters } from '../evaluator/update';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { compileQuerySql, param } from '../query/sql';
import { createRecordCaster } from '../records/cast';
import { checkUpdate, planTier1 } from './updates';

/**
 * Which corpus C updates tier 1 compiles to SQL (docs/postgres-port/PHASE4.md §3.3, §8 C2): the
 * child-table `$push`/`$pull`/`$addToSet` and the positional `$`, `$[]` and `$[x]` writes of the
 * store code's shapes must not fall back to tier 2 (read-modify-write). The corpus specs check
 * what each tier writes; this one pins that the store shapes take tier 1.
 */

const subdocument = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });
const schema = new Schema(
  extendedCorpusSchemaDefinition({
    ObjectId: Schema.Types.ObjectId,
    Mixed: Schema.Types.Mixed,
    subdocument,
  }),
  { versionKey: false, autoIndex: false },
);
const tables = indexRecordTables(
  buildSchemaDescriptor(
    [introspectSchema(schema, { collection: EXTENDED_CORPUS_COLLECTION })],
    NO_SCHEMA_OVERRIDES,
  ),
);
const caster = createRecordCaster(tables, {
  engine: createSchemaEngineForSchemas([{ collection: EXTENDED_CORPUS_COLLECTION, schema }]),
});
const table = tables.collection(EXTENDED_CORPUS_COLLECTION);

function planOf(name: string): Tier1Plan | null {
  const entry = EXTENDED_UPDATES.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no case ${name}`);
  const update = caster.castUpdate(EXTENDED_CORPUS_COLLECTION, entry.update);
  checkUpdate(update);
  const arrayFilters = entry.arrayFilters
    ? caster.castArrayFilters(EXTENDED_CORPUS_COLLECTION, update, entry.arrayFilters)
    : [];
  return planTier1(tables, table, update, {
    filter: caster.castFilter(EXTENDED_CORPUS_COLLECTION, updateCaseFilter(entry)),
    arrayFilters: indexArrayFilters(update, arrayFilters),
  });
}

/** Store shapes compiled with child-table statements. */
const CHILD_STATEMENTS = [
  '$ from $elemMatch (backup code)',
  '$ set of fields, subdocuments and an unset (reconciliation persistence)',
  '$ replacing the whole element',
  '$ from a dotted path',
  '$ with $inc',
  '$ on a nested child path (nonce expiry)',
  '$ under a subdocument array (lastRun.mcp)',
  '$ in updateMany',
  '$[] on a child array',
  '$[x] (balance reservation renewal)',
  '$[x] with a range and $max',
  '$[x] with $or',
  '$push under $not $elemMatch (reconciliation admission)',
  '$push $each $slice negative (delivery history)',
  '$push to a missing child array',
  '$push under a subdocument',
  '$pull by a predicate (nonce expiry)',
  '$pull by equality with $inc (reservation release)',
  '$pull with $in (allocations)',
  '$pull by nested fields (reconciliation lifecycle)',
  '$addToSet $each with duplicates (schedule run receipts)',
  '$addToSet to a missing child array',
];

/** Store shapes compiled to the parent row's `SET` list alone. */
const PARENT_ONLY = [
  'scalar $ (conversation tag rename)',
  '$push $slice on a date array (schedule counters)',
  '$pull from a scalar array with $in',
  '$addToSet $each on a scalar array',
];

/** Shapes left to tier 2 on purpose (`json` subpaths, MongoDB's index from another array). */
const TIER_2 = [
  'json $[part] stamping a claim (message claims)',
  'json $[part] settle with $set and $unset (tool call result)',
  '$ taken from another array (MongoDB applies its index)',
  'numeric segment in a child array',
  'scalar $[x]',
];

describe('tier 1 on child tables and positions (C2)', () => {
  it.each(CHILD_STATEMENTS)('compiles with child statements: %s', (name) => {
    const plan = planOf(name);
    expect(plan).not.toBeNull();
    expect(plan!.children.length).toBeGreaterThan(0);
    for (const statement of plan!.children) {
      expect(() => compileQuerySql(statement(param(['x'], 'text[]')))).not.toThrow();
    }
  });

  it.each(PARENT_ONLY)('compiles to the parent row: %s', (name) => {
    const plan = planOf(name);
    expect(plan).not.toBeNull();
    expect(plan!.children).toHaveLength(0);
  });

  it.each(TIER_2)('leaves to tier 2: %s', (name) => {
    expect(planOf(name)).toBeNull();
  });
});
