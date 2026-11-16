/**
 * The PostgreSQL Jest configs (`jest.postgres.config.*` in packages/data-schemas, packages/api and
 * api; `npm run test:postgres`; docs/postgres-port/PHASE4.md §7 and §8 H1): each package's own
 * config, run with `DATABASE_BACKEND=postgres` on the PostgreSQL test server, limited to
 *
 * - the **no-DB suites**, every one, found by the rule below (so the list never drifts), and
 * - the package's **explicit list of PostgreSQL-enabled DB suites** (`enabled`): the suites
 *   written for PostgreSQL, and each DB-backed suite once it runs on both backends
 *   (`createTestDataStore()` from `@librechat/data-schemas/testing`) and the stores it touches
 *   exist on PostgreSQL (H2a to H2d).
 *
 * **The rule.** A test file (Jest's default `testMatch`, minus the config's
 * `testPathIgnorePatterns`) is a DB suite when it, or a local module it loads statically
 * (relative paths and the config's `moduleNameMapper` aliases, followed transitively; packages
 * are not followed), does one of these; otherwise it is a no-DB suite:
 *
 * - `mongo`: loads `mongodb-memory-server` (or `-core`), or the test file itself opens a mongoose
 *   connection (`mongoose.connect(` / `mongoose.createConnection(`);
 * - `postgres`: uses the PostgreSQL test server (`describePostgres`, `usePostgresTestDatabase`,
 *   `openPostgresTestDatabase`, data-schemas' `src/test/postgres`, or `POSTGRES_TEST_URI`);
 * - `neutral`: calls `createTestDataStore(`.
 *
 * A file that matches several is `postgres` first, then `mongo`. Comments starting a line are
 * ignored, and so are type-only imports (`import type`, `export type ... from`). Dynamic
 * `import()` is followed only in the test file itself (a lazily loaded module is not loaded by
 * every suite that imports its loader).
 *
 * A no-DB suite that asserts the MongoDB default itself (that `getDataStoreBackend()` is the
 * MongoDB backend when `DATABASE_BACKEND` is unset) cannot pass with `DATABASE_BACKEND=postgres`;
 * such suites are listed in `mongoDefault`, each with its reason, and left out.
 *
 * The config refuses to load (so `test:postgres` fails) when a listed path is not a DB suite of
 * the package, when a `mongoDefault` path is not a no-DB suite, or when a `postgres` suite is
 * missing from the list (a PostgreSQL spec is never left out by accident). `node config/jest.postgres.cjs <package dir>...` prints the counts and,
 * with `--list`, every suite and its kind.
 */
