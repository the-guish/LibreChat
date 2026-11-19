import path from 'path';
import { PrincipalType } from 'librechat-data-provider';
import { applyRuntimeEnv } from './runtimeEnv';

type TUser = { email: string; password: string };

/**
 * Registers the backend's `~` alias in this process. Playwright's require hook only
 * maps it when `api/jsconfig.json` is the nearest path-config to the requiring file,
 * so a stray `api/tsconfig.json` would otherwise break every backend require here.
 */
function registerBackendAlias() {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  require('module-alias')({
    base: path.dirname(require.resolve('@librechat/backend/package.json')),
  });
}

/**
 * Removes an e2e user and what it left behind, through the `~/models` stores only, so the
 * teardown runs on whichever backend the server used (`DATABASE_BACKEND` and the connection
 * settings come from the runtime env file `start-server*.js` wrote).
 */
export default async function cleanupUser(user: TUser) {
  applyRuntimeEnv();
  registerBackendAlias();
  /* eslint-disable @typescript-eslint/no-require-imports */
  /** The stores reach the backend's data models, which the server registers at boot
   *  (`api/db/index.js`); registering them here too is a no-op on PostgreSQL. */
  require('@librechat/data-schemas').getDataStoreBackend().registerModels();
  const { connectDb, dataStoreConnection } = require('@librechat/backend/db/connect');
  const {
    findUser,
    deleteTokens,
    deleteConvos,
    deleteBalances,
    deleteMessages,
    deleteUserById,
    deleteTransactions,
    deleteAllUserSessions,
    removeUserFromAllGroups,
    deletePrincipalAclEntries,
  } = require('@librechat/backend/models');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const { email } = user;
  let connected = false;
  try {
    console.log('🤖: global teardown has been started');
    await connectDb();
    connected = true;
    console.log('🤖:  ✅  Connected to Database');

    const foundUser = await findUser({ email });
    if (!foundUser) {
      console.log('🤖:  ⚠️  User not found in Database');
      return;
    }

    const userId = foundUser._id;
    console.log('🤖:  ✅  Found user in Database');

    // Delete all conversations & associated messages
    const { deletedCount, messages } = await deleteConvos(userId, {}).catch((error) => {
      if (error instanceof Error && error.message.includes('Conversation not found')) {
        console.log('🤖:  ⚠️  No conversations found for user');
        return { deletedCount: 0, messages: { deletedCount: 0 } };
      }

      throw error;
    });

    if (messages.deletedCount > 0 || deletedCount > 0) {
      console.log(`🤖:  ✅  Deleted ${deletedCount} convos & ${messages.deletedCount} messages`);
    }

    // Ensure all user messages are deleted
    const { deletedCount: deletedMessages } = await deleteMessages({ user: userId });
    if (deletedMessages > 0) {
      console.log(`🤖:  ✅  Deleted ${deletedMessages} remaining message(s)`);
    }

    // Delete all user sessions
    await deleteAllUserSessions(userId.toString());

    // Delete user, balance, transactions, tokens, ACL entries, and remove from groups
    const userIdStr = userId.toString();
    await deleteBalances({ user: userId });
    await deleteTransactions({ user: userId });
    await deleteTokens({ userId });
    await deletePrincipalAclEntries({ principalType: PrincipalType.USER, principalId: userId });
    await removeUserFromAllGroups(userIdStr);
    await deleteUserById(userIdStr);

    console.log('🤖:  ✅  Deleted user from Database');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    try {
      if (connected) {
        await dataStoreConnection.close();
      }
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
}

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
