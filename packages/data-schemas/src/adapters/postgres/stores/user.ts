/**
 * The PostgreSQL `UserStore` (`~/ports/user`) on the `users` table, through the collection
 * primitive, with the rules of `~/methods/userRules` (email normalization, start balance, the
 * guarded writes' filters and updates, fence checks, the access token, search ranking, the auth
 * user document eviction). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Typed storage (docs/postgres-port/PHASE4.md §1.4): `backupCodes`, `pendingBackupCodes`,
 * `subagentAdmissionFences`, `favorites` and `refreshToken` are child tables; the search tokens
 * are element tables, kept by the primitive's collection hook on every insert and update;
 * `skillStates` (a `Map`) and `plugins` (an array of `Mixed`) are `json` columns, so the plugin
 * install and uninstall (`$addToSet`/`$pull`) run as the primitive's read-modify-write under the
 * row lock and concurrent requests never overwrite each other.
 *
 * - The guarded writes are the primitive's compare-and-set (§3.5): one `findOneAndUpdate` or
 *   `updateOne` whose filter is re-evaluated on the locked row, child-table conditions
 *   (`backupCodes` `$elemMatch`, the fence count `subagentAdmissionFences.31`, the live fence
 *   `$not $elemMatch`) in a new statement, so of two racing redemptions of one recovery code
 *   exactly one wins.
 * - `createUserIfAbsent` inserts the user and credits its start balance in one transaction, so
 *   the account is never visible without the balance (as MongoDB's order, balance first, keeps)
 *   and an insert a unique index rejects leaves no balance behind; validation runs before any
 *   write. MongoDB removes such a balance afterwards instead.
 * - `resetTermsAcceptance` evicts every user's cached documents by reading the user ids in
 *   keyset pages (`_id` order, 500 at a time), never holding a cursor across awaits (§4).
 * - Records come back lean, ids as 24-hex strings (R7); a created user is handed out without its
 *   search tokens, as the schema's `toObject` transform strips them on MongoDB.
 */
import { sql } from 'kysely';
import type {
  IUser,
  UserRecord,
  BalanceConfig,
  UserDeleteResult,
  CreateUserIfAbsentResult,
} from '~/types';
import type { CacheFactoryDeps } from '~/compose/types';
import type { StoreTransaction } from '~/ports/common';
import type { PostgresStoreContext } from './context';
import type { UserStore } from '~/ports/user';
import {
  assertValidDate,
  assertFenceToken,
  samlClaimFilter,
  samlClaimUpdate,
  generateUserToken,
  expiredFencePrune,
  userPluginsUpdate,
  startBalanceFields,
  TERMS_RESET_UPDATE,
  fenceCapacityFilter,
  userUpdateOperation,
  admissibleOwnerFilter,
  rankUserSearchResults,
  FENCE_CAPACITY_MESSAGE,
  termsAcceptanceClaims,
  PENDING_ACCOUNT_TTL_MS,
  unusedBackupCodeFilter,
  consumeBackupCodeUpdate,
  normalizeEmailInCriteria,
  staleDeletionFenceFilter,
  createUserAuthDocEviction,
  twoFactorEnrollmentFilter,
  twoFactorEnrollmentUpdate,
  TERMS_ACCEPTANCE_ATTEMPTS,
  TWO_FACTOR_ENROLLMENT_PROJECTION,
} from '~/methods/userRules';
import { buildUserSearchFilter, USER_SEARCH_TOKEN_FIELDS } from '~/utils/search';
import { asRecord, runStoreSql, storeWhere } from './context';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { valuesEqual } from '../evaluator/values';

/** User ids per keyset page of the terms-reset eviction sweep. */
const EVICTION_PAGE_SIZE = 500;

type UserRow = IUser & Record<string, unknown>;

/** The user without its search tokens (the schema's `toObject` transform). */
function withoutSearchTokens<T extends Record<string, unknown>>(record: T): T {
  const user = { ...record };
  for (const field of USER_SEARCH_TOKEN_FIELDS) {
    delete user[field.tokens];
  }
  return user;
}

/** The projection option of a read, when the caller selects fields. */
const selecting = (projection?: string | null) => (projection ? { projection } : {});

