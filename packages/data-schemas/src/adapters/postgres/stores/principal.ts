/**
 * The PostgreSQL `PrincipalStore` (`~/ports/principal`): the principal lookups of the admin API
 * on the `roles`, `groups` and `users` tables, through the collection primitive. Must not import
 * `mongoose`, `mongodb` or `bson`.
 */
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { PrincipalStore } from '~/ports/principal';
import type { PostgresStoreContext } from './context';
import { isCanonicalObjectIdString } from '~/utils/objectId';
import { tenantPartitionFilter } from '../collection/tenant';

const systemRoleNames: ReadonlySet<string> = new Set(Object.values(SystemRoles));

export function createPostgresPrincipalStore(context: PostgresStoreContext): PrincipalStore {
  /** Whether the record exists in the caller's tenant partition (as on MongoDB). */
  async function existsInPartition(
    collection: 'roles' | 'groups' | 'users',
    filter: { name: string } | { _id: string },
  ): Promise<boolean> {
    const found = await context
      .collections()
      .collection(collection)
      .exists({ ...filter, ...tenantPartitionFilter('principalExists') });
    return found != null;
  }

  const store: PrincipalStore = {
    async principalExists(principalType, principalId) {
      switch (principalType) {
        case PrincipalType.ROLE:
          return (
            systemRoleNames.has(principalId) || existsInPartition('roles', { name: principalId })
          );
        case PrincipalType.GROUP:
          return (
            isCanonicalObjectIdString(principalId) &&
            existsInPartition('groups', { _id: principalId })
          );
        case PrincipalType.USER:
          return (
            isCanonicalObjectIdString(principalId) &&
            existsInPartition('users', { _id: principalId })
          );
        default:
          return false;
      }
    },

    async findPrincipalUser(userId) {
      if (!isCanonicalObjectIdString(userId)) {
        return null;
      }
      const user = (await context
        .collections()
        .collection('users')
        .findOne({ _id: userId }, { projection: 'role idOnTheSource tenantId' })) as {
        role?: string;
        idOnTheSource?: string | null;
        tenantId?: string | null;
      } | null;
      if (user == null) {
        return null;
      }
      return {
        id: userId,
        role: user.role,
        idOnTheSource: user.idOnTheSource ?? null,
        ...(user.tenantId ? { tenantId: user.tenantId } : {}),
      };
    },
  };
  return store;
}
