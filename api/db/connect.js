require('dotenv').config();
const { getDataStoreQueryObserver } = require('@librechat/api');
const { getDataStoreBackend } = require('@librechat/data-schemas');

/**
 * The process's database connection, from the data store backend (MongoDB today; the backend
 * reads its own settings, such as `MONGO_URI` and the `MONGO_*` pool options, from the
 * environment and throws when a required one is missing). Query metrics are installed first
 * when metrics are configured. The connection is cached in `global.mongoose` across hot reloads
 * in development, which keeps connections from growing during API route use.
 */
const dataStoreConnection = getDataStoreBackend().createConnection({
  env: process.env,
  observeQueries: getDataStoreQueryObserver(),
});

/** Connects (or reuses the process's connection) and resolves to the backend's handle. */
async function connectDb() {
  return dataStoreConnection.connect();
}

module.exports = {
  connectDb,
  dataStoreConnection,
};
