/**
 * The user store's database-neutral rules (`UserStore`, `~/ports/user`), shared by every backend:
 * the MongoDB methods (`./user`) and the PostgreSQL store (`adapters/postgres/stores/user.ts`).
 * The constants, the email normalization of lookups, the start balance, the guarded writes'
 * filters and updates (stated in the store query language), the fence checks, the access token,
 * the search ranking and the auth user document eviction every credential-relevant write runs.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import { AUTH_USER_DOC_MAX_AGE_MS } from 'librechat-data-provider';
import type { BalanceRefillMode, RefillIntervalUnit } from 'librechat-data-provider';
import type {
  IUser,
  CacheStore,
  BalanceConfig,
  TwoFactorEnrollmentGuard,
  TwoFactorEnrollmentUpdate,
} from '~/types';
import { evictAuthUserDocsForUsers } from '~/utils/eviction';
import { scoreSearchMatch } from '~/utils/search';
import { signPayload } from '~/crypto';
import logger from '~/config/winston';

/** Default JWT session expiry: 15 minutes in milliseconds */
export const DEFAULT_SESSION_EXPIRY: number = 1000 * 60 * 15;
/** Minimum age before an explicitly offline operator may recover an abandoned deletion fence. */
export const USER_DELETION_FENCE_STALE_MS: number = 15 * 60_000;
/** Bounds concurrent bulk deletions held for one owner at any moment. */
export const MAX_SUBAGENT_ADMISSION_FENCES: number = 32;
/** How long an account created with a TTL lives before it expires: one week. */
export const PENDING_ACCOUNT_TTL_MS: number = 604800 * 1000;

/** Providers whose credentials LibreChat owns, and therefore the only ones it can enroll in 2FA. */
export const TWO_FACTOR_ENROLLMENT_PROVIDERS: Array<string | null> = [null, 'local', 'ldap'];
export const TWO_FACTOR_ENROLLMENT_PROJECTION: string =
  '+totpSecret +backupCodes +pendingTotpSecret +pendingBackupCodes +twoFactorAcknowledgementNonceHash +twoFactorFinalizationNonceHash';

/** Timers can fire a millisecond early, so the wait outlasts a cached document by this much. */
export const AUTH_USER_DOC_EXPIRY_MARGIN_MS: number = 100;

/** Cached auth documents evicted at once when a reset touches every user. */
export const TERMS_RESET_EVICTION_BATCH: number = 100;

/** What the user methods are built with, on every backend. */
export interface UserMethodDeps {
  getCache?: (key: string) => CacheStore | undefined;
  /** Resolves after the given milliseconds; tests pass one that need not wait out the cache TTL. */
  delay?: (ms: number) => Promise<void>;
}

/** A filter or update in the store query language (with the extended operators C2 serves). */
export type UserQuery = Record<string, unknown>;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A filter's top-level fields and `$or` branches, as the email normalization reads them. */
type UserCriteria = { email?: unknown; $or?: unknown } & Record<string, unknown>;

/**
 * Normalizes email fields in search criteria to lowercase and trimmed.
 * Handles both direct email fields and $or arrays containing email conditions.
 */
export function normalizeEmailInCriteria<T extends object>(criteria: T): T {
  const normalized = { ...criteria } as UserCriteria;
  if (typeof normalized.email === 'string') {
    normalized.email = normalized.email.trim().toLowerCase();
  }
  if (Array.isArray(normalized.$or)) {
    normalized.$or = normalized.$or.map((condition: UserCriteria) => {
      if (typeof condition.email === 'string') {
        return { ...condition, email: condition.email.trim().toLowerCase() };
      }
      return condition;
    });
  }
  return normalized as T;
}

/** The fields of a new user's start balance (`$setOnInsert`, with `user` added by the caller). */
export interface StartBalanceFields {
  tokenCredits: number;
  autoRefillEnabled?: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: RefillIntervalUnit;
  refillAmount?: number;
  refillMode?: BalanceRefillMode;
}

