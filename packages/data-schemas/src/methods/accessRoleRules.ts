/**
 * The access role rules every backend's `AccessRoleStore` shares (docs/postgres-port/PHASE4.md
 * §4, "Domain rules"): the default access roles and how a tenant's own copies are merged over
 * them. Nothing here may import `mongoose`.
 */
import { AccessRoleIds, ResourceType } from 'librechat-data-provider';
import type { IAccessRole } from '~/types';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { RoleBits } from '~/common';

/** One default access role, as `seedDefaultRoles` creates it. */
export interface DefaultAccessRole {
  accessRoleId: AccessRoleIds;
  name: string;
  description: string;
  resourceType: ResourceType;
  permBits: number;
}

/** The default access roles, seeded once, globally (without a tenant). */
export const DEFAULT_ACCESS_ROLES: ReadonlyArray<DefaultAccessRole> = [
  {
    accessRoleId: AccessRoleIds.AGENT_VIEWER,
    name: 'com_ui_role_viewer',
    description: 'com_ui_role_viewer_desc',
    resourceType: ResourceType.AGENT,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.AGENT_EDITOR,
    name: 'com_ui_role_editor',
    description: 'com_ui_role_editor_desc',
    resourceType: ResourceType.AGENT,
    permBits: RoleBits.EDITOR,
  },
  {
    accessRoleId: AccessRoleIds.AGENT_OWNER,
    name: 'com_ui_role_owner',
    description: 'com_ui_role_owner_desc',
    resourceType: ResourceType.AGENT,
    permBits: RoleBits.OWNER,
  },
  {
    accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
    name: 'com_ui_role_viewer',
    description: 'com_ui_role_viewer_desc',
    resourceType: ResourceType.CODE_ENVIRONMENT,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_EDITOR,
    name: 'com_ui_role_editor',
    description: 'com_ui_role_editor_desc',
    resourceType: ResourceType.CODE_ENVIRONMENT,
    permBits: RoleBits.EDITOR,
  },
  {
    accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_OWNER,
    name: 'com_ui_role_owner',
    description: 'com_ui_role_owner_desc',
    resourceType: ResourceType.CODE_ENVIRONMENT,
    permBits: RoleBits.OWNER,
  },
  {
    accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
    name: 'com_ui_role_viewer',
    description: 'com_ui_role_viewer_desc',
    resourceType: ResourceType.PROMPTGROUP,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
    name: 'com_ui_role_editor',
    description: 'com_ui_role_editor_desc',
    resourceType: ResourceType.PROMPTGROUP,
    permBits: RoleBits.EDITOR,
  },
  {
    accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
    name: 'com_ui_role_owner',
    description: 'com_ui_role_owner_desc',
    resourceType: ResourceType.PROMPTGROUP,
    permBits: RoleBits.OWNER,
  },
  {
    accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
    name: 'com_ui_mcp_server_role_viewer',
    description: 'com_ui_mcp_server_role_viewer_desc',
    resourceType: ResourceType.MCPSERVER,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.MCPSERVER_EDITOR,
    name: 'com_ui_mcp_server_role_editor',
    description: 'com_ui_mcp_server_role_editor_desc',
    resourceType: ResourceType.MCPSERVER,
    permBits: RoleBits.EDITOR,
  },
  {
    accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
    name: 'com_ui_mcp_server_role_owner',
    description: 'com_ui_mcp_server_role_owner_desc',
    resourceType: ResourceType.MCPSERVER,
    permBits: RoleBits.OWNER,
  },
  {
    accessRoleId: AccessRoleIds.REMOTE_AGENT_VIEWER,
    name: 'com_ui_remote_agent_role_viewer',
    description: 'com_ui_remote_agent_role_viewer_desc',
    resourceType: ResourceType.REMOTE_AGENT,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.REMOTE_AGENT_EDITOR,
    name: 'com_ui_remote_agent_role_editor',
    description: 'com_ui_remote_agent_role_editor_desc',
    resourceType: ResourceType.REMOTE_AGENT,
    permBits: RoleBits.EDITOR,
  },
  {
    accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
    name: 'com_ui_remote_agent_role_owner',
    description: 'com_ui_remote_agent_role_owner_desc',
    resourceType: ResourceType.REMOTE_AGENT,
    permBits: RoleBits.OWNER,
  },
  {
    accessRoleId: AccessRoleIds.SKILL_VIEWER,
    name: 'com_ui_role_viewer',
    description: 'com_ui_role_viewer_desc',
    resourceType: ResourceType.SKILL,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.SKILL_EDITOR,
    name: 'com_ui_role_editor',
    description: 'com_ui_role_editor_desc',
    resourceType: ResourceType.SKILL,
    permBits: RoleBits.EDITOR,
  },
  {
    accessRoleId: AccessRoleIds.SKILL_OWNER,
    name: 'com_ui_role_owner',
    description: 'com_ui_role_owner_desc',
    resourceType: ResourceType.SKILL,
    permBits: RoleBits.OWNER,
  },
  {
    accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    name: 'com_ui_role_viewer',
    description: 'com_ui_role_viewer_desc',
    resourceType: ResourceType.SHARED_LINK,
    permBits: RoleBits.VIEWER,
  },
  {
    accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
    name: 'com_ui_role_owner',
    description: 'com_ui_role_owner_desc',
    resourceType: ResourceType.SHARED_LINK,
    permBits: RoleBits.OWNER,
  },
];

/** True inside a tenant's own context; false with no context or a system one. */
export function inTenantScope(): boolean {
  const tenantId = getTenantId();
  return tenantId != null && tenantId !== SYSTEM_TENANT_ID;
}

/**
 * The access roles visible inside tenant `tenantId`, from its own roles and the global defaults
 * (`roles`, in any order): the defaults with the tenant's copies substituted by `accessRoleId`.
 */
export function mergeTenantAccessRoles<R extends Pick<IAccessRole, 'accessRoleId' | 'tenantId'>>(
  roles: readonly R[],
  tenantId: string | undefined,
): R[] {
  const rolesById = new Map<string, R>();
  for (const role of roles) {
    const id = String(role.accessRoleId);
    if (role.tenantId === tenantId || !rolesById.has(id)) {
      rolesById.set(id, role);
    }
  }
  return [...rolesById.values()];
}
