/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SessionStore` contract (`~/ports/session`): refresh-token sessions created, found by
 * token, user or id (unexpired only), rotated, upserted from an external token, and deleted.
 * `createSession` and `findSession(…, { lean: false })` hand out hydrated documents with
 * MongoDB, and `generateRefreshToken` saves the document it is given (R5): the cases rotate a
 * token on both kinds of document. Refresh tokens are stored as their SHA-256 hex hash, which
 * every backend keeps (a copied session must still match its token). Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { createHash } from 'node:crypto';
import type { ContractHarness } from './harness';
import type { ISession } from '~/types';
import { runAsSystem } from '~/config/tenantContext';
import { idOf, timeOf, useContractHarness } from './support';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY = 24 * 60 * 60 * 1000;

/** The payload of a signed token, without verifying it. */
function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

export function describeSessionContract(harness: ContractHarness): void {
  describe(`SessionStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const originalSecret = process.env.JWT_REFRESH_SECRET;
    beforeAll(() => {
      process.env.JWT_REFRESH_SECRET = originalSecret ?? 'contract-refresh-secret';
    });
    afterAll(() => {
      if (originalSecret === undefined) {
        delete process.env.JWT_REFRESH_SECRET;
      } else {
        process.env.JWT_REFRESH_SECRET = originalSecret;
      }
    });

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const stores = () => harness.createStores().sessions;
    const session = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      user: userId,
      refreshTokenHash: sha256(`token-${Math.random()}`),
      expiration: new Date(Date.now() + DAY),
      ...overrides,
    });

    describe('createSession', () => {
      it('stores a session for the user, expiring in seven days, with a signed refresh token', async () => {
        const before = Date.now();
        const { session: created, refreshToken } = await stores().createSession(userId);
        const [stored] = await harness.readRaw('sessions');
        expect(stored).toMatchObject({ user: userId, refreshTokenHash: sha256(refreshToken) });
        expect(idOf(harness, created._id)).toBe(stored._id);
        expect(idOf(harness, created.user)).toBe(userId);
        const expiresAt = timeOf(stored.expiration);
        expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY - 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000);
        const payload = payloadOf(refreshToken);
        expect(payload).toMatchObject({ id: userId, sessionId: stored._id });
        expect(typeof payload.issuedAtMs).toBe('number');
      });

      it('expires at the given date, or after the given duration', async () => {
        const expiration = new Date(Date.now() + 3 * DAY);
        await stores().createSession(userId, { expiration });
        await stores().createSession(otherUserId, { expiresIn: 60_000 });
        const [first, second] = await harness.readRaw('sessions');
        expect(timeOf(first.expiration)).toBe(expiration.getTime());
        expect(timeOf(second.expiration)).toBeLessThanOrEqual(Date.now() + 61_000);
        expect(timeOf(second.expiration)).toBeGreaterThan(Date.now());
      });

      it('throws a coded session error without a user', async () => {
        await expect(stores().createSession('')).rejects.toMatchObject({
          name: 'SessionError',
          code: 'INVALID_USER_ID',
        });
      });
    });

    describe('findSession', () => {
      it('finds the unexpired session by refresh token, user and id', async () => {
        const { refreshToken } = await stores().createSession(userId);
        const [stored] = await harness.readRaw('sessions');
        const sessions = stores();
        for (const params of [
          { refreshToken },
          { userId },
          { sessionId: stored._id as string },
          { sessionId: { sessionId: stored._id as string } },
          { refreshToken, userId, sessionId: stored._id as string },
        ]) {
          const found = await sessions.findSession(params);
          expect(idOf(harness, found?._id)).toBe(stored._id);
          expect(idOf(harness, found?.user)).toBe(userId);
        }
      });

      it('requires every given parameter to match', async () => {
        const { refreshToken } = await stores().createSession(userId);
        const sessions = stores();
        expect(await sessions.findSession({ refreshToken, userId: otherUserId })).toBeNull();
        expect(await sessions.findSession({ refreshToken: 'unknown' })).toBeNull();
        expect(await sessions.findSession({ sessionId: harness.ids.generate() })).toBeNull();
      });

      it('leaves out expired sessions', async () => {
        await harness.seedRaw('sessions', [
          session({ refreshTokenHash: sha256('expired'), expiration: new Date(Date.now() - 1000) }),
        ]);
        expect(await stores().findSession({ refreshToken: 'expired' })).toBeNull();
        expect(await stores().findSession({ userId })).toBeNull();
      });

      it('throws a coded error without parameters or with a malformed id', async () => {
        await expect(stores().findSession({})).rejects.toMatchObject({
          code: 'FIND_SESSION_FAILED',
        });
        await expect(stores().findSession({ sessionId: 'not-an-id' })).rejects.toMatchObject({
          code: 'FIND_SESSION_FAILED',
        });
      });
    });

    describe('generateRefreshToken', () => {
      it('rotates the token of a session read as a document, saving the new hash', async () => {
        const sessions = stores();
        const { refreshToken } = await sessions.createSession(userId);
        const found = await sessions.findSession({ refreshToken }, { lean: false });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const rotated = await sessions.generateRefreshToken(found as ISession);
        expect(rotated).not.toBe(refreshToken);
        const [stored] = await harness.readRaw('sessions');
        expect(stored.refreshTokenHash).toBe(sha256(rotated));
        expect(await sessions.findSession({ refreshToken })).toBeNull();
        expect(idOf(harness, (await sessions.findSession({ refreshToken: rotated }))?._id)).toBe(
          stored._id,
        );
        expect(await harness.readRaw('sessions')).toHaveLength(1);
      });

      it('rotates the token of the session createSession handed out', async () => {
        const sessions = stores();
        const { session: created } = await sessions.createSession(userId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const rotated = await sessions.generateRefreshToken(created as ISession);
        const records = await harness.readRaw('sessions');
        expect(records).toHaveLength(1);
        expect(records[0].refreshTokenHash).toBe(sha256(rotated));
      });

      it('throws a coded error for a session without a user', async () => {
        await expect(
          stores().generateRefreshToken({} as unknown as ISession),
        ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
      });
    });

    describe('upsertSession', () => {
      it('stores an external refresh token as its hash, and extends it on a second call', async () => {
        const sessions = stores();
        const first = new Date(Date.now() + DAY);
        /** Its caller (the OpenID session store) writes as the system, naming the tenant. */
        const stored = await runAsSystem(() =>
          sessions.upsertSession(userId, 'external-refresh', {
            expiration: first,
            tenantId: 'tenant-a',
          }),
        );
        expect(idOf(harness, stored.user)).toBe(userId);
        const [record] = await harness.readRaw('sessions');
        expect(record).toMatchObject({
          user: userId,
          refreshTokenHash: sha256('external-refresh'),
          tenantId: 'tenant-a',
        });
        expect(idOf(harness, stored._id)).toBe(record._id);
        const later = new Date(Date.now() + 2 * DAY);
        await runAsSystem(() =>
          sessions.upsertSession(userId, 'external-refresh', { expiration: later }),
        );
        const records = await harness.readRaw('sessions');
        expect(records).toHaveLength(1);
        expect(timeOf(records[0].expiration)).toBe(later.getTime());
        expect(
          idOf(harness, (await sessions.findSession({ refreshToken: 'external-refresh' }))?._id),
        ).toBe(record._id);
      });

      it('keeps the same token of two users apart', async () => {
        const sessions = stores();
        const expiration = new Date(Date.now() + DAY);
        await sessions.upsertSession(userId, 'shared', { expiration });
        await sessions.upsertSession(otherUserId, 'shared', { expiration });
        expect(await harness.readRaw('sessions')).toHaveLength(2);
      });

      it('throws a coded error without user, token or expiration', async () => {
        await expect(
          stores().upsertSession(userId, '', { expiration: new Date() }),
        ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
        await expect(
          stores().upsertSession(userId, 'token', {} as { expiration: Date }),
        ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
      });
    });

    describe('deleteSession', () => {
      it('deletes by refresh token or by id, counting it', async () => {
        const sessions = stores();
        const { refreshToken } = await sessions.createSession(userId);
        await sessions.createSession(userId);
        const [, second] = await harness.readRaw('sessions');
        expect(await sessions.deleteSession({ refreshToken })).toMatchObject({ deletedCount: 1 });
        expect(await sessions.deleteSession({ sessionId: second._id as string })).toMatchObject({
          deletedCount: 1,
        });
        expect(await harness.readRaw('sessions')).toEqual([]);
      });

      it('counts 0 when there is none, and throws without a token or id', async () => {
        expect(await stores().deleteSession({ refreshToken: 'unknown' })).toMatchObject({
          deletedCount: 0,
        });
        await expect(stores().deleteSession({})).rejects.toMatchObject({
          code: 'DELETE_SESSION_FAILED',
        });
      });
    });

    describe('deleteAllUserSessions', () => {
      it("deletes every session of the user, keeping other users'", async () => {
        await harness.seedRaw('sessions', [session(), session(), session({ user: otherUserId })]);
        expect(await stores().deleteAllUserSessions(userId)).toMatchObject({ deletedCount: 2 });
        const remaining = await harness.readRaw('sessions');
        expect(remaining.map((record) => record.user)).toEqual([otherUserId]);
      });

      it('keeps the current session with excludeCurrentSession, and takes { userId }', async () => {
        const current = session();
        await harness.seedRaw('sessions', [current, session(), session()]);
        expect(
          await stores().deleteAllUserSessions(
            { userId },
            { excludeCurrentSession: true, currentSessionId: current._id },
          ),
        ).toMatchObject({ deletedCount: 2 });
        expect((await harness.readRaw('sessions')).map((record) => record._id)).toEqual([
          current._id,
        ]);
      });

      it('throws a coded error for a malformed user id', async () => {
        await expect(stores().deleteAllUserSessions('not-an-id')).rejects.toMatchObject({
          code: 'DELETE_ALL_SESSIONS_FAILED',
        });
      });
    });

    describe('ensureSessionIndexes', () => {
      it('resolves, and resolves again on a later call', async () => {
        const sessions = stores();
        await expect(sessions.ensureSessionIndexes()).resolves.toBeUndefined();
        await expect(sessions.ensureSessionIndexes()).resolves.toBeUndefined();
      });
    });
  });
}
