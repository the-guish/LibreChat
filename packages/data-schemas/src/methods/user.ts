import mongoose, { FilterQuery } from 'mongoose';
import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import type {
  IUser,
  BalanceConfig,
  CreateUserRequest,
  UserRecord,
  NewUserData,
  UserDeleteResult,
  CreateUserIfAbsentResult,
} from '~/types';
import type { TwoFactorEnrollmentGuard, TwoFactorEnrollmentUpdate } from '~/types';
import type { UserMethodDeps } from './userRules';
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
} from './userRules';
import { buildUserSearchFilter } from '~/utils/search';
import logger from '~/config/winston';

export { DEFAULT_SESSION_EXPIRY, USER_DELETION_FENCE_STALE_MS } from './userRules';

/** Factory function that takes mongoose instance and returns the methods */
export function createUserMethods(
  mongoose: typeof import('mongoose'),
  deps: UserMethodDeps = {},
): {
  findUser: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IUser | null>;
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  findOwnerContactUsers: (
    ownerIds: string[],
  ) => Promise<Array<Pick<IUser, '_id' | 'name' | 'username'>>>;
  countUsers: (filter?: FilterQuery<IUser>) => Promise<number>;
  createUser: (
    data: CreateUserRequest,
    balanceConfig?: BalanceConfig,
    disableTTL?: boolean,
    returnUser?: boolean,
  ) => Promise<mongoose.Types.ObjectId | Partial<IUser>>;
  createUserIfAbsent: (
    data: NewUserData,
    balanceConfig?: BalanceConfig,
  ) => Promise<CreateUserIfAbsentResult>;
  updateUser: (
    userId: string,
    updateData: Partial<IUser>,
    expectedState?: FilterQuery<IUser>,
    options?: { preserveExpiresAt?: boolean },
  ) => Promise<IUser | null>;
  awaitAuthUserDocEviction: (userId: string) => Promise<void>;
  consumeBackupCode: (userId: string, codeHash: string) => Promise<boolean>;
  claimSamlIdentity: (
    userId: string,
    samlId: string,
    profileData: Pick<Partial<IUser>, 'username' | 'name'>,
  ) => Promise<IUser | null>;
  updateTwoFactorEnrollment: (
    userId: string,
    guard: TwoFactorEnrollmentGuard,
    updateData: TwoFactorEnrollmentUpdate,
  ) => Promise<IUser | null>;
  acceptTerms: (userId: string) => Promise<IUser | null>;
  resetTermsAcceptance: () => Promise<{ modifiedCount: number }>;
  searchUsers: ({
    searchPattern,
    limit,
    fieldsToSelect,
  }: {
    searchPattern: string;
    limit?: number;
    fieldsToSelect?: string | string[] | null;
  }) => Promise<
    {
      _id: mongoose.Types.ObjectId;
      id: string;
      name?: string;
      username?: string;
      email: string;
      emailVerified: boolean;
      password?: string;
      avatar?: string;
      provider: string;
      role?: string;
      googleId?: string;
      facebookId?: string;
      openidId?: string;
      samlId?: string;
      ldapId?: string;
      githubId?: string;
      discordId?: string;
      appleId?: string;
      plugins?: string[];
      openidIssuer?: string;
      twoFactorEnabled?: boolean;
      totpSecret?: string;
      backupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      pendingTotpSecret?: string;
      pendingBackupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      twoFactorAcknowledgementNonceHash?: string | null;
      twoFactorFinalizationNonceHash?: string | null;
      refreshToken?: Array<{
        refreshToken: string;
      }>;
      expiresAt?: Date;
      termsAccepted?: boolean;
      personalization?: {
        memories?: boolean;
        statefulCodeEnvironment?: import('librechat-data-provider').StatefulCodeEnvironment;
      };
      favorites?: import('librechat-data-provider').TUserFavorite[];
      skillStates?: Record<string, boolean>;
      createdAt?: Date;
      updatedAt?: Date;
      idOnTheSource?: string;
      tenantId?: string;
      federatedTokens?: import('~/types').OIDCTokens;
      openidTokens?: import('~/types').OIDCTokens;
      $locals: Record<string, unknown>;
      $op: 'save' | 'validate' | 'remove' | null;
      $where: Record<string, unknown>;
      baseModelName?: string;
      collection: mongoose.Collection;
      db: mongoose.Connection;
      errors?: mongoose.Error.ValidationError;
      isNew: boolean;
      schema: mongoose.Schema;
    }[]
  >;
  getUserById: (userId: string, fieldsToSelect?: string | string[] | null) => Promise<IUser | null>;
  generateToken: (user: IUser, expiresIn?: number) => Promise<string>;
  beginAgentTriggerUserDeletion: (
    userId: string,
    startedAt: Date,
  ) => Promise<'acquired' | 'in_progress' | 'missing'>;
  recoverStaleAgentTriggerUserDeletion: (
    userId: string,
    recoveredAt: Date,
  ) => Promise<'acquired' | 'in_progress' | 'missing'>;
  cancelAgentTriggerUserDeletion: (userId: string, startedAt: Date) => Promise<boolean>;
  isAgentTriggerPrincipalActive: (userId: string) => Promise<boolean>;
  fenceSubagentAdmission: (userId: string, token: string, fencedUntil: Date) => Promise<void>;
  renewSubagentAdmission: (userId: string, token: string, fencedUntil: Date) => Promise<boolean>;
  releaseSubagentAdmission: (userId: string, token: string) => Promise<void>;
  isSubagentOwnerAdmissible: (userId: string) => Promise<boolean>;
  deleteUserById: (userId: string) => Promise<UserDeleteResult>;
  updateUserPlugins: (
    userId: string,
    plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ) => Promise<IUser | null>;
  toggleUserMemories: (userId: string, memoriesEnabled: boolean) => Promise<IUser | null>;
  updateUserStatefulCodeEnvironment: (
    userId: string,
    environment: StatefulCodeEnvironment,
  ) => Promise<IUser | null>;
} {
  const eviction = createUserAuthDocEviction(deps);

  /**
   * Search for a single user based on partial data and return matching user document as plain object.
   * Email fields in searchCriteria are automatically normalized to lowercase for case-insensitive matching.
   */
  async function findUser(
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ): Promise<IUser | null> {
    const User = mongoose.models.User as mongoose.Model<IUser>;
    const normalizedCriteria = normalizeEmailInCriteria(searchCriteria);
    const query = User.findOne(normalizedCriteria);
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    return await query.lean<IUser>();
  }

  async function findUsers(
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ): Promise<IUser[]> {
    const User = mongoose.models.User as mongoose.Model<IUser>;
    const normalizedCriteria = normalizeEmailInCriteria(searchCriteria);
    const query = User.find(normalizedCriteria);
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    if (options?.sort != null) {
      query.sort(options.sort);
    }
    if (options?.offset != null) {
      query.skip(options.offset);
    }
    if (options?.limit != null && options.limit > 0) {
      query.limit(options.limit);
    }
    return await query.lean<IUser[]>();
  }
  async function findOwnerContactUsers(
    ownerIds: string[],
  ): Promise<Array<Pick<IUser, '_id' | 'name' | 'username'>>> {
    if (ownerIds.length === 0) {
      return [];
    }

    const User = mongoose.models.User as mongoose.Model<IUser>;
    const objectIds = ownerIds.map((ownerId) => new mongoose.Types.ObjectId(ownerId));
    return await User.find({ _id: { $in: objectIds } })
      .select('_id name username')
      .lean<Array<Pick<IUser, '_id' | 'name' | 'username'>>>();
  }

  /**
   * Count the number of user documents in the collection based on the provided filter.
   */
  async function countUsers(filter: FilterQuery<IUser> = {}): Promise<number> {
    const User = mongoose.models.User;
    return await User.countDocuments(filter);
  }

  /**
   * Initializes a new user's start balance, with auto-refill settings when complete. The write is
   * insert-only, so it never replaces a balance that already exists or the activity recorded on it.
   */
  async function creditStartBalance(
    userId: mongoose.Types.ObjectId,
    balanceConfig?: BalanceConfig,
  ): Promise<void> {
    const initial = startBalanceFields(balanceConfig);
    if (!initial) {
      return;
    }

    const Balance = mongoose.models.Balance;
    await Balance.findOneAndUpdate(
      { _id: userId },
      { $setOnInsert: { ...initial, user: userId } },
      { upsert: true, new: true },
    ).lean();
  }

  /**
   * Creates a new user, optionally with a TTL of 1 week.
   */
  async function createUser(
    data: CreateUserRequest,
    balanceConfig?: BalanceConfig,
    disableTTL: boolean = true,
    returnUser: boolean = false,
  ): Promise<mongoose.Types.ObjectId | Partial<IUser>> {
    const User = mongoose.models.User;

    const userData: Partial<IUser> = {
      ...data,
      expiresAt: disableTTL ? undefined : new Date(Date.now() + PENDING_ACCOUNT_TTL_MS),
    };

    if (disableTTL) {
      delete userData.expiresAt;
    }

    const user = await User.create(userData);
    await creditStartBalance(user._id, balanceConfig);

    if (returnUser) {
      return user.toObject() as Partial<IUser>;
    }
    return user._id as mongoose.Types.ObjectId;
  }

  /**
   * Creates a user without a TTL, or reports `user_exists` when a unique email or provider
   * identity index already holds the account, as when concurrent first logins race to insert it.
   * The start balance is initialized under the new user's id before the user is inserted, so
   * the account is never visible without it and login balance sync never initializes it first.
   * A balance write that fails, or an insert a unique index rejects, removes the balance under
   * the id that never became a user; any other insert failure keeps it, since an unacknowledged
   * insert may still have committed.
   */
  async function createUserIfAbsent(
    data: NewUserData,
    balanceConfig?: BalanceConfig,
  ): Promise<CreateUserIfAbsentResult> {
    const User = mongoose.models.User as mongoose.Model<IUser>;
    const userData: Partial<IUser> = { ...data };
    delete userData.expiresAt;

    const user = new User(userData);
    await user.validate();
    try {
      await creditStartBalance(user._id, balanceConfig);
    } catch (error) {
      await discardStartBalance(user._id, balanceConfig);
      throw error;
    }

    try {
      await user.save({ validateBeforeSave: false });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }
      await discardStartBalance(user._id, balanceConfig);
      return { ok: false, error: { code: 'user_exists' } };
    }

    return { ok: true, value: user.toObject() as UserRecord };
  }

  /** Removes, best effort, the start balance initialized for an id that never became a user. */
  async function discardStartBalance(
    userId: mongoose.Types.ObjectId,
    balanceConfig?: BalanceConfig,
  ): Promise<void> {
    if (!balanceConfig?.enabled || !balanceConfig?.startBalance) {
      return;
    }
    try {
      await mongoose.models.Balance.deleteOne({ _id: userId });
    } catch {
      logger.warn(
        '[createUserIfAbsent] Could not remove the start balance of a user never created',
        {
          userId: userId.toString(),
        },
      );
    }
  }

  /**
   * Update a user with new data without overwriting existing properties.
   * Removes pending-account expiry unless preserveExpiresAt is requested.
   */
  async function updateUser(
    userId: string,
    updateData: Partial<IUser>,
    expectedState: FilterQuery<IUser> = {},
    options: { preserveExpiresAt?: boolean } = {},
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updateOperation = userUpdateOperation(updateData, options);
    const updated = await User.findOneAndUpdate(
      { ...expectedState, _id: userId },
      updateOperation,
      {
        new: true,
        runValidators: true,
      },
    ).lean<IUser>();
    await invalidateAuthUserDocCache(userId);
    return updated;
  }

  /**
   * The barrier a credential change passes before it is confirmed. A cached document without
   * the new credentialsChangedAt keeps pre-change access tokens verifying until it expires, so
   * eviction is retried and, when it still cannot remove every document, this resolves only
   * after the longest a cached document can live, which a lookup that began just before the
   * change may stretch to two cache TTLs. Callers revoke sessions and passkeys first: during the wait those
   * could otherwise mint access tokens issued after the stamp.
   */
  async function awaitAuthUserDocEviction(userId: string): Promise<void> {
    await eviction.awaitEviction(userId);
  }

  /** Only the request that atomically consumes an unused recovery code may authenticate. */
  async function consumeBackupCode(userId: string, codeHash: string): Promise<boolean> {
    const result = await mongoose.models.User.updateOne(
      unusedBackupCodeFilter(userId, codeHash),
      consumeBackupCodeUpdate(),
    );
    if (result.modifiedCount !== 1) {
      return false;
    }
    await invalidateAuthUserDocCache(userId);
    return true;
  }

  /** Atomically updates a SAML user only when the incoming identity can claim the document. */
  async function claimSamlIdentity(
    userId: string,
    samlId: string,
    profileData: Pick<Partial<IUser>, 'username' | 'name'>,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updated = await User.findOneAndUpdate(
      samlClaimFilter(userId, samlId),
      samlClaimUpdate(samlId, profileData),
      { new: true, runValidators: true },
    ).lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  /**
   * Single compare-and-swap for every step of required two-factor enrollment. The filter always
   * pins the user to an unenrolled, policy-eligible provider, and `guard` adds the exact pending
   * secret, pending backup-code snapshot, or one-time nonce hash the caller observed. A step whose
   * predicate has moved returns `null` instead of writing.
   */
  async function updateTwoFactorEnrollment(
    userId: string,
    guard: TwoFactorEnrollmentGuard,
    updateData: TwoFactorEnrollmentUpdate,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updated = await User.findOneAndUpdate(
      twoFactorEnrollmentFilter(userId, guard),
      twoFactorEnrollmentUpdate(updateData),
      { new: true, runValidators: true },
    )
      .select(TWO_FACTOR_ENROLLMENT_PROJECTION)
      .lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  /** Resolves false only when a cached document for the user may still be served. */
  async function invalidateAuthUserDocCache(userId: string): Promise<boolean> {
    return eviction.invalidate(userId);
  }

  /**
   * Atomically records terms acceptance for a user.
   * A null-guarded claim stamps termsAcceptedAt only when no timestamp is
   * already stored (explicit null from the schema default, a missing legacy
   * field, or a terms reset), so the first acceptance within a terms cycle is
   * preserved across concurrent or repeated requests. The repeat-acceptance
   * fallback is guarded by the exact complement (a non-null timestamp) so it
   * can never resurrect termsAccepted into a cycle that config/reset-terms.js
   * started between the two updates; when both guards miss because a reset
   * raced in, the claim retries and records a fresh stamped acceptance. Plain
   * updates are used instead of an aggregation pipeline with $$NOW, which
   * Amazon DocumentDB rejects.
   */
  /** Withdraws every user's acceptance and evicts their cached auth documents, so a reset takes effect at once. */
  async function resetTermsAcceptance(): Promise<{ modifiedCount: number }> {
    const User = mongoose.models.User;
    const result = await User.updateMany({}, TERMS_RESET_UPDATE);
    /** Every user, not only those read as accepted beforehand: an acceptance racing the update may be cached. */
    const cursor = User.find({}).select('_id').lean().cursor();
    async function* userIds(): AsyncGenerator<string> {
      for await (const user of cursor) {
        yield String(user._id);
      }
    }
    await eviction.evictEveryUser(userIds());
    return { modifiedCount: result.modifiedCount };
  }

  async function acceptTerms(userId: string): Promise<IUser | null> {
    const User = mongoose.models.User;
    for (let attempt = 0; attempt < TERMS_ACCEPTANCE_ATTEMPTS; attempt++) {
      const claims = termsAcceptanceClaims(userId);
      const firstAcceptance = await User.findOneAndUpdate(
        claims.first.filter,
        claims.first.update,
        { new: true, runValidators: true },
      ).lean<IUser>();
      if (firstAcceptance) {
        await invalidateAuthUserDocCache(userId);
        return firstAcceptance;
      }
      const reacceptance = await User.findOneAndUpdate(claims.repeat.filter, claims.repeat.update, {
        new: true,
        runValidators: true,
      }).lean<IUser>();
      if (reacceptance) {
        await invalidateAuthUserDocCache(userId);
        return reacceptance;
      }
      const exists = await User.exists({ _id: userId });
      if (!exists) {
        return null;
      }
    }
    return null;
  }

  /**
   * Retrieve a user by ID and convert the found user document to a plain object.
   */
  async function getUserById(
    userId: string,
    fieldsToSelect?: string | string[] | null,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const query = User.findById(userId);
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    return await query.lean<IUser>();
  }

  /**
   * Delete a user by their unique ID.
   */
  async function deleteUserById(userId: string): Promise<UserDeleteResult> {
    try {
      const User = mongoose.models.User;
      await mongoose.models.ToolApprovalGrant?.deleteMany({ user: userId });
      const result = await User.deleteOne({ _id: userId });
      if (result.deletedCount === 0) {
        return { deletedCount: 0, message: 'No user found with that ID.' };
      }
      await invalidateAuthUserDocCache(userId);
      return { deletedCount: result.deletedCount, message: 'User was deleted successfully.' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error('Error deleting user: ' + errorMessage);
    }
  }

  /** Establishes the durable admission fence used while account deletion drains triggers. */
  async function beginAgentTriggerUserDeletion(
    userId: string,
    startedAt: Date,
  ): Promise<'acquired' | 'in_progress' | 'missing'> {
    assertValidDate(startedAt, 'startedAt');
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId, agentTriggerDeletionStartedAt: { $exists: false } },
      { $set: { agentTriggerDeletionStartedAt: startedAt } },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
      return 'acquired';
    }
    return (await User.exists({ _id: userId })) == null ? 'missing' : 'in_progress';
  }

  /** Replaces an abandoned fence only for an operator-confirmed offline deployment.
   * Normal request paths must never call this: age alone cannot prove the prior owner died. */
  async function recoverStaleAgentTriggerUserDeletion(
    userId: string,
    recoveredAt: Date,
  ): Promise<'acquired' | 'in_progress' | 'missing'> {
    assertValidDate(recoveredAt, 'recoveredAt');
    const User = mongoose.models.User;
    const result = await User.updateOne(staleDeletionFenceFilter(userId, recoveredAt), {
      $set: { agentTriggerDeletionStartedAt: recoveredAt },
    });
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
      return 'acquired';
    }
    return (await User.exists({ _id: userId })) == null ? 'missing' : 'in_progress';
  }

  /** Releases only the account-deletion attempt that owns this exact fence. */
  async function cancelAgentTriggerUserDeletion(userId: string, startedAt: Date): Promise<boolean> {
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId, agentTriggerDeletionStartedAt: startedAt },
      { $unset: { agentTriggerDeletionStartedAt: 1 } },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
      return true;
    }
    return false;
  }

  async function isAgentTriggerPrincipalActive(userId: string): Promise<boolean> {
    const User = mongoose.models.User;
    return (
      (await User.exists({ _id: userId, agentTriggerDeletionStartedAt: { $exists: false } })) !=
      null
    );
  }

  /**
   * Closes subagent admission for one owner while a bulk conversation deletion drains
   * its live children. Every concurrent deletion holds its own fence, so admission
   * reopens only once the last one finishes, in whatever order they complete. Each
   * fence expires on its own, so a process that dies mid-delete cannot lock the
   * account out of running subagents, and expired fences are pruned as new ones
   * arrive rather than accumulating.
   */
  async function fenceSubagentAdmission(
    userId: string,
    token: string,
    fencedUntil: Date,
  ): Promise<void> {
    assertValidDate(fencedUntil, 'fencedUntil');
    assertFenceToken(token);
    const User = mongoose.models.User;
    /** Plain update operators only: DocumentDB rejects pipeline-form updates, and
     * this runs before any deletion, so using one would fail the whole endpoint. */
    await User.updateOne({ _id: userId }, expiredFencePrune(), { timestamps: false });
    try {
      /** Admitted only while the owner is under the concurrent-deletion cap. Dropping
       * an active fence to make room would reopen admission for a deletion that is
       * still running, so an excess deletion is refused instead. */
      const fenced = await User.updateOne(
        fenceCapacityFilter(userId),
        { $push: { subagentAdmissionFences: { token, expiresAt: fencedUntil } } },
        { timestamps: false },
      );
      if (fenced.matchedCount !== 1) {
        throw new Error(FENCE_CAPACITY_MESSAGE);
      }
    } finally {
      /** The prune above commits on its own, so a refused or failed fence still leaves
       * the cached document describing entries the collection no longer holds. */
      await invalidateAuthUserDocCache(userId);
    }
  }

  /** Extends only this deletion's own fence while its work is still running. */
  async function renewSubagentAdmission(
    userId: string,
    token: string,
    fencedUntil: Date,
  ): Promise<boolean> {
    assertValidDate(fencedUntil, 'fencedUntil');
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId, 'subagentAdmissionFences.token': token },
      { $set: { 'subagentAdmissionFences.$.expiresAt': fencedUntil } },
      { timestamps: false },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
    }
    return result.matchedCount === 1;
  }

  /** Lifts only this deletion's fence, so an overlapping one keeps admission closed. */
  async function releaseSubagentAdmission(userId: string, token: string): Promise<void> {
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId },
      { $pull: { subagentAdmissionFences: { token } } },
      { timestamps: false },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
    }
  }

  /** True while this owner may admit a new child: no account deletion, no live fence. */
  async function isSubagentOwnerAdmissible(userId: string): Promise<boolean> {
    const User = mongoose.models.User;
    return (await User.exists(admissibleOwnerFilter(userId))) != null;
  }

  /**
   * Generates a JWT token for a given user.
   * @param user - The user object
   * @param expiresIn - Optional expiry time in milliseconds. Default: 15 minutes
   */
  async function generateToken(user: IUser, expiresIn?: number): Promise<string> {
    return generateUserToken(user, expiresIn);
  }

  /**
   * Update a user's personalization memories setting.
   * Handles the edge case where the personalization object doesn't exist.
   */
  async function toggleUserMemories(
    userId: string,
    memoriesEnabled: boolean,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;

    /** `$set` on the nested path creates `personalization` when missing; a missing user yields null. */
    const updateOperation = {
      $set: {
        'personalization.memories': memoriesEnabled,
      },
    };

    const updated = await User.findByIdAndUpdate(userId, updateOperation, {
      new: true,
      runValidators: true,
    }).lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  async function updateUserStatefulCodeEnvironment(
    userId: string,
    environment: StatefulCodeEnvironment,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { 'personalization.statefulCodeEnvironment': environment } },
      { new: true, runValidators: true },
    ).lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  /**
   * Search for users by word prefix of name, email, or username (see `buildUserSearchFilter`)
   * @param searchPattern - The pattern to search for
   * @param limit - Maximum number of results to return
   * @param fieldsToSelect - The fields to include or exclude in the returned documents
   * @returns Array of matching user documents
   */
  const searchUsers = async function ({
    searchPattern,
    limit = 20,
    fieldsToSelect = null,
  }: {
    searchPattern: string;
    limit?: number;
    fieldsToSelect?: string | string[] | null;
  }): Promise<
    {
      _id: mongoose.Types.ObjectId;
      id: string;
      name?: string;
      username?: string;
      email: string;
      emailVerified: boolean;
      password?: string;
      avatar?: string;
      provider: string;
      role?: string;
      googleId?: string;
      facebookId?: string;
      openidId?: string;
      samlId?: string;
      ldapId?: string;
      githubId?: string;
      discordId?: string;
      appleId?: string;
      plugins?: string[];
      openidIssuer?: string;
      twoFactorEnabled?: boolean;
      totpSecret?: string;
      backupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      pendingTotpSecret?: string;
      pendingBackupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      twoFactorAcknowledgementNonceHash?: string | null;
      twoFactorFinalizationNonceHash?: string | null;
      refreshToken?: Array<{
        refreshToken: string;
      }>;
      expiresAt?: Date;
      termsAccepted?: boolean;
      personalization?: {
        memories?: boolean;
        statefulCodeEnvironment?: import('librechat-data-provider').StatefulCodeEnvironment;
      };
      favorites?: import('librechat-data-provider').TUserFavorite[];
      skillStates?: Record<string, boolean>;
      createdAt?: Date;
      updatedAt?: Date;
      idOnTheSource?: string;
      tenantId?: string;
      federatedTokens?: import('~/types').OIDCTokens;
      openidTokens?: import('~/types').OIDCTokens;
      $locals: Record<string, unknown>;
      $op: 'save' | 'validate' | 'remove' | null;
      $where: Record<string, unknown>;
      baseModelName?: string;
      collection: mongoose.Collection;
      db: mongoose.Connection;
      errors?: mongoose.Error.ValidationError;
      isNew: boolean;
      schema: mongoose.Schema;
    }[]
  > {
    if (!searchPattern || searchPattern.trim().length === 0) {
      return [];
    }

    const trimmedPattern = searchPattern.trim();
    const filter = buildUserSearchFilter(trimmedPattern);
    if (!filter) {
      return [];
    }
    const User = mongoose.models.User;

    const query = User.find(filter).limit(limit * 2); // Get more results to allow for relevance sorting

    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }

    const users = await query.lean<IUser[]>();

    return rankUserSearchResults(users, trimmedPattern, limit);
  };

  /**
   * Installs or uninstalls a plugin with a single atomic array operator, so concurrent
   * install/uninstall requests cannot overwrite each other.
   * @param userId - The user ID whose plugins are to be updated
   * @param _plugins - Ignored; the caller's possibly stale snapshot, kept for signature compatibility
   * @param pluginKey - The key of the plugin to install or uninstall
   * @param action - The action to perform, 'install' or 'uninstall'
   * @returns The updated user, or null if the action is invalid or the user is missing
   */
  async function updateUserPlugins(
    userId: string,
    _plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ): Promise<IUser | null> {
    const update = userPluginsUpdate(pluginKey, action);
    if (!update) {
      return null;
    }
    const User = mongoose.models.User;
    const updated = await User.findByIdAndUpdate(userId, update, {
      new: true,
      runValidators: true,
    }).lean<IUser>();
    await invalidateAuthUserDocCache(userId);
    return updated;
  }

  return {
    findUser,
    findUsers,
    findOwnerContactUsers,
    countUsers,
    createUser,
    createUserIfAbsent,
    updateUser,
    awaitAuthUserDocEviction,
    consumeBackupCode,
    claimSamlIdentity,
    updateTwoFactorEnrollment,
    acceptTerms,
    resetTermsAcceptance,
    searchUsers,
    getUserById,
    generateToken,
    beginAgentTriggerUserDeletion,
    recoverStaleAgentTriggerUserDeletion,
    cancelAgentTriggerUserDeletion,
    isAgentTriggerPrincipalActive,
    fenceSubagentAdmission,
    renewSubagentAdmission,
    releaseSubagentAdmission,
    isSubagentOwnerAdmissible,
    deleteUserById,
    updateUserPlugins,
    toggleUserMemories,
    updateUserStatefulCodeEnvironment,
  };
}

export type UserMethods = ReturnType<typeof createUserMethods>;
