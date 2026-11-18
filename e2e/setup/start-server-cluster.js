const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getE2EDatabaseBackend, getPostgresRuntimeEnv, startE2EPostgres } = require('./postgres');

const DEFAULT_BASE_URL = 'http://localhost:3080';
const DEFAULT_RUNTIME_ENV_PATH = path.resolve(__dirname, '../specs/.test-results/runtime-env.json');
const REPLICA_STARTUP_TIMEOUT_MS = 120_000;
const serverPath = path.resolve(__dirname, 'start-server.js');

let shuttingDown = false;
let mongoServer;
let postgres;
let proxyServer;
const children = [];

function getTopology() {
  const baseURL = new URL(process.env.E2E_BASE_URL || DEFAULT_BASE_URL);
  if (baseURL.protocol !== 'http:') {
    throw new Error(`[e2e] Replica proxy requires an http base URL, received ${baseURL.protocol}`);
  }
  const basePort = Number(baseURL.port || 80);
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65533) {
    throw new Error(`[e2e] Invalid replica base port: ${baseURL.port}`);
  }
  return {
    baseURL,
    replicaPorts: [basePort + 1, basePort + 2],
  };
}

function writeRuntimeEnv(runtimeEnv) {
  const runtimeEnvPath = process.env.E2E_RUNTIME_ENV_PATH || DEFAULT_RUNTIME_ENV_PATH;
  fs.mkdirSync(path.dirname(runtimeEnvPath), { recursive: true });
  fs.writeFileSync(runtimeEnvPath, JSON.stringify(runtimeEnv, null, 2));
}

/** `databaseEnv`: `MONGO_URI`, or on PostgreSQL the runtime env (`DATABASE_BACKEND`, `POSTGRES_URI`). */
function startReplica(port, index, databaseEnv) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      E2E_REPLICA_INDEX: String(index),
      E2E_USE_MEMORY_MONGO: 'false',
      HOST: process.env.E2E_HOST || '127.0.0.1',
      ...databaseEnv,
      PORT: String(port),
    },
    stdio: 'inherit',
  });
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `[e2e] LibreChat replica ${index} exited unexpectedly (${signal || `code ${code}`})`,
      );
      void shutdown(code || 1);
    }
  });
  return child;
}

async function waitForReplica(port) {
  const deadline = Date.now() + REPLICA_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const isReady = await new Promise((resolve) => {
      const request = http.get(`http://127.0.0.1:${port}/readyz`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.setTimeout(500, () => request.destroy());
      request.once('error', () => resolve(false));
    });
    if (isReady) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`[e2e] LibreChat replica on port ${port} did not become ready`);
}

function startProxy(baseURL, targetPort) {
  proxyServer = http.createServer((request, response) => {
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain' });
      }
      response.end(`Replica unavailable: ${error.message}`);
    });
    request.pipe(upstream);
  });
  proxyServer.listen(Number(baseURL.port || 80), baseURL.hostname, () => {
    console.log(
      `[e2e] Replica proxy listening at ${baseURL.origin}; primary target is ${targetPort}`,
    );
  });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (proxyServer) {
    proxyServer.close();
  }
  for (const child of children) {
    child.kill('SIGTERM');
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode != null || child.signalCode != null) {
            resolve();
            return;
          }
          child.once('exit', resolve);
        }),
    ),
  );
  if (mongoServer) {
    await mongoServer.stop();
  }
  if (postgres) {
    await postgres.stop();
  }
  process.exit(exitCode);
}

/** The shared database of both replicas: a memory MongoDB, or PostgreSQL (`./postgres.js`). */
async function startSharedDatabase() {
  if (getE2EDatabaseBackend() === 'postgres') {
    postgres = await startE2EPostgres();
    const runtimeEnv = getPostgresRuntimeEnv();
    writeRuntimeEnv(runtimeEnv);
    console.log(`[e2e] Using shared PostgreSQL database at ${postgres.uri}`);
    return runtimeEnv;
  }
  mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName: 'LibreChat-e2e',
      ip: '127.0.0.1',
    },
  });
  const mongoUri = new URL('LibreChat-e2e', mongoServer.getUri()).toString();
  writeRuntimeEnv({ MONGO_URI: mongoUri });
  console.log(`[e2e] Started shared memory MongoDB at ${mongoUri}`);
  return { MONGO_URI: mongoUri };
}

async function startCluster() {
  const { baseURL, replicaPorts } = getTopology();
  const databaseEnv = await startSharedDatabase();
  startReplica(replicaPorts[0], 1, databaseEnv);
  await waitForReplica(replicaPorts[0]);
  startReplica(replicaPorts[1], 2, databaseEnv);
  await waitForReplica(replicaPorts[1]);
  startProxy(baseURL, replicaPorts[0]);
}

process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));

startCluster().catch((error) => {
  console.error('[e2e] Failed to start LibreChat replicas:', error);
  void shutdown(1);
});