const fs = require('node:fs');
const path = require('node:path');

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
/** Jest's default `testMatch`: under `__tests__`, or named `*.spec.*` / `*.test.*`. */
const TEST_FILE = /(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$|(?:^|\/|\.)(?:spec|test)\.[cm]?[jt]sx?$/;
const MEMORY_SERVER = /^mongodb-memory-server(?:-core)?(?:\/|$)/;
const MONGOOSE_CONNECTION = /\bmongoose\s*\.\s*(?:connect|createConnection)\s*\(/;
const POSTGRES_HARNESS =
  /\b(?:describePostgres|usePostgresTestDatabase|openPostgresTestDatabase|POSTGRES_TEST_URI)\b/;
const POSTGRES_HARNESS_DIR = `${path.sep}packages${path.sep}data-schemas${path.sep}src${path.sep}test${path.sep}postgres${path.sep}`;
const NEUTRAL = /(?<!function\s+)\bcreateTestDataStore\s*\(/;

/** The source without comments that start a line, and without type-only imports. */
function stripForScan(source) {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*['"][^'"]+['"]/g, '');
}

/** The static module specifiers of `source`, and its dynamic `import()` ones. */
function specifiersOf(source) {
  const statics = [];
  const dynamics = [];
  const collect = (pattern, into) => {
    for (const match of source.matchAll(pattern)) {
      into.push(match[1]);
    }
  };
  collect(/\bfrom\s*['"]([^'"]+)['"]/g, statics);
  collect(/\bimport\s*['"]([^'"]+)['"]/g, statics);
  collect(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, statics);
  collect(/\brequireActual\s*\(\s*['"]([^'"]+)['"]\s*\)/g, statics);
  collect(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, dynamics);
  return { statics, dynamics };
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `base` as a source file: itself, with an extension, or its `index`. */
function resolveSourceFile(base) {
  if (SOURCE_EXTENSIONS.includes(path.extname(base)) && isFile(base)) {
    return base;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(`${base}${extension}`)) {
      return `${base}${extension}`;
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const index = path.join(base, `index${extension}`);
    if (isFile(index)) {
      return index;
    }
  }
  return undefined;
}

/** Every file under `dir` whose path relative to `rootDir` passes `keep`. */
function walk(dir, keep, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), keep, files);
      }
    } else if (entry.isFile()) {
      const file = path.join(dir, entry.name);
      if (keep(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

/**
 * Classifies the test files of a package (see the rule above).
 *
 * @param {object} options
 * @param {string} options.rootDir - the package's Jest `rootDir`.
 * @param {string[]} [options.roots] - Jest `roots` (`<rootDir>` by default).
 * @param {string[]} [options.testPathIgnorePatterns] - patterns excluding test files.
 * @param {Record<string, string>} [options.moduleNameMapper] - the aliases to follow.
 * @returns {Array<{ file: string, path: string, kind: 'none' | 'mongo' | 'postgres' | 'neutral' }>}
 *   sorted by `path` (relative to `rootDir`, with `/`).
 */
function classifyTestSuites({
  rootDir,
  roots,
  testPathIgnorePatterns = [],
  moduleNameMapper = {},
}) {
  const ignore = testPathIgnorePatterns.map(
    (pattern) => new RegExp(pattern.replace(/<rootDir>/g, rootDir)),
  );
  const mappers = Object.entries(moduleNameMapper).map(([pattern, target]) => [
    new RegExp(pattern),
    target,
  ]);
  const resolveSpecifier = (specifier, from) => {
    if (specifier.startsWith('.')) {
      return resolveSourceFile(path.resolve(path.dirname(from), specifier));
    }
    for (const [pattern, target] of mappers) {
      const match = specifier.match(pattern);
      if (match) {
        const mapped = target
          .replace(/<rootDir>/g, rootDir)
          .replace(/\$(\d)/g, (_, index) => match[Number(index)] ?? '');
        return resolveSourceFile(path.resolve(rootDir, mapped));
      }
    }
    return undefined;
  };

  /** Per file: its own marks, and the local modules it loads statically / dynamically. */
  const scanned = new Map();
  const scan = (file) => {
    let result = scanned.get(file);
    if (result) {
      return result;
    }
    let source = '';
    try {
      source = stripForScan(fs.readFileSync(file, 'utf8'));
    } catch {
      /* unreadable: no marks */
    }
    const { statics, dynamics } = specifiersOf(source);
    const marks = new Set();
    if ([...statics, ...dynamics].some((specifier) => MEMORY_SERVER.test(specifier))) {
      marks.add('mongo');
    }
    if (POSTGRES_HARNESS.test(source) || file.includes(POSTGRES_HARNESS_DIR)) {
      marks.add('postgres');
    }
    if (NEUTRAL.test(source)) {
      marks.add('neutral');
    }
    const local = (specifiers) =>
      specifiers
        .map((specifier) => resolveSpecifier(specifier, file))
        .filter((resolved) => resolved && !resolved.includes(`${path.sep}node_modules${path.sep}`));
    result = {
      marks,
      connects: MONGOOSE_CONNECTION.test(source),
      statics: local(statics),
      dynamics: local(dynamics),
    };
    scanned.set(file, result);
    return result;
  };

  const testFiles = (roots ?? [rootDir])
    .map((root) => root.replace(/<rootDir>/g, rootDir))
    .flatMap((root) =>
      walk(path.resolve(rootDir, root), (file) => {
        const relative = path.relative(rootDir, file).split(path.sep).join('/');
        return TEST_FILE.test(relative) && !ignore.some((pattern) => pattern.test(file));
      }),
    );

  return [...new Set(testFiles)]
    .map((file) => {
      const own = scan(file);
      const marks = new Set(own.marks);
      if (own.connects) {
        marks.add('mongo');
      }
      const seen = new Set([file]);
      const pending = [...own.statics, ...own.dynamics];
      while (pending.length > 0) {
        const next = pending.pop();
        if (seen.has(next)) {
          continue;
        }
        seen.add(next);
        const reached = scan(next);
        reached.marks.forEach((mark) => marks.add(mark));
        pending.push(...reached.statics);
      }
      const kind = ['postgres', 'mongo', 'neutral'].find((mark) => marks.has(mark)) ?? 'none';
      return { file, path: path.relative(rootDir, file).split(path.sep).join('/'), kind };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The last classification each config made, by `rootDir` (for the command line below). */
const classifications = new Map();

/**
 * A package's PostgreSQL Jest config: `base` (its own config) running the no-DB suites and the
 * `enabled` DB suites only, with the PostgreSQL global setup and teardown.
 *
 * @param {object} base - the package's Jest config.
 * @param {object} options
 * @param {string} options.rootDir - the package directory (`base.rootDir` when it sets one).
 * @param {string[]} options.enabled - the PostgreSQL-enabled DB suites, relative to `rootDir`.
 * @param {string} options.globalSetup - the global setup (it starts the server or prepares the run).
 * @param {string} options.globalTeardown - the global teardown.
 * @param {string[]} [options.testPathIgnorePatterns] - extra patterns (the CI command's own).
 * @param {Record<string, string>} [options.mongoDefault] - no-DB suites asserting the MongoDB
 *   default, left out, each with its reason.
 */
function createPostgresJestConfig(base, options) {
  const rootDir = options.rootDir;
  const testPathIgnorePatterns = [
    ...(base.testPathIgnorePatterns ?? ['/node_modules/']),
    ...(options.testPathIgnorePatterns ?? []),
  ];
  const suites = classifyTestSuites({
    rootDir,
    roots: base.roots,
    testPathIgnorePatterns,
    moduleNameMapper: base.moduleNameMapper,
  });
  const enabled = new Set(options.enabled);
  const mongoDefault = new Set(Object.keys(options.mongoDefault ?? {}));
  classifications.set(rootDir, { suites, enabled, mongoDefault });
  const byPath = new Map(suites.map((suite) => [suite.path, suite]));
  const problems = [];
  for (const listed of enabled) {
    const suite = byPath.get(listed);
    if (!suite) {
      problems.push(`${listed} is listed but is not a test suite of this config`);
    } else if (suite.kind === 'none') {
      problems.push(`${listed} is listed but is a no-DB suite (those always run): unlist it`);
    }
  }
  for (const listed of mongoDefault) {
    if (byPath.get(listed)?.kind !== 'none') {
      problems.push(
        `${listed} is listed as asserting the MongoDB default but is not a no-DB suite`,
      );
    }
  }
  for (const suite of suites) {
    if (suite.kind === 'postgres' && !enabled.has(suite.path)) {
      problems.push(`${suite.path} uses the PostgreSQL test server but is not listed`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The PostgreSQL Jest config of ${rootDir} does not match its suites (config/jest.postgres.cjs):\n- ${problems.join('\n- ')}`,
    );
  }

  const excluded = suites.filter(
    (suite) => (suite.kind !== 'none' && !enabled.has(suite.path)) || mongoDefault.has(suite.path),
  );
  return {
    ...base,
    rootDir,
    globalSetup: options.globalSetup,
    globalTeardown: options.globalTeardown,
    testPathIgnorePatterns: [
      ...testPathIgnorePatterns,
      ...excluded.map((suite) => `^${escapeRegExp(suite.file)}$`),
    ],
  };
}

module.exports = { classifyTestSuites, createPostgresJestConfig, classifications };

if (require.main === module) {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const dirs = args.filter((arg) => !arg.startsWith('--'));
  (async () => {
    for (const dir of dirs.length > 0 ? dirs : ['packages/data-schemas', 'packages/api', 'api']) {
      const rootDir = path.resolve(dir);
      const config = ['jest.postgres.config.mjs', 'jest.postgres.config.js']
        .map((name) => path.join(rootDir, name))
        .find(isFile);
      if (!config) {
        console.error(`${dir}: no jest.postgres.config.* found`);
        process.exitCode = 1;
        continue;
      }
      await import(config);
      const { suites, enabled, mongoDefault } = classifications.get(rootDir);
      const runsOnPostgres = (suite) =>
        (suite.kind === 'none' && !mongoDefault.has(suite.path)) || enabled.has(suite.path);
      const counts = {};
      for (const suite of suites) {
        counts[suite.kind] = (counts[suite.kind] ?? 0) + 1;
      }
      const runs = suites.filter(runsOnPostgres);
      console.log(
        `${dir}: ${suites.length} suites (${Object.entries(counts)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(', ')}); test:postgres runs ${runs.length}: ${
          runs.length - enabled.size
        } no-DB suites (${mongoDefault.size} left out as asserting the MongoDB default) and ${enabled.size} listed DB suites`,
      );
      if (list) {
        for (const suite of suites) {
          const run = runsOnPostgres(suite) ? 'run ' : '    ';
          console.log(`  ${run}${suite.kind.padEnd(9)}${suite.path}`);
        }
      }
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