/**
 * The start balance a new user is credited with, with auto-refill settings when complete, or
 * `null` when the balance config enables none. The write is insert-only, so it never replaces a
 * balance that already exists or the activity recorded on it.
 */
export function startBalanceFields(balanceConfig?: BalanceConfig): StartBalanceFields | null {
  if (!balanceConfig?.enabled || !balanceConfig?.startBalance) {
    return null;
  }

  const initial: StartBalanceFields = { tokenCredits: balanceConfig.startBalance };

  if (
    balanceConfig.autoRefillEnabled &&
    balanceConfig.refillIntervalValue != null &&
    balanceConfig.refillIntervalUnit != null &&
    balanceConfig.refillAmount != null
  ) {
    initial.autoRefillEnabled = true;
    initial.refillIntervalValue = balanceConfig.refillIntervalValue;
    initial.refillIntervalUnit = balanceConfig.refillIntervalUnit;
    initial.refillAmount = balanceConfig.refillAmount;
    initial.refillMode = balanceConfig.refillMode ?? 'add';
  }
  return initial;
}

/** The update of `updateUser`: the given fields, and the expiry removed unless preserved. */
export function userUpdateOperation(
  updateData: Partial<IUser>,
  options: { preserveExpiresAt?: boolean } = {},
): { $set: Partial<IUser>; $unset?: { expiresAt: '' } } {
  return {
    $set: updateData,
    ...(options.preserveExpiresAt ? {} : { $unset: { expiresAt: '' as const } }),
  };
}

/** The filter of `consumeBackupCode`: the user still holding this unused code. */
export function unusedBackupCodeFilter(userId: string, codeHash: string): UserQuery {
  return { _id: userId, backupCodes: { $elemMatch: { codeHash, used: false } } };
}

/** The update of `consumeBackupCode`: the code the filter matched is used now. */
export function consumeBackupCodeUpdate(now: Date = new Date()): UserQuery {
  return { $set: { 'backupCodes.$.used': true, 'backupCodes.$.usedAt': now } };
}

/** The filter of `claimSamlIdentity`: a SAML user without a SAML id yet, or with this one. */
export function samlClaimFilter(userId: string, samlId: string): UserQuery {
  return {
    _id: userId,
    provider: 'saml',
    $or: [{ samlId }, { samlId: { $exists: false } }, { samlId: null }, { samlId: '' }],
  };
}

/** The update of `claimSamlIdentity`. */
export function samlClaimUpdate(
  samlId: string,
  profileData: Pick<Partial<IUser>, 'username' | 'name'>,
): UserQuery {
  return {
    $set: { ...profileData, samlId },
    $unset: { expiresAt: '' as const },
  };
}

/**
 * The filter of a two-factor enrollment step: the user unenrolled, on a provider LibreChat
 * enrolls, and still holding every value of `guard`.
 */
export function twoFactorEnrollmentFilter(
  userId: string,
  guard: TwoFactorEnrollmentGuard,
): UserQuery {
  return {
    _id: userId,
    twoFactorEnabled: { $ne: true },
    provider: { $in: TWO_FACTOR_ENROLLMENT_PROVIDERS },
    ...guard,
  };
}

/** The update of a two-factor enrollment step. */
export function twoFactorEnrollmentUpdate(updateData: TwoFactorEnrollmentUpdate): UserQuery {
  return { $set: updateData, $unset: { expiresAt: '' as const } };
}

/**
 * The two claims of `acceptTerms`, tried in this order. A null-guarded claim stamps
 * termsAcceptedAt only when no timestamp is already stored (explicit null from the schema
 * default, a missing legacy field, or a terms reset), so the first acceptance within a terms
 * cycle is preserved across concurrent or repeated requests. The repeat-acceptance fallback is
 * guarded by the exact complement (a non-null timestamp) so it can never resurrect
 * termsAccepted into a cycle that config/reset-terms.js started between the two updates; when
 * both guards miss because a reset raced in, the claim retries and records a fresh stamped
 * acceptance. Plain updates are used instead of an aggregation pipeline with $$NOW, which Amazon
 * DocumentDB rejects.
 */
