import { createHash } from 'node:crypto';
import type { BrowserSetupSession } from '~/types/browserSetup';
import type { PostgresStoreContext } from './context';
import type { PostgresKysely } from '../types';
import {
  CodeEnvironmentReferenceError,
  withCodeEnvironmentReferencesSteps,
} from '~/methods/codeEnvironmentReferenceRules';
import {
  createPostgresCodeEnvironmentStore,
  createPostgresCodeEnvironmentReferenceSteps,
} from './codeEnvironment';
import { createPostgresMCPAuthorizationFenceRetryStore } from './mcpAuthorizationFenceRetry';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresStoreTransactions } from '../storeTransactions';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { createPostgresBrowserSetupStore } from './browserSetup';
import { createPostgresMCPServerStore } from './mcpServer';
import { createPgCollections } from '../collection';
import { getSchemaEngine } from '../schema/engine';
import { postgresStoreIds } from '../storeIds';

/**
 * Contention specs of the PostgreSQL MCP and code environment stores (docs/postgres-port/PHASE4.md
 * §3.5, R2): parallel calls on separate pool clients. The browser setup budgets and nonces stay
 * within their bounds and count every admission once; a session revision is won once; a removal
 * lease is claimed once and never while an agent reference is held (the claim's filter reads the
 * `pendingAgentReferences` child table, so it is rechecked in a new statement after the lock); an
 * owner's slots are each taken once; a revocation lease counts one attempt; competing reference
 * sweeps never rewind their progress; concurrent server creates get distinct names; racing fence
 * retry upserts converge on one row. Each case runs with the shadow check off (the production
 * single-statement path) and on (the lock-then-write path).
 */
const MINUTE = 60_000;
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');

function setupSession(attemptId: string, now: number): BrowserSetupSession {
  const requestCanonical = JSON.stringify({ attemptId });
  return {
    attemptId,
    requestCanonical,
    requestHash: hash(requestCanonical),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * MINUTE).toISOString(),
    verificationCode: 'ABCD-1234',
    workerId: `worker-${attemptId}`,
    status: 'pending',
    revision: 0,
  };
}

