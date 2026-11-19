const { getDataStoreBackend } = require('@librechat/data-schemas');
const {
  matchModelName,
  findMatchingPattern,
  isDeploymentSkillId,
  createMessageBudgetReader,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const messageBudget = createMessageBudgetReader();

/** The data methods and their stores, built once on the process's data store backend. */
const methods = getDataStoreBackend().createMethods({
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
  getMCPAppMessageBudget: messageBudget.getBudget,
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
};

/**
 * Every ported operation (`db.getConvo`, `db.getBanner`, ...) comes from its store in
 * `methods.stores` (one per port, see `DataStore`), so the backend behind all of them is the one
 * `getDataStoreBackend` chose, at once. Methods outside the ports, such as `saveConvo`, still
 * come straight from the MongoDB methods.
 */
const storeMethods = Object.assign({}, ...Object.values(methods.stores ?? {}));

module.exports = {
  ...methods,
  ...storeMethods,
  initializeMessageBudget: messageBudget.initialize,
  seedDatabase,
};
