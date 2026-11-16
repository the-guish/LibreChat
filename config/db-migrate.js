/**
 * `npm run db:migrate`: applies the PostgreSQL schema migrations to the database of `POSTGRES_URI`
 * (and `POSTGRES_SCHEMA`), then builds the missing large-table indexes `CONCURRENTLY`
 * (docs/postgres-port/PHASE4.md §5, D6). The server migrates on boot by default
 * (`POSTGRES_AUTO_MIGRATE=true`); this script is for deployments that migrate before rolling out
 * and boot with `POSTGRES_AUTO_MIGRATE=false`. It runs whatever `DATABASE_BACKEND` says, and needs
 * the built `@librechat/data-schemas` package (`npm run build:data-schemas`).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { runPostgresMigrations } = require('@librechat/data-schemas');

(async () => {
  try {
    const { applied, builtIndexes } = await runPostgresMigrations({ env: process.env });
    console.log(
      applied.length > 0
        ? `Applied PostgreSQL migrations: ${applied.join(', ')}`
        : 'The PostgreSQL schema is up to date: no migration to apply.',
    );
    if (builtIndexes.length > 0) {
      console.log(`Built indexes concurrently: ${builtIndexes.join(', ')}`);
    }
  } catch (error) {
    console.error('PostgreSQL migration failed:', error);
    process.exitCode = 1;
  }
})();
