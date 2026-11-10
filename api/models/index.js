const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const {
  matchModelName,
  findMatchingPattern,
  isDeploymentSkillId,
  createMessageBudgetReader,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const messageBudget = createMessageBudgetReader();

const methods = createMethods(mongoose, {
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
 * Conversation operations come from the `ConversationStore` port, so the backend behind them is
 * chosen here. `saveConvo`, `deleteConvos`, `bulkSaveConvos` and `searchConversation` are not in
 * the port yet and still come straight from the MongoDB methods.
 */
const { conversations } = methods;

module.exports = {
  ...methods,
  ...conversations,
  initializeMessageBudget: messageBudget.initialize,
  seedDatabase,
};
