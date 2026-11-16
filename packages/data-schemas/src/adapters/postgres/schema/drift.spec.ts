/**
 * Drift spec 1 (docs/postgres-port/PHASE4.md §5): the checked-in generated files (descriptor,
 * Kysely types, snapshot, migration list) equal a fresh generation from the mongoose schemas. It
 * fails when a schema changed and `npm run db:generate` was not run (or its output was edited).
 */
import path from 'node:path';
import mongoose from 'mongoose';
import type { Schema } from 'mongoose';
import { planSchemaFiles, listMigrationModules, findOutOfDateSchemaFiles } from './files';
import { collectModelSources, collectRawSources, introspectSchema } from './generate';
import { SCHEMA_DESCRIPTOR } from './descriptor.generated';
import { generateSchemaDescriptor } from './generate';
import { buildSchemaDescriptor } from './descriptor';
import { POSTGRES_MIGRATIONS } from '../migrations';
import { defaultSchemaFilePaths } from './cli';
import { SCHEMA_OVERRIDES } from './overrides';
import { createModels } from '~/models';

const paths = defaultSchemaFilePaths();
const relative = (files: string[]) => files.map((file) => path.relative(paths.schemaDir, file));

describe('PostgreSQL schema drift: generated files vs the mongoose schemas', () => {
  const fresh = generateSchemaDescriptor();

  it('has every generated file up to date and no migration pending (else run `npm run db:generate`)', () => {
    const plan = planSchemaFiles(fresh, paths);
    expect(relative(findOutOfDateSchemaFiles(plan))).toEqual([]);
    expect(plan.migration).toBeUndefined();
  });

  it('ships the fresh descriptor and registers every migration module', () => {
    expect(SCHEMA_DESCRIPTOR).toEqual(fresh);
    expect(Object.keys(POSTGRES_MIGRATIONS)).toEqual(listMigrationModules(paths.migrationsDir));
    expect(Object.keys(POSTGRES_MIGRATIONS)[0]).toBe('0001_initial');
  });

  it('fails when a schema gains a field without a generated migration (spec-local probe)', () => {
    /** A copy of the presets schema with one more field; the module-level schema is untouched. */
    const presetModel = createModels(new mongoose.Mongoose()).Preset as unknown as {
      schema: Schema;
      modelName: string;
    };
    const probeSchema = presetModel.schema.clone();
    probeSchema.add({ driftProbe: String });
    const sources = collectModelSources().map((source) =>
      source.collection === 'presets'
        ? introspectSchema(probeSchema, { collection: 'presets', modelName: presetModel.modelName })
        : source,
    );
    const probe = buildSchemaDescriptor([...sources, ...collectRawSources()], SCHEMA_OVERRIDES);

    const plan = planSchemaFiles(probe, paths, {
      slug: 'drift probe',
      now: new Date(Date.UTC(2099, 0, 1)),
    });
    expect(relative(findOutOfDateSchemaFiles(plan))).toEqual([
      'descriptor.generated.ts',
      'db.generated.ts',
      'snapshot.json',
      '../migrations/209901010000_drift_probe.ts',
      '../migrations/index.ts',
    ]);
    expect(plan.migration).toBe('209901010000_drift_probe');
    const migration = plan.writes.find((write) => write.path.endsWith('_drift_probe.ts'))!;
    expect(migration.content).toContain(
      '`ALTER TABLE "presets" ADD COLUMN "driftProbe" text COLLATE "C"`',
    );
    expect(SCHEMA_DESCRIPTOR).not.toEqual(probe);

    /** The production schema did not change. */
    expect(presetModel.schema.path('driftProbe')).toBeUndefined();
    expect(generateSchemaDescriptor()).toEqual(fresh);
  });
});