export interface TermsAcceptanceClaims {
  first: { filter: UserQuery; update: UserQuery };
  repeat: { filter: UserQuery; update: UserQuery };
}

export function termsAcceptanceClaims(
  userId: string,
  now: Date = new Date(),
): TermsAcceptanceClaims {
  return {
    first: {
      filter: { _id: userId, termsAcceptedAt: null },
      update: {
        $set: { termsAccepted: true, termsAcceptedAt: now },
        $unset: { termsAcceptedSource: 1 as const },
      },
    },
    repeat: {
      filter: { _id: userId, termsAcceptedAt: { $ne: null } },
      update: { $set: { termsAccepted: true } },
    },
  };
}

/** How many times `acceptTerms` retries when a terms reset races both claims. */
export const TERMS_ACCEPTANCE_ATTEMPTS: number = 3;

/** The update of `resetTermsAcceptance`, applied to every user. */
export const TERMS_RESET_UPDATE: UserQuery = {
  $set: { termsAccepted: false, termsAcceptedAt: null },
  $unset: { termsAcceptedSource: 1 as const },
};

/** Throws the `TypeError` the fence methods refuse an invalid date with. */
export function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

/** Throws the `TypeError` `fenceSubagentAdmission` refuses an empty or oversized token with. */
export function assertFenceToken(token: string): void {
  if (token.length === 0 || token.length > 128) {
    throw new TypeError('A subagent admission fence needs a bounded owner token');
  }
}

/** The filter of a stale deletion fence `recoverStaleAgentTriggerUserDeletion` may replace. */
export function staleDeletionFenceFilter(userId: string, recoveredAt: Date): UserQuery {
  const staleBefore = new Date(recoveredAt.getTime() - USER_DELETION_FENCE_STALE_MS);
  return { _id: userId, agentTriggerDeletionStartedAt: { $lte: staleBefore } };
}

/** The update pruning the user's expired subagent admission fences. */
export function expiredFencePrune(now: Date = new Date()): UserQuery {
  return { $pull: { subagentAdmissionFences: { expiresAt: { $lte: now } } } };
}

/** The filter admitting one more fence: the user holds fewer than the most fences allowed. */
export function fenceCapacityFilter(userId: string): UserQuery {
  return {
    _id: userId,
    [`subagentAdmissionFences.${MAX_SUBAGENT_ADMISSION_FENCES - 1}`]: { $exists: false },
  };
}

/** The error `fenceSubagentAdmission` throws when the user already holds the most fences. */
export const FENCE_CAPACITY_MESSAGE: string =
  'Too many concurrent bulk deletions are already fencing this owner.';

/** The filter of `isSubagentOwnerAdmissible`: no account deletion, no live fence. */
export function admissibleOwnerFilter(userId: string, now: Date = new Date()): UserQuery {
  return {
    _id: userId,
    agentTriggerDeletionStartedAt: { $exists: false },
    subagentAdmissionFences: { $not: { $elemMatch: { expiresAt: { $gt: now } } } },
  };
}

/**
 * The single array operation of `updateUserPlugins` (with the expiry removed), or `null` for an
 * action other than `install` and `uninstall`.
 */
export function userPluginsUpdate(pluginKey: string, action: string): UserQuery | null {
  let arrayOperation: Record<string, { plugins: string }>;
  if (action === 'install') {
    arrayOperation = { $addToSet: { plugins: pluginKey } };
  } else if (action === 'uninstall') {
    arrayOperation = { $pull: { plugins: pluginKey } };
  } else {
    return null;
  }
  return { ...arrayOperation, $unset: { expiresAt: '' } };
}

/**
 * Generates a JWT token for a given user.
 * @param user - The user object
 * @param expiresIn - Optional expiry time in milliseconds. Default: 15 minutes
 */
