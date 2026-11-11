const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { findUsers, findBalanceCreditsByUsers } = require('~/models');
const { silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('-----------------------------');
  console.purple('Show the balance of all users');
  console.purple('-----------------------------');

  const users = await findUsers({});
  /** Earliest balance per user, matching the previous per-user `findOne().sort({ _id: 1 })` */
  const balances = await findBalanceCreditsByUsers(users.map((user) => user._id));
  const balanceByUser = new Map(balances.map((balance) => [balance.user, balance]));
  for (const user of users) {
    const balance = balanceByUser.get(String(user._id)) ?? null;
    if (balance !== null) {
      console.green(`User ${user.name} (${user.email}) has a balance of ${balance.tokenCredits}`);
    } else {
      console.yellow(`User ${user.name} (${user.email}) has no balance`);
    }
  }

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
