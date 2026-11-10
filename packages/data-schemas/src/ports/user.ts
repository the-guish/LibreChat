/**
 * User store port: the accounts users sign in with, their credentials state (two-factor
 * enrollment, recovery codes, SAML identity, terms acceptance), their personalization and the
 * fences that hold their background work while the account is deleted. Nothing here may import
 * `mongoose`. Signatures are those of `UserMethods` (`~/methods/user`), with the id `createUser`
 * resolves to stated as `IdLike`; `user.spec.ts` fails the typecheck if the MongoDB methods stop
 * satisfying them.
 *
 * Every write that changes what an access token's user lookup reads evicts the user's cached
 * auth documents; any store keeps that.
 *
 * Not in this port: `findUser`, `findUsers` and `countUsers` take a raw MongoDB filter (and the
 * first two a projection, `findUsers` also a sort record); `updateUser` takes a raw filter
 * (`expectedState`); `getUserById` and `searchUsers` take a projection.
 *
 * Known leaks kept for now so callers stay unchanged: `IUser` extends mongoose's `Document` (its
 * `_id` is an ObjectId), `CreateUserRequest` extends `Partial<IUser>`, and `claimSamlIdentity`
 * takes `IUser` fields.
 */
import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import type {
  IUser,
  BalanceConfig,
  NewUserData,
  UserDeleteResult,
  CreateUserRequest,
  CreateUserIfAbsentResult,
  TwoFactorEnrollmentGuard,
  TwoFactorEnrollmentUpdate,
} from '~/types';
import type { IdLike } from './common';
import { listPortMethods } from './common';

/** Whether an account-deletion fence was taken, is held by another attempt, or has no user. */
type UserDeletionFence = 'acquired' | 'in_progress' | 'missing';

