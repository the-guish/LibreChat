import { SYSTEM_TENANT_ID, getTenantId, getDataStoreBackend } from '@librechat/data-schemas';
import {
  ResourceType,
  PrincipalType,
  PermissionBits,
  AccessRoleIds,
} from 'librechat-data-provider';
import type { AclEntryStore, IdLike } from '@librechat/data-schemas';
import type { Types } from 'mongoose';

export interface Principal {
  type: string;
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  source?: string;
  idOnTheSource?: string;
  accessRoleId: string;
  isImplicit?: boolean;
}

export interface EnricherDependencies {
  listUserPermissionHolders: AclEntryStore['listUserPermissionHolders'];
  bulkWriteAclEntries: AclEntryStore['bulkWriteAclEntries'];
  findRoleByIdentifier: (
    accessRoleId: string,
  ) => Promise<{ _id: Types.ObjectId; permBits: number } | null>;
  logger: { error: (msg: string, ...args: unknown[]) => void };
}

export interface EnrichResult {
  principals: Principal[];
  entriesToBackfill: Types.ObjectId[];
}

function matchesCurrentTenant(principal: Record<string, unknown>, tenantId?: string): boolean {
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    return true;
  }
  return principal.tenantId === tenantId;
}

/** Enriches REMOTE_AGENT principals with implicit AGENT owners */
export async function enrichRemoteAgentPrincipals(
  deps: EnricherDependencies,
  resourceId: IdLike,
  principals: Principal[],
): Promise<EnrichResult> {
  const tenantId = getTenantId();

  /**
   * The agent's user holders of SHARE, each with its user record; the store casts a hex
   * `resourceId` to the id it names (see `listUserPermissionHolders`).
   */
  const agentOwnerEntries = await deps.listUserPermissionHolders(
    ResourceType.AGENT,
    resourceId,
    PermissionBits.SHARE,
  );

  const enrichedPrincipals = [...principals];
  const entriesToBackfill: Types.ObjectId[] = [];

  for (const entry of agentOwnerEntries) {
    if (!entry.userInfo) {
      continue;
    }

    const userInfo = entry.userInfo as Record<string, unknown>;
    if (!matchesCurrentTenant(userInfo, tenantId)) {
      continue;
    }

    const principalId = entry.principalId as Types.ObjectId;

    const alreadyIncluded = enrichedPrincipals.some(
      (p) => p.type === PrincipalType.USER && p.id === principalId.toString(),
    );

    if (!alreadyIncluded) {
      enrichedPrincipals.unshift({
        type: PrincipalType.USER,
        id: (userInfo._id as Types.ObjectId).toString(),
        name: (userInfo.name || userInfo.username) as string,
        email: userInfo.email as string,
        avatar: userInfo.avatar as string,
        source: 'local',
        idOnTheSource:
          (userInfo.idOnTheSource as string) || (userInfo._id as Types.ObjectId).toString(),
        accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
        isImplicit: true,
      });

      entriesToBackfill.push(principalId);
    }
  }

  return { principals: enrichedPrincipals, entriesToBackfill };
}

/** Backfills REMOTE_AGENT ACL entries for AGENT owners (fire-and-forget) */
export function backfillRemoteAgentPermissions(
  deps: EnricherDependencies,
  resourceId: IdLike,
  entriesToBackfill: Types.ObjectId[],
): void {
  if (entriesToBackfill.length === 0) {
    return;
  }

  const { logger } = deps;

  const resourceObjectId =
    typeof resourceId === 'string' && /^[a-f\d]{24}$/i.test(resourceId)
      ? getDataStoreBackend().ids.toStoreId(resourceId)
      : resourceId;

  deps
    .findRoleByIdentifier(AccessRoleIds.REMOTE_AGENT_OWNER)
    .then((role) => {
      if (!role) {
        logger.error('[backfillRemoteAgentPermissions] REMOTE_AGENT_OWNER role not found');
        return;
      }

      const bulkOps = entriesToBackfill.map((principalId) => ({
        updateOne: {
          filter: {
            principalType: PrincipalType.USER,
            principalId,
            resourceType: ResourceType.REMOTE_AGENT,
            resourceId: resourceObjectId,
          },
          update: {
            $setOnInsert: {
              principalType: PrincipalType.USER,
              principalId,
              principalModel: 'User',
              resourceType: ResourceType.REMOTE_AGENT,
              resourceId: resourceObjectId,
              permBits: role.permBits,
              roleId: role._id,
              grantedBy: principalId,
              grantedAt: new Date(),
            },
          },
          upsert: true,
        },
      }));

      return deps.bulkWriteAclEntries(bulkOps, { ordered: false });
    })
    .catch((err: unknown) => {
      logger.error('[backfillRemoteAgentPermissions] Failed to backfill:', err);
    });
}
