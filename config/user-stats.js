const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const { findUsers, countConvosByUser, countMessagesByUser } = require('~/models');
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('-----------------------------');
  console.purple('Show the stats of all users');
  console.purple('-----------------------------');

  const countByUser = async (countRecords) => {
    const rows = await countRecords();
    return new Map(rows.map(({ user, count }) => [String(user), count]));
  };
  const [users, conversationCounts, messageCounts] = await Promise.all([
    findUsers({}),
    countByUser(countConvosByUser),
    countByUser(countMessagesByUser),
  ]);
  const userData = users.map((user) => ({
    User: user.name,
    Email: user.email,
    Conversations: conversationCounts.get(String(user._id)) ?? 0,
    Messages: messageCounts.get(String(user._id)) ?? 0,
  }));

  userData.sort((a, b) => {
    if (a.Conversations !== b.Conversations) {
      return b.Conversations - a.Conversations;
    }

    return b.Messages - a.Messages;
  });

  console.table(userData);

  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (!err.message.includes('fetch failed')) {
    process.exit(1);
  }
});