describePostgres('PostgreSQL MCP and code environment stores under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    let db: PostgresKysely;
    let context: PostgresStoreContext;

    beforeAll(() => {
      db = database.kysely({ max: 16 });
      const engine = getSchemaEngine();
      const collections = createPgCollections({
        db: () => db,
        descriptor: SCHEMA_DESCRIPTOR,
        engine,
        shadowCheck,
      });
      context = {
        collections: () => collections,
        db: () => db,
        transactions: createPostgresStoreTransactions(() => db),
        isTenantScoped: (collection) => engine.isTenantScoped(collection),
      };
    });
    beforeEach(() => database.truncateAll());

    const raw = (collection: string) => context.collections().raw(collection).find({});
    const newId = () => postgresStoreIds.generate();
    const environments = () => createPostgresCodeEnvironmentStore(context);
    const browserSetup = () =>
      createPostgresBrowserSetupStore(context, { codeEnvironments: environments() });
    const seedEnvironment = async (environmentId: string, record: Record<string, unknown> = {}) => {
      const _id = newId();
      await context
        .collections()
        .raw('codeenvironments')
        .insertOne({
          _id,
          environmentId,
          name: environmentId,
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
          createdBy: newId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...record,
        });
      return _id;
    };

    /* ------------------------------------------------------------------ browser setup */

    it('admits 24 racing starts within the global and per-peer allocation bounds', async () => {
      const now = Date.now();
      const limits = { global: 7, perIp: 2, windowMs: MINUTE };
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          browserSetup()
            .createStore()
            .start({
              session: setupSession(`attempt-${index}`, now),
              ipHash: hash(`peer-${index % 6}`),
              now,
              limits,
            }),
        ),
      );
      const created = results.filter((result) => result.status === 'created');
      expect(created).toHaveLength(limits.global);
      expect(results.every((r) => r.status === 'created' || r.status === 'limited')).toBe(true);
      const [budget] = await raw('browser_setup_budget');
      const allocations = budget.allocations as Array<{ ipHash: string; attemptId: string }>;
      expect(allocations).toHaveLength(limits.global);
      const perPeer = new Map<string, number>();
      for (const { ipHash } of allocations) perPeer.set(ipHash, (perPeer.get(ipHash) ?? 0) + 1);
      expect(Math.max(...perPeer.values())).toBeLessThanOrEqual(limits.perIp);
      expect((await raw('browser_setup_sessions')).map((row) => row._id).sort()).toEqual(
        allocations.map((entry) => entry.attemptId).sort(),
      );
    });

    it('claims exactly the nonce capacity among 20 racing claims, counting each once', async () => {
      const now = Date.now();
      const session = setupSession('nonces', now);
      const store = browserSetup().createStore();
      await store.start({
        session,
        ipHash: hash('peer'),
        now,
        limits: { global: 4, perIp: 4, windowMs: MINUTE },
      });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          browserSetup()
            .createStore()
            .claimNonce({
              attemptId: session.attemptId,
              requestHash: session.requestHash,
              nonce: `nonce-${index % 10}`,
              now,
              expiresAt: now + MINUTE,
              maxNonces: 5,
              maxOperations: 100,
            }),
        ),
      );
      expect(results.filter((result) => result === 'claimed')).toHaveLength(5);
      const [stored] = await raw('browser_setup_sessions');
      const nonces = (stored.nonces as Array<{ nonce: string }>).map((entry) => entry.nonce);
      expect(new Set(nonces).size).toBe(5);
      expect(stored.operations).toBe(5);
    });

    it('admits exactly the request budget among 40 racing requests', async () => {
      const now = Date.now();
      const limits = { global: 9, perIp: 3, windowMs: MINUTE };
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          browserSetup()
            .createStore()
            .consumeRequest({ ipHash: hash(`peer-${index % 5}`), now, limits }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(limits.global);
      const [budget] = await raw('browser_setup_requests');
      const peers = budget.peers as Record<string, number>;
      expect(budget.count).toBe(limits.global);
      expect(Object.values(peers).reduce((sum, count) => sum + count, 0)).toBe(limits.global);
      expect(Math.max(...Object.values(peers))).toBeLessThanOrEqual(limits.perIp);
    });

    it('lets one of 8 racing updates at one revision win', async () => {
      const now = Date.now();
      const session = setupSession('revision', now);
      await browserSetup()
        .createStore()
        .start({
          session,
          ipHash: hash('peer'),
          now,
          limits: { global: 4, perIp: 4, windowMs: MINUTE },
        });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          browserSetup()
            .createStore()
            .update({
              attemptId: session.attemptId,
              requestHash: session.requestHash,
              revision: 0,
              patch: { ownerId: `owner-${index}`, status: 'provisioning' },
            }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const [stored] = await raw('browser_setup_sessions');
      expect(stored.revision).toBe(1);
      expect(stored.ownerId).toBe(results.find(Boolean)?.ownerId);
    });

    /* ------------------------------------------------------------------ code environments */

    it('claims a removal lease once among 8 racing claims', async () => {
      const id = await seedEnvironment('env-race');
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => environments().beginCodeEnvironmentRemoval(id)),
      );
      const won = claims.filter((claim) => claim != null);
      expect(won).toHaveLength(1);
      const [stored] = await raw('codeenvironments');
      expect(stored.deletionLeaseId).toBe(won[0]?.deletionLeaseId);
    });

    it('never claims a removal while a racing agent write holds a reference', async () => {
      const steps = createPostgresCodeEnvironmentReferenceSteps(context);
      for (let round = 0; round < 12; round++) {
        await database.truncateAll();
        const id = await seedEnvironment(`env-${round}`);
        let releaseWrite: () => void = () => undefined;
        const writeHeld = new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        let held = false;
        const write = withCodeEnvironmentReferencesSteps(steps, [`env-${round}`], async () => {
          held = true;
          await writeHeld;
          return 'written';
        }).catch((error: unknown) => error);
        const removal = environments().beginCodeEnvironmentRemoval(id);
        const claimed = await removal;
        releaseWrite();
        const written = await write;
        if (claimed != null) {
          // The removal won: the write was refused before it ran.
          expect(held).toBe(false);
          expect(written).toBeInstanceOf(CodeEnvironmentReferenceError);
        } else {
          expect(written).toBe('written');
        }
        const [stored] = await raw('codeenvironments');
        expect((stored.pendingAgentReferences as unknown[] | undefined) ?? []).toEqual([]);
      }
    });

    it('gives each of an owner’s slots to one of 6 racing creates', async () => {
      const ownerId = newId();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          environments().createCodeEnvironmentWithinOwnerLimit(
            {
              environmentId: `env-slot-${index}`,
              name: `Machine ${index}`,
              type: 'attached',
              baseURL: 'https://code.example.com',
              controlPlaneId: 'shared-code-api',
              createdBy: ownerId as never,
            },
            3,
          ),
        ),
      );
      expect(results.filter((result) => result != null)).toHaveLength(3);
      const stored = await raw('codeenvironments');
      expect(stored.map((row) => row.ownerSlot).sort()).toEqual([0, 1, 2]);
    });

    it('counts one attempt for 8 racing revocation claims', async () => {
      const id = await seedEnvironment('env-revoke', {
        revocationPendingAt: new Date(Date.now() - MINUTE),
        revocationAttempts: 1,
      });
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          environments().claimCodeEnvironmentRevocation(id, `lease-${index}`, MINUTE),
        ),
      );
      expect(claims.filter((claim) => claim != null)).toHaveLength(1);
      const [stored] = await raw('codeenvironments');
      expect(stored.revocationAttempts).toBe(2);
    });

    it('never rewinds the reference sweep progress under competing sweeps', async () => {
      const expired = new Date(Date.now() - MINUTE);
      const live = new Date(Date.now() + MINUTE);
      for (let index = 0; index < 12; index++) {
        await seedEnvironment(`env-sweep-${index}`, {
          pendingAgentReferences: [
            { reservationId: 'expired', expiresAt: expired },
            { reservationId: 'live', expiresAt: live },
          ],
        });
      }
      for (let pass = 0; pass < 8; pass++) {
        await Promise.all(
          Array.from({ length: 3 }, () =>
            environments().sweepExpiredCodeEnvironmentReferences(new Date(), 2),
          ),
        );
      }
      const stored = await raw('codeenvironments');
      for (const row of stored) {
        expect(
          (row.pendingAgentReferences as Array<{ reservationId: string }>).map(
            (entry) => entry.reservationId,
          ),
        ).toEqual(['live']);
      }
    });

    /* ------------------------------------------------------------------ MCP */

    it('gives 5 racing creates of one title distinct names', async () => {
      const servers = createPostgresMCPServerStore(context, {
        getSoleOwnedResourceIds: async () => [],
      });
      /*
       * Each collision round lets at least one racer win, so `createMCPServerOnSteps` (five
       * attempts) promises distinct names to at most five racers; more can run out of retries.
       */
      const created = await Promise.all(
        Array.from({ length: 5 }, () =>
          servers.createMCPServer({
            config: { type: 'sse', url: 'https://example.com/mcp', title: 'Racing' },
            author: newId(),
          }),
        ),
      );
      expect(new Set(created.map((server) => server.serverName)).size).toBe(5);
      expect(await raw('mcpservers')).toHaveLength(5);
    });

    it('converges 10 racing upserts of one fence retry on one row, deferrals on the latest', async () => {
      const retries = createPostgresMCPAuthorizationFenceRetryStore(context);
      const scope = { userId: 'user-1', serverName: 'github' };
      const base = Date.parse('2026-06-01T00:00:00.000Z');
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          retries.upsert({
            scope,
            tenantId: 'tenant-a',
            version: 'v1',
            now: new Date(base + index),
          }),
        ),
      );
      expect(await raw('mcp_authorization_fence_retries')).toHaveLength(1);
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          retries.deferVersion({
            scope,
            tenantId: 'tenant-a',
            version: 'v1',
            updatedAt: new Date(base + 1000 + index * 10),
          }),
        ),
      );
      const [stored] = await raw('mcp_authorization_fence_retries');
      expect(stored.updatedAt).toEqual(new Date(base + 1090));
    });
  });
});