export async function generateUserToken(user: IUser, expiresIn?: number): Promise<string> {
  if (!user) {
    throw new Error('No user provided');
  }

  const expires = expiresIn ?? DEFAULT_SESSION_EXPIRY;

  return await signPayload({
    payload: {
      id: user._id,
      username: user.username,
      provider: user.provider,
      email: user.email,
      /** `iat` is whole seconds, too coarse to order this token against a password reset that
       * lands in the same second. `isTokenRetired` reads this claim to settle that exactly. */
      issuedAtMs: Date.now(),
    },
    secret: process.env.JWT_SECRET,
    expirationTime: expires / 1000,
  });
}

/**
 * The best `limit` of the users a search read (up to twice `limit`), by relevance to
 * `pattern`, without their score.
 */
export function rankUserSearchResults<T extends Pick<IUser, 'name' | 'email' | 'username'>>(
  users: T[],
  pattern: string,
  limit: number,
): T[] {
  const scoredUsers = users.map((user) => ({
    ...user,
    _searchScore: scoreSearchMatch([user.name, user.email, user.username], pattern),
  }));

  /** Top results sorted by relevance */
  return scoredUsers
    .sort((a, b) => b._searchScore - a._searchScore)
    .slice(0, limit)
    .map((user) => {
      const { _searchScore, ...userWithoutScore } = user;
      return userWithoutScore as unknown as T;
    });
}

/** The auth user document cache eviction of the user methods. */
export interface UserAuthDocEviction {
  /** Resolves false only when a cached document for the user may still be served. */
  invalidate(userId: string): Promise<boolean>;
  /**
   * The barrier a credential change passes before it is confirmed. A cached document without
   * the new credentialsChangedAt keeps pre-change access tokens verifying until it expires, so
   * eviction is retried and, when it still cannot remove every document, this resolves only
   * after the longest a cached document can live, which a lookup that began just before the
   * change may stretch to two cache TTLs. Callers revoke sessions and passkeys first: during the
   * wait those could otherwise mint access tokens issued after the stamp.
   */
  awaitEviction(userId: string): Promise<void>;
  /**
   * Evicts the cached documents of every user `userIds` yields (a terms reset), a batch at a
   * time, waiting out the cache TTL when an eviction failed. The eviction fence keeps requests
   * that read the old document from caching it, so only a failed eviction needs to outlast the
   * TTL.
   */
  evictEveryUser(userIds: AsyncIterable<string>): Promise<void>;
}

export function createUserAuthDocEviction(deps: UserMethodDeps): UserAuthDocEviction {
  const invalidate = (userId: string) => evictAuthUserDocsForUsers(deps.getCache, [userId]);
  const outlastCache = () =>
    (deps.delay ?? wait)(AUTH_USER_DOC_MAX_AGE_MS + AUTH_USER_DOC_EXPIRY_MARGIN_MS);

  return {
    invalidate,

    async awaitEviction(userId) {
      if (await invalidate(userId)) {
        return;
      }
      logger.warn(
        '[awaitAuthUserDocEviction] Cached auth documents were not evicted after a credential change; waiting for them to expire',
        { userId, waitMs: AUTH_USER_DOC_MAX_AGE_MS + AUTH_USER_DOC_EXPIRY_MARGIN_MS },
      );
      await outlastCache();
    },

    async evictEveryUser(userIds) {
      let evicted = true;
      let batch: string[] = [];
      for await (const userId of userIds) {
        batch.push(userId);
        if (batch.length === TERMS_RESET_EVICTION_BATCH) {
          evicted = (await evictAuthUserDocsForUsers(deps.getCache, batch)) && evicted;
          batch = [];
        }
      }
      evicted = (await evictAuthUserDocsForUsers(deps.getCache, batch)) && evicted;
      if (!evicted) {
        logger.warn(
          '[resetTermsAcceptance] Cached auth documents were not evicted; waiting for them to expire',
          {
            waitMs: AUTH_USER_DOC_MAX_AGE_MS + AUTH_USER_DOC_EXPIRY_MARGIN_MS,
          },
        );
        await outlastCache();
      }
    },
  };
}
