const { runAsSystem, getDataStoreBackend } = require('@librechat/data-schemas');
const { checkStartupMigrations } = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized. The checks come from the data
 * store backend, which reads its own data to answer them.
 */
const checkMigrations = () =>
  checkStartupMigrations(getDataStoreBackend().createStartupChecks({ findRoleByIdentifier }));

module.exports = {
  checkMigrations: () => runAsSystem(checkMigrations),
};
