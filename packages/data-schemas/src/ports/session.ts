/**
 * Session store port: the refresh-token sessions a user signs in with. Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `SessionMethods` (`~/methods/session`);
 * `session.spec.ts` fails the typecheck if the two drift. Refresh tokens are stored only as
 * hashes; any store keeps that. Failures are thrown as `SessionError`s, whose `code` names what
 * failed.
 *
 * Known leaks kept for now so callers stay unchanged:
 * - `ISession` extends mongoose's `Document`.
 * - `findSession`'s `lean` option is mongoose's hydration switch (it reads as a plain record by
 *   default). With `lean: false` the session comes back as a record `generateRefreshToken` can
 *   save, which is the one way callers use it; a store that always returns such records can
 *   ignore the option.
 * - `generateRefreshToken` mutates and saves the session it is handed (from `createSession` or
 *   `findSession(…, { lean: false })`), storing the new token's hash on it.
 */
import type {
  ISession,
  SessionResult,
  SessionQueryOptions,
  SessionSearchParams,
  DeleteSessionParams,
  CreateSessionOptions,
  UpsertSessionOptions,
  DeleteAllSessionsOptions,
} from '~/types/session';
import { listPortMethods } from './common';

export interface SessionStore {
  /**
   * The unexpired session matching every given parameter (at least one is required): the
   * refresh token, the user, the session id.
   */
  findSession(params: SessionSearchParams, options?: SessionQueryOptions): Promise<ISession | null>;
  /** Deletes the session by refresh token or id; `deletedCount` is 0 when there was none. */
  deleteSession(params: DeleteSessionParams): Promise<{ deletedCount?: number }>;
  /**
   * Starts a session for the user, expiring at `expiration` or after `expiresIn` ms (seven days
   * by default), and issues its refresh token.
   */
  createSession(userId: string, options?: CreateSessionOptions): Promise<SessionResult>;
  /**
   * Stores an externally issued refresh token as the user's session, or extends the one already
   * stored for it, so logout and administrative revocation apply to it.
   */
  upsertSession(
    userId: string,
    refreshToken: string,
    options: UpsertSessionOptions,
  ): Promise<ISession>;
  /** Makes sure the session indexes exist; a failed build is retried on the next call. */
  ensureSessionIndexes(): Promise<void>;
  /** Signs a new refresh token for the session and stores its hash on the session. */
  generateRefreshToken(session: ISession): Promise<string>;
  /**
   * Deletes every session of the user, optionally all but `currentSessionId` with
   * `excludeCurrentSession`.
   */
  deleteAllUserSessions(
    userId: string | { userId: string },
    options?: DeleteAllSessionsOptions,
  ): Promise<{ deletedCount?: number }>;
}

/** Every method of {@link SessionStore}, for adapters and conformance checks. */
export const SESSION_STORE_METHODS: ReadonlyArray<keyof SessionStore> =
  listPortMethods<SessionStore>({
    findSession: true,
    deleteSession: true,
    createSession: true,
    upsertSession: true,
    ensureSessionIndexes: true,
    generateRefreshToken: true,
    deleteAllUserSessions: true,
  });
