import { describe, it } from 'node:test';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import dataLayer from './dataLayer.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const rule = dataLayer.rules['no-database-driver'];
const tester = new RuleTester({ languageOptions: { parser: tsParser } });

/** Every syntactic form a source can name a module in. */
const forms = (specifier) => [
  `import x from '${specifier}';`,
  `import { Types } from '${specifier}';`,
  `import type { Types } from '${specifier}';`,
  `import '${specifier}';`,
  `export * from '${specifier}';`,
  `export { x } from '${specifier}';`,
  `export type { X } from '${specifier}';`,
  `export const load = () => import('${specifier}');`,
  `export const load = () => import(\`${specifier}\`);`,
  `const x = require('${specifier}');`,
  `const x = require(\`${specifier}\`);`,
  `import x = require('${specifier}');`,
  `export type X = typeof import('${specifier}');`,
  `export type X = import('${specifier}').Types.ObjectId;`,
  `/** @type {import('${specifier}').Types.ObjectId} */\nexport const id = null;`,
  `/**\n * @typedef {import("${specifier}").Schema} S\n */`,
];

const drivers = [
  'mongoose',
  'mongodb',
  'bson',
  'mongoose/lib/types',
  'mongodb/lib/bson',
  '@langchain/langgraph-checkpoint-mongodb',
];

describe('data-layer/no-database-driver', () => {
  tester.run('no-database-driver', rule, {
    valid: [
      ...forms('@librechat/data-schemas'),
      ...forms('~/models'),
      // Packages that only share a prefix with a driver, and instrumentation that hooks one.
      ...forms('mongoose-lean-virtuals'),
      ...forms('mongodb-memory-server'),
      ...forms('@opentelemetry/instrumentation-mongoose'),
      ...forms('@opentelemetry/instrumentation-mongodb'),
      ...forms('@langchain/langgraph-checkpoint'),
      // A specifier that cannot be read statically, and prose that only mentions a driver.
      'const name = "mongoose"; const x = require(name);',
      'export const load = (m) => import(`${m}`);',
      "// import('mongoose') is not a type in a line comment",
      '/** Uses mongoose through the data layer. */\nexport const x = 1;',
      // The `modules` option replaces the list.
      { code: "import x from 'mongoose';", options: [{ modules: ['bson'] }] },
    ],
    invalid: [
      ...drivers.flatMap((specifier) =>
        forms(specifier).map((code) => ({ code, errors: [{ messageId: 'driver' }] })),
      ),
      {
        code: "import x from 'mongodb-memory-server';",
        options: [{ modules: ['mongodb-memory-server'] }],
        errors: [{ messageId: 'driver' }],
      },
      {
        code: "/**\n * @param {import('mongoose').Types.ObjectId} a\n * @returns {Promise<import('bson').ObjectId>}\n */\nexport function f(a) { return a; }",
        errors: [{ messageId: 'driver' }, { messageId: 'driver' }],
      },
    ],
  });
});
