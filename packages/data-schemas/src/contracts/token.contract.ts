/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `TokenStore` contract (`~/ports/token`), ported from `methods/token.spec.ts`: creation with
 * an expiry, AND lookups (explicitly absent fields, normalized emails, regex identifiers, the
 * OAuth credential-set selector, sort), the scope compare-and-set, updates and deletes.
 * `createToken` and `updateToken` hand out hydrated documents with MongoDB, whose `metadata` is a
 * `Map`; callers accept a `Map` or a plain object, so the cases read metadata through
 * `metadataOf`. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { idOf, timeOf, useContractHarness } from './support';

const HOUR = 60 * 60 * 1000;

/** Token metadata as a plain object, whether the store handed out a `Map` or an object. */
function metadataOf(token: { metadata?: unknown } | null | undefined): Record<string, unknown> {
  const metadata = token?.metadata;
  if (metadata instanceof Map) {
    return Object.fromEntries(metadata);
  }
  return (metadata ?? {}) as Record<string, unknown>;
}

export function describeTokenContract(harness: ContractHarness): void {
  describe(`TokenStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const stores = () => harness.createStores().tokens;
    const token = (value: string, overrides: RawRecord = {}): RawRecord => ({
      _id: harness.ids.generate(),
      userId,
      token: value,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + HOUR),
      ...overrides,
    });
    const tokenValues = async () =>
      (await harness.readRaw('tokens')).map((record) => record.token).sort();

    describe('createToken', () => {
      it('stores the token with its fields, expiring expiresIn seconds from now', async () => {
        const before = Date.now();
        const created = await stores().createToken({
          userId,
          email: 'user@example.com',
          type: 'mcp_oauth',
          identifier: 'mcp:server',
          token: 'value',
          expiresIn: 3600,
          metadata: { credential_set_id: 'set-a', nested: { a: 1 } },
        });
        expect(created.token).toBe('value');
        expect(idOf(harness, created.userId)).toBe(userId);
        expect(metadataOf(created)).toEqual({ credential_set_id: 'set-a', nested: { a: 1 } });
        const [stored] = await harness.readRaw('tokens');
        expect(idOf(harness, created._id)).toBe(stored._id);
        expect(stored).toMatchObject({
          userId,
          email: 'user@example.com',
          type: 'mcp_oauth',
          identifier: 'mcp:server',
          token: 'value',
          metadata: { credential_set_id: 'set-a', nested: { a: 1 } },
        });
        const created_at = timeOf(stored.createdAt);
        expect(created_at).toBeGreaterThanOrEqual(before);
        expect(timeOf(stored.expiresAt) - created_at).toBe(3600 * 1000);
      });

      it('stores the email trimmed and lowercased', async () => {
        await stores().createToken({
          userId,
          email: '  User@Example.COM ',
          token: 'mixed',
          expiresIn: 60,
        });
        expect((await harness.readRaw('tokens'))[0].email).toBe('user@example.com');
      });

      it('rejects a token without its required fields', async () => {
        await expect(stores().createToken({ userId, expiresIn: 60 } as never)).rejects.toThrow();
        expect(await harness.readRaw('tokens')).toEqual([]);
      });
    });

    describe('findToken', () => {
      it('finds by each field, and by several together (AND)', async () => {
        await harness.seedRaw('tokens', [
          token('a', { email: 'a@example.com', type: 'verify', identifier: 'id-a' }),
          token('b', { userId: otherUserId, email: 'b@example.com', type: 'verify' }),
        ]);
        const tokens = stores();
        expect((await tokens.findToken({ token: 'a' }))?.token).toBe('a');
        expect((await tokens.findToken({ userId: otherUserId }))?.token).toBe('b');
        expect((await tokens.findToken({ email: 'b@example.com' }))?.token).toBe('b');
        expect((await tokens.findToken({ identifier: 'id-a' }))?.token).toBe('a');
        expect((await tokens.findToken({ type: 'verify', userId }))?.token).toBe('a');
        expect(await tokens.findToken({ token: 'a', userId: otherUserId })).toBeNull();
        expect(await tokens.findToken({ token: 'missing' })).toBeNull();
      });

      it('matches an email whatever its case and surrounding whitespace', async () => {
        await harness.seedRaw('tokens', [token('t', { email: 'user@example.com' })]);
        expect((await stores().findToken({ email: '  USER@Example.com ' }))?.token).toBe('t');
      });

      it('matches explicitly absent optional fields with null', async () => {
        await harness.seedRaw('tokens', [
          token('legacy-reset-token'),
          token('legacy-identified-token', { identifier: 'oauth-legacy' }),
          token('null-email-token', { email: null, type: 'reset' }),
        ]);
        const tokens = stores();
        expect(
          (await tokens.findToken({ userId, email: null, identifier: null, type: null }))?.token,
        ).toBe('legacy-reset-token');
        expect((await tokens.findToken({ type: 'reset', email: null }))?.token).toBe(
          'null-email-token',
        );
      });

      it('matches a regular expression identifier', async () => {
        await harness.seedRaw('tokens', [
          token('one', { identifier: `${userId}:action-1` }),
          token('two', { identifier: `${userId}:action-2` }),
        ]);
        expect((await stores().findToken({ identifier: /^[^:]+:action-2$/ }))?.token).toBe('two');
      });

      it('matches the credential-set selector, null meaning a token without one', async () => {
        await harness.seedRaw('tokens', [
          token('legacy', { type: 'mcp_oauth' }),
          token('tagged', { type: 'mcp_oauth', metadata: { credential_set_id: 'set-b' } }),
        ]);
        const tokens = stores();
        expect(
          (await tokens.findToken({ type: 'mcp_oauth', metadataCredentialSetId: 'set-b' }))?.token,
        ).toBe('tagged');
        expect(
          (await tokens.findToken({ type: 'mcp_oauth', metadataCredentialSetId: null }))?.token,
        ).toBe('legacy');
      });

      it('reads in the given sort order', async () => {
        const base = Date.now();
        await harness.seedRaw('tokens', [
          token('middle', { createdAt: new Date(base - 2000), type: 'refresh' }),
          token('newest', { createdAt: new Date(base - 1000), type: 'refresh' }),
          token('oldest', { createdAt: new Date(base - 3000), type: 'refresh' }),
        ]);
        const tokens = stores();
        expect(
          (await tokens.findToken({ userId, type: 'refresh' }, { sort: { createdAt: -1 } }))?.token,
        ).toBe('newest');
        expect(
          (await tokens.findToken({ userId, type: 'refresh' }, { sort: { createdAt: 1 } }))?.token,
        ).toBe('oldest');
        expect(
          (await tokens.findToken({ userId }, { sort: { type: 1, createdAt: -1 } }))?.token,
        ).toBe('newest');
      });

      it('reads metadata as stored', async () => {
        await harness.seedRaw('tokens', [token('m', { metadata: { credential_set_id: 'x' } })]);
        expect(metadataOf(await stores().findToken({ token: 'm' }))).toEqual({
          credential_set_id: 'x',
        });
      });
    });

    describe('updateToken', () => {
      it('updates the first matching token and resolves to it updated', async () => {
        await harness.seedRaw('tokens', [token('update-token', { email: 'old@example.com' })]);
        const tokens = stores();
        const updated = await tokens.updateToken(
          { token: 'update-token' },
          { email: 'new@example.com' },
        );
        expect(updated?.email).toBe('new@example.com');
        expect(await tokens.updateToken({ userId }, { type: 'renamed' })).toMatchObject({
          type: 'renamed',
          email: 'new@example.com',
        });
        expect(
          await tokens.updateToken({ token: 'missing' }, { email: 'x@example.com' }),
        ).toBeNull();
        expect((await harness.readRaw('tokens'))[0]).toMatchObject({
          email: 'new@example.com',
          type: 'renamed',
        });
      });

      it('sets expiresAt from expiresIn, and leaves it alone otherwise', async () => {
        const expiresAt = new Date(Date.now() + HOUR);
        await harness.seedRaw('tokens', [token('t', { expiresAt })]);
        const tokens = stores();
        await tokens.updateToken({ token: 't' }, { email: 'x@example.com' });
        expect(timeOf((await harness.readRaw('tokens'))[0].expiresAt)).toBe(expiresAt.getTime());
        const before = Date.now();
        await tokens.updateToken({ token: 't' }, { expiresIn: 7200 });
        const updated = timeOf((await harness.readRaw('tokens'))[0].expiresAt);
        expect(updated).toBeGreaterThanOrEqual(before + 7200 * 1000);
        expect(updated).toBeLessThanOrEqual(Date.now() + 7200 * 1000);
      });

      it('conditions the update on the credential-set selector', async () => {
        await harness.seedRaw('tokens', [
          token('legacy'),
          token('tagged', {
            metadata: { credential_set_id: 'generation-a' },
          }),
        ]);
        const tokens = stores();
        expect(
          await tokens.updateToken(
            { token: 'tagged', metadataCredentialSetId: 'generation-b' },
            { email: 'stale@example.com' },
          ),
        ).toBeNull();
        expect(
          (
            await tokens.updateToken(
              { token: 'tagged', metadataCredentialSetId: 'generation-a' },
              { email: 'current@example.com' },
            )
          )?.email,
        ).toBe('current@example.com');
        expect(
          await tokens.updateToken(
            { token: 'tagged', metadataCredentialSetId: null },
            { email: 'stale@example.com' },
          ),
        ).toBeNull();
        expect(
          (
            await tokens.updateToken(
              { token: 'legacy', metadataCredentialSetId: null },
              { email: 'claimed@example.com', metadata: { credential_set_id: 'generation-c' } },
            )
          )?.email,
        ).toBe('claimed@example.com');
        const legacy = (await harness.readRaw('tokens')).find(
          (record) => record.token === 'legacy',
        );
        expect(legacy?.metadata).toEqual({ credential_set_id: 'generation-c' });
      });
    });

    describe('replaceTokenIfCurrent', () => {
      const candidate = (email: string, value: string) => ({
        userId,
        type: 'email_change',
        email,
        token: value,
        expiresIn: 900,
      });
      const scope = `email_change:${userId}`;

      it('lets only one of concurrent creates into an empty scope win', async () => {
        const candidates = [
          candidate('first@example.com', 'first-token'),
          candidate('second@example.com', 'second-token'),
        ];
        const results = await Promise.all(
          candidates.map((item) => stores().replaceTokenIfCurrent(scope, null, item)),
        );
        expect([...results].sort()).toEqual([false, true]);
        const winner = candidates[results.indexOf(true)];
        const stored = await harness.readRaw('tokens');
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ scope, token: winner.token, email: winner.email });
        expect(timeOf(stored[0].expiresAt) - timeOf(stored[0].createdAt)).toBe(900 * 1000);
      });

      it('lets only one of concurrent replacements of the observed token win', async () => {
        await stores().replaceTokenIfCurrent(scope, null, candidate('old@example.com', 'existing'));
        const candidates = [
          candidate('first@example.com', 'first-token'),
          candidate('second@example.com', 'second-token'),
        ];
        const results = await Promise.all(
          candidates.map((item) => stores().replaceTokenIfCurrent(scope, 'existing', item)),
        );
        expect([...results].sort()).toEqual([false, true]);
        const winner = candidates[results.indexOf(true)];
        const stored = await harness.readRaw('tokens');
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ token: winner.token, email: winner.email });
      });

      it('keeps the current token when the expected one is stale, or the scope taken', async () => {
        const tokens = stores();
        expect(
          await tokens.replaceTokenIfCurrent(scope, null, candidate('a@example.com', 'current')),
        ).toBe(true);
        expect(
          await tokens.replaceTokenIfCurrent(scope, 'stale', candidate('b@example.com', 'b')),
        ).toBe(false);
        expect(
          await tokens.replaceTokenIfCurrent(scope, null, candidate('c@example.com', 'c')),
        ).toBe(false);
        expect(await harness.readRaw('tokens')).toMatchObject([
          { token: 'current', email: 'a@example.com' },
        ]);
      });

      it('does not create a token when replacing in an empty scope', async () => {
        expect(
          await stores().replaceTokenIfCurrent(scope, 'expected', candidate('a@example.com', 'a')),
        ).toBe(false);
        expect(await harness.readRaw('tokens')).toEqual([]);
      });
    });

    describe('deleteTokens', () => {
      it('deletes only the tokens matching every given field', async () => {
        await harness.seedRaw('tokens', [
          token('verify-1', { email: 'one@example.com', type: 'verify' }),
          token('verify-2', { email: 'two@example.com', type: 'verify' }),
          token('reset-1', { email: 'one@example.com', type: 'reset' }),
          token('other', { userId: otherUserId, type: 'verify', identifier: 'shared' }),
          token('mine', { type: 'verify', identifier: 'shared' }),
        ]);
        const tokens = stores();
        expect(
          await tokens.deleteTokens({ email: ' ONE@example.com', type: 'verify' }),
        ).toMatchObject({ deletedCount: 1 });
        expect(await tokens.deleteTokens({ identifier: 'shared', userId })).toMatchObject({
          deletedCount: 1,
        });
        expect(
          await tokens.deleteTokens({
            token: 'verify-2',
            identifier: undefined,
            userId: undefined,
          }),
        ).toMatchObject({ deletedCount: 1 });
        expect(await tokenValues()).toEqual(['other', 'reset-1']);
        expect(await tokens.deleteTokens({ token: 'missing' })).toMatchObject({ deletedCount: 0 });
      });

      it('deletes only tokens whose optional fields are explicitly absent', async () => {
        await harness.seedRaw('tokens', [
          token('legacy-reset-token'),
          token('legacy-identified-token', { identifier: 'oauth-legacy' }),
          token('typed-reset-token', { type: 'password_reset' }),
        ]);
        expect(
          await stores().deleteTokens({ userId, email: null, identifier: null, type: null }),
        ).toMatchObject({ deletedCount: 1 });
        expect(await tokenValues()).toEqual(['legacy-identified-token', 'typed-reset-token']);
      });

      it('matches a regular expression identifier', async () => {
        await harness.seedRaw('tokens', [
          token('one', { type: 'oauth', identifier: `${userId}:action-1` }),
          token('two', { type: 'oauth', identifier: `${userId}:action-2` }),
        ]);
        expect(
          await stores().deleteTokens({ type: 'oauth', identifier: /^[^:]+:action-1$/ }),
        ).toMatchObject({ deletedCount: 1 });
        expect(await tokenValues()).toEqual(['two']);
      });

      it('conditions the delete on the credential-set selector', async () => {
        const identifier = 'mcp:test-server:refresh';
        await harness.seedRaw('tokens', [
          token('legacy', { type: 'mcp_oauth_refresh', identifier }),
          token('tagged', {
            type: 'mcp_oauth_refresh',
            identifier,
            metadata: { credential_set_id: 'generation-b' },
          }),
        ]);
        const tokens = stores();
        expect(
          await tokens.deleteTokens({ identifier, metadataCredentialSetId: 'generation-a' }),
        ).toMatchObject({ deletedCount: 0 });
        expect(
          await tokens.deleteTokens({ identifier, metadataCredentialSetId: null }),
        ).toMatchObject({ deletedCount: 1 });
        expect(await tokenValues()).toEqual(['tagged']);
      });

      it('throws without any criterion, deleting nothing', async () => {
        await harness.seedRaw('tokens', [token('kept')]);
        await expect(stores().deleteTokens({})).rejects.toThrow(
          'At least one query parameter must be provided',
        );
        await expect(stores().deleteTokens({ token: undefined })).rejects.toThrow(
          'At least one query parameter must be provided',
        );
        expect(await tokenValues()).toEqual(['kept']);
      });
    });
  });
}
