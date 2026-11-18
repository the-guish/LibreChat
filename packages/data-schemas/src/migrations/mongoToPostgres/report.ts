/**
 * The report of a MongoDB → PostgreSQL copy (docs/postgres-port/PHASE4.md §8 X1): per collection
 * and per checkpoint storage, the counts, the values moved to `_extra` (by path), U+0000
 * replacements (D8), `Long` values beyond 2^53, records that could not be copied and verify
 * mismatches; and {@link formatMongoToPostgresReport}, the summary the script prints.
 */

/** How many examples a report line keeps. */
export const REPORT_SAMPLE_SIZE = 5;

/** A count with a few example record ids. */
export interface SampledCount {
  count: number;
  sampleIds: string[];
}

/** Values moved whole to `_extra` at one path of one table (D7). */
export interface DivertedPathReport extends SampledCount {
  /** The table whose `_extra` holds them (a child table's paths are relative to its element). */
  table: string;
  path: string;
  /** `undeclared`: a field the schema does not declare; `misfit`: a value its storage cannot hold. */
  reason: 'undeclared' | 'misfit';
}

/** Converted values at one path: `Long`s beyond 2^53, or BSON types no schema declares. */
export interface ConvertedPathReport extends SampledCount {
  path: string;
  /** `Long`: the exact value of the first example; other types: the BSON type. */
  detail: string;
}

/** A record that could not be copied, or that reads back different from its source. */
export interface RecordProblem {
  id: string;
  message: string;
}

/** What one source collection gave. */
export interface CollectionCopyReport {
  /** The MongoDB collection. */
  collection: string;
  /** `table`: a collection or raw table; `keyValue`: a Keyv collection; `gridfs`: a bucket. */
  kind: 'table' | 'keyValue' | 'gridfs';
  /** The PostgreSQL table written. */
  table: string;
  /** Source records read. */
  read: number;
  /** Rows inserted by this run. */
  inserted: number;
  /** Rows already there (an earlier, interrupted run): left as they are. */
  existing: number;
  /** Records read back and found equal to their source. */
  verified: number;
  /** Records that could not be copied (counted, a few kept). */
  failed: number;
  failures: RecordProblem[];
  /** Records that read back different from their source (counted, a few kept). */
  mismatched: number;
  mismatches: RecordProblem[];
  diverted: DivertedPathReport[];
  /** Records holding U+0000 in a string or key (replaced with U+FFFD). */
  nul: SampledCount;
  longs: ConvertedPathReport[];
  unsupported: ConvertedPathReport[];
  /** Key-value collections: further entries for a key already copied (the first one wins). */
  duplicateKeys?: number;
}

/** What one checkpoint storage gave. */
export interface CheckpointCopyReport {
  checkpointCollection: string;
  writesCollection: string;
  /** The PostgreSQL schema of the storage. */
  schema: string;
  /** `(thread_id, checkpoint_ns)` pairs. */
  threads: number;
  checkpoints: number;
  writes: number;
  /** Checkpoints read back and found equal to their source. */
  verified: number;
  failed: number;
  failures: RecordProblem[];
  mismatched: number;
  mismatches: RecordProblem[];
  /** Writes whose checkpoint does not exist (not copied: no saver read returns them). */
  orphanWrites: number;
}

/** The state of the PostgreSQL schema before the copy. */
export interface SchemaReport {
  /** The PostgreSQL schema (`POSTGRES_SCHEMA`). */
  schema: string;
  /** Migrations this run applied (none on a dry run). */
  applied: string[];
  /** Migrations a dry run would apply. */
  pending: string[];
}

/** The whole copy. */
export interface MongoToPostgresReport {
  dryRun: boolean;
  schema: SchemaReport;
  collections: CollectionCopyReport[];
  checkpoints: CheckpointCopyReport[];
  /** Source collections the tool does not know how to copy (left out). */
  skippedCollections: Array<{ collection: string; documents: number; reason: string }>;
  /** Source indexes of this version missing in MongoDB, when the check was overridden. */
  sourceWarnings: string[];
  /** Whether every record was copied and verified. */
  ok: boolean;
}

/** A new, empty collection report. */
export function emptyCollectionReport(
  collection: string,
  kind: CollectionCopyReport['kind'],
  table: string,
): CollectionCopyReport {
  return {
    collection,
    kind,
    table,
    read: 0,
    inserted: 0,
    existing: 0,
    verified: 0,
    failed: 0,
    failures: [],
    mismatched: 0,
    mismatches: [],
    diverted: [],
    nul: { count: 0, sampleIds: [] },
    longs: [],
    unsupported: [],
  };
}

/** Adds `id` to a sampled count. */
export function sample(target: SampledCount, id: string): void {
  target.count += 1;
  if (target.sampleIds.length < REPORT_SAMPLE_SIZE && !target.sampleIds.includes(id)) {
    target.sampleIds.push(id);
  }
}

/** Adds a problem to a counted list. */
export function addProblem(list: RecordProblem[], problem: RecordProblem): void {
  if (list.length < REPORT_SAMPLE_SIZE) {
    list.push(problem);
  }
}

