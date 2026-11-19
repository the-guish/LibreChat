/**
 * The generator's command line (docs/postgres-port/PHASE4.md §5), run by
 * `packages/data-schemas/scripts/postgres-schema.cjs` (`npm run db:generate` passes `--write`):
 *
 * ```sh
 * node packages/data-schemas/scripts/postgres-schema.cjs --write [--name <slug>]
 * node packages/data-schemas/scripts/postgres-schema.cjs --check
 * node packages/data-schemas/scripts/postgres-schema.cjs [--out <dir>] [--previous <snapshot.json>]
 * ```
 *
 * It prints a summary of the generated schema, then:
 *
 * - with `--write`, updates the checked-in files in place (`files.ts`): `schema/descriptor.generated.ts`,
 *   `schema/db.generated.ts`, `schema/snapshot.json`, and, when the schema changed since the
 *   snapshot, a new migration `migrations/<YYYYMMDDHHmm>_<slug>.ts` (`--name`, default `schema`;
 *   `0001_initial` for the first) with `migrations/index.ts`. A migration already checked in is
 *   never rewritten;
 * - with `--check`, writes nothing and fails (exit code 1) when `--write` would change a file;
 * - with `--out`, writes into that directory: `snapshot.json`, `descriptor.generated.ts`,
 *   `db.generated.ts`, `schema.sql` (the statements of a first migration: the domain, the helper
 *   functions, every table and index) and, with `--previous`, `migration.sql` (the DDL of the
 *   changes since that snapshot, statements built `CONCURRENTLY` marked as such).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SchemaDescriptor } from './descriptor';
import type { SchemaFilePaths } from './files';
import { planSchemaFiles, emitDescriptorModule, findOutOfDateSchemaFiles } from './files';
import { diffSchemaDescriptors, emitMigrationDdl } from './diff';
import { generateSchemaDescriptor } from './generate';
import { planMigration } from './migrationModule';
import { emitKyselyTypes } from './emitKysely';

export { emitDescriptorModule } from './files';

/** The counts the summary prints. */
export interface SchemaSummary {
  collections: number;
  rawCollections: number;
  childTables: number;
  elementTables: number;
  tables: number;
  columns: number;
  jsonColumns: number;
  indexes: number;
  uniqueIndexes: number;
  partialIndexes: number;
  ginIndexes: number;
  ttlRules: number;
  checks: number;
}

/** The counts of `descriptor`. */
export function summarizeSchema(descriptor: SchemaDescriptor): SchemaSummary {
  const tables = descriptor.tables;
  const count = (kind: string) => tables.filter((table) => table.kind === kind).length;
  const indexes = tables.flatMap((table) => table.indexes);
  return {
    collections: count('collection'),
    rawCollections: count('raw'),
    childTables: count('child'),
    elementTables: count('element'),
    tables: tables.length,
    columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
    jsonColumns: tables.reduce(
      (sum, table) => sum + table.columns.filter((column) => column.type === 'json').length,
      0,
    ),
    indexes: indexes.length,
    uniqueIndexes: indexes.filter((index) => index.unique).length,
    partialIndexes: indexes.filter((index) => index.where !== undefined).length,
    ginIndexes: indexes.filter((index) => index.method === 'gin').length,
    ttlRules: tables.reduce((sum, table) => sum + table.ttl.length, 0),
    checks: tables.reduce((sum, table) => sum + table.checks.length, 0),
  };
}

/** The parsed command line. */
interface GeneratorArguments {
  out?: string;
  previous?: string;
  write?: boolean;
  check?: boolean;
  name?: string;
}

const USAGE =
  'usage: --write [--name <slug>] | --check | [--out <dir>] [--previous <snapshot.json>]';

