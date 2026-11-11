require('module-alias/register');
const { getDataStoreBackend, runAsSystem } = require('@librechat/data-schemas');
const { runSkillUploadRecoveryCommand } = require('@librechat/api');

const backend = getDataStoreBackend();
backend.registerModels();
const methods = backend.createMethods();

runSkillUploadRecoveryCommand(process.argv.slice(2), {
  connect: () => require('./db/connect').connectDb(),
  disconnect: () => require('./db/connect').dataStoreConnection.close(),
  runAsSystem,
  getIntent: methods.getSkillUploadIntent,
  listIntents: methods.listSkillUploadIntents,
  recoverStoppedIntent: methods.recoverStoppedSkillUploadIntent,
  recoverStoppedCleanupHold: methods.recoverStoppedSkillUploadCleanupHold,
  write: console.log,
  writeError: console.error,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Skill upload recovery failed');
    process.exitCode = 1;
  });