/** The entry of `list` matching `match`, created by `create` when missing. */
export function entryOf<T>(list: T[], match: (entry: T) => boolean, create: () => T): T {
  let entry = list.find(match);
  if (!entry) {
    entry = create();
    list.push(entry);
  }
  return entry;
}

function ids(target: SampledCount): string {
  return target.sampleIds.length > 0 ? ` (e.g. ${target.sampleIds.join(', ')})` : '';
}

/** The summary the copy script prints: one block per collection with anything to say. */
export function formatMongoToPostgresReport(report: MongoToPostgresReport): string {
  const lines: string[] = [];
  const mode = report.dryRun ? 'Dry run (nothing written)' : 'Copy';
  lines.push(`${mode}: MongoDB → PostgreSQL schema "${report.schema.schema}"`);
  if (report.schema.applied.length > 0) {
    lines.push(`  Migrations applied: ${report.schema.applied.join(', ')}`);
  }
  if (report.schema.pending.length > 0) {
    lines.push(`  Migrations to apply: ${report.schema.pending.join(', ')}`);
  }
  for (const warning of report.sourceWarnings) {
    lines.push(`  Warning: ${warning}`);
  }
  lines.push('');
  const verb = report.dryRun ? 'checked' : 'verified';
  const empty = report.collections.filter((entry) => entry.read === 0);
  if (empty.length > 0) {
    lines.push(
      `Empty in MongoDB (nothing to copy): ${empty.map((entry) => entry.collection).join(', ')}`,
    );
  }
  for (const entry of report.collections) {
    if (entry.read === 0) continue;
    const counts = report.dryRun
      ? `${entry.read} read`
      : `${entry.read} read, ${entry.inserted} inserted, ${entry.existing} already there, ${entry.verified} ${verb}`;
    const target = entry.kind === 'table' ? entry.table : `${entry.table} (${entry.kind})`;
    lines.push(`${entry.collection} → ${target}: ${counts}`);
    for (const diverted of entry.diverted) {
      const where = diverted.table === entry.table ? '' : ` of ${diverted.table}`;
      lines.push(
        `  _extra: ${diverted.path}${where} (${diverted.reason}) in ${diverted.count} record(s)${ids(diverted)}`,
      );
    }
    if (entry.nul.count > 0) {
      lines.push(`  U+0000 replaced with U+FFFD in ${entry.nul.count} record(s)${ids(entry.nul)}`);
    }
    for (const long of entry.longs) {
      lines.push(
        `  Long beyond 2^53 at ${long.path} in ${long.count} record(s), stored as the nearest number (e.g. ${long.detail})${ids(long)}`,
      );
    }
    for (const unsupported of entry.unsupported) {
      lines.push(
        `  BSON ${unsupported.detail} at ${unsupported.path} in ${unsupported.count} record(s), converted${ids(unsupported)}`,
      );
    }
    if (entry.duplicateKeys) {
      lines.push(
        `  ${entry.duplicateKeys} duplicate key(s) or older revision(s) left out: the entry MongoDB reads was kept`,
      );
    }
    if (entry.failed > 0) {
      lines.push(`  FAILED: ${entry.failed} record(s) not copied`);
      for (const failure of entry.failures) lines.push(`    ${failure.id}: ${failure.message}`);
    }
    if (entry.mismatched > 0) {
      lines.push(`  VERIFY FAILED: ${entry.mismatched} record(s) differ`);
      for (const mismatch of entry.mismatches)
        lines.push(`    ${mismatch.id}: ${mismatch.message}`);
    }
  }
  for (const storage of report.checkpoints) {
    const counts = report.dryRun
      ? `${storage.checkpoints} checkpoint(s), ${storage.writes} write(s) in ${storage.threads} thread(s)`
      : `${storage.checkpoints} checkpoint(s), ${storage.writes} write(s) in ${storage.threads} thread(s), ${storage.verified} ${verb}`;
    lines.push(
      `checkpoints ${storage.checkpointCollection}/${storage.writesCollection} → ${storage.schema}: ${counts}`,
    );
    if (storage.orphanWrites > 0) {
      lines.push(`  ${storage.orphanWrites} write(s) without their checkpoint, left out`);
    }
    if (storage.failed > 0) {
      lines.push(`  FAILED: ${storage.failed} checkpoint(s) not copied`);
      for (const failure of storage.failures) lines.push(`    ${failure.id}: ${failure.message}`);
    }
    if (storage.mismatched > 0) {
      lines.push(`  VERIFY FAILED: ${storage.mismatched} checkpoint(s) differ`);
      for (const mismatch of storage.mismatches)
        lines.push(`    ${mismatch.id}: ${mismatch.message}`);
    }
  }
  for (const skipped of report.skippedCollections) {
    lines.push(
      `${skipped.collection}: left out (${skipped.reason}), ${skipped.documents} document(s)`,
    );
  }
  lines.push('');
  lines.push(
    report.ok
      ? `${report.dryRun ? 'Dry run finished' : 'Copy finished and verified'}: no problems found.`
      : `${report.dryRun ? 'Dry run finished' : 'Copy finished'} WITH PROBLEMS: see FAILED and VERIFY FAILED above.`,
  );
  return lines.join('\n');
}
