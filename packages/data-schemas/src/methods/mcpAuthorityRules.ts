/**
 * The MCP authority store's database-neutral rules (`MCPAuthorityStore`, `~/ports/mcpAuthority`),
 * shared by every backend: the MongoDB methods (`./mcpAuthority`) and the PostgreSQL store
 * (`adapters/postgres/stores/mcpAuthority.ts`). Everything but the reads is written once here: the
 * stable digest and the revision helpers `@librechat/api` computes its targets with, the target
 * and proof validation, the proof assembled from the rows of one snapshot (on the reads of
 * {@link MCPAuthoritySnapshotReads}, in the order the MongoDB methods issue them), and the two
 * methods on a backend's snapshot runner ({@link createMCPAuthorityOnSnapshot}). Ids are whatever
 * the backend's rows carry ({@link AuthorityId}: a MongoDB id or a hex string), read through their
 * string form; id validity is the backend's ({@link IsValidId}). Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import { createHash } from 'crypto';
import {
  Constants,
  Permissions,
  PermissionBits,
  ResourceType,
  PrincipalType,
  PermissionTypes,
  normalizeServerName,
} from 'librechat-data-provider';
import type {
  IRole,
  IConfig,
  MCPServerDocument,
  MCPAuthorityProofV1,
  MCPAuthorityBootRevision,
  MCPAuthorityResolveInput,
  MCPAuthorityAssertInput,
  MCPAuthorityGroupProof,
  MCPAuthorityConfigProof,
  MCPAuthorityServerProofV1,
  MCPAuthorityRejectionReason,
  MCPAuthorityImmutableConfig,
  MCPAuthorityServerSource,
} from '~/types';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { MCP_AUTHORITY_PROOF_VERSION } from '~/types';
import { getTenantId } from '~/config/tenantContext';

/** An id as a backend's rows carry it: a MongoDB id (read by its hex string form) or a string. */
export type AuthorityId = string | { toString(): string };

/** Whether `id` is an id of the backend's format (MongoDB: `Types.ObjectId.isValid`). */
export type IsValidId = (id: unknown) => boolean;

/** The string form of a row id (an id's hex string). */
function idText(id: AuthorityId): string {
  return typeof id === 'string' ? id : id.toString();
}

/** A MongoDB id value inside digested data, recognized without loading the driver. */
function isObjectIdValue(value: object): value is { toHexString(): string } {
  const candidate = value as { _bsontype?: unknown; toHexString?: unknown };
  return candidate._bsontype === 'ObjectId' && typeof candidate.toHexString === 'function';
}

/** A target as the proof reads it: validated, with its derived credential fields. */
interface PreparedTarget {
  readonly serverName: string;
  readonly normalizedServerName: string;
  readonly source: MCPAuthorityServerSource;
  readonly databaseId: string | null;
  readonly sourceRevision: string;
  readonly expectedCredentialRevision: string;
  readonly expectedOAuthGrantGeneration: string | null;
  readonly resolvedConfigDigest: string;
  readonly credentialFields: readonly string[];
  readonly requiresOAuth: boolean;
}

