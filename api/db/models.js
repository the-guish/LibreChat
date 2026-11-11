/**
 * MongoDB only: the MongoDB models on the default mongoose connection, for the legacy data
 * migrations in `config/` (`migrate-*-permissions`, `migrate-code-file-duplicates`,
 * `migrate-orphaned-agent-files`), which run against an existing MongoDB deployment, and for
 * tests. Not part of the database-neutral data layer: application code reaches the database
 * through `~/models`.
 */
const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const models = createModels(mongoose);

module.exports = { ...models };
