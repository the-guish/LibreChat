#!/usr/bin/env node
/**
 * Runs the PostgreSQL schema generator (src/adapters/postgres/schema/cli.ts) from the TypeScript
 * sources, without a build: `.ts` files are transpiled on load with the package's own
 * `typescript` (CommonJS, no type check) and `~/` resolves to `src/`, as in the Jest config.
 *
 *   node packages/data-schemas/scripts/postgres-schema.cjs --write [--name <slug>]   (npm run db:generate)
 *   node packages/data-schemas/scripts/postgres-schema.cjs --check
 *   node packages/data-schemas/scripts/postgres-schema.cjs [--out <dir>] [--previous <snapshot.json>]
 *
 * `--write` updates the checked-in descriptor, Kysely types, snapshot and migrations; `--check`
 * fails when they are out of date; `--out` only produces output (see cli.ts). The package is `"type": "module"`, which is why this
 * launcher is CommonJS and installs its own `.ts` loader rather than relying on Node's.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const srcDir = path.resolve(__dirname, '..', 'src');

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, ...rest) {
  const target = request.startsWith('~/') ? path.join(srcDir, request.slice(2)) : request;
  return resolveFilename.call(this, target, parent, ...rest);
};

Module._extensions['.ts'] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      sourceMap: false,
    },
  });
  module._compile(outputText, filename);
};

const { runSchemaGenerator } = require(path.join(srcDir, 'adapters/postgres/schema/cli.ts'));

try {
  process.exitCode = runSchemaGenerator(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
