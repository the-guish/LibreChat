const { getDataStoreBackend } = require('@librechat/data-schemas');
const { connectDb } = require('./connect');

// The models MUST be registered before requiring indexSync.
// indexSync.js reaches the Message and Conversation models through the backend's
// search index sync (getDataStoreBackend().getSearchIndexSync()), which is null until
// they are registered; without them every MeiliSearch sync fails on startup.
getDataStoreBackend().registerModels();

const indexSync = require('./indexSync');

module.exports = { connectDb, indexSync };