export interface UserProjection {
  _id: AuthorityId;
  tenantId?: string;
  role?: string;
  provider?: string;
  idOnTheSource?: string;
  openidIssuer?: string;
  googleId?: string;
  facebookId?: string;
  openidId?: string;
  samlId?: string;
  ldapId?: string;
  githubId?: string;
  discordId?: string;
  appleId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface GroupProjection {
  _id: AuthorityId;
  source: string;
  idOnTheSource?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ConfigProjection {
  _id: AuthorityId;
  principalType: PrincipalType;
  principalId: AuthorityId;
  priority: number;
  mcpSettingsOverride?: object;
  tombstones?: string[];
  isActive: boolean;
  configVersion: number;
  updatedAt?: Date;
}

export interface RoleProjection {
  _id: AuthorityId;
  name: string;
  permissions?: IRole['permissions'];
}

export interface ServerProjection {
  _id: AuthorityId;
  serverName: string;
  normalizedServerName: string;
  config: MCPServerDocument['config'];
  author: AuthorityId;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AgentProjection {
  _id: AuthorityId;
  id: string;
  mcpServerNames?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AclProjection {
  _id: AuthorityId;
  principalType: PrincipalType;
  principalId?: AuthorityId;
  resourceType: ResourceType;
  resourceId: AuthorityId;
  permBits: number;
  expiredAt?: Date;
  updatedAt?: Date;
}

export interface PluginAuthProjection {
  _id: AuthorityId;
  pluginKey?: string;
  authField: string;
  value: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface TokenProjection {
  _id: AuthorityId;
  type?: string;
  identifier?: string;
  token: string;
  metadata?: Map<string, unknown> | Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

/** One `$group` batch: the rows a bounded read returned, with their count. */
export interface AggregateBatch<Projection> {
  rows: Projection[];
  count: number;
}

const OAUTH_TOKEN_TYPES = ['mcp_oauth', 'mcp_oauth_refresh', 'mcp_oauth_client'] as const;
type OAuthTokenType = (typeof OAUTH_TOKEN_TYPES)[number];
export const MAX_MCP_AUTHORITY_TARGETS = 32;
const MAX_MCP_AUTHORITY_GROUPS = 64;
const MAX_MCP_AUTHORITY_AGENTS = 64;
const MAX_MCP_AUTHORITY_CREDENTIALS = 64;
const MAX_MCP_AUTHORITY_ACL_ENTRIES = 96;
const MAX_MCP_AUTHORITY_SERVER_NAME_LENGTH = 256;
const MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH = 256;
const MAX_MCP_AUTHORITY_CREDENTIAL_FIELDS = 64;
const MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH = 256;
const MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES = 64;

export class MCPAuthorityProofError extends Error {
  constructor(
    public readonly reason: MCPAuthorityRejectionReason,
    message: string,
    public readonly serverName?: string,
  ) {
    super(message);
    this.name = 'MCPAuthorityProofError';
  }
}

function reject(reason: MCPAuthorityRejectionReason, message: string, serverName?: string): never {
  throw new MCPAuthorityProofError(reason, message, serverName);
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      reject('malformed_input', 'Authority proof data contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') {
    return 'null';
  }
  if (typeof value !== 'object') {
    reject('malformed_input', 'Authority proof data contains an unsupported value');
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      reject('malformed_input', 'Authority proof data contains an invalid date');
    }
    return JSON.stringify(value.toISOString());
  }
  if (isObjectIdValue(value)) {
    return JSON.stringify(value.toHexString());
  }
  if (seen.has(value)) {
    reject('malformed_input', 'Authority proof data contains a circular value');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    seen.delete(value);
    return serialized;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    );
    const serialized = `{${entries
      .map(([key, item]) => `${JSON.stringify(String(key))}:${stableStringify(item, seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return serialized;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const serialized = `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
    .join(',')}}`;
  seen.delete(value);
  return serialized;
}

export function digestMCPAuthorityValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('base64url');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function createMCPAuthorityBootRevision(
  revision: string,
  immutableConfig: MCPAuthorityImmutableConfig,
): MCPAuthorityBootRevision {
  const normalizedRevision = revision.trim();
  if (!normalizedRevision) {
    reject('malformed_input', 'MCP boot revision is required');
  }
  return deepFreeze({
    revision: normalizedRevision,
    digest: digestMCPAuthorityValue(immutableConfig),
  });
}

/** A stored config document, as a config source revision reads it. */
export interface MCPAuthorityConfigSourceDocument {
  _id: AuthorityId;
  principalType: PrincipalType;
  principalId: AuthorityId;
  priority: number;
  overrides?: IConfig['overrides'];
  tombstones?: readonly string[];
  isActive: boolean;
  configVersion: number;
  updatedAt?: Date | null;
}

function computeConfigSourceRevision(
  isValidId: IsValidId,
  bootDigest: string,
  documents: readonly MCPAuthorityConfigSourceDocument[],
): string {
  if (typeof bootDigest !== 'string' || !bootDigest.trim() || !Array.isArray(documents)) {
    reject('malformed_input', 'MCP config source revision inputs are malformed');
  }
  if (documents.length > MAX_MCP_AUTHORITY_GROUPS + 3) {
    reject('malformed_input', 'MCP config source revision exceeds the proof limit');
  }
  const principals = new Set<string>();
  const configs = documents
    .map((document) => {
      const id = document._id.toString();
      const principalId = document.principalId.toString();
      const key = principalKey(document.principalType, principalId);
      const rawTombstones = document.tombstones ?? [];
      if (!Array.isArray(rawTombstones) || rawTombstones.some((path) => typeof path !== 'string')) {
        reject('malformed_input', 'MCP config source revision inputs are malformed');
      }
      const tombstones = rawTombstones
        .filter((path) => path === 'mcpSettings' || path.startsWith('mcpSettings.'))
        .sort();
      if (
        !isValidId(id) ||
        !principalId ||
        principals.has(key) ||
        !Number.isFinite(document.priority) ||
        typeof document.isActive !== 'boolean' ||
        !Number.isInteger(document.configVersion) ||
        document.configVersion < 0 ||
        tombstones.length > MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES
      ) {
        reject('malformed_input', 'MCP config source revision inputs are malformed');
      }
      principals.add(key);
      const mcpSettingsOverride = document.overrides?.mcpSettings;
      return {
        id,
        principalType: document.principalType,
        principalId,
        priority: document.priority,
        isActive: document.isActive,
        configVersion: document.configVersion,
        mcpSettingsOverrideDigest:
          mcpSettingsOverride === undefined ? null : digestMCPAuthorityValue(mcpSettingsOverride),
        tombstones,
        updatedAt: document.updatedAt ?? null,
      };
    })
    .sort((left, right) =>
      principalKey(left.principalType, left.principalId).localeCompare(
        principalKey(right.principalType, right.principalId),
      ),
    );
  return digestMCPAuthorityValue({ bootDigest, configs });
}

/** A stored database server, as its source revision reads it. */
export interface MCPAuthorityDatabaseSourceInput {
  databaseId: string;
  serverName: string;
  author: string;
  config: MCPServerDocument['config'];
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

function computeDatabaseSourceRevision(
  isValidId: IsValidId,
  server: MCPAuthorityDatabaseSourceInput,
): string {
  if (!isValidId(server.databaseId) || !server.serverName || !server.author) {
    reject('malformed_input', 'MCP database source revision inputs are malformed');
  }
  return digestMCPAuthorityValue({
    id: server.databaseId,
    name: server.serverName,
    author: server.author,
    config: server.config,
    createdAt: server.createdAt ?? null,
    updatedAt: server.updatedAt ?? null,
  });
}

/** A stored credential, as a credential revision reads it. */
export interface MCPAuthorityCredentialSourceDocument {
  _id: AuthorityId;
  authField: string;
  value: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

function computeCredentialRevision(
  isValidId: IsValidId,
  credentialFields: readonly string[],
  credentials: readonly MCPAuthorityCredentialSourceDocument[],
): string {
  const fields = [...new Set(credentialFields)].sort();
  if (
    fields.length !== credentialFields.length ||
    fields.some(
      (field) =>
        !field ||
        field.trim() !== field ||
        field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH,
    )
  ) {
    reject('malformed_input', 'MCP credential source fields are malformed');
  }
  const fieldSet = new Set(fields);
  const seen = new Set<string>();
  const rows = credentials
    .map((credential) => {
      const id = credential._id.toString();
      if (
        !isValidId(id) ||
        !fieldSet.has(credential.authField) ||
        seen.has(credential.authField) ||
        typeof credential.value !== 'string'
      ) {
        reject('malformed_input', 'MCP credential source data is malformed');
      }
      seen.add(credential.authField);
      return {
        id,
        authField: credential.authField,
        valueDigest: digestMCPAuthorityValue(credential.value),
        createdAt: credential.createdAt ?? null,
        updatedAt: credential.updatedAt ?? null,
      };
    })
    .sort((left, right) => left.authField.localeCompare(right.authField));
  return digestMCPAuthorityValue({ expectedFields: fields, rows });
}

function normalizeCredentialFields(
  target: MCPAuthorityResolveInput['targets'][number],
): readonly string[] {
  const configured = target.resolvedConfig.customUserVars;
  const providedFields = target.credentialFields ?? [];
  if (!Array.isArray(providedFields) || providedFields.some((field) => typeof field !== 'string')) {
    reject('malformed_input', `Credential fields for "${target.serverName}" are malformed`);
  }
  const normalizedProvided = [
    ...new Set(providedFields.map((field) => field.trim()).filter(Boolean)),
  ];
  if (
    normalizedProvided.length !== providedFields.length ||
    normalizedProvided.some((field) => field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH)
  ) {
    reject('malformed_input', `Credential fields for "${target.serverName}" are malformed`);
  }
  const configuredFields = configured ? Object.keys(configured) : [];
  if (
    configuredFields.some(
      (field) =>
        !field ||
        field.trim() !== field ||
        field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH,
    )
  ) {
    reject('malformed_input', `Configured credentials for "${target.serverName}" are malformed`);
  }
  return [...new Set([...normalizedProvided, ...configuredFields])].sort();
}

function assertPreparedTargetBounds(targets: readonly PreparedTarget[]): void {
  if (targets.length > MAX_MCP_AUTHORITY_TARGETS) {
    reject('malformed_input', 'Too many selected MCP servers for one authority snapshot');
  }
  const credentialFieldCount = targets.reduce(
    (total, target) => total + target.credentialFields.length,
    0,
  );
  if (credentialFieldCount > MAX_MCP_AUTHORITY_CREDENTIAL_FIELDS) {
    reject('malformed_input', 'Too many MCP credential fields for one authority snapshot');
  }
}

function prepareTargets(
  isValidId: IsValidId,
  targets: MCPAuthorityResolveInput['targets'],
): readonly PreparedTarget[] {
  if (!Array.isArray(targets)) {
    reject('malformed_input', 'Selected MCP authority targets are malformed');
  }
  if (targets.length === 0) {
    reject('malformed_input', 'At least one selected MCP server is required');
  }
  if (targets.length > MAX_MCP_AUTHORITY_TARGETS) {
    reject('malformed_input', 'Too many selected MCP servers for one authority snapshot');
  }
  const rawNames = new Set<string>();
  const normalizedNames = new Set<string>();
  const prepared = targets.map((target): PreparedTarget => {
    if (!target || typeof target !== 'object') {
      reject('malformed_input', 'Selected MCP authority target is malformed');
    }
    const source: string = target.source;
    if (
      !target.serverName ||
      target.serverName.trim() !== target.serverName ||
      target.serverName.length > MAX_MCP_AUTHORITY_SERVER_NAME_LENGTH
    ) {
      reject('malformed_input', 'Selected MCP server name is required');
    }
    if (rawNames.has(target.serverName)) {
      reject('malformed_input', `Selected MCP server "${target.serverName}" is duplicated`);
    }
    rawNames.add(target.serverName);
    const normalizedServerName = normalizeServerName(target.serverName);
    if (normalizedNames.has(normalizedServerName)) {
      reject(
        'malformed_input',
        `Selected MCP server "${target.serverName}" has an ambiguous normalized identity`,
        target.serverName,
      );
    }
    normalizedNames.add(normalizedServerName);
    if (source !== 'config' && source !== 'database') {
      reject('malformed_input', `Source for "${target.serverName}" is invalid`);
    }
    if (source === 'config' && target.databaseId != null) {
      reject('malformed_input', `Config server "${target.serverName}" has a database identity`);
    }
    if (source === 'database') {
      if (!target.databaseId || !isValidId(target.databaseId)) {
        reject('malformed_input', `Database identity for "${target.serverName}" is invalid`);
      }
    }
    if (
      typeof target.sourceRevision !== 'string' ||
      !target.sourceRevision ||
      target.sourceRevision.trim() !== target.sourceRevision ||
      target.sourceRevision.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH
    ) {
      reject('malformed_input', `Source revision for "${target.serverName}" is required`);
    }
    if (
      typeof target.expectedCredentialRevision !== 'string' ||
      !target.expectedCredentialRevision ||
      target.expectedCredentialRevision.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH ||
      (target.expectedOAuthGrantGeneration !== null &&
        (typeof target.expectedOAuthGrantGeneration !== 'string' ||
          !target.expectedOAuthGrantGeneration ||
          target.expectedOAuthGrantGeneration.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH))
    ) {
      reject('malformed_input', `Credential generation for "${target.serverName}" is malformed`);
    }
    if (target.requiresOAuth !== undefined && typeof target.requiresOAuth !== 'boolean') {
      reject('malformed_input', `OAuth requirement for "${target.serverName}" is malformed`);
    }
    if (
      !target.resolvedConfig ||
      typeof target.resolvedConfig !== 'object' ||
      Array.isArray(target.resolvedConfig)
    ) {
      reject('malformed_input', `Resolved config for "${target.serverName}" is malformed`);
    }
    return {
      serverName: target.serverName,
      normalizedServerName,
      source,
      databaseId: target.databaseId ?? null,
      sourceRevision: target.sourceRevision,
      expectedCredentialRevision: target.expectedCredentialRevision,
      expectedOAuthGrantGeneration: target.expectedOAuthGrantGeneration,
      resolvedConfigDigest: digestMCPAuthorityValue(target.resolvedConfig),
      credentialFields: normalizeCredentialFields(target),
      requiresOAuth: target.resolvedConfig.oauth != null || target.requiresOAuth === true,
    };
  });
  assertPreparedTargetBounds(prepared);
  return prepared.sort((left, right) => left.serverName.localeCompare(right.serverName));
}

function assertRevisionIntegrity<T extends { readonly revision: string }>(
  value: T,
  description: string,
): void {
  const { revision, ...revisionInput } = value;
  if (!revision || digestMCPAuthorityValue(revisionInput) !== revision) {
    reject('malformed_input', `${description} revision is invalid`);
  }
}

function assertProofIntegrity(isValidId: IsValidId, proof: MCPAuthorityProofV1): void {
  if (!proof || typeof proof !== 'object' || proof.version !== MCP_AUTHORITY_PROOF_VERSION) {
    reject('malformed_input', 'MCP authority proof version is invalid');
  }
  if (!proof.shared || typeof proof.shared !== 'object' || !Array.isArray(proof.servers)) {
    reject('malformed_input', 'MCP authority proof contents are invalid');
  }
  const shared = proof.shared;
  if (
    !shared.user ||
    !shared.role ||
    !shared.boot ||
    !Array.isArray(shared.groups) ||
    !Array.isArray(shared.configs) ||
    !shared.user.userId ||
    !shared.user.revision ||
    !shared.role.revision ||
    !shared.boot.revision ||
    !shared.boot.digest
  ) {
    reject('malformed_input', 'MCP authority shared proof is invalid');
  }
  if (
    shared.groups.length > MAX_MCP_AUTHORITY_GROUPS ||
    shared.configs.length > MAX_MCP_AUTHORITY_GROUPS + 3 ||
    shared.configs.some(
      (config) =>
        !Array.isArray(config?.tombstones) ||
        config.tombstones.length > MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES,
    )
  ) {
    reject('malformed_input', 'MCP authority shared proof exceeds its bounded shape');
  }
  if (shared.groups.some((group) => !group?.revision)) {
    reject('malformed_input', 'MCP authority group proof is invalid');
  }
  if (shared.configs.some((config) => !config?.revision)) {
    reject('malformed_input', 'MCP authority configuration proof is invalid');
  }
  if (shared.groupsRevision !== digestMCPAuthorityValue(shared.groups)) {
    reject('malformed_input', 'MCP authority group revision is invalid');
  }
  if (shared.configsRevision !== digestMCPAuthorityValue(shared.configs)) {
    reject('malformed_input', 'MCP authority configuration revision is invalid');
  }
  assertRevisionIntegrity(shared, 'MCP authority shared proof');

  if (proof.servers.length === 0 || proof.servers.length > MAX_MCP_AUTHORITY_TARGETS) {
    reject('malformed_input', 'MCP authority proof contains no selected servers');
  }
  const normalizedNames = new Set<string>();
  for (const server of proof.servers) {
    if (
      !server ||
      typeof server.serverName !== 'string' ||
      !server.serverName ||
      server.serverName.trim() !== server.serverName ||
      server.serverName.length > MAX_MCP_AUTHORITY_SERVER_NAME_LENGTH ||
      typeof server.normalizedServerName !== 'string' ||
      !server.normalizedServerName ||
      typeof server.sourceRevision !== 'string' ||
      !server.sourceRevision ||
      server.sourceRevision.trim() !== server.sourceRevision ||
      server.sourceRevision.length > MAX_MCP_AUTHORITY_SOURCE_REVISION_LENGTH ||
      !server.resolvedConfigDigest ||
      !server.serverRevision ||
      !server.authorizationRevision ||
      !server.credentialRevision ||
      !server.oauthRevision ||
      !server.effectivePolicyDigest ||
      !Array.isArray(server.linkedAgentIds) ||
      server.linkedAgentIds.length > MAX_MCP_AUTHORITY_AGENTS ||
      server.linkedAgentIds.some((id: string) => typeof id !== 'string') ||
      !Array.isArray(server.credentialFields) ||
      server.credentialFields.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELDS ||
      server.credentialFields.some((field: string) => typeof field !== 'string') ||
      typeof server.directAccess !== 'boolean' ||
      typeof server.agentAccess !== 'boolean' ||
      typeof server.requiresOAuth !== 'boolean' ||
      (server.oauthGrantGeneration !== null && typeof server.oauthGrantGeneration !== 'string')
    ) {
      reject('malformed_input', 'MCP authority server proof is invalid');
    }
    const normalizedServerName = normalizeServerName(server.serverName);
    if (server.normalizedServerName !== normalizedServerName) {
      reject(
        'malformed_input',
        'MCP authority server normalized identity is invalid',
        server.serverName,
      );
    }
    if (normalizedNames.has(normalizedServerName)) {
      reject(
        'malformed_input',
        'MCP authority proof contains ambiguous server identities',
        server.serverName,
      );
    }
    normalizedNames.add(normalizedServerName);
    if (
      (server.source !== 'config' && server.source !== 'database') ||
      (server.source === 'config' && server.databaseId !== null) ||
      (server.source === 'database' &&
        (typeof server.databaseId !== 'string' || !isValidId(server.databaseId)))
    ) {
      reject('malformed_input', 'MCP authority server source is invalid', server.serverName);
    }
    const normalizedCredentialFields = [...new Set<string>(server.credentialFields)].sort();
    if (
      normalizedCredentialFields.length !== server.credentialFields.length ||
      normalizedCredentialFields.some(
        (field, index) =>
          !field ||
          field.trim() !== field ||
          field.length > MAX_MCP_AUTHORITY_CREDENTIAL_FIELD_LENGTH ||
          field !== server.credentialFields[index],
      )
    ) {
      reject('malformed_input', 'MCP authority credential fields are invalid', server.serverName);
    }
    const expectedPolicyDigest = digestMCPAuthorityValue({
      sharedRevision: shared.revision,
      serverRevision: server.serverRevision,
      sourceRevision: server.sourceRevision,
      resolvedConfigDigest: server.resolvedConfigDigest,
      authorizationRevision: server.authorizationRevision,
      credentialRevision: server.credentialRevision,
      oauthRevision: server.oauthRevision,
    });
    if (server.effectivePolicyDigest !== expectedPolicyDigest) {
      reject('malformed_input', 'MCP authority effective policy is invalid', server.serverName);
    }
    assertRevisionIntegrity(server, 'MCP authority server proof');
  }
  assertRevisionIntegrity(proof, 'MCP authority proof');
}

function sourceIdentity(user: UserProjection): object {
  return {
    idOnTheSource: user.idOnTheSource ?? null,
    openidIssuer: user.openidIssuer ?? null,
    googleId: user.googleId ?? null,
    facebookId: user.facebookId ?? null,
    openidId: user.openidId ?? null,
    samlId: user.samlId ?? null,
    ldapId: user.ldapId ?? null,
    githubId: user.githubId ?? null,
    discordId: user.discordId ?? null,
    appleId: user.appleId ?? null,
  };
}

function principalKey(principalType: string, principalId: string): string {
  return `${principalType}:${principalId}`;
}

function appendIndexValue<Key, Value>(index: Map<Key, Value[]>, key: Key, value: Value): void {
  const values = index.get(key);
  if (values) {
    values.push(value);
    return;
  }
  index.set(key, [value]);
}

function assertCompleteBatch<Projection>(
  rows: readonly Projection[],
  count: number,
  limit: number,
  description: string,
): void {
  if (!Number.isInteger(count) || count < 0 || count > limit || rows.length !== count) {
    reject('proof_unavailable', `${description} exceeds one complete authoritative proof batch`);
  }
}

function unwrapAggregateBatch<Projection>(
  batches: readonly AggregateBatch<Projection>[],
  limit: number,
  description: string,
): Projection[] {
  if (batches.length === 0) {
    return [];
  }
  if (batches.length !== 1 || !Array.isArray(batches[0].rows)) {
    reject('proof_unavailable', `${description} proof batch is malformed`);
  }
  const batch = batches[0];
  assertCompleteBatch(batch.rows, batch.count, limit, description);
  return batch.rows;
}

/** A config slot of a proof: the base config, the role, each group or the user. */
export interface AuthorityConfigSlot {
  principalType: PrincipalType;
  principalId: string;
}

function configSlots(
  userId: string,
  role: string,
  groups: readonly GroupProjection[],
): AuthorityConfigSlot[] {
  return [
    { principalType: PrincipalType.ROLE, principalId: BASE_CONFIG_PRINCIPAL_ID },
    { principalType: PrincipalType.ROLE, principalId: role },
    ...groups.map((group) => ({
      principalType: PrincipalType.GROUP,
      principalId: idText(group._id),
    })),
    { principalType: PrincipalType.USER, principalId: userId },
  ].sort((left, right) =>
    principalKey(left.principalType, left.principalId).localeCompare(
      principalKey(right.principalType, right.principalId),
    ),
  );
}

function buildGroupProof(group: GroupProjection): MCPAuthorityGroupProof {
  const id = idText(group._id);
  const sourceIdentityDigest = digestMCPAuthorityValue({
    source: group.source,
    idOnTheSource: group.idOnTheSource ?? null,
  });
  return {
    id,
    source: group.source,
    sourceIdentityDigest,
    revision: digestMCPAuthorityValue({
      id,
      sourceIdentityDigest,
      createdAt: group.createdAt ?? null,
      updatedAt: group.updatedAt ?? null,
    }),
  };
}

function buildConfigProofs(
  slots: ReturnType<typeof configSlots>,
  documents: readonly ConfigProjection[],
): readonly MCPAuthorityConfigProof[] {
  const byPrincipal = new Map<string, ConfigProjection>();
  const allowed = new Set(slots.map((slot) => principalKey(slot.principalType, slot.principalId)));
  for (const document of documents) {
    const key = principalKey(document.principalType, document.principalId.toString());
    const tombstones = document.tombstones;
    if (!allowed.has(key) || byPrincipal.has(key)) {
      reject('proof_unavailable', 'Applicable MCP configuration proof is malformed');
    }
    if (
      typeof document.isActive !== 'boolean' ||
      !Number.isFinite(document.priority) ||
      !Number.isInteger(document.configVersion) ||
      document.configVersion < 0 ||
      !Array.isArray(tombstones) ||
      tombstones.some((path) => typeof path !== 'string')
    ) {
      reject('proof_unavailable', 'Applicable MCP configuration proof is malformed');
    }
    byPrincipal.set(key, document);
  }
  return slots.map((slot): MCPAuthorityConfigProof => {
    const document = byPrincipal.get(principalKey(slot.principalType, slot.principalId));
    if (!document) {
      const absent = {
        principalType: slot.principalType,
        principalId: slot.principalId,
        present: false,
        active: false,
        priority: null,
        configVersion: null,
        mcpOverrideDigest: null,
        tombstones: [] as readonly string[],
      };
      return { ...absent, revision: digestMCPAuthorityValue(absent) };
    }
    const tombstones = (document.tombstones ?? [])
      .filter((path) => path === 'mcpSettings' || path.startsWith('mcpSettings.'))
      .sort();
    if (tombstones.length > MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES) {
      reject('proof_unavailable', 'Applicable MCP configuration tombstones exceed the proof limit');
    }
    const mcpOverrideDigest =
      document.mcpSettingsOverride === undefined
        ? null
        : digestMCPAuthorityValue(document.mcpSettingsOverride);
    const present = {
      principalType: slot.principalType,
      principalId: slot.principalId,
      present: true,
      active: document.isActive,
      priority: document.priority,
      configVersion: document.configVersion,
      mcpOverrideDigest,
      tombstones,
      documentId: idText(document._id),
      updatedAt: document.updatedAt ?? null,
    };
    return {
      principalType: present.principalType,
      principalId: present.principalId,
      present: present.present,
      active: present.active,
      priority: present.priority,
      configVersion: present.configVersion,
      mcpOverrideDigest: present.mcpOverrideDigest,
      tombstones: present.tombstones,
      revision: digestMCPAuthorityValue(present),
    };
  });
}

function tokenMetadata(token: TokenProjection): Record<string, unknown> {
  if (!token.metadata) {
    return {};
  }
  return token.metadata instanceof Map
    ? Object.fromEntries(token.metadata.entries())
    : { ...token.metadata };
}

function oauthTokenIdentities(
  serverName: string,
): readonly { type: OAuthTokenType; identifier: string }[] {
  const base = `mcp:${serverName}`;
  return [
    { type: 'mcp_oauth', identifier: base },
    { type: 'mcp_oauth_refresh', identifier: `${base}:refresh` },
    { type: 'mcp_oauth_client', identifier: `${base}:client` },
  ];
}

function oauthTokenKey(type: string, identifier: string): string {
  return JSON.stringify([type, identifier]);
}

function isActiveViewAcl(entry: AclProjection, now: Date): boolean {
  if (!Number.isInteger(entry.permBits) || entry.permBits < 0) {
    reject('proof_unavailable', 'MCP ACL proof is malformed');
  }
  return (
    (entry.permBits & PermissionBits.VIEW) === PermissionBits.VIEW &&
    (!entry.expiredAt || entry.expiredAt > now)
  );
}

function aclRevision(entry: AclProjection): object {
  return {
    id: idText(entry._id),
    principalType: entry.principalType,
    principalId: entry.principalId?.toString() ?? null,
    resourceType: entry.resourceType,
    resourceId: idText(entry.resourceId),
    permBits: entry.permBits,
    expiredAt: entry.expiredAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  };
}

function buildCredentialProof(
  isValidId: IsValidId,
  target: PreparedTarget,
  credentials: readonly PluginAuthProjection[],
): { fields: readonly string[]; revision: string } {
  const pluginKey = `${Constants.mcp_prefix}${target.serverName}`;
  const selected = credentials.filter((credential) => credential.pluginKey === pluginKey);
  return {
    fields: target.credentialFields,
    revision: computeCredentialRevision(isValidId, target.credentialFields, selected),
  };
}

function buildOAuthProof(
  target: PreparedTarget,
  tokens: readonly TokenProjection[],
  now: Date,
): { generation: string | null; revision: string } {
  const identities = new Set(
    oauthTokenIdentities(target.serverName).map(({ type, identifier }) =>
      oauthTokenKey(type, identifier),
    ),
  );
  const seen = new Set<string>();
  const generations = new Set<string>();
  const rows = tokens
    .map((token) => {
      const type = token.type ?? '';
      const identifier = token.identifier ?? '';
      const key = oauthTokenKey(type, identifier);
      if (
        !OAUTH_TOKEN_TYPES.includes(type as (typeof OAUTH_TOKEN_TYPES)[number]) ||
        !identifier ||
        !identities.has(key) ||
        seen.has(key)
      ) {
        reject('proof_unavailable', 'MCP OAuth grant proof is malformed', target.serverName);
      }
      seen.add(key);
      const metadata = tokenMetadata(token);
      const generation = metadata.credential_set_id;
      if (typeof generation !== 'string' || generation.length === 0) {
        reject('proof_unavailable', 'MCP OAuth grant proof is malformed', target.serverName);
      }
      generations.add(generation);
      return {
        id: idText(token._id),
        type,
        identifier,
        generation,
        tokenDigest: digestMCPAuthorityValue(token.token),
        metadataDigest: digestMCPAuthorityValue(metadata),
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        active: token.expiresAt > now,
      };
    })
    .sort((left, right) =>
      `${left.type}:${left.identifier}`.localeCompare(`${right.type}:${right.identifier}`),
    );
  if (generations.size > 1) {
    reject('proof_unavailable', 'MCP OAuth grant generations disagree', target.serverName);
  }
  const generation = generations.values().next().value ?? null;
  return {
    generation,
    revision: digestMCPAuthorityValue({ requiresOAuth: target.requiresOAuth, rows }),
  };
}

function asMCPError(error: unknown): MCPAuthorityProofError {
  if (error instanceof MCPAuthorityProofError) {
    return error;
  }
  return new MCPAuthorityProofError(
    'proof_unavailable',
    'Authoritative MCP proof data is unavailable',
  );
}

/** The credential fields read for one selected server. */
export interface AuthorityCredentialSelector {
  pluginKey: string;
  authFields: readonly string[];
}

/** One OAuth token record a selected server's grant may consist of. */
export interface AuthorityTokenSelector {
  type: OAuthTokenType;
  identifier: string;
}

/** The principals and resources whose ACL entries a proof reads. */
export interface AuthorityAclSelection {
  userId: string;
  roleName: string;
  /** The user's groups' ids, as their rows carry them. */
  groupIds: readonly AuthorityId[];
  /** The selected servers' ids, as their rows carry them. */
  serverIds: readonly AuthorityId[];
  /** The linked agents' ids, as their rows carry them. */
  agentIds: readonly AuthorityId[];
}

/**
 * The reads of one authority snapshot, each restricted to `tenantId` (records without a tenant
 * when it is `undefined`) and run on the snapshot. Counts are capped at `limit + 1` and reads
 * return at most `limit + 1` rows, so an overflow is seen without reading it all.
 */
export interface MCPAuthoritySnapshotReads {
  /** The user with the id, its source identities and timestamps. */
  user(userId: string, tenantId: string | undefined): Promise<UserProjection | null>;
  /** How many groups hold `memberId`. */
  groupCount(memberId: string, tenantId: string | undefined, limit: number): Promise<number>;
  /** The groups holding `memberId`. */
  groups(memberId: string, tenantId: string | undefined, limit: number): Promise<GroupProjection[]>;
  /** The role named `name`, with its MCP server `USE` permission. */
  role(name: string, tenantId: string | undefined): Promise<RoleProjection | null>;
  /** Runs between the principal reads and the rest (a test hook; MongoDB only). */
  afterPrincipalSnapshot?(): void | Promise<void>;
  /**
   * The config documents of the slots, each with its MCP settings override and its tombstones
   * under `mcpSettings` (at most `tombstoneLimit + 1`), as one batch of at most `limit` rows (none
   * when no document matches).
   */
  configs(
    slots: readonly AuthorityConfigSlot[],
    tenantId: string | undefined,
    limit: number,
    tombstoneLimit: number,
  ): Promise<readonly AggregateBatch<ConfigProjection>[]>;
  /** How many servers have one of `serverNames` or `normalizedNames`. */
  serverCount(
    serverNames: readonly string[],
    normalizedNames: readonly string[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<number>;
  /** The servers with one of `serverNames` or `normalizedNames`. */
  servers(
    serverNames: readonly string[],
    normalizedNames: readonly string[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<ServerProjection[]>;
  /**
   * The agents linked to one of `serverNames`, their `mcpServerNames` narrowed to those names, as
   * one batch of at most `limit` rows (none when no agent matches).
   */
  agents(
    serverNames: readonly string[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<readonly AggregateBatch<AgentProjection>[]>;
  /** How many of the user's credentials the selectors name (none without selectors). */
  credentialCount(
    userId: string,
    selectors: readonly AuthorityCredentialSelector[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<number>;
  /** The user's credentials the selectors name (none without selectors). */
  credentials(
    userId: string,
    selectors: readonly AuthorityCredentialSelector[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<PluginAuthProjection[]>;
  /** How many of the user's OAuth token records the selectors name (none without selectors). */
  tokenCount(
    userId: string,
    selectors: readonly AuthorityTokenSelector[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<number>;
  /** The user's OAuth token records the selectors name (none without selectors). */
  tokens(
    userId: string,
    selectors: readonly AuthorityTokenSelector[],
    tenantId: string | undefined,
    limit: number,
  ): Promise<TokenProjection[]>;
  /** How many ACL entries of the selection's principals are on its servers or agents. */
  aclCount(
    selection: AuthorityAclSelection,
    tenantId: string | undefined,
    limit: number,
  ): Promise<number>;
  /** The ACL entries of the selection's principals on its servers or agents. */
  aclEntries(
    selection: AuthorityAclSelection,
    tenantId: string | undefined,
    limit: number,
  ): Promise<AclProjection[]>;
}

/** The current proof of `targets` for the user, from the reads of one snapshot. */
async function loadCurrentProof(
  isValidId: IsValidId,
  reads: MCPAuthoritySnapshotReads,
  userId: string,
  tenantId: string | undefined,
  boot: MCPAuthorityBootRevision,
  targets: readonly PreparedTarget[],
): Promise<MCPAuthorityProofV1> {
  if (!isValidId(userId)) {
    reject('malformed_input', 'MCP authority user identity is invalid');
  }
  if (!boot.revision.trim() || !boot.digest.trim()) {
    reject('malformed_input', 'MCP boot authority revision is malformed');
  }

  const user = await reads.user(userId, tenantId);
  if (!user) {
    reject('user_revoked', 'MCP authority user no longer exists');
  }
  const actualTenantId = user.tenantId ?? null;
  if (actualTenantId !== (tenantId ?? null)) {
    reject('principal_changed', 'MCP authority tenant identity changed');
  }
  const roleName = user.role?.trim();
  const provider = user.provider?.trim();
  if (!roleName || !provider) {
    reject('proof_unavailable', 'MCP authority principal data is malformed');
  }
  const memberId = user.idOnTheSource || userId;

  const groupCount = await reads.groupCount(memberId, tenantId, MAX_MCP_AUTHORITY_GROUPS + 1);
  const groups = await reads.groups(memberId, tenantId, MAX_MCP_AUTHORITY_GROUPS + 1);
  const role = await reads.role(roleName, tenantId);
  assertCompleteBatch(groups, groupCount, MAX_MCP_AUTHORITY_GROUPS, 'MCP group membership');
  if (!role || role.name !== roleName) {
    reject('role_changed', 'MCP authority role no longer exists');
  }
  const useMCP = role.permissions?.[PermissionTypes.MCP_SERVERS]?.[Permissions.USE] === true;
  if (!useMCP) {
    reject('mcp_use_revoked', 'MCP server use permission is not current');
  }
  await reads.afterPrincipalSnapshot?.();
  const sortedGroups = groups.sort((left, right) =>
    idText(left._id).localeCompare(idText(right._id)),
  );
  const slots = configSlots(userId, roleName, sortedGroups);
  const lookupNames = [
    ...new Set(targets.flatMap((target) => [target.serverName, target.normalizedServerName])),
  ];
  const oauthSelectors = targets
    .filter((target) => target.requiresOAuth)
    .flatMap((target) => oauthTokenIdentities(target.serverName));
  const selectedServerNames = targets.map((target) => target.serverName);
  const selectedDatabaseServerNames = targets
    .filter((target) => target.source === 'database')
    .map((target) => target.serverName);
  const normalizedNames = targets.map((target) => target.normalizedServerName);
  const credentialSelectors = targets
    .filter((target) => target.credentialFields.length > 0)
    .map((target) => ({
      pluginKey: `${Constants.mcp_prefix}${target.serverName}`,
      authFields: target.credentialFields,
    }));

  const configBatch = await reads.configs(
    slots,
    tenantId,
    MAX_MCP_AUTHORITY_GROUPS + 4,
    MAX_MCP_AUTHORITY_CONFIG_TOMBSTONES + 1,
  );
  const configs = unwrapAggregateBatch(configBatch, slots.length, 'Applicable MCP configuration');
  const serverLimit = MAX_MCP_AUTHORITY_TARGETS * 2 + 1;
  const serverCount = await reads.serverCount(lookupNames, normalizedNames, tenantId, serverLimit);
  const servers = await reads.servers(lookupNames, normalizedNames, tenantId, serverLimit);
  assertCompleteBatch(servers, serverCount, MAX_MCP_AUTHORITY_TARGETS * 2, 'Selected MCP servers');
  const agentBatch = await reads.agents(
    selectedDatabaseServerNames,
    tenantId,
    MAX_MCP_AUTHORITY_AGENTS + 1,
  );
  const agents = unwrapAggregateBatch(
    agentBatch,
    MAX_MCP_AUTHORITY_AGENTS,
    'Selected MCP Agent linkage',
  );
  const credentialCount = await reads.credentialCount(
    userId,
    credentialSelectors,
    tenantId,
    MAX_MCP_AUTHORITY_CREDENTIALS + 1,
  );
  const credentials = await reads.credentials(
    userId,
    credentialSelectors,
    tenantId,
    MAX_MCP_AUTHORITY_CREDENTIALS + 1,
  );
  assertCompleteBatch(
    credentials,
    credentialCount,
    MAX_MCP_AUTHORITY_CREDENTIALS,
    'Selected MCP credentials',
  );
  const tokenLimit = MAX_MCP_AUTHORITY_TARGETS * OAUTH_TOKEN_TYPES.length + 1;
  const tokenCount = await reads.tokenCount(userId, oauthSelectors, tenantId, tokenLimit);
  const tokens = await reads.tokens(userId, oauthSelectors, tenantId, tokenLimit);
  assertCompleteBatch(
    tokens,
    tokenCount,
    MAX_MCP_AUTHORITY_TARGETS * OAUTH_TOKEN_TYPES.length,
    'Selected MCP OAuth grants',
  );

  const serverIds = servers.map((server) => server._id);
  const agentIds = agents.map((agent) => agent._id);
  let aclEntries: AclProjection[] = [];
  if (serverIds.length > 0 || agentIds.length > 0) {
    const selection: AuthorityAclSelection = {
      userId,
      roleName,
      groupIds: sortedGroups.map((group) => group._id),
      serverIds,
      agentIds,
    };
    const aclCount = await reads.aclCount(selection, tenantId, MAX_MCP_AUTHORITY_ACL_ENTRIES + 1);
    aclEntries = await reads.aclEntries(selection, tenantId, MAX_MCP_AUTHORITY_ACL_ENTRIES + 1);
    assertCompleteBatch(
      aclEntries,
      aclCount,
      MAX_MCP_AUTHORITY_ACL_ENTRIES,
      'Selected MCP ACL entries',
    );
  }

  const serversByNormalizedName = new Map<string, ServerProjection[]>();
  for (const server of servers) {
    if (
      typeof server.serverName !== 'string' ||
      typeof server.normalizedServerName !== 'string' ||
      server.normalizedServerName !== normalizeServerName(server.serverName)
    ) {
      reject('proof_unavailable', 'MCP server name index is malformed');
    }
    appendIndexValue(serversByNormalizedName, server.normalizedServerName, server);
  }
  const selectedServerNameSet = new Set(selectedServerNames);
  const agentsByServerName = new Map<string, AgentProjection[]>();
  for (const agent of agents) {
    if (
      agent.mcpServerNames !== undefined &&
      (!Array.isArray(agent.mcpServerNames) ||
        agent.mcpServerNames.some((serverName) => typeof serverName !== 'string'))
    ) {
      reject('proof_unavailable', 'MCP Agent linkage proof is malformed');
    }
    const selectedLinks = new Set(
      (agent.mcpServerNames ?? []).filter((serverName) => selectedServerNameSet.has(serverName)),
    );
    for (const serverName of selectedLinks) {
      appendIndexValue(agentsByServerName, serverName, agent);
    }
  }
  const credentialsByPluginKey = new Map<string, PluginAuthProjection[]>();
  for (const credential of credentials) {
    if (typeof credential.pluginKey !== 'string') {
      reject('proof_unavailable', 'MCP credential proof is malformed');
    }
    appendIndexValue(credentialsByPluginKey, credential.pluginKey, credential);
  }
  const serverNameByOAuthTokenKey = new Map<string, string>();
  for (const selected of targets) {
    for (const { type, identifier } of oauthTokenIdentities(selected.serverName)) {
      serverNameByOAuthTokenKey.set(oauthTokenKey(type, identifier), selected.serverName);
    }
  }
  const tokensByServerName = new Map<string, TokenProjection[]>();
  for (const token of tokens) {
    const serverName =
      token.type && token.identifier
        ? serverNameByOAuthTokenKey.get(oauthTokenKey(token.type, token.identifier))
        : undefined;
    if (!serverName) {
      reject('proof_unavailable', 'MCP OAuth grant proof is malformed');
    }
    appendIndexValue(tokensByServerName, serverName, token);
  }
  const directAclByServerId = new Map<string, AclProjection[]>();
  const agentAclByAgentId = new Map<string, AclProjection[]>();
  for (const entry of aclEntries) {
    const resourceId = idText(entry.resourceId);
    if (entry.resourceType === ResourceType.MCPSERVER) {
      appendIndexValue(directAclByServerId, resourceId, entry);
    } else if (entry.resourceType === ResourceType.AGENT) {
      appendIndexValue(agentAclByAgentId, resourceId, entry);
    } else {
      reject('proof_unavailable', 'MCP ACL proof is malformed');
    }
  }

  const userSourceIdentityDigest = digestMCPAuthorityValue(sourceIdentity(user));
  const userProof = {
    userId,
    tenantId: actualTenantId,
    role: roleName,
    provider,
    sourceIdentityDigest: userSourceIdentityDigest,
    revision: digestMCPAuthorityValue({
      userId,
      tenantId: actualTenantId,
      role: roleName,
      provider,
      sourceIdentityDigest: userSourceIdentityDigest,
      createdAt: user.createdAt ?? null,
      updatedAt: user.updatedAt ?? null,
    }),
  };
  const groupProofs = sortedGroups.map(buildGroupProof);
  const groupsRevision = digestMCPAuthorityValue(groupProofs);
  const configProofs = buildConfigProofs(slots, configs);
  const configsRevision = digestMCPAuthorityValue(configProofs);
  const configSourceRevision = computeConfigSourceRevision(
    isValidId,
    boot.digest,
    configs.map((config) => ({
      _id: config._id,
      principalType: config.principalType,
      principalId: config.principalId,
      priority: config.priority,
      overrides:
        config.mcpSettingsOverride === undefined
          ? undefined
          : { mcpSettings: config.mcpSettingsOverride },
      tombstones: config.tombstones,
      isActive: config.isActive,
      configVersion: config.configVersion,
      updatedAt: config.updatedAt,
    })),
  );
  const roleProof = {
    id: idText(role._id),
    name: role.name,
    use: useMCP,
    revision: digestMCPAuthorityValue({
      id: idText(role._id),
      name: role.name,
      use: useMCP,
    }),
  };
  const sharedWithoutRevision = {
    user: userProof,
    groups: groupProofs,
    configs: configProofs,
    role: roleProof,
    boot,
    groupsRevision,
    configsRevision,
  };
  const shared = {
    ...sharedWithoutRevision,
    revision: digestMCPAuthorityValue(sharedWithoutRevision),
  };
  const now = new Date();
  const serverProofs = targets.map((target): MCPAuthorityServerProofV1 => {
    const collidingServers = serversByNormalizedName.get(target.normalizedServerName) ?? [];
    if (collidingServers.length > 1) {
      reject('server_changed', 'MCP server normalized identity is ambiguous', target.serverName);
    }
    const databaseServer = collidingServers[0];
    if (target.source === 'config' && databaseServer) {
      reject(
        'server_changed',
        'MCP config server collides with a database server identity',
        target.serverName,
      );
    }
    if (
      target.source === 'database' &&
      (!databaseServer || databaseServer.serverName !== target.serverName)
    ) {
      reject('server_revoked', 'Selected MCP database server no longer exists', target.serverName);
    }
    const databaseId = databaseServer ? idText(databaseServer._id) : null;
    if (target.databaseId && target.databaseId !== databaseId) {
      reject('server_changed', 'Selected MCP database identity changed', target.serverName);
    }
    const serverRevision = databaseServer
      ? computeDatabaseSourceRevision(isValidId, {
          databaseId: idText(databaseServer._id),
          serverName: databaseServer.serverName,
          author: databaseServer.author.toString(),
          config: databaseServer.config,
          createdAt: databaseServer.createdAt,
          updatedAt: databaseServer.updatedAt,
        })
      : digestMCPAuthorityValue({ source: 'config', name: target.serverName });
    const sourceRevision = target.source === 'database' ? serverRevision : configSourceRevision;
    if (target.sourceRevision !== sourceRevision) {
      reject(
        target.source === 'database' ? 'server_changed' : 'config_changed',
        'Selected MCP source changed before authority was resolved',
        target.serverName,
      );
    }
    const linkedAgents = (agentsByServerName.get(target.serverName) ?? []).sort((left, right) =>
      idText(left._id).localeCompare(idText(right._id)),
    );
    const linkedAgentIds = linkedAgents.map((agent) => idText(agent._id));
    const directAcl = databaseId ? (directAclByServerId.get(databaseId) ?? []) : [];
    const agentAcl = linkedAgentIds.flatMap((id) => agentAclByAgentId.get(id) ?? []);
    const directAccess = directAcl.some((entry) => isActiveViewAcl(entry, now));
    const agentAccess = agentAcl.some((entry) => isActiveViewAcl(entry, now));
    if (target.source === 'database' && !directAccess && !agentAccess) {
      reject('access_revoked', 'Selected MCP server access is not current', target.serverName);
    }
    const authorizationRevision = digestMCPAuthorityValue({
      linkedAgents: linkedAgents.map((agent) => ({
        id: idText(agent._id),
        agentId: agent.id,
        serverNames: [...(agent.mcpServerNames ?? [])].sort(),
        createdAt: agent.createdAt ?? null,
        updatedAt: agent.updatedAt ?? null,
      })),
      directAcl: directAcl
        .map(aclRevision)
        .sort((left, right) =>
          String((left as { id: string }).id).localeCompare((right as { id: string }).id),
        ),
      agentAcl: agentAcl
        .map(aclRevision)
        .sort((left, right) =>
          String((left as { id: string }).id).localeCompare((right as { id: string }).id),
        ),
      directAccess,
      agentAccess,
    });
    const credential = buildCredentialProof(
      isValidId,
      target,
      credentialsByPluginKey.get(`${Constants.mcp_prefix}${target.serverName}`) ?? [],
    );
    const oauth = buildOAuthProof(target, tokensByServerName.get(target.serverName) ?? [], now);
    if (credential.revision !== target.expectedCredentialRevision) {
      reject(
        'credential_changed',
        'Selected MCP credential changed before authority was resolved',
        target.serverName,
      );
    }
    if (oauth.generation !== target.expectedOAuthGrantGeneration) {
      reject(
        'oauth_grant_changed',
        'Selected MCP OAuth grant changed before authority was resolved',
        target.serverName,
      );
    }
    const effectivePolicyDigest = digestMCPAuthorityValue({
      sharedRevision: shared.revision,
      serverRevision,
      sourceRevision,
      resolvedConfigDigest: target.resolvedConfigDigest,
      authorizationRevision,
      credentialRevision: credential.revision,
      oauthRevision: oauth.revision,
    });
    const proofWithoutRevision = {
      serverName: target.serverName,
      normalizedServerName: target.normalizedServerName,
      source: target.source,
      databaseId,
      sourceRevision,
      resolvedConfigDigest: target.resolvedConfigDigest,
      serverRevision,
      linkedAgentIds,
      directAccess,
      agentAccess,
      authorizationRevision,
      credentialFields: credential.fields,
      credentialRevision: credential.revision,
      requiresOAuth: target.requiresOAuth,
      oauthGrantGeneration: oauth.generation,
      oauthRevision: oauth.revision,
      effectivePolicyDigest,
    };
    return {
      ...proofWithoutRevision,
      revision: digestMCPAuthorityValue(proofWithoutRevision),
    };
  });
  const proofWithoutRevision = {
    version: MCP_AUTHORITY_PROOF_VERSION,
    shared,
    servers: serverProofs,
  };
  return deepFreeze({
    ...proofWithoutRevision,
    revision: digestMCPAuthorityValue(proofWithoutRevision),
  });
}

function assertionTargets(proofs: readonly MCPAuthorityProofV1[]): readonly PreparedTarget[] {
  const targets = new Map<string, PreparedTarget & { revision: string }>();
  const normalizedTargets = new Map<string, string>();
  for (const proof of proofs) {
    for (const server of proof.servers) {
      const current = targets.get(server.serverName);
      if (current && current.revision !== server.revision) {
        reject('malformed_input', 'MCP authority proofs disagree about a selected server');
      }
      const normalizedTarget = normalizedTargets.get(server.normalizedServerName);
      if (normalizedTarget && normalizedTarget !== server.serverName) {
        reject('malformed_input', 'MCP authority proofs contain ambiguous server identities');
      }
      normalizedTargets.set(server.normalizedServerName, server.serverName);
      targets.set(server.serverName, {
        serverName: server.serverName,
        normalizedServerName: server.normalizedServerName,
        source: server.source,
        databaseId: server.databaseId,
        sourceRevision: server.sourceRevision,
        expectedCredentialRevision: server.credentialRevision,
        expectedOAuthGrantGeneration: server.oauthGrantGeneration,
        resolvedConfigDigest: server.resolvedConfigDigest,
        credentialFields: server.credentialFields,
        requiresOAuth: server.requiresOAuth,
        revision: server.revision,
      });
    }
  }
  const prepared = [...targets.values()]
    .map(({ revision: _revision, ...target }) => target)
    .sort((left, right) => left.serverName.localeCompare(right.serverName));
  assertPreparedTargetBounds(prepared);
  return prepared;
}

function assertSameSharedProofs(proofs: readonly MCPAuthorityProofV1[]): void {
  const first = proofs[0];
  for (let index = 1; index < proofs.length; index++) {
    const proof = proofs[index];
    if (
      proof.shared.revision !== first.shared.revision ||
      proof.shared.user.userId !== first.shared.user.userId ||
      proof.shared.user.tenantId !== first.shared.user.tenantId
    ) {
      reject('malformed_input', 'MCP authority proofs do not share one principal snapshot');
    }
  }
}

function compareProofs(
  expectedProofs: readonly MCPAuthorityProofV1[],
  current: MCPAuthorityProofV1,
): void {
  const expectedShared = expectedProofs[0].shared;
  if (current.shared.user.revision !== expectedShared.user.revision) {
    reject('principal_changed', 'MCP authority principal identity changed');
  }
  if (current.shared.groupsRevision !== expectedShared.groupsRevision) {
    reject('groups_changed', 'MCP authority group membership changed');
  }
  if (current.shared.configsRevision !== expectedShared.configsRevision) {
    reject('config_changed', 'MCP authority configuration changed');
  }
  if (!current.shared.role.use) {
    reject('mcp_use_revoked', 'MCP server use permission was revoked');
  }
  if (current.shared.role.revision !== expectedShared.role.revision) {
    reject('role_changed', 'MCP authority role changed');
  }
  if (current.shared.revision !== expectedShared.revision) {
    reject('principal_changed', 'MCP authority shared snapshot changed');
  }
  const expectedServers = new Map(
    expectedProofs.flatMap((proof) => proof.servers).map((server) => [server.serverName, server]),
  );
  for (const server of current.servers) {
    const expected = expectedServers.get(server.serverName);
    if (!expected) {
      reject('malformed_input', 'MCP authority assertion contains an unexpected server');
    }
    if (
      server.normalizedServerName !== expected.normalizedServerName ||
      server.source !== expected.source ||
      server.databaseId !== expected.databaseId ||
      server.sourceRevision !== expected.sourceRevision ||
      server.serverRevision !== expected.serverRevision ||
      server.resolvedConfigDigest !== expected.resolvedConfigDigest
    ) {
      reject('server_changed', 'Selected MCP server configuration changed', server.serverName);
    }
    if (server.source === 'database' && !server.directAccess && !server.agentAccess) {
      reject('access_revoked', 'Selected MCP server access was revoked', server.serverName);
    }
    if (server.authorizationRevision !== expected.authorizationRevision) {
      reject(
        'authorization_changed',
        'Selected MCP server authorization changed',
        server.serverName,
      );
    }
    if (server.credentialRevision !== expected.credentialRevision) {
      reject('credential_changed', 'Selected MCP credential changed', server.serverName);
    }
    if (server.oauthRevision !== expected.oauthRevision) {
      reject('oauth_grant_changed', 'Selected MCP OAuth grant changed', server.serverName);
    }
    if (server.effectivePolicyDigest !== expected.effectivePolicyDigest) {
      reject('server_changed', 'Selected MCP effective policy changed', server.serverName);
    }
    if (server.revision !== expected.revision) {
      reject('server_changed', 'Selected MCP authority proof changed', server.serverName);
    }
  }
}
/** The revision helpers callers compute their targets with, for the backend's id format. */
export interface MCPAuthorityRevisions {
  createMCPAuthorityConfigSourceRevision(
    bootDigest: string,
    documents: readonly MCPAuthorityConfigSourceDocument[],
  ): string;
  createMCPAuthorityDatabaseSourceRevision(server: MCPAuthorityDatabaseSourceInput): string;
  createMCPAuthorityCredentialRevision(
    credentialFields: readonly string[],
    credentials: readonly MCPAuthorityCredentialSourceDocument[],
  ): string;
}

/** {@link MCPAuthorityRevisions} for the ids `isValidId` accepts. */
export function createMCPAuthorityRevisions(isValidId: IsValidId): MCPAuthorityRevisions {
  return {
    createMCPAuthorityConfigSourceRevision: (bootDigest, documents) =>
      computeConfigSourceRevision(isValidId, bootDigest, documents),
    createMCPAuthorityDatabaseSourceRevision: (server) =>
      computeDatabaseSourceRevision(isValidId, server),
    createMCPAuthorityCredentialRevision: (credentialFields, credentials) =>
      computeCredentialRevision(isValidId, credentialFields, credentials),
  };
}

/**
 * Runs `read` on one consistent snapshot of the database and resolves to its result (MongoDB: a
 * snapshot transaction on `session` or a session of its own). It rejects as the backend's reads
 * do; the methods turn any failure that is not an `MCPAuthorityProofError` into
 * `proof_unavailable`.
 */
export type MCPAuthoritySnapshotRunner<Session> = <T>(
  read: (reads: MCPAuthoritySnapshotReads) => Promise<T>,
  session: Session | undefined,
) => Promise<T>;

/** The inputs of the two methods, with the backend's session (MongoDB) or none. */
type WithSession<Input, Session> = Omit<Input, 'session'> & { readonly session?: Session };

/** The two methods of the port (with an optional backend session) on a snapshot runner. */
export function createMCPAuthorityOnSnapshot<Session = never>(options: {
  isValidId: IsValidId;
  runSnapshot: MCPAuthoritySnapshotRunner<Session>;
}): {
  resolveMCPAuthorityProof(
    input: WithSession<MCPAuthorityResolveInput, Session>,
  ): Promise<MCPAuthorityProofV1>;
  assertMCPAuthorityProofsCurrent(
    input: WithSession<MCPAuthorityAssertInput, Session>,
  ): Promise<void>;
} {
  const { isValidId, runSnapshot } = options;

  async function loadAuthoritativeSnapshot(
    userId: string,
    tenantId: string | undefined,
    boot: MCPAuthorityBootRevision,
    targets: readonly PreparedTarget[],
    session: Session | undefined,
  ): Promise<MCPAuthorityProofV1> {
    if ((getTenantId() ?? null) !== (tenantId ?? null)) {
      reject('proof_unavailable', 'MCP authority tenant context does not match its principal');
    }
    return runSnapshot(
      (reads) => loadCurrentProof(isValidId, reads, userId, tenantId, boot, targets),
      session,
    );
  }

  async function resolveMCPAuthorityProof(
    input: WithSession<MCPAuthorityResolveInput, Session>,
  ): Promise<MCPAuthorityProofV1> {
    try {
      const targets = prepareTargets(isValidId, input.targets);
      return await loadAuthoritativeSnapshot(
        input.userId,
        input.tenantId,
        input.boot,
        targets,
        input.session,
      );
    } catch (error) {
      throw asMCPError(error);
    }
  }

  async function assertMCPAuthorityProofsCurrent(
    input: WithSession<MCPAuthorityAssertInput, Session>,
  ): Promise<void> {
    try {
      const proofs = Array.isArray(input.proofs) ? input.proofs : [input.proofs];
      if (proofs.length === 0 || proofs.length > MAX_MCP_AUTHORITY_TARGETS) {
        reject('malformed_input', 'MCP authority proof composition exceeds its bounded shape');
      }
      proofs.forEach((proof) => assertProofIntegrity(isValidId, proof));
      assertSameSharedProofs(proofs);
      const expectedShared = proofs[0].shared;
      if (
        expectedShared.boot.revision !== input.boot.revision ||
        expectedShared.boot.digest !== input.boot.digest
      ) {
        reject('boot_revision_changed', 'Immutable MCP boot configuration changed');
      }
      const targets = assertionTargets(proofs);
      const current = await loadAuthoritativeSnapshot(
        expectedShared.user.userId,
        expectedShared.user.tenantId ?? undefined,
        input.boot,
        targets,
        input.session,
      );
      compareProofs(proofs, current);
    } catch (error) {
      throw asMCPError(error);
    }
  }

  return { resolveMCPAuthorityProof, assertMCPAuthorityProofsCurrent };
}
