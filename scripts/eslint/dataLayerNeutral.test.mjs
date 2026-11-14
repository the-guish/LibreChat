import { describe, it } from 'node:test';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import dataLayer from './dataLayer.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const rule = dataLayer.rules['no-database-driver'];
const tester = new RuleTester({ languageOptions: { parser: tsParser } });

/** With `neutral`, the database-neutral code of the data layer gets its own message. */
tester.run('no-database-driver (neutral)', rule, {
  valid: [
    { code: "import type { IdLike } from '~/ports/common';", options: [{ neutral: true }] },
    { code: "import { SearchParams } from 'meilisearch';", options: [{ neutral: true }] },
  ],
  invalid: [
    {
      code: "import type { Types } from 'mongoose';",
      options: [{ neutral: true }],
      errors: [{ messageId: 'neutral', data: { specifier: 'mongoose' } }],
    },
    {
      code: "/** @param {import('mongodb').Db} db */\nexport const use = (db) => db;",
      options: [{ neutral: true }],
      errors: [{ messageId: 'neutral', data: { specifier: 'mongodb' } }],
    },
    {
      code: "export type X = import('bson').ObjectId;",
      options: [{ neutral: true }],
      errors: [{ messageId: 'neutral', data: { specifier: 'bson' } }],
    },
    {
      code: "import type { Types } from 'mongoose';",
      options: [{ neutral: false }],
      errors: [{ messageId: 'driver', data: { specifier: 'mongoose' } }],
    },
  ],
});
