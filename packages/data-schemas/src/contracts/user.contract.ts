/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `UserStore` contract (`~/ports/user`), ported from `methods/user.methods.spec.ts` and
 * `methods/user.test.ts`: lookups (normalized emails, projections, paging, hidden fields),
 * creation (TTL, start balance, the `toObject` transform that strips search tokens), the
 * guarded updates (expected state, duplicate keys, SAML claims, the two-factor enrollment
 * compare-and-swap, backup codes, terms), word-prefix search, signed access tokens, the
 * account-deletion and subagent admission fences, plugins, personalization, and the auth user
 * document cache every credential-relevant write evicts (with a fake cache store). Cases that
 * make the cache, a model or the driver fail, or that check write order with spies, stay in the
 * method spec. Nothing here may import `mongoose` or the MongoDB driver.
 */
import {
  CacheKeys,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_EVICTED_PREFIX,
} from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { CacheStore, IUser } from '~/types';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

/** `USER_DELETION_FENCE_STALE_MS` of `methods/user.ts`, which the port's recovery relies on. */
const USER_DELETION_FENCE_STALE_MS = 15 * 60_000;
const WEEK = 604800 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The payload of a signed token, without verifying it. */
function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

export function describeUserContract(harness: ContractHarness): void {
  describe(`UserStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const originalEnv = {
      JWT_SECRET: process.env.JWT_SECRET,
      AUTH_USER_CACHE_MODE: process.env.AUTH_USER_CACHE_MODE,
    };
    const restoreEnv = () => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
    beforeAll(() => {
      process.env.JWT_SECRET = originalEnv.JWT_SECRET ?? 'contract-jwt-secret';
    });
    afterEach(() => {
      process.env.JWT_SECRET = originalEnv.JWT_SECRET ?? 'contract-jwt-secret';
      process.env.AUTH_USER_CACHE_MODE = originalEnv.AUTH_USER_CACHE_MODE;
      if (originalEnv.AUTH_USER_CACHE_MODE === undefined) {
        delete process.env.AUTH_USER_CACHE_MODE;
      }
    });
    afterAll(restoreEnv);

    const stores = () => harness.createStores().users;
    /** Creates a user through the store (so derived fields are written) and resolves its id. */
    const create = async (data: Partial<IUser> & Record<string, unknown>): Promise<string> =>
      idOf(harness, await stores().createUser({ provider: 'local', ...data } as never));
    const raw = async (userId: string) =>
      (await readRawWhere(harness, 'users', { _id: userId }))[0];
    /** Seeds a user raw (no defaults, no derived fields), resolving its id. */
    const seedUser = async (record: RawRecord): Promise<string> => {
      const _id = harness.ids.generate();
      await harness.seedRaw('users', [{ _id, provider: 'local', ...record }]);
      return _id;
    };

    /**
     * Runs `action` with the auth user document cache on, a cached document and the reverse
     * index of `userId` in a fake cache store, and resolves whether the action evicted them.
     */
    const evicts = async (
      userId: string,
      action: (users: ReturnType<typeof stores>) => Promise<unknown>,
    ): Promise<boolean> => {
      process.env.AUTH_USER_CACHE_MODE = 'on';
      const entries = new Map<string, unknown>();
      const cache: CacheStore = {
        get: async (key) => entries.get(key),
        set: async (key, value) => entries.set(key, value),
        delete: async (key) => entries.delete(key),
      };
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
      entries.set(indexKey, ['cached-auth-doc']);
      entries.set('cached-auth-doc', { _id: userId });
      const { users } = harness.createStores({
        getCache: (key) => (key === CacheKeys.AUTH_USER_DOC ? cache : undefined),
      });
      await action(users).catch(() => undefined);
      return (
        !entries.has('cached-auth-doc') &&
        !entries.has(indexKey) &&
        entries.has(`${AUTH_USER_DOC_EVICTED_PREFIX}:${userId}`)
      );
    };

    describe('createUser', () => {
      it('creates the user with its defaults and resolves its id', async () => {
        const id = await stores().createUser({
          name: 'Ada',
          email: 'Ada@Example.COM',
          username: 'ada',
        } as never);
        const stored = await raw(idOf(harness, id));
        expect(stored).toMatchObject({
          name: 'Ada',
          email: 'ada@example.com',
          username: 'ada',
          provider: 'local',
          role: 'USER',
          emailVerified: false,
          personalization: { statefulCodeEnvironment: 'user' },
        });
        expect(stored).not.toHaveProperty('expiresAt');
        expect(stored.createdAt).toBeInstanceOf(Date);
      });

      it('resolves the user as a plain object with returnUser, without search tokens', async () => {
        const user = (await stores().createUser(
          { name: 'Ada Lovelace', email: 'ada@example.com', username: 'ada' } as never,
          undefined,
          true,
          true,
        )) as Partial<IUser>;
        expect(user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
        expect(harness.ids.isValid(user._id)).toBe(true);
        expect(user).not.toHaveProperty('nameTokens');
        expect(user).not.toHaveProperty('emailTokens');
        expect(user).not.toHaveProperty('usernameTokens');
      });

      it('expires the account after a week unless disableTTL', async () => {
        const before = Date.now();
        const id = idOf(
          harness,
          await stores().createUser({ email: 'ttl@example.com' } as never, undefined, false),
        );
        const expiresAt = timeOf((await raw(id)).expiresAt);
        expect(expiresAt).toBeGreaterThanOrEqual(before + WEEK - 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + WEEK + 1000);
      });

      it('creates the start balance when the balance config enables one', async () => {
        const id = idOf(
          harness,
          await stores().createUser({ email: 'balance@example.com' } as never, {
            enabled: true,
            startBalance: 1000,
            autoRefillEnabled: true,
            refillIntervalValue: 30,
            refillIntervalUnit: 'days',
            refillAmount: 500,
          }),
        );
        const [balance] = await harness.readRaw('balances');
        expect(balance).toMatchObject({
          user: id,
          tokenCredits: 1000,
          autoRefillEnabled: true,
          refillIntervalValue: 30,
          refillIntervalUnit: 'days',
          refillAmount: 500,
          refillMode: 'add',
        });
        await stores().createUser({ email: 'nobalance@example.com' } as never, { enabled: false });
        expect(await harness.readRaw('balances')).toHaveLength(1);
      });

      it('rejects a duplicate email and an unsupported workspace default', async () => {
        await create({ email: 'taken@example.com' });
        const duplicate = await stores()
          .createUser({ email: 'TAKEN@example.com', provider: 'local' } as never)
          .catch((error: unknown) => error);
        expect(harness.errors.isDuplicateKey(duplicate)).toBe(true);
        await expect(
          stores().createUser({
            email: 'agent@example.com',
            personalization: { statefulCodeEnvironment: 'agent' },
          } as never),
        ).rejects.toThrow();
        expect(await harness.readRaw('users')).toHaveLength(1);
      });
    });

    describe('createUserIfAbsent', () => {
      const newUser = {
        name: 'First Login',
        email: 'first@example.com',
        provider: 'openid',
        openidId: 'first-sub',
        openidIssuer: 'https://issuer.example.com',
      };
      const balanceConfig = { enabled: true, startBalance: 500 };

      it('creates the user without expiry, credits the start balance, and resolves it', async () => {
        const result = await stores().createUserIfAbsent(
          { ...newUser, expiresAt: new Date() } as never,
          balanceConfig,
        );
        expect(result.ok).toBe(true);
        const created = result.ok ? result.value : undefined;
        expect(created).toMatchObject({ email: 'first@example.com', provider: 'openid' });
        expect(created).not.toHaveProperty('nameTokens');
        const id = idOf(harness, created?._id);
        expect(await raw(id)).not.toHaveProperty('expiresAt');
        expect(await harness.readRaw('balances')).toMatchObject([{ user: id, tokenCredits: 500 }]);
      });

      it('lets one of two concurrent inserts win, crediting the balance once', async () => {
        const results = await Promise.all([
          stores().createUserIfAbsent(newUser as never, balanceConfig),
          stores().createUserIfAbsent(newUser as never, balanceConfig),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.find((result) => !result.ok)).toEqual({
          ok: false,
          error: { code: 'user_exists' },
        });
        expect(await harness.readRaw('users')).toHaveLength(1);
        const created = results.find((result) => result.ok);
        expect(await harness.readRaw('balances')).toMatchObject([
          { user: idOf(harness, created?.ok ? created.value._id : undefined), tokenCredits: 500 },
        ]);
      });

      it('reports user_exists when another account holds the provider identity', async () => {
        await stores().createUserIfAbsent(newUser as never);
        expect(
          await stores().createUserIfAbsent({ ...newUser, email: 'renamed@example.com' } as never),
        ).toEqual({ ok: false, error: { code: 'user_exists' } });
      });

      it('throws a validation failure without writing a balance', async () => {
        await expect(
          stores().createUserIfAbsent(
            { ...newUser, email: 'not-an-email' } as never,
            balanceConfig,
          ),
        ).rejects.toMatchObject({ name: 'ValidationError' });
        expect(await harness.readRaw('balances')).toEqual([]);
        expect(await harness.readRaw('users')).toEqual([]);
      });
    });

    describe('findUser', () => {
      it('finds by email whatever its case and surrounding whitespace, also inside $or', async () => {
        const id = await create({ name: 'Test', email: 'test@example.com', username: 'test' });
        const users = stores();
        for (const email of ['test@example.com', 'TEST@Example.COM', '  test@example.com  ']) {
          expect(idOf(harness, (await users.findUser({ email }))?._id)).toBe(id);
        }
        expect(
          idOf(
            harness,
            (await users.findUser({ $or: [{ email: ' TEST@example.com' }, { username: 'x' }] }))
              ?._id,
          ),
        ).toBe(id);
        expect(await users.findUser({ email: 'other@example.com' })).toBeNull();
      });

      it('matches other criteria as given', async () => {
        const id = await create({ email: 'saml@example.com', provider: 'saml', samlId: 'Saml-ID' });
        expect(idOf(harness, (await stores().findUser({ samlId: 'Saml-ID' }))?._id)).toBe(id);
        expect(await stores().findUser({ samlId: 'saml-id' })).toBeNull();
      });

      it('returns the default fields, without hidden ones, unless a projection asks', async () => {
        const id = await create({
          name: 'Hidden',
          email: 'hidden@example.com',
          password: 'hashed-password',
          backupCodes: [{ codeHash: 'h', used: false }],
        });
        const user = await stores().findUser({ _id: id });
        expect(user).toMatchObject({ name: 'Hidden', email: 'hidden@example.com' });
        for (const hidden of [
          'password',
          'backupCodes',
          'totpSecret',
          'nameTokens',
          'emailTokens',
        ]) {
          expect(user).not.toHaveProperty(hidden);
        }
        const selected = await stores().findUser({ _id: id }, 'email +password');
        expect(selected).toMatchObject({
          email: 'hidden@example.com',
          password: 'hashed-password',
        });
        expect(selected).not.toHaveProperty('name');
        expect(await stores().findUser({ _id: id }, '-name')).not.toHaveProperty('name');
      });
    });

    describe('findUsers', () => {
      const seedFive = async () => {
        for (const name of ['Charlie', 'Alice', 'Eve', 'Bob', 'Diana']) {
          await create({ name, email: `${name.toLowerCase()}@example.com` });
        }
      };

      it('sorts, skips and limits; a limit of 0 does not restrict', async () => {
        await seedFive();
        const users = stores();
        const names = async (options: Parameters<typeof users.findUsers>[2]) =>
          (await users.findUsers({}, 'name', options)).map((user) => user.name);
        expect(await names({ sort: { name: 1 } })).toEqual([
          'Alice',
          'Bob',
          'Charlie',
          'Diana',
          'Eve',
        ]);
        expect(await names({ sort: { name: -1 } })).toEqual([
          'Eve',
          'Diana',
          'Charlie',
          'Bob',
          'Alice',
        ]);
        expect(await names({ sort: { name: 1 }, offset: 2 })).toEqual(['Charlie', 'Diana', 'Eve']);
        expect(await names({ sort: { name: 1 }, offset: 2, limit: 2 })).toEqual([
          'Charlie',
          'Diana',
        ]);
        expect(await names({ limit: 2 })).toHaveLength(2);
        expect(await names({ limit: 0 })).toHaveLength(5);
        expect(await users.findUsers({})).toHaveLength(5);
      });

      it('normalizes emails and selects fields', async () => {
        await seedFive();
        const found = await stores().findUsers(
          { $or: [{ email: ' ALICE@example.com' }, { email: 'Bob@Example.com ' }] },
          'email',
        );
        expect(found.map((user) => user.email).sort()).toEqual([
          'alice@example.com',
          'bob@example.com',
        ]);
        expect(found[0]).not.toHaveProperty('name');
      });
    });

    describe('findOwnerContactUsers', () => {
      it('returns only the id, name and username of the users that exist', async () => {
        const owner = await create({
          name: 'Ada Owner',
          username: 'ada',
          email: 'ada@example.com',
        });
        await create({ name: 'Other', username: 'other', email: 'other@example.com' });
        const rows = await stores().findOwnerContactUsers([owner, harness.ids.generate()]);
        expect(rows).toHaveLength(1);
        expect(idOf(harness, rows[0]._id)).toBe(owner);
        expect(rows[0]).toMatchObject({ name: 'Ada Owner', username: 'ada' });
        expect(Object.keys(rows[0]).sort()).toEqual(['_id', 'name', 'username']);
        expect(await stores().findOwnerContactUsers([])).toEqual([]);
      });
    });

    describe('countUsers', () => {
      it('counts every user, or those matching the filter', async () => {
        expect(await stores().countUsers()).toBe(0);
        await create({ email: 'a@example.com', role: 'ADMIN' });
        await create({ email: 'b@example.com' });
        await create({ email: 'c@example.com' });
        expect(await stores().countUsers()).toBe(3);
        expect(await stores().countUsers({ role: 'ADMIN' })).toBe(1);
        expect(await stores().countUsers({ role: 'NONE' })).toBe(0);
      });
    });

    describe('getUserById', () => {
      it('returns the user, with the selected fields, or null', async () => {
        const id = await create({
          name: 'By Id',
          email: 'byid@example.com',
          password: 'hashed-password',
        });
        const user = await stores().getUserById(id);
        expect(user).toMatchObject({ name: 'By Id', email: 'byid@example.com' });
        expect(user).not.toHaveProperty('password');
        expect(user).not.toHaveProperty('twoFactorAcknowledgementNonceHash');
        const selected = await stores().getUserById(id, 'name');
        expect(selected).toMatchObject({ name: 'By Id' });
        expect(selected).not.toHaveProperty('email');
        expect(await stores().getUserById(harness.ids.generate())).toBeNull();
      });
    });

    describe('updateUser', () => {
      it('sets the given fields, keeps the others, and removes the expiry', async () => {
        const id = idOf(
          harness,
          await stores().createUser(
            { name: 'Original', email: 'update@example.com', provider: 'local' } as never,
            undefined,
            false,
          ),
        );
        const updated = await stores().updateUser(id, { name: 'Updated' });
        expect(updated).toMatchObject({ name: 'Updated', email: 'update@example.com' });
        expect(updated?.expiresAt).toBeUndefined();
        expect(await raw(id)).not.toHaveProperty('expiresAt');
      });

      it('keeps the expiry with preserveExpiresAt', async () => {
        const id = idOf(
          harness,
          await stores().createUser({ email: 'pending@example.com' } as never, undefined, false),
        );
        const expiresAt = (await raw(id)).expiresAt;
        const updated = await stores().updateUser(
          id,
          { password: 'new-hash', credentialsChangedAt: new Date() } as Partial<IUser>,
          {},
          { preserveExpiresAt: true },
        );
        expect(timeOf(updated?.expiresAt)).toBe(timeOf(expiresAt));
        expect(updated?.credentialsChangedAt).toBeInstanceOf(Date);
        expect(await raw(id)).toMatchObject({ password: 'new-hash' });
      });

      it('updates only while the expected state still matches', async () => {
        const id = await create({ email: 'original@example.com', password: 'original-hash' });
        expect(
          await stores().updateUser(
            id,
            { email: 'stale@example.com' },
            { email: 'different@example.com', password: 'original-hash' },
          ),
        ).toBeNull();
        expect(
          (
            await stores().updateUser(
              id,
              { email: 'current@example.com' },
              { email: 'original@example.com', password: 'original-hash' },
            )
          )?.email,
        ).toBe('current@example.com');
      });

      it('accepts a whole user record, its id included', async () => {
        const id = await create({ name: 'Whole', email: 'whole@example.com' });
        const user = (await stores().getUserById(id)) as IUser;
        const updated = await stores().updateUser(id, { ...user, name: 'Whole Updated' });
        expect(updated).toMatchObject({ name: 'Whole Updated', email: 'whole@example.com' });
        expect(idOf(harness, updated?._id)).toBe(id);
      });

      it('rejects with a duplicate-key error when the email belongs to another user', async () => {
        await create({ email: 'first@example.com' });
        const second = await create({ email: 'second@example.com' });
        const failure = await stores()
          .updateUser(second, { email: 'first@example.com' })
          .catch((error: unknown) => error);
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
        expect((await raw(second)).email).toBe('second@example.com');
      });

      it('validates the update', async () => {
        const id = await create({ email: 'valid@example.com' });
        await expect(
          stores().updateUser(id, {
            personalization: { statefulCodeEnvironment: 'agent' },
          } as never),
        ).rejects.toThrow();
      });

      it('resolves null for a missing user, and evicts cached auth documents', async () => {
        expect(await stores().updateUser(harness.ids.generate(), { name: 'x' })).toBeNull();
        const id = await create({ email: 'cached@example.com' });
        expect(await evicts(id, (users) => users.updateUser(id, { name: 'Cached' }))).toBe(true);
      });
    });

    describe('awaitAuthUserDocEviction', () => {
      it('resolves at once with the cache off, and evicts the cached documents with it on', async () => {
        const id = await create({ email: 'barrier@example.com' });
        const started = Date.now();
        await stores().awaitAuthUserDocEviction(id);
        expect(await evicts(id, (users) => users.awaitAuthUserDocEviction(id))).toBe(true);
        expect(Date.now() - started).toBeLessThan(5000);
      });
    });

    describe('consumeBackupCode', () => {
      const recoveryUser = () =>
        create({
          email: 'recovery@example.com',
          backupCodes: [
            { codeHash: 'hash-a', used: false },
            { codeHash: 'hash-b', used: false },
          ],
        });

      it('lets exactly one of simultaneous redemptions of a code win, stamping its use', async () => {
        const id = await recoveryUser();
        const results = await Promise.all([
          stores().consumeBackupCode(id, 'hash-a'),
          stores().consumeBackupCode(id, 'hash-a'),
        ]);
        expect([...results].sort()).toEqual([false, true]);
        const codes = (await raw(id)).backupCodes as RawRecord[];
        expect(codes[0]).toMatchObject({ codeHash: 'hash-a', used: true });
        expect(codes[0].usedAt).toBeInstanceOf(Date);
        expect(codes[1]).toMatchObject({ codeHash: 'hash-b', used: false });
      });

      it('consumes different codes simultaneously, and refuses an unknown hash', async () => {
        const id = await recoveryUser();
        expect(
          await Promise.all([
            stores().consumeBackupCode(id, 'hash-a'),
            stores().consumeBackupCode(id, 'hash-b'),
          ]),
        ).toEqual([true, true]);
        expect(((await raw(id)).backupCodes as RawRecord[]).every((code) => code.used)).toBe(true);
        expect(await stores().consumeBackupCode(id, 'stale')).toBe(false);
        expect(await stores().consumeBackupCode(harness.ids.generate(), 'hash-a')).toBe(false);
      });

      it('evicts cached auth documents after a consumption', async () => {
        const id = await recoveryUser();
        expect(await evicts(id, (users) => users.consumeBackupCode(id, 'hash-a'))).toBe(true);
      });
    });

    describe('claimSamlIdentity', () => {
      it('binds an unbound SAML user, removing its expiry', async () => {
        const id = idOf(
          harness,
          await stores().createUser(
            { email: 'saml@example.com', provider: 'saml' } as never,
            undefined,
            false,
          ),
        );
        const claimed = await stores().claimSamlIdentity(id, 'saml-1', {
          username: 'samluser',
          name: 'SAML User',
        });
        expect(claimed).toMatchObject({
          samlId: 'saml-1',
          username: 'samluser',
          name: 'SAML User',
        });
        expect(await raw(id)).not.toHaveProperty('expiresAt');
      });

      it('keeps a different binding, updates a matching one, and refuses other providers', async () => {
        const bound = await create({
          email: 'bound@example.com',
          provider: 'saml',
          samlId: 'saml-1',
        });
        expect(await stores().claimSamlIdentity(bound, 'saml-2', { name: 'Intruder' })).toBeNull();
        expect((await raw(bound)).samlId).toBe('saml-1');
        expect(
          await stores().claimSamlIdentity(bound, 'saml-1', { name: 'Renamed' }),
        ).toMatchObject({ name: 'Renamed' });
        const local = await create({ email: 'local@example.com' });
        expect(await stores().claimSamlIdentity(local, 'saml-3', { name: 'x' })).toBeNull();
      });

      it('lets only one concurrent first-time binding win', async () => {
        const id = await create({ email: 'race@example.com', provider: 'saml' });
        const results = await Promise.all([
          stores().claimSamlIdentity(id, 'saml-a', { name: 'A' }),
          stores().claimSamlIdentity(id, 'saml-b', { name: 'B' }),
        ]);
        expect(results.filter((result) => result != null)).toHaveLength(1);
      });

      it('evicts cached auth documents after a successful claim only', async () => {
        const id = await create({ email: 'saml-cache@example.com', provider: 'saml', samlId: 's' });
        expect(await evicts(id, (users) => users.claimSamlIdentity(id, 's', { name: 'x' }))).toBe(
          true,
        );
        expect(
          await evicts(id, (users) => users.claimSamlIdentity(id, 'other', { name: 'x' })),
        ).toBe(false);
      });
    });

    describe('updateTwoFactorEnrollment', () => {
      const ACK_HASH = 'acknowledgement-nonce-hash';
      const FINAL_HASH = 'finalization-nonce-hash';
      const enrollingUser = async (overrides: Record<string, unknown> = {}) => {
        const id = await create({
          name: 'Enrolling User',
          email: `enrolling-${harness.ids.generate()}@example.com`,
          twoFactorEnabled: false,
          pendingTotpSecret: 'pending-secret',
          pendingBackupCodes: [{ codeHash: 'staged-hash', used: false }],
          ...overrides,
        });
        /** The snapshot a caller guards on, read as callers read it. */
        const snapshot = await stores().findUser({ _id: id }, '+pendingBackupCodes');
        return { id, pendingBackupCodes: snapshot?.pendingBackupCodes ?? [] };
      };
      const promotion = (pendingBackupCodes: NonNullable<IUser['pendingBackupCodes']>) => ({
        totpSecret: 'pending-secret',
        backupCodes: pendingBackupCodes,
        twoFactorEnabled: true,
        pendingTotpSecret: null,
        pendingBackupCodes: [],
        twoFactorAcknowledgementNonceHash: null,
        twoFactorFinalizationNonceHash: null,
      });

      it('stages rotated backup codes and a nonce without enabling 2FA', async () => {
        const { id, pendingBackupCodes } = await enrollingUser();
        const updated = await stores().updateTwoFactorEnrollment(
          id,
          { pendingTotpSecret: 'pending-secret', pendingBackupCodes },
          {
            pendingBackupCodes: [{ codeHash: 'deliverable-hash', used: false, usedAt: null }],
            twoFactorAcknowledgementNonceHash: ACK_HASH,
            twoFactorFinalizationNonceHash: null,
          },
        );
        expect(updated).toMatchObject({
          twoFactorAcknowledgementNonceHash: ACK_HASH,
          pendingBackupCodes: [{ codeHash: 'deliverable-hash' }],
        });
        const stored = await raw(id);
        expect(stored).toMatchObject({
          twoFactorEnabled: false,
          pendingTotpSecret: 'pending-secret',
          pendingBackupCodes: [{ codeHash: 'deliverable-hash' }],
          twoFactorAcknowledgementNonceHash: ACK_HASH,
          twoFactorFinalizationNonceHash: null,
        });
        expect(stored.totpSecret).toBeFalsy();
      });

      it('updates a legacy enrolling user without a two-factor flag', async () => {
        const id = await seedUser({
          email: 'legacy-2fa@example.com',
          pendingTotpSecret: 'pending-secret',
        });
        expect(
          await stores().updateTwoFactorEnrollment(
            id,
            { pendingTotpSecret: 'pending-secret' },
            { twoFactorAcknowledgementNonceHash: ACK_HASH },
          ),
        ).not.toBeNull();
        expect((await raw(id)).twoFactorAcknowledgementNonceHash).toBe(ACK_HASH);
      });

      it('lets a second step on a stale snapshot lose and write nothing', async () => {
        const { id, pendingBackupCodes } = await enrollingUser();
        const guard = { pendingTotpSecret: 'pending-secret', pendingBackupCodes };
        const first = await stores().updateTwoFactorEnrollment(id, guard, {
          pendingBackupCodes: [{ codeHash: 'first-hash', used: false, usedAt: null }],
          twoFactorAcknowledgementNonceHash: 'first-ack',
        });
        const second = await stores().updateTwoFactorEnrollment(id, guard, {
          pendingBackupCodes: [{ codeHash: 'second-hash', used: false, usedAt: null }],
          twoFactorAcknowledgementNonceHash: 'second-ack',
        });
        expect(first).not.toBeNull();
        expect(second).toBeNull();
        expect(await raw(id)).toMatchObject({
          pendingBackupCodes: [{ codeHash: 'first-hash' }],
          twoFactorAcknowledgementNonceHash: 'first-ack',
        });
      });

      it('consumes a nonce exactly once', async () => {
        const { id } = await enrollingUser({ twoFactorAcknowledgementNonceHash: ACK_HASH });
        const step = (finalization: string) =>
          stores().updateTwoFactorEnrollment(
            id,
            { twoFactorAcknowledgementNonceHash: ACK_HASH },
            {
              twoFactorAcknowledgementNonceHash: null,
              twoFactorFinalizationNonceHash: finalization,
            },
          );
        expect(await step(FINAL_HASH)).not.toBeNull();
        expect(await step('replayed')).toBeNull();
        expect(await raw(id)).toMatchObject({
          twoFactorEnabled: false,
          twoFactorFinalizationNonceHash: FINAL_HASH,
        });
      });

      it('promotes the pending enrollment once, clearing every enrollment field and the expiry', async () => {
        const { id, pendingBackupCodes } = await enrollingUser({
          twoFactorFinalizationNonceHash: FINAL_HASH,
          expiresAt: new Date(Date.now() + WEEK),
        });
        const guard = {
          pendingTotpSecret: 'pending-secret',
          pendingBackupCodes,
          twoFactorFinalizationNonceHash: FINAL_HASH,
        };
        const twoFactorEnrolledAt = new Date();
        const promoted = await stores().updateTwoFactorEnrollment(id, guard, {
          ...promotion(pendingBackupCodes),
          twoFactorEnrolledAt,
        });
        expect(promoted).toMatchObject({
          name: 'Enrolling User',
          provider: 'local',
          twoFactorEnabled: true,
        });
        expect(promoted?.createdAt).toBeInstanceOf(Date);
        expect(
          await stores().updateTwoFactorEnrollment(id, guard, promotion(pendingBackupCodes)),
        ).toBeNull();
        const stored = await raw(id);
        expect(stored).toMatchObject({
          twoFactorEnabled: true,
          totpSecret: 'pending-secret',
          pendingTotpSecret: null,
          pendingBackupCodes: [],
          backupCodes: [{ codeHash: 'staged-hash' }],
          twoFactorAcknowledgementNonceHash: null,
          twoFactorFinalizationNonceHash: null,
        });
        expect(timeOf(stored.twoFactorEnrolledAt)).toBe(twoFactorEnrolledAt.getTime());
        expect(stored).not.toHaveProperty('expiresAt');
      });

      it.each([
        ['a regenerated secret', { pendingTotpSecret: 'different-secret' }],
        ['regenerated backup codes', { pendingBackupCodes: [{ codeHash: 'other', used: false }] }],
        ['a federated provider', { provider: 'openid' }],
        ['2FA already enabled', { twoFactorEnabled: true }],
      ])('does not promote after %s', async (_label, state) => {
        const { id, pendingBackupCodes } = await enrollingUser({
          twoFactorFinalizationNonceHash: FINAL_HASH,
        });
        const current = await raw(id);
        await harness.reset();
        await harness.seedRaw('users', [{ ...current, ...state }]);
        expect(
          await stores().updateTwoFactorEnrollment(
            id,
            {
              pendingTotpSecret: 'pending-secret',
              pendingBackupCodes,
              twoFactorFinalizationNonceHash: FINAL_HASH,
            },
            promotion(pendingBackupCodes),
          ),
        ).toBeNull();
        expect((await raw(id)).totpSecret).toBeFalsy();
      });

      it('evicts cached auth documents after a successful step only', async () => {
        const { id } = await enrollingUser();
        expect(
          await evicts(id, (users) =>
            users.updateTwoFactorEnrollment(id, { pendingTotpSecret: 'wrong' }, {}),
          ),
        ).toBe(false);
        expect(
          await evicts(id, (users) =>
            users.updateTwoFactorEnrollment(
              id,
              { pendingTotpSecret: 'pending-secret' },
              { twoFactorAcknowledgementNonceHash: ACK_HASH },
            ),
          ),
        ).toBe(true);
      });
    });

    describe('acceptTerms', () => {
      it('accepts and stamps the first acceptance, keeping it on repeats', async () => {
        const id = await create({ email: 'terms@example.com' });
        const before = Date.now();
        const accepted = await stores().acceptTerms(id);
        expect(accepted?.termsAccepted).toBe(true);
        const stamped = timeOf(accepted?.termsAcceptedAt);
        expect(stamped).toBeGreaterThanOrEqual(before - 1000);
        await sleep(5);
        expect(timeOf((await stores().acceptTerms(id))?.termsAcceptedAt)).toBe(stamped);
      });

      it('preserves a stored acceptance time and its backfill marker', async () => {
        const acceptedAt = new Date('2023-01-01T00:00:00.000Z');
        const id = await create({
          email: 'backfilled@example.com',
          termsAccepted: true,
          termsAcceptedAt: acceptedAt,
          termsAcceptedSource: 'migration',
        });
        const repeat = await stores().acceptTerms(id);
        expect(timeOf(repeat?.termsAcceptedAt)).toBe(acceptedAt.getTime());
        expect(repeat?.termsAcceptedSource).toBe('migration');
      });

      it('stamps a legacy accepted user, or a document missing the fields entirely', async () => {
        const accepted = await create({ email: 'legacy@example.com', termsAccepted: true });
        expect((await stores().acceptTerms(accepted))?.termsAcceptedAt).toBeInstanceOf(Date);
        const bare = await seedUser({ email: 'pre-terms@example.com' });
        expect(await stores().acceptTerms(bare)).toMatchObject({ termsAccepted: true });
        expect((await raw(bare)).termsAcceptedAt).toBeInstanceOf(Date);
      });

      it('stamps a fresh acceptance after a terms reset, dropping the backfill marker', async () => {
        const id = await create({
          email: 'reset@example.com',
          termsAccepted: true,
          termsAcceptedAt: new Date('2023-01-01T00:00:00.000Z'),
          termsAcceptedSource: 'migration',
        });
        await stores().resetTermsAcceptance();
        const reaccepted = await stores().acceptTerms(id);
        expect(reaccepted?.termsAccepted).toBe(true);
        expect(timeOf(reaccepted?.termsAcceptedAt)).toBeGreaterThan(
          new Date('2023-01-01T00:00:00.000Z').getTime(),
        );
        expect(reaccepted?.termsAcceptedSource).toBeUndefined();
      });

      it('converges on one acceptance time under concurrent acceptance', async () => {
        const id = await create({ email: 'concurrent@example.com' });
        const results = await Promise.all(
          Array.from({ length: 5 }, () => stores().acceptTerms(id)),
        );
        expect(results.every((result) => result?.termsAccepted === true)).toBe(true);
        expect(new Set(results.map((result) => timeOf(result?.termsAcceptedAt))).size).toBe(1);
      });

      it('resolves null for a missing user, and evicts cached auth documents', async () => {
        expect(await stores().acceptTerms(harness.ids.generate())).toBeNull();
        const id = await create({ email: 'cached-terms@example.com' });
        expect(await evicts(id, (users) => users.acceptTerms(id))).toBe(true);
      });
    });

    describe('resetTermsAcceptance', () => {
      it('withdraws every acceptance and clears the source, evicting cached documents', async () => {
        const accepted = await create({
          email: 'accepted@example.com',
          termsAccepted: true,
          termsAcceptedAt: new Date(),
          termsAcceptedSource: 'migration',
        });
        await create({ email: 'never@example.com' });
        let result: { modifiedCount: number } | undefined;
        expect(
          await evicts(accepted, async (users) => {
            result = await users.resetTermsAcceptance();
          }),
        ).toBe(true);
        expect(result?.modifiedCount).toBeGreaterThanOrEqual(1);
        const stored = await raw(accepted);
        expect(stored).toMatchObject({ termsAccepted: false, termsAcceptedAt: null });
        expect(stored).not.toHaveProperty('termsAcceptedSource');
      });
    });

    describe('searchUsers', () => {
      const seedSearch = async () => {
        for (const user of [
          { name: 'John Doe', email: 'john@example.com', username: 'johnd' },
          { name: 'Jane Smith', email: 'jane@example.com', username: 'janes' },
          { name: 'Bob Johnson', email: 'bob@example.com', username: 'bobbyj' },
          { name: 'Alice Wonder', email: 'alice@test.com', username: 'alice', provider: 'openid' },
        ]) {
          await create(user);
        }
      };
      const names = (users: Array<{ name?: string }>) => users.map((user) => user.name);

      it('matches word prefixes of name, email and username, case-insensitively', async () => {
        await seedSearch();
        const users = stores();
        expect(names(await users.searchUsers({ searchPattern: 'John' })).sort()).toEqual([
          'Bob Johnson',
          'John Doe',
        ]);
        expect(await users.searchUsers({ searchPattern: 'JOHN' })).toHaveLength(2);
        expect(await users.searchUsers({ searchPattern: 'example.com' })).toHaveLength(3);
        const byUsername = await users.searchUsers({ searchPattern: 'alice' });
        expect(byUsername).toHaveLength(1);
        expect(byUsername[0]).toMatchObject({ username: 'alice' });
        expect(byUsername[0]).not.toHaveProperty('usernameTokens');
      });

      it('respects the limit and returns nothing for a blank pattern', async () => {
        await seedSearch();
        expect(await stores().searchUsers({ searchPattern: 'example', limit: 2 })).toHaveLength(2);
        expect(await stores().searchUsers({ searchPattern: '' })).toEqual([]);
        expect(await stores().searchUsers({ searchPattern: '   ' })).toEqual([]);
      });

      it('treats regex syntax as literal text', async () => {
        await create({
          name: 'Literal .* User',
          email: 'literal-star@test.com',
          username: 'literal-star',
        });
        await create({ name: 'Regex [invalid User', email: 'regex@test.com', username: 'regex' });
        expect(await stores().searchUsers({ searchPattern: '.*' })).toEqual([]);
        expect(names(await stores().searchUsers({ searchPattern: 'literal' }))).toEqual([
          'Literal .* User',
        ]);
        expect(names(await stores().searchUsers({ searchPattern: '[invalid' }))).toEqual([
          'Regex [invalid User',
        ]);
      });

      it('selects fields', async () => {
        await seedSearch();
        const [first] = await stores().searchUsers({
          searchPattern: 'john',
          fieldsToSelect: 'name email',
        });
        expect(first).toHaveProperty('name');
        expect(first).toHaveProperty('email');
        expect(first).not.toHaveProperty('username');
      });

      it('ranks the best match first: exact, accent-folded, reordered full names', async () => {
        await seedSearch();
        await create({ name: 'Zoe Adams', email: 'zadams@test.com', username: 'zadams' });
        await create({ name: 'Zoë', email: 'zoe-umlaut@test.com', username: 'zumlaut' });
        await create({ name: 'Smith Johnson', email: 'sjohnson@test.com', username: 'sjohnson' });
        await create({ name: 'John Smith', email: 'jsmith@test.com', username: 'jsmith' });
        const users = stores();
        expect(names(await users.searchUsers({ searchPattern: 'zoe', limit: 1 }))).toEqual(['Zoë']);
        expect(names(await users.searchUsers({ searchPattern: 'smith john', limit: 1 }))).toEqual([
          'John Smith',
        ]);
        expect((await users.searchUsers({ searchPattern: 'alice' }))[0]).toMatchObject({
          username: 'alice',
        });
      });
    });

    describe('generateToken', () => {
      it('signs the user claims, expiring after 15 minutes by default', async () => {
        const id = await create({ email: 'token@example.com', username: 'token' });
        const user = (await stores().getUserById(id)) as IUser;
        const before = Math.floor(Date.now() / 1000);
        const payload = payloadOf(await stores().generateToken(user));
        expect(payload).toMatchObject({
          id,
          username: 'token',
          provider: 'local',
          email: 'token@example.com',
        });
        expect(typeof payload.issuedAtMs).toBe('number');
        expect((payload.exp as number) - (payload.iat as number)).toBe(15 * 60);
        expect(payload.iat as number).toBeGreaterThanOrEqual(before);
      });

      it('expires after the given milliseconds, and throws without a user', async () => {
        const id = await create({ email: 'token2@example.com' });
        const user = (await stores().getUserById(id)) as IUser;
        const payload = payloadOf(await stores().generateToken(user, 60_000));
        expect((payload.exp as number) - (payload.iat as number)).toBe(60);
        await expect(stores().generateToken(undefined as unknown as IUser)).rejects.toThrow(
          'No user provided',
        );
      });
    });

    describe('account-deletion fence', () => {
      it('blocks trigger admission until the owning deletion releases it', async () => {
        const id = await create({ email: 'fence@example.com' });
        const startedAt = new Date('2026-08-17T12:00:00.000Z');
        const users = stores();
        expect(await users.isAgentTriggerPrincipalActive(id)).toBe(true);
        expect(await users.beginAgentTriggerUserDeletion(id, startedAt)).toBe('acquired');
        expect(await users.isAgentTriggerPrincipalActive(id)).toBe(false);
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(false);
        const later = new Date(startedAt.getTime() + 1);
        expect(await users.beginAgentTriggerUserDeletion(id, later)).toBe('in_progress');
        expect(await users.cancelAgentTriggerUserDeletion(id, later)).toBe(false);
        expect(await users.cancelAgentTriggerUserDeletion(id, startedAt)).toBe(true);
        expect(await users.isAgentTriggerPrincipalActive(id)).toBe(true);
      });

      it('reports a missing principal without creating a fence', async () => {
        const id = harness.ids.generate();
        expect(await stores().beginAgentTriggerUserDeletion(id, new Date())).toBe('missing');
        expect(await stores().recoverStaleAgentTriggerUserDeletion(id, new Date())).toBe('missing');
        expect(await stores().isAgentTriggerPrincipalActive(id)).toBe(false);
        expect(await harness.readRaw('users')).toEqual([]);
      });

      it('takes over a fence only once it is stale, preserving the successor', async () => {
        const id = await create({ email: 'stale-fence@example.com' });
        const abandonedAt = new Date('2026-08-17T12:00:00.000Z');
        const takeoverAt = new Date(abandonedAt.getTime() + USER_DELETION_FENCE_STALE_MS + 1);
        const users = stores();
        expect(await users.beginAgentTriggerUserDeletion(id, abandonedAt)).toBe('acquired');
        expect(await users.beginAgentTriggerUserDeletion(id, takeoverAt)).toBe('in_progress');
        expect(
          await users.recoverStaleAgentTriggerUserDeletion(
            id,
            new Date(abandonedAt.getTime() + USER_DELETION_FENCE_STALE_MS - 1),
          ),
        ).toBe('in_progress');
        expect(await users.recoverStaleAgentTriggerUserDeletion(id, takeoverAt)).toBe('acquired');
        expect(await users.cancelAgentTriggerUserDeletion(id, abandonedAt)).toBe(false);
        expect(await users.isAgentTriggerPrincipalActive(id)).toBe(false);
        expect(await users.cancelAgentTriggerUserDeletion(id, takeoverAt)).toBe(true);
        expect(await users.isAgentTriggerPrincipalActive(id)).toBe(true);
      });

      it('rejects invalid timestamps', async () => {
        const id = harness.ids.generate();
        await expect(
          stores().beginAgentTriggerUserDeletion(id, new Date(Number.NaN)),
        ).rejects.toThrow('startedAt must be a valid Date');
        await expect(
          stores().recoverStaleAgentTriggerUserDeletion(id, new Date(Number.NaN)),
        ).rejects.toThrow('recoveredAt must be a valid Date');
      });

      it('evicts cached auth documents when a fence is taken or lifted', async () => {
        const id = await create({ email: 'fence-cache@example.com' });
        const startedAt = new Date();
        expect(
          await evicts(id, (users) => users.beginAgentTriggerUserDeletion(id, startedAt)),
        ).toBe(true);
        expect(
          await evicts(id, (users) => users.cancelAgentTriggerUserDeletion(id, startedAt)),
        ).toBe(true);
      });
    });

    describe('subagent admission fences', () => {
      const until = () => new Date(Date.now() + 60_000);
      const fencesOf = async (id: string) =>
        ((await raw(id)).subagentAdmissionFences as RawRecord[] | undefined) ?? [];

      it('keeps admission closed until every overlapping fence is released, in any order', async () => {
        const id = await create({ email: 'subagent@example.com' });
        const users = stores();
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(true);
        await users.fenceSubagentAdmission(id, 'deletion-a', until());
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(false);
        await users.fenceSubagentAdmission(id, 'deletion-b', until());
        await users.releaseSubagentAdmission(id, 'deletion-b');
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(false);
        await users.releaseSubagentAdmission(id, 'deletion-a');
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(true);
        await users.releaseSubagentAdmission(id, 'deletion-a');
        expect(await users.isSubagentOwnerAdmissible(harness.ids.generate())).toBe(false);
      });

      it('reopens once a fence expires, and prunes expired fences on the next one', async () => {
        const id = await create({ email: 'expired@example.com' });
        const users = stores();
        await users.fenceSubagentAdmission(id, 'abandoned', new Date(Date.now() - 1));
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(true);
        await users.fenceSubagentAdmission(id, 'deletion-a', until());
        expect((await fencesOf(id)).map((fence) => fence.token)).toEqual(['deletion-a']);
      });

      it('renews only an existing fence', async () => {
        const id = await create({ email: 'renew@example.com' });
        const users = stores();
        await users.fenceSubagentAdmission(id, 'deletion-a', new Date(Date.now() + 1000));
        const extended = new Date(Date.now() + 120_000);
        expect(await users.renewSubagentAdmission(id, 'deletion-a', extended)).toBe(true);
        expect(timeOf((await fencesOf(id))[0].expiresAt)).toBe(extended.getTime());
        expect(await users.renewSubagentAdmission(id, 'unknown', extended)).toBe(false);
        await expect(
          users.renewSubagentAdmission(id, 'deletion-a', new Date(Number.NaN)),
        ).rejects.toThrow('fencedUntil must be a valid Date');
      });

      it('refuses a fence past the cap instead of dropping an active one', async () => {
        const id = await create({ email: 'saturated@example.com' });
        const users = stores();
        for (let index = 0; index < 32; index += 1) {
          await users.fenceSubagentAdmission(id, `deletion-${index}`, until());
        }
        await expect(users.fenceSubagentAdmission(id, 'overflow', until())).rejects.toThrow(
          'Too many concurrent bulk deletions',
        );
        const fences = await fencesOf(id);
        expect(fences).toHaveLength(32);
        expect(fences[0].token).toBe('deletion-0');
        expect(await users.isSubagentOwnerAdmissible(id)).toBe(false);
      });

      it('refuses an invalid expiry or token', async () => {
        const id = await create({ email: 'invalid-fence@example.com' });
        await expect(
          stores().fenceSubagentAdmission(id, 'deletion-a', new Date(Number.NaN)),
        ).rejects.toThrow('fencedUntil must be a valid Date');
        await expect(stores().fenceSubagentAdmission(id, '', until())).rejects.toThrow(
          'bounded owner token',
        );
        await expect(stores().fenceSubagentAdmission(id, 'x'.repeat(129), until())).rejects.toThrow(
          'bounded owner token',
        );
      });

      it('evicts cached auth documents on fence, renewal and release', async () => {
        const id = await create({ email: 'fence-evict@example.com' });
        expect(await evicts(id, (users) => users.fenceSubagentAdmission(id, 'a', until()))).toBe(
          true,
        );
        expect(await evicts(id, (users) => users.renewSubagentAdmission(id, 'a', until()))).toBe(
          true,
        );
        expect(await evicts(id, (users) => users.releaseSubagentAdmission(id, 'a'))).toBe(true);
      });
    });

    describe('deleteUserById', () => {
      it('deletes the user and its tool approval grants, and only those', async () => {
        const id = await create({ email: 'delete@example.com' });
        await harness.seedRaw('toolapprovalgrants', [
          {
            _id: harness.ids.generate(),
            user: id,
            agentId: 'agent',
            toolName: 'tool',
            conversationId: 'chat',
            binding: 'mine',
          },
          {
            _id: harness.ids.generate(),
            user: 'another-user',
            agentId: 'agent',
            toolName: 'tool',
            conversationId: 'chat',
            binding: 'theirs',
          },
        ]);
        expect(await stores().deleteUserById(id)).toEqual({
          deletedCount: 1,
          message: 'User was deleted successfully.',
        });
        expect(await harness.readRaw('users')).toEqual([]);
        expect((await harness.readRaw('toolapprovalgrants')).map((grant) => grant.binding)).toEqual(
          ['theirs'],
        );
      });

      it('reports zero for a missing user, and evicts cached auth documents', async () => {
        expect(await stores().deleteUserById(harness.ids.generate())).toEqual({
          deletedCount: 0,
          message: 'No user found with that ID.',
        });
        const id = await create({ email: 'delete-cache@example.com' });
        expect(await evicts(id, (users) => users.deleteUserById(id))).toBe(true);
      });
    });

    describe('updateUserPlugins', () => {
      it('keeps concurrent installs made from the same stale snapshot', async () => {
        const id = await create({ email: 'plugins@example.com', plugins: ['existing'] });
        const stale = ['existing'];
        await Promise.all([
          stores().updateUserPlugins(id, stale, 'alpha', 'install'),
          stores().updateUserPlugins(id, stale, 'beta', 'install'),
          stores().updateUserPlugins(id, stale, 'alpha', 'install'),
        ]);
        expect([...((await raw(id)).plugins as string[])].sort()).toEqual([
          'alpha',
          'beta',
          'existing',
        ]);
      });

      it('uninstalls only the target plugin, removing the expiry', async () => {
        const id = idOf(
          harness,
          await stores().createUser(
            { email: 'uninstall@example.com', plugins: ['alpha', 'beta', 'gamma'] } as never,
            undefined,
            false,
          ),
        );
        const updated = await stores().updateUserPlugins(id, ['alpha'], 'alpha', 'uninstall');
        expect(updated?.plugins).toEqual(['beta', 'gamma']);
        expect(await raw(id)).not.toHaveProperty('expiresAt');
      });

      it('resolves null for an unknown user or action', async () => {
        const id = await create({ email: 'unknown-action@example.com' });
        expect(
          await stores().updateUserPlugins(harness.ids.generate(), [], 'alpha', 'install'),
        ).toBeNull();
        expect(await stores().updateUserPlugins(id, [], 'alpha', 'upgrade' as never)).toBeNull();
        expect(await evicts(id, (users) => users.updateUserPlugins(id, [], 'a', 'install'))).toBe(
          true,
        );
      });
    });

    describe('toggleUserMemories', () => {
      it('turns memories on and off, creating personalization when missing', async () => {
        const id = await seedUser({ email: 'memories@example.com' });
        expect((await stores().toggleUserMemories(id, false))?.personalization).toMatchObject({
          memories: false,
        });
        expect((await raw(id)).personalization).toMatchObject({ memories: false });
        expect((await stores().toggleUserMemories(id, true))?.personalization?.memories).toBe(true);
      });

      it('resolves null for a missing user, and evicts cached auth documents', async () => {
        expect(await stores().toggleUserMemories(harness.ids.generate(), true)).toBeNull();
        const id = await create({ email: 'memories-cache@example.com' });
        expect(await evicts(id, (users) => users.toggleUserMemories(id, false))).toBe(true);
      });
    });

    describe('updateUserStatefulCodeEnvironment', () => {
      it('sets the workspace default without changing memories', async () => {
        const id = await create({
          email: 'workspace@example.com',
          personalization: { memories: false },
        });
        const updated = await stores().updateUserStatefulCodeEnvironment(id, 'conversation');
        expect(updated?.personalization).toMatchObject({
          memories: false,
          statefulCodeEnvironment: 'conversation',
        });
        await expect(
          stores().updateUserStatefulCodeEnvironment(id, 'agent' as never),
        ).rejects.toThrow();
      });

      it('resolves null for a missing user, and evicts cached auth documents', async () => {
        expect(
          await stores().updateUserStatefulCodeEnvironment(harness.ids.generate(), 'user'),
        ).toBeNull();
        const id = await create({ email: 'workspace-cache@example.com' });
        expect(
          await evicts(id, (users) => users.updateUserStatefulCodeEnvironment(id, 'conversation')),
        ).toBe(true);
      });
    });
  });
}