function parseArguments(argv: readonly string[]): GeneratorArguments {
  const options: GeneratorArguments = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--out' || argument === '--previous' || argument === '--name') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${argument} needs a ${argument === '--name' ? 'slug' : 'path'}`);
      }
      options[argument.slice(2) as 'out' | 'previous' | 'name'] = value;
    } else if (argument === '--write' || argument === '--check') {
      options[argument.slice(2) as 'write' | 'check'] = true;
    } else {
      throw new Error(`Unknown argument ${argument}; ${USAGE}`);
    }
  }
  if ((options.write || options.check) && (options.out || options.previous)) {
    throw new Error(`--write and --check update the checked-in files; ${USAGE}`);
  }
  if (options.write && options.check) {
    throw new Error(`--write and --check exclude each other; ${USAGE}`);
  }
  return options;
}

/** Where `--write` and `--check` find the checked-in files: this package's sources. */
export function defaultSchemaFilePaths(): SchemaFilePaths {
  return {
    schemaDir: path.resolve(__dirname),
    migrationsDir: path.resolve(__dirname, '..', 'migrations'),
  };
}

/** What {@link runSchemaGenerator} may be given instead of its defaults (specs). */
export interface SchemaGeneratorOptions {
  /** The checked-in files (`--write`, `--check`); this package's by default. */
  paths?: SchemaFilePaths;
  /** The descriptor; a fresh generation by default. */
  descriptor?: SchemaDescriptor;
  /** The time a new migration is stamped with; now by default. */
  now?: Date;
}

/** Runs the generator with `argv`; returns the process exit code. */
export function runSchemaGenerator(
  argv: readonly string[],
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  generatorOptions: SchemaGeneratorOptions = {},
): number {
  const options = parseArguments(argv);
  const descriptor = generatorOptions.descriptor ?? generateSchemaDescriptor();
  const summary = summarizeSchema(descriptor);
  for (const [key, value] of Object.entries(summary)) {
    log(`${key}: ${value}`);
  }
  if (options.write || options.check) {
    const paths = generatorOptions.paths ?? defaultSchemaFilePaths();
    const plan = planSchemaFiles(descriptor, paths, {
      slug: options.name,
      now: generatorOptions.now,
    });
    const outOfDate = new Set(findOutOfDateSchemaFiles(plan));
    if (options.check) {
      for (const file of outOfDate) {
        log(`out of date: ${file}`);
      }
      if (outOfDate.size > 0) {
        log('The PostgreSQL schema files are out of date: run `npm run db:generate`.');
        return 1;
      }
      log('The PostgreSQL schema files are up to date.');
      return 0;
    }
    for (const write of plan.writes) {
      if (outOfDate.has(write.path)) {
        fs.writeFileSync(write.path, write.content);
        log(`wrote ${write.path}`);
      }
    }
    if (plan.migration) {
      log(`new migration: ${plan.migration}`);
      if (plan.deferredIndexes.length > 0) {
        log(`indexes built CONCURRENTLY after it: ${plan.deferredIndexes.join(', ')}`);
      }
    } else {
      log('No schema change since the latest migration.');
    }
    return 0;
  }
  if (!options.out) {
    return 0;
  }
  const out = path.resolve(options.out);
  fs.mkdirSync(out, { recursive: true });
  const write = (name: string, content: string) => {
    fs.writeFileSync(path.join(out, name), content);
    log(`wrote ${path.join(out, name)}`);
  };
  const statements = (sql: string[]) => sql.map((statement) => `${statement};\n`).join('\n');
  write('snapshot.json', `${JSON.stringify(descriptor, null, 2)}\n`);
  write('descriptor.generated.ts', emitDescriptorModule(descriptor));
  write('db.generated.ts', emitKyselyTypes(descriptor));
  write('schema.sql', statements(planMigration(null, descriptor).statements));
  if (options.previous) {
    const previous = JSON.parse(fs.readFileSync(options.previous, 'utf8')) as SchemaDescriptor;
    const migration = emitMigrationDdl(diffSchemaDescriptors(previous, descriptor));
    write(
      'migration.sql',
      migration
        .map(
          ({ sql, concurrently }) => `${concurrently ? '-- outside a transaction\n' : ''}${sql};\n`,
        )
        .join('\n'),
    );
  }
  return 0;
}
