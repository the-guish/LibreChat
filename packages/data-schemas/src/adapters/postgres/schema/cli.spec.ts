import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSchemaGenerator, summarizeSchema, emitDescriptorModule } from './cli';
import { generateSchemaDescriptor } from './generate';

describe('PostgreSQL schema generator CLI', () => {
  let out: string;

  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pg-schema-'));
  });

  afterEach(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('prints the summary and writes nothing without --out', () => {
    const lines: string[] = [];
    expect(runSchemaGenerator([], (line) => lines.push(line))).toBe(0);
    expect(lines).toContain('collections: 53');
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('writes the snapshot, descriptor module, Kysely types and DDL; an unchanged diff is empty', () => {
    const lines: string[] = [];
    runSchemaGenerator(['--out', out], (line) => lines.push(line));
    expect(fs.readdirSync(out).sort()).toEqual([
      'db.generated.ts',
      'descriptor.generated.ts',
      'schema.sql',
      'snapshot.json',
    ]);
    const descriptor = generateSchemaDescriptor();
    expect(JSON.parse(fs.readFileSync(path.join(out, 'snapshot.json'), 'utf8'))).toEqual(
      descriptor,
    );
    expect(fs.readFileSync(path.join(out, 'descriptor.generated.ts'), 'utf8')).toBe(
      emitDescriptorModule(descriptor),
    );
    runSchemaGenerator(
      ['--out', out, '--previous', path.join(out, 'snapshot.json')],
      () => undefined,
    );
    expect(fs.readFileSync(path.join(out, 'migration.sql'), 'utf8')).toBe('');
    const summary = summarizeSchema(descriptor);
    expect(summary).toMatchObject({ collections: 53, rawCollections: 10, elementTables: 5 });
    expect(summary.tables).toBe(descriptor.tables.length);
  });

  it('refuses unknown arguments', () => {
    expect(() => runSchemaGenerator(['--bogus'])).toThrow(/Unknown argument --bogus/);
    expect(() => runSchemaGenerator(['--out'])).toThrow(/--out needs a path/);
  });
});
