/**
 * Principal store port: the principal lookups of the admin API. Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `PrincipalMethods` (`~/methods/principal`);
 * `principal.spec.ts` fails the typecheck if the two drift. The MongoDB adapter reads the role,
 * group and user collections.
 */
import type { PrincipalType } from 'librechat-data-provider';
import type { PrincipalUser } from '~/types';
import { listPortMethods } from './common';

export interface PrincipalStore {
  /**
   * Whether a role (by exact name), group or user (by canonical lowercase id) exists in the
   * caller's tenant partition: the active tenant's principals, or outside a tenant only
   * platform-level ones. The system roles always exist. Creates nothing; any other type or a
   * non-canonical group or user id is `false`.
   */
  principalExists(principalType: PrincipalType, principalId: string): Promise<boolean>;
  /**
   * The user with this canonical id, with what principal resolution reads of them, as the tenant
   * in context sees users; `null` for a non-canonical id or a user the caller cannot see.
   */
  findPrincipalUser(userId: string): Promise<PrincipalUser | null>;
}

/** Every method of {@link PrincipalStore}, for adapters and conformance checks. */
export const PRINCIPAL_STORE_METHODS: ReadonlyArray<keyof PrincipalStore> =
  listPortMethods<PrincipalStore>({
    principalExists: true,
    findPrincipalUser: true,
  });
