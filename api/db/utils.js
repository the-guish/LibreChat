/**
 * MongoDB only: `batchResetMeiliFlags(collection)` moved to the MongoDB adapter in
 * `@librechat/data-schemas` (the server resets the flags through the backend's search index sync,
 * `getDataStoreBackend().getSearchIndexSync().resetSyncFlags(...)`). Re-exported here for the
 * MongoDB-only `config/reset-meili-sync.js` script.
 */
const { batchResetMeiliFlags } = require('@librechat/data-schemas');

module.exports = {
  batchResetMeiliFlags,
};
