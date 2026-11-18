/**
 * `node postgres-reaper.js <pid> <runDir>`: waits for process `<pid>` (an e2e test server that
 * started a PostgreSQL test database, `postgres.js`) to exit, however it exits, then stops the
 * run's temporary cluster or drops its databases and removes `<runDir>`
 * (`stopPostgresTestServer` of `@librechat/data-schemas/testing`). Runs detached, in its own
 * process group, so the SIGKILL Playwright sends the server's group does not reach it. Exits at
 * once when the server already cleaned up (the run directory is gone).
 */
const fs = require('fs');

const POLL_MS = 500;
const [pidArg, runDir] = process.argv.slice(2);
const pid = Number(pidArg);

function isAlive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function reap() {
  if (!fs.existsSync(runDir)) {
    return;
  }
  const { stopPostgresTestServer } = require('@librechat/data-schemas/testing');
  await stopPostgresTestServer(runDir);
}

if (!Number.isInteger(pid) || pid <= 0 || !runDir) {
  console.error('usage: node postgres-reaper.js <pid> <runDir>');
  process.exit(2);
}

const timer = setInterval(() => {
  if (!fs.existsSync(runDir)) {
    clearInterval(timer);
    return;
  }
  if (isAlive(pid)) {
    return;
  }
  clearInterval(timer);
  reap()
    .catch((error) => console.error('[e2e] PostgreSQL reaper failed:', error))
    .finally(() => process.exit(0));
}, POLL_MS);
