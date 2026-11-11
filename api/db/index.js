const { getDataStoreBackend } = require('@librechat/data-schemas');
const { connectDb } = require('./connect');

// The models MUST be registered before requiring indexSync.
// indexSync.js captures mongoose.models.Message and mongoose.models.Conversation
// at module load time. If those models are not registered first, all MeiliSearch
// sync operations will silently fail on every startup.
getDataStoreBackend().registerModels();

const indexSync = require('./indexSync');

module.exports = { connectDb, indexSync };