export function createPostgresUserStore(
  context: PostgresStoreContext,
  deps: CacheFactoryDeps = {},
): UserStore {
  const users = () => context.collections().collection<UserRow>('users');
  const eviction = createUserAuthDocEviction(deps);
  const invalidate = (userId: string) => eviction.invalidate(userId);

  /** Credits the user's start balance (insert-only, so an existing balance is kept). */
  async function creditStartBalance(
    userId: string,
    balanceConfig?: BalanceConfig,
    tx?: StoreTransaction,
  ): Promise<void> {
    const initial = startBalanceFields(balanceConfig);
    if (!initial) {
      return;
    }
    await context
      .collections()
      .collection('balances')
      .updateOne(
        { _id: userId },
        { $setOnInsert: { ...initial, user: userId } },
        { upsert: true, tx },
      );
  }

  /** The user's id when it exists (after a guarded write matched nothing). */
  const exists = async (userId: string) => (await users().exists({ _id: userId })) != null;

  /** `'acquired'` when the fence write took, otherwise whether the user exists. */
  async function fenceOutcome(
    userId: string,
    modifiedCount: number,
  ): Promise<'acquired' | 'in_progress' | 'missing'> {
    if (modifiedCount === 1) {
      await invalidate(userId);
      return 'acquired';
    }
    return (await exists(userId)) ? 'in_progress' : 'missing';
  }

  /**
   * `write` (in a transaction) only while the user matching `filter` still holds exactly
   * `pendingBackupCodes`, the snapshot a two-factor step guards on. The query language cannot
   * compare a subdocument array with an array (MongoDB's exact, order-sensitive equality), so:
   * the user row is locked while the column part of the guard holds (hand-written `SELECT ...
   * FOR UPDATE`, which reads no child rows, §3.5), its codes are read in the next statement and
   * compared with MongoDB's equality (the evaluator's `valuesEqual`: elements, keys and their
   * order), and `write` re-evaluates `filter` on the locked row. Every write of the child rows
   * locks the user row first, so they cannot change in between.
   */
  async function guardedBySnapshot(
    filter: Record<string, unknown>,
    pendingBackupCodes: unknown,
    write: (tx: StoreTransaction | undefined) => Promise<UserRow | null>,
  ): Promise<UserRow | null> {
    return context.transactions.transaction(async (tx) => {
      const locked = await runStoreSql<{ _id: string }>(
        context,
        sql`SELECT t._id FROM users t WHERE ${storeWhere(context, 'users', filter, {
          operation: 'findOneAndUpdate',
        })} FOR UPDATE`,
        tx,
      );
      const userId = locked.rows[0]?._id;
      if (userId === undefined) {
        return null;
      }
      const current = await users().findOne(
        { _id: userId },
        { projection: 'pendingBackupCodes', tx },
      );
      if (!current || !valuesEqual(current.pendingBackupCodes, pendingBackupCodes)) {
        return null;
      }
      return await write(tx);
    });
  }

  /** Every user id, in `_id` order, by keyset pages. */
  async function* everyUserId(): AsyncGenerator<string> {
    let after: string | undefined;
    for (;;) {
      const page = await users().find(after === undefined ? {} : { _id: { $gt: after } }, {
        projection: '_id',
        sort: { _id: 1 },
        limit: EVICTION_PAGE_SIZE,
      });
      for (const user of page) {
        yield String(user._id);
      }
      if (page.length < EVICTION_PAGE_SIZE) {
        return;
      }
      after = String(page[page.length - 1]._id);
    }
  }

  const store: UserStore = {
    async findUser(filter, projection) {
      return await users().findOne(normalizeEmailInCriteria(filter), selecting(projection));
    },

    async findUsers(filter, projection, options) {
      return await users().find(normalizeEmailInCriteria(filter), {
        ...selecting(projection),
        ...(options?.sort != null ? { sort: options.sort } : {}),
        ...(options?.offset != null ? { skip: options.offset } : {}),
        ...(options?.limit != null && options.limit > 0 ? { limit: options.limit } : {}),
      });
    },

    async findOwnerContactUsers(ownerIds) {
      if (ownerIds.length === 0) {
        return [];
      }
      return await users().find({ _id: { $in: ownerIds } }, { projection: '_id name username' });
    },

    async countUsers(filter = {}) {
      return await users().count(filter);
    },

    async createUser(data, balanceConfig, disableTTL = true, returnUser = false) {
      const userData: Partial<IUser> = {
        ...data,
        expiresAt: disableTTL ? undefined : new Date(Date.now() + PENDING_ACCOUNT_TTL_MS),
      };
      if (disableTTL) {
        delete userData.expiresAt;
      }
      const user = await users().insertOne(asRecord(userData));
      await creditStartBalance(String(user._id), balanceConfig);
      if (returnUser) {
        return withoutSearchTokens(user) as Partial<IUser>;
      }
      return String(user._id);
    },

    async createUserIfAbsent(data, balanceConfig): Promise<CreateUserIfAbsentResult> {
      const userData: Partial<IUser> = { ...data };
      delete userData.expiresAt;
      try {
        const user = await context.transactions.transaction(async (tx) => {
          const inserted = await users().insertOne(asRecord(userData), { tx });
          await creditStartBalance(String(inserted._id), balanceConfig, tx);
          return inserted;
        });
        return { ok: true, value: withoutSearchTokens(user) as unknown as UserRecord };
      } catch (error) {
        if (error instanceof StoreDuplicateKeyError) {
          return { ok: false, error: { code: 'user_exists' } };
        }
        throw error;
      }
    },

    async updateUser(userId, updateData, expectedState = {}, options = {}) {
      const updated = await users().findOneAndUpdate(
        { ...expectedState, _id: userId },
        asRecord(userUpdateOperation(updateData, options)),
        { returnDocument: 'after', runValidators: true },
      );
      await invalidate(userId);
      return updated;
    },

    async awaitAuthUserDocEviction(userId) {
      await eviction.awaitEviction(userId);
    },

    async consumeBackupCode(userId, codeHash) {
      const result = await users().updateOne(
        unusedBackupCodeFilter(userId, codeHash),
        consumeBackupCodeUpdate(),
      );
      if (result.modifiedCount !== 1) {
        return false;
      }
      await invalidate(userId);
      return true;
    },

    async claimSamlIdentity(userId, samlId, profileData) {
      const updated = await users().findOneAndUpdate(
        samlClaimFilter(userId, samlId),
        samlClaimUpdate(samlId, profileData),
        { returnDocument: 'after', runValidators: true },
      );
      if (updated) {
        await invalidate(userId);
      }
      return updated;
    },

    async updateTwoFactorEnrollment(userId, guard, updateData) {
      const { pendingBackupCodes, ...columnGuard } = guard;
      const filter = twoFactorEnrollmentFilter(userId, columnGuard);
      const update = twoFactorEnrollmentUpdate(updateData);
      const options = {
        returnDocument: 'after' as const,
        runValidators: true,
        projection: TWO_FACTOR_ENROLLMENT_PROJECTION,
      };
      const updated =
        pendingBackupCodes === undefined
          ? await users().findOneAndUpdate(filter, update, options)
          : await guardedBySnapshot(filter, pendingBackupCodes, (tx) =>
              users().findOneAndUpdate(filter, update, { ...options, tx }),
            );
      if (updated) {
        await invalidate(userId);
      }
      return updated;
    },

    async acceptTerms(userId) {
      for (let attempt = 0; attempt < TERMS_ACCEPTANCE_ATTEMPTS; attempt++) {
        const claims = termsAcceptanceClaims(userId);
        const firstAcceptance = await users().findOneAndUpdate(
          claims.first.filter,
          claims.first.update,
          { returnDocument: 'after', runValidators: true },
        );
        if (firstAcceptance) {
          await invalidate(userId);
          return firstAcceptance;
        }
        const reacceptance = await users().findOneAndUpdate(
          claims.repeat.filter,
          claims.repeat.update,
          { returnDocument: 'after', runValidators: true },
        );
        if (reacceptance) {
          await invalidate(userId);
          return reacceptance;
        }
        if (!(await exists(userId))) {
          return null;
        }
      }
      return null;
    },

    async resetTermsAcceptance() {
      const result = await users().updateMany({}, TERMS_RESET_UPDATE);
      /** Every user, not only those read as accepted beforehand: an acceptance racing the update may be cached. */
      await eviction.evictEveryUser(everyUserId());
      return { modifiedCount: result.modifiedCount };
    },

    async searchUsers({ searchPattern, limit = 20, fieldsToSelect = null }) {
      if (!searchPattern || searchPattern.trim().length === 0) {
        return [];
      }
      const trimmedPattern = searchPattern.trim();
      const filter = buildUserSearchFilter(trimmedPattern);
      if (!filter) {
        return [];
      }
      /** More results than asked for, to allow for relevance sorting. */
      const found = await users().find(filter, {
        limit: limit * 2,
        ...selecting(fieldsToSelect),
      });
      return rankUserSearchResults(found, trimmedPattern, limit) as unknown as UserRecord[];
    },

    async getUserById(userId, projection) {
      return await users().findOne({ _id: userId }, selecting(projection));
    },

    generateToken: generateUserToken,

    async beginAgentTriggerUserDeletion(userId, startedAt) {
      assertValidDate(startedAt, 'startedAt');
      const result = await users().updateOne(
        { _id: userId, agentTriggerDeletionStartedAt: { $exists: false } },
        { $set: { agentTriggerDeletionStartedAt: startedAt } },
      );
      return await fenceOutcome(userId, result.modifiedCount);
    },

    async recoverStaleAgentTriggerUserDeletion(userId, recoveredAt) {
      assertValidDate(recoveredAt, 'recoveredAt');
      const result = await users().updateOne(staleDeletionFenceFilter(userId, recoveredAt), {
        $set: { agentTriggerDeletionStartedAt: recoveredAt },
      });
      return await fenceOutcome(userId, result.modifiedCount);
    },

    async cancelAgentTriggerUserDeletion(userId, startedAt) {
      const result = await users().updateOne(
        { _id: userId, agentTriggerDeletionStartedAt: startedAt },
        { $unset: { agentTriggerDeletionStartedAt: 1 } },
      );
      if (result.modifiedCount === 1) {
        await invalidate(userId);
        return true;
      }
      return false;
    },

    async isAgentTriggerPrincipalActive(userId) {
      return (
        (await users().exists({
          _id: userId,
          agentTriggerDeletionStartedAt: { $exists: false },
        })) != null
      );
    },

    async fenceSubagentAdmission(userId, token, fencedUntil) {
      assertValidDate(fencedUntil, 'fencedUntil');
      assertFenceToken(token);
      await users().updateOne({ _id: userId }, expiredFencePrune(), { timestamps: false });
      try {
        /** Admitted only while the owner is under the concurrent-deletion cap. Dropping an
         * active fence to make room would reopen admission for a deletion that is still
         * running, so an excess deletion is refused instead. */
        const fenced = await users().updateOne(
          fenceCapacityFilter(userId),
          { $push: { subagentAdmissionFences: { token, expiresAt: fencedUntil } } },
          { timestamps: false },
        );
        if (fenced.matchedCount !== 1) {
          throw new Error(FENCE_CAPACITY_MESSAGE);
        }
      } finally {
        /** The prune above commits on its own, so a refused or failed fence still leaves the
         * cached document describing entries the table no longer holds. */
        await invalidate(userId);
      }
    },

    async renewSubagentAdmission(userId, token, fencedUntil) {
      assertValidDate(fencedUntil, 'fencedUntil');
      const result = await users().updateOne(
        { _id: userId, 'subagentAdmissionFences.token': token },
        { $set: { 'subagentAdmissionFences.$.expiresAt': fencedUntil } },
        { timestamps: false },
      );
      if (result.modifiedCount === 1) {
        await invalidate(userId);
      }
      return result.matchedCount === 1;
    },

    async releaseSubagentAdmission(userId, token) {
      const result = await users().updateOne(
        { _id: userId },
        { $pull: { subagentAdmissionFences: { token } } },
        { timestamps: false },
      );
      if (result.modifiedCount === 1) {
        await invalidate(userId);
      }
    },

    async isSubagentOwnerAdmissible(userId) {
      return (await users().exists(admissibleOwnerFilter(userId))) != null;
    },

    async deleteUserById(userId): Promise<UserDeleteResult> {
      try {
        await context.collections().collection('toolapprovalgrants').deleteMany({ user: userId });
        const result = await users().deleteOne({ _id: userId });
        if (result.deletedCount === 0) {
          return { deletedCount: 0, message: 'No user found with that ID.' };
        }
        await invalidate(userId);
        return { deletedCount: result.deletedCount, message: 'User was deleted successfully.' };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error('Error deleting user: ' + errorMessage);
      }
    },

    async updateUserPlugins(userId, _plugins, pluginKey, action) {
      const update = userPluginsUpdate(pluginKey, action);
      if (!update) {
        return null;
      }
      const updated = await users().findOneAndUpdate({ _id: userId }, update, {
        returnDocument: 'after',
        runValidators: true,
      });
      await invalidate(userId);
      return updated;
    },

    async toggleUserMemories(userId, memoriesEnabled) {
      /** `$set` on the nested path creates `personalization` when missing; a missing user yields null. */
      const updated = await users().findOneAndUpdate(
        { _id: userId },
        { $set: { 'personalization.memories': memoriesEnabled } },
        { returnDocument: 'after', runValidators: true },
      );
      if (updated) {
        await invalidate(userId);
      }
      return updated;
    },

    async updateUserStatefulCodeEnvironment(userId, environment) {
      const updated = await users().findOneAndUpdate(
        { _id: userId },
        { $set: { 'personalization.statefulCodeEnvironment': environment } },
        { returnDocument: 'after', runValidators: true },
      );
      if (updated) {
        await invalidate(userId);
      }
      return updated;
    },
  };
  return store;
}