export interface UserStore {
  /** The id, name and username of each of the given users that exists. */
  findOwnerContactUsers(
    ownerIds: string[],
  ): Promise<Array<Pick<IUser, '_id' | 'name' | 'username'>>>;
  /**
   * Creates a user and, when the balance config enables one, its start balance. Without
   * `disableTTL` (default `true`) the account expires after a week unless a later update
   * removes the expiry. Resolves to the new user's id, or the user with `returnUser`.
   */
  createUser(
    data: CreateUserRequest,
    balanceConfig?: BalanceConfig,
    disableTTL?: boolean,
    returnUser?: boolean,
  ): Promise<IdLike | Partial<IUser>>;
  /**
   * Creates a user without an expiry, its start balance first, or resolves `user_exists` when
   * an account already holds its email or provider identity.
   */
  createUserIfAbsent(
    data: NewUserData,
    balanceConfig?: BalanceConfig,
  ): Promise<CreateUserIfAbsentResult>;
  /**
   * Resolves once no cached auth document of the user predates a credential change: at once
   * when they were evicted, else after the longest a cached document can live.
   */
  awaitAuthUserDocEviction(userId: string): Promise<void>;
  /** Marks the user's unused recovery code with this hash used; false when there is none. */
  consumeBackupCode(userId: string, codeHash: string): Promise<boolean>;
  /**
   * Updates a SAML user's profile and SAML id only when the user has no SAML id yet or this
   * one; resolves to the user updated, or `null`.
   */
  claimSamlIdentity(
    userId: string,
    samlId: string,
    profileData: Pick<Partial<IUser>, 'username' | 'name'>,
  ): Promise<IUser | null>;
  /**
   * One step of required two-factor enrollment, written only while the user is unenrolled, has
   * a provider LibreChat enrolls, and still holds every value in `guard`; resolves to the user
   * updated (with its two-factor fields), or `null` when the step's guard no longer holds.
   */
  updateTwoFactorEnrollment(
    userId: string,
    guard: TwoFactorEnrollmentGuard,
    updateData: TwoFactorEnrollmentUpdate,
  ): Promise<IUser | null>;
  /**
   * Records the user's terms acceptance, keeping the first acceptance time of the current terms
   * cycle; `null` when there is no such user.
   */
  acceptTerms(userId: string): Promise<IUser | null>;
  /** Withdraws every user's terms acceptance; resolves how many users changed. */
  resetTermsAcceptance(): Promise<{ modifiedCount: number }>;
  /** Signs an access token for the user, expiring after `expiresIn` ms (15 minutes by default). */
  generateToken(user: IUser, expiresIn?: number): Promise<string>;
  /** Takes the account-deletion fence for the user, unless another deletion holds it. */
  beginAgentTriggerUserDeletion(userId: string, startedAt: Date): Promise<UserDeletionFence>;
  /**
   * Takes over an account-deletion fence older than the stale age. Only for an operator who
   * confirmed the deployment that held it is offline.
   */
  recoverStaleAgentTriggerUserDeletion(
    userId: string,
    recoveredAt: Date,
  ): Promise<UserDeletionFence>;
  /** Lifts the account-deletion fence taken at `startedAt`; false when another holds it. */
  cancelAgentTriggerUserDeletion(userId: string, startedAt: Date): Promise<boolean>;
  /** True while the user exists and no account deletion holds its fence. */
  isAgentTriggerPrincipalActive(userId: string): Promise<boolean>;
  /**
   * Closes subagent admission for the user until `fencedUntil` under `token`, one fence per
   * concurrent bulk deletion; throws when the user already holds the most fences allowed.
   */
  fenceSubagentAdmission(userId: string, token: string, fencedUntil: Date): Promise<void>;
  /** Extends the fence `token` to `fencedUntil`; false when the user holds no such fence. */
  renewSubagentAdmission(userId: string, token: string, fencedUntil: Date): Promise<boolean>;
  /** Lifts the fence `token`; the user's other fences keep admission closed. */
  releaseSubagentAdmission(userId: string, token: string): Promise<void>;
  /** True while the user may admit a new subagent: no account deletion, no live fence. */
  isSubagentOwnerAdmissible(userId: string): Promise<boolean>;
  /** Deletes the user and its tool approval grants; `deletedCount` is 0 when there was none. */
  deleteUserById(userId: string): Promise<UserDeleteResult>;
  /**
   * Adds `pluginKey` to the user's plugins (`install`) or removes it (`uninstall`) in one write,
   * so concurrent requests cannot overwrite each other; `plugins` is ignored. Resolves to the
   * user updated, or `null` for any other action or a missing user.
   */
  updateUserPlugins(
    userId: string,
    plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ): Promise<IUser | null>;
  /** Turns the user's memories on or off; `null` when there is no such user. */
  toggleUserMemories(userId: string, memoriesEnabled: boolean): Promise<IUser | null>;
  /** Sets the user's stateful code environment; `null` when there is no such user. */
  updateUserStatefulCodeEnvironment(
    userId: string,
    environment: StatefulCodeEnvironment,
  ): Promise<IUser | null>;
}

/** Every method of {@link UserStore}, for adapters and conformance checks. */
export const USER_STORE_METHODS: ReadonlyArray<keyof UserStore> = listPortMethods<UserStore>({
  findOwnerContactUsers: true,
  createUser: true,
  createUserIfAbsent: true,
  awaitAuthUserDocEviction: true,
  consumeBackupCode: true,
  claimSamlIdentity: true,
  updateTwoFactorEnrollment: true,
  acceptTerms: true,
  resetTermsAcceptance: true,
  generateToken: true,
  beginAgentTriggerUserDeletion: true,
  recoverStaleAgentTriggerUserDeletion: true,
  cancelAgentTriggerUserDeletion: true,
  isAgentTriggerPrincipalActive: true,
  fenceSubagentAdmission: true,
  renewSubagentAdmission: true,
  releaseSubagentAdmission: true,
  isSubagentOwnerAdmissible: true,
  deleteUserById: true,
  updateUserPlugins: true,
  toggleUserMemories: true,
  updateUserStatefulCodeEnvironment: true,
});
