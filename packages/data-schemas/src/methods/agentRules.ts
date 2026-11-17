/**
 * The agent store's database-neutral rules (`AgentStore`, `~/ports/agent`), shared by every
 * backend: the MongoDB methods (`./agent`) and the PostgreSQL store
 * (`adapters/postgres/stores/agent.ts`). The listing orders and their cursors, the popularity
 * page, the MCP server names derived from tools, the version history rules of `updateAgent`
 * (what a version snapshots, the duplicate rule, the operators that change the agent), the skill
 * allowlist self-heal, the revert plan, the action metadata hash and the graph edge cleanup loop
 * on storage steps. Filters and updates are in the store query language. Nothing here may import
 * `mongoose` or the MongoDB driver.
 */
import crypto from 'node:crypto';
import {
  Constants,
  SkillsScope,
  EToolResources,
  actionDelimiter,
  isActionTool,
} from 'librechat-data-provider';
import type { AgentToolResources } from 'librechat-data-provider';
import type { IAgent, AgentListSortOption } from '~/types';

const { mcp_delimiter } = Constants;

/**
 * Fallback used for the `author` sort when an agent has neither a joined
 * user display name nor a denormalized `authorName`. U+10FFFF is the highest
 * valid Unicode code point, so this sentinel sorts after every real display
 * name — including ones starting with an emoji, whose leading UTF-8 byte is
 * otherwise higher than any ASCII sentinel like `'zzz_unknown'`.
 */
export const AUTHOR_SORT_SENTINEL: string = String.fromCodePoint(0x10ffff);

/**
 * How each marketplace sort mode orders the agent list, and how a cursor taken from
 * that ordering has to be read back.
 *
 * `createdAt` is stored, while popularity counts and author display names are computed for
 * their respective paths. Each mode applies its cursor predicate before selecting the next
 * page.
 *
 * The cursor version is part of the ordering identity. Bump the version whenever an ordering's
 * comparison semantics change, or an older reader will resume a walk under semantics that no
 * longer exist. Cursors without a version are version 1 for rolling-deployment compatibility.
 *
 * `'recent'` is not a marketplace mode: it is the order this endpoint has always served when
 * nothing asks for one — most recently edited first — and the agent selector, the mention menu
 * and the schedule pickers still rely on it. The marketplace's own default, `'newest'`, orders
 * by creation instead, so it has to be requested explicitly.
 *
 * The `_id` tie-break is ascending for every mode except 'oldest'. The latter reverses both
 * keys so MongoDB can scan the existing `{ createdAt: -1, _id: 1 }` index backwards without
 * requiring a second ascending index.
 */
export const AGENT_SORT_CONFIG: Record<
  AgentListSortOption,
  {
    field: 'createdAt' | 'updatedAt' | 'favoriteCount' | 'authorSortKey';
    direction: 1 | -1;
    tieBreakDirection: 1 | -1;
    valueType: 'date' | 'number' | 'string';
    version: number;
  }
> = {
  recent: {
    field: 'updatedAt',
    direction: -1,
    tieBreakDirection: 1,
    valueType: 'date',
    version: 1,
  },
  newest: {
    field: 'createdAt',
    direction: -1,
    tieBreakDirection: 1,
    valueType: 'date',
    version: 1,
  },
  oldest: {
    field: 'createdAt',
    direction: 1,
    tieBreakDirection: -1,
    valueType: 'date',
    version: 1,
  },
  popular: {
    field: 'favoriteCount',
    direction: -1,
    tieBreakDirection: 1,
    valueType: 'number',
    version: 1,
  },
  // Version 2 records the normalized (`$toLower`) comparison key.
  author: {
    field: 'authorSortKey',
    direction: 1,
    tieBreakDirection: 1,
    valueType: 'string',
    version: 2,
  },
};

/**
 * Sort keys the list query needs internally — to order rows and to build the cursor —
 * but which are not part of the endpoint's response contract. `createdAt` in particular
 * has never been returned by this endpoint, and leaking any of them would make the
 * response shape depend on `?sort=`.
 */
export const INTERNAL_SORT_FIELDS = [
  'createdAt',
  'favoriteCount',
  'authorDisplayName',
  'authorSortKey',
] as const;

/**
 * Favourite counts are keyed per tenant because agent ids collide across tenants,
 * and a missing `tenantId` is the same tenant as an explicitly null one — the separator
 * is a code point no tenant id or agent id can contain.
 */
const FAVORITE_COUNT_KEY_SEPARATOR = '\u0000';
export function favoriteCountKey(tenantId: string | null | undefined, agentId: string): string {
  return `${tenantId ?? ''}${FAVORITE_COUNT_KEY_SEPARATOR}${agentId}`;
}

/**
 * Marks a list row whose owner contact the list query already resolved, so `attachOwnerContacts`
 * skips the ACL aggregation and the user lookup for it and strips this field from the response.
 */
export const AGENT_OWNER_CONTACT_RESOLVED_FIELD = '_ownerContactResolved';

/**
 * A stringified ObjectId is always exactly 24 hex characters. Checked explicitly rather
 * than with `ObjectId.isValid`, which also accepts any 12-character string.
 */
export const OBJECT_ID_HEX: RegExp = /^[0-9a-fA-F]{24}$/;

export interface AgentSortCursor {
  /** The last row's value for the mode's sort field; `''` means "that value was absent". */
  primary: string;
  /** The last row's `_id`, used as the tie-break. */
  secondary: string;
}

export type AgentSortCursorFailure = 'ordering-mismatch' | 'unreadable';

export class AgentSortCursorError extends Error {
  readonly code = 'AGENT_SORT_CURSOR_INVALID';

  constructor(readonly failure: AgentSortCursorFailure) {
    super(`Agent sort cursor ${failure}`);
    this.name = 'AgentSortCursorError';
  }
}

export type AgentSortCursorDecodeResult =
  | { kind: 'usable'; cursor: AgentSortCursor }
  | { kind: 'ordering-mismatch' }
  | { kind: 'unreadable' };

export function isAgentListSortOption(value: unknown): value is AgentListSortOption {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_SORT_CONFIG, value)
  );
}

function castCursorPrimary(
  valueType: 'date' | 'number' | 'string',
  raw: string,
): Date | number | string {
  if (valueType === 'date') {
    return new Date(raw);
  }
  if (valueType === 'number') {
    return Number(raw);
  }
  return raw;
}

/**
 * Cursor invariant: a cursor names the ordering it was produced under, and is honored only
 * by a reader that implements that ordering. A cursor that cannot be honored is an error,
 * never a silent restart.
 *
 * The `sort`/`version` pair is the ordering identity. Bump the version whenever an ordering's
 * comparison semantics change, or an older reader will resume a walk under semantics that no
 * longer exist. Cursors without a version are version 1 for rolling-deployment compatibility.
 *
 * Orderings past version 1 nest their boundary under `boundary`, where a pre-versioning reader
 * cannot find it — see {@link encodeAgentSortCursor}. A flat boundary claiming such a version
 * did not come from this encoder and is unreadable rather than trusted.
 *
 * Legacy cursors carry only `updatedAt` and `_id`; they name `recent`, whose ordering preserves
 * the old updated-time walk. A cursor naming another ordering is a mismatch, while malformed
 * data is unreadable; both are fail-closed.
 */
export function decodeAgentSortCursor(
  after: string,
  sort: AgentListSortOption,
): AgentSortCursorDecodeResult {
  try {
    const decoded: Record<string, unknown> = JSON.parse(
      Buffer.from(after, 'base64').toString('utf8'),
    );
    if (decoded == null || Array.isArray(decoded) || typeof decoded !== 'object') {
      return { kind: 'unreadable' };
    }

    const hasPrimary = typeof decoded.primary !== 'undefined';
    const hasLegacyPair = typeof decoded.updatedAt === 'string' && typeof decoded._id === 'string';
    /** Set once a versioned cursor's nested boundary has been lifted into place, so the
     *  legacy substitution below does not overwrite it with an absent `updatedAt`. */
    let hasNestedBoundary = false;
    let cursorSort: AgentListSortOption | null = null;

    if (typeof decoded.sort === 'undefined') {
      if (!hasPrimary && hasLegacyPair) {
        cursorSort = 'recent';
      } else if (
        hasPrimary &&
        hasLegacyPair &&
        decoded.primary === decoded.updatedAt &&
        decoded.secondary === decoded._id
      ) {
        // Cursors from the immediately preceding current release were recent cursors
        // without the explicit identity; retain their safe legacy interpretation.
        cursorSort = 'recent';
      } else {
        return { kind: 'unreadable' };
      }
    } else if (!isAgentListSortOption(decoded.sort)) {
      return { kind: 'unreadable' };
    } else {
      cursorSort = decoded.sort;
      const cursorVersion = typeof decoded.version === 'undefined' ? 1 : decoded.version;
      if (cursorVersion !== AGENT_SORT_CONFIG[cursorSort].version) {
        return { kind: 'ordering-mismatch' };
      }
      if (cursorVersion > 1) {
        const boundary = decoded.boundary;
        if (boundary == null || typeof boundary !== 'object' || Array.isArray(boundary)) {
          return { kind: 'unreadable' };
        }
        const { primary, secondary } = boundary as Record<string, unknown>;
        decoded.primary = primary;
        decoded.secondary = secondary;
        hasNestedBoundary = true;
      }
    }
    if (!hasPrimary && !hasNestedBoundary && hasLegacyPair && cursorSort !== 'recent') {
      return { kind: 'ordering-mismatch' };
    }
    if (cursorSort !== sort) {
      return { kind: 'ordering-mismatch' };
    }

    if (!hasPrimary && !hasNestedBoundary) {
      decoded.primary = decoded.updatedAt;
      decoded.secondary = decoded._id;
    }
    if (typeof decoded.secondary !== 'string' || !OBJECT_ID_HEX.test(decoded.secondary)) {
      return { kind: 'unreadable' };
    }

    const { valueType } = AGENT_SORT_CONFIG[sort];
    /* Coercion is not validation: `String(undefined)` is `'undefined'`, which compares as a
       perfectly ordinary author key and would resume the walk partway through the alphabet
       instead of failing closed. The date mode is caught by its cast; the numeric mode also
       requires a non-negative integer because favorite counts are discrete. The string mode
       has no cast to fail, so its boundary has to arrive as a string. */
    if (valueType === 'string' && typeof decoded.primary !== 'string') {
      return { kind: 'unreadable' };
    }
    const primary = String(decoded.primary);
    if (valueType === 'date') {
      if (primary !== '' && Number.isNaN(new Date(primary).getTime())) {
        return { kind: 'unreadable' };
      }
    } else if (valueType === 'number') {
      const numericPrimary = Number(primary);
      if (primary === '' || !Number.isInteger(numericPrimary) || numericPrimary < 0) {
        return { kind: 'unreadable' };
      }
    }
    return { kind: 'usable', cursor: { primary, secondary: decoded.secondary } };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Builds the filter that selects everything ordered after a decoded cursor.
 *
 * Field-name-agnostic: the same Date/Number/String comparison works whether the sort
 * field is stored (`createdAt`) or computed by an aggregation (`favoriteCount`/`authorSortKey`).
 *
 * Agents inserted outside Mongoose can lack `createdAt`, and legacy rows can
 * contain an explicit null. Mongo sorts both as the same null tier. Cursor predicates
 * therefore use a null equality branch so neither form disappears between pages.
 */
export function buildAgentSortCursorCondition(
  sort: AgentListSortOption,
  decoded: AgentSortCursor,
  /**
   * `decoded.secondary` already cast to the backend's id value. Passed in rather than
   * constructed here because the rules know no id type, and MongoDB's aggregation branch gets
   * no automatic query casting.
   */
  secondaryId: unknown,
): Record<string, unknown> {
  const { field, direction, tieBreakDirection, valueType } = AGENT_SORT_CONFIG[sort];
  const tieBreakOperator = tieBreakDirection === 1 ? '$gt' : '$lt';
  const tieBreak = { _id: { [tieBreakOperator]: secondaryId } };

  // Missing and explicit null dates occupy the same MongoDB sort tier.
  if (valueType === 'date' && decoded.primary === '') {
    const stillNull = { [field]: null, ...tieBreak };
    if (direction === 1) {
      return { $or: [stillNull, { [field]: { $exists: true, $ne: null } }] };
    }
    return stillNull;
  }

  const op = direction === -1 ? '$lt' : '$gt';
  const primaryValue = castCursorPrimary(valueType, decoded.primary);
  const branches: Record<string, unknown>[] = [
    { [field]: { [op]: primaryValue } },
    { [field]: primaryValue, ...tieBreak },
  ];

  if (valueType === 'date' && direction === -1) {
    branches.push({ [field]: null });
  }

  return { $or: branches };
}

/**
 * Cursor invariant: a cursor names the ordering it was produced under, and is honored only
 * by a reader that implements that ordering. A cursor that cannot be honored is an error,
 * never a silent restart.
 *
 * The `sort`/`version` pair is the ordering identity. Bump the version whenever an ordering's
 * comparison semantics change, or an older reader will resume a walk under semantics that no
 * longer exist. `recent` additionally carries the legacy pair so old instances can keep
 * reading its updated-time walk.
 *
 * A version is only half the protection, because it protects the reader that knows to look
 * at it. Instances deployed before versioning existed ignore unknown fields and read
 * `primary`/`secondary` straight out of the payload, so a bumped ordering whose boundary sits
 * where they expect it would still be resumed under the comparison it replaced. So any
 * ordering past version 1 carries its boundary nested instead: a reader that does not know
 * about versions finds no boundary it recognizes and fails closed, and one that does knows
 * where to look. Version 1 keeps the flat shape, which is what makes every cursor already in
 * flight readable across a deployment.
 */
export function encodeAgentSortCursor(
  sort: AgentListSortOption,
  lastAgent: Record<string, unknown>,
): string {
  const { field, valueType, version } = AGENT_SORT_CONFIG[sort];
  const rawValue = lastAgent[field];
  const asIsoDate = (value: unknown): string | null => {
    if (value == null) {
      return null;
    }
    let asDate: Date;
    if (value instanceof Date) {
      asDate = value;
    } else if (typeof value === 'string' || typeof value === 'number') {
      asDate = new Date(value);
    } else {
      asDate = new Date(Number.NaN);
    }
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  };

  let primary: string;
  if (valueType === 'date') {
    primary = asIsoDate(rawValue) ?? '';
  } else if (valueType === 'number') {
    primary = String(rawValue ?? 0);
  } else {
    /* The row already carries the key `$sort` compared — `$toLower` of the display name —
       so it is serialized as it stands. Lowercasing it again here would normalize what the
       database did not: `$toLower` is only defined over ASCII and leaves `Émile` uppercase,
       while JavaScript lowercases the whole of Unicode. The boundary would then land on
       `émile` (U+00E9) and the next page's `$match` would skip every key between it and
       `Émile` (U+00C9). */
    primary = String(rawValue ?? AUTHOR_SORT_SENTINEL);
  }

  const secondary = String(lastAgent._id);
  if (version > 1) {
    return Buffer.from(
      JSON.stringify({ sort, version, boundary: { primary, secondary } }),
    ).toString('base64');
  }

  const legacyUpdatedAt = sort === 'recent' ? asIsoDate(lastAgent.updatedAt) : null;
  return Buffer.from(
    JSON.stringify({
      sort,
      version,
      primary,
      secondary,
      ...(legacyUpdatedAt == null ? {} : { updatedAt: legacyUpdatedAt, _id: secondary }),
    }),
  ).toString('base64');
}

/**
 * Whether emptying an allowlist has to fall back to disabling skills.
 *
 * An explicit `all` or `selected` scope already defines what an empty
 * allowlist means, so neither is inferred from the array: `all` is the full
 * catalog on purpose, and `selected` with nothing selected resolves to no
 * skills on its own. Every other shape is: a missing scope, which is the
 * legacy form whose meaning came from the array, and an explicit `none`
 * carrying a true master flag, which the API accepts and which `skillDeps`
 * reads as standing permission to expose the skill-authoring tools.
 */
export function requiresSkillsDisable(scope: unknown): boolean {
  return scope !== SkillsScope.all && scope !== SkillsScope.selected;
}

/**
 * Mirrors `TOOL_RESOURCE_KEYS` in `@librechat/api` — the subset of
 * `EToolResources` that actually carries `file_ids` on an agent document.
 * `code_interpreter` is excluded (it belongs to the Assistants API, not
 * `AgentToolResources`) to avoid emitting dead MongoDB clauses.
 */
export const TOOL_RESOURCE_KEYS: ReadonlyArray<keyof AgentToolResources> = [
  EToolResources.execute_code,
  EToolResources.file_search,
  EToolResources.image_edit,
  EToolResources.context,
  EToolResources.ocr,
];

/** Graphs read per cleanup pass; bounds application memory the way the server-side update did. */
export const EDGE_CLEANUP_BATCH = 200;
/** Consecutive passes that may clean nothing before the loop gives up. */
export const EDGE_CLEANUP_STALLED_PASSES = 5;
/** Sweeps from the top before the loop gives up on references that keep being added. */
export const EDGE_CLEANUP_MAX_SWEEPS = 5;

export type AgentEdge = NonNullable<IAgent['edges']>[number];
type EdgeEndpoint = AgentEdge['from'];

/** An endpoint with `removed` taken out: a list loses those ids; a single id that is one becomes null. */
function pruneEndpoint(
  endpoint: EdgeEndpoint | null | undefined,
  removed: Set<string>,
): EdgeEndpoint | null {
  if (Array.isArray(endpoint)) {
    return endpoint.filter((id) => !removed.has(id));
  }
  return typeof endpoint === 'string' && removed.has(endpoint) ? null : (endpoint ?? null);
}

function hasEndpoint(endpoint: EdgeEndpoint | null): endpoint is EdgeEndpoint {
  return Array.isArray(endpoint) ? endpoint.length > 0 : endpoint != null;
}

/** The edges that survive removing `removed`, with those ids pruned from their endpoints. */
export function pruneEdges(edges: IAgent['edges'], removed: Set<string>): AgentEdge[] {
  return (edges ?? []).flatMap((edge) => {
    const from = pruneEndpoint(edge.from, removed);
    const to = pruneEndpoint(edge.to, removed);
    return hasEndpoint(from) && hasEndpoint(to) ? [{ ...edge, from, to }] : [];
  });
}

/**
 * Extracts unique MCP server names from tools array.
 * Tools format: "toolName_mcp_serverName" or "sys__server__sys_mcp_serverName"
 */
export function extractMCPServerNames(tools: string[] | undefined | null): string[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const serverNames = new Set<string>();
  for (const tool of tools) {
    if (!tool || !tool.includes(mcp_delimiter) || isActionTool(tool)) {
      continue;
    }
    const parts = tool.split(mcp_delimiter);
    /** This index only grants DB-backed servers (`ServerConfigsDB.getAccessibleServers`),
     * and DB server names are slugs that cannot contain the delimiter
     * (`generateServerNameFromTitle` strips underscores), so the last segment is always
     * the real server for those. A config server whose own name contains the delimiter
     * yields a trailing segment that is not its name; resolving that needs the configured
     * server list, which is unavailable here - see #14449. */
    if (parts.length >= 2) {
      serverNames.add(parts[parts.length - 1]);
    }
  }
  return Array.from(serverNames);
}

/**
 * Rebuilds an agent's MCP server index across a tools update without re-deriving
 * names from the keys.
 *
 * A name already on the agent was resolved against the registry when it was
 * stored, so it is authoritative; it carries forward while some retained tool
 * still resolves to it. Only keys that match none of them fall back to the
 * ambiguous trailing-segment derivation, which cannot tell a config server's
 * suffix from a real DB server name.
 */
export function rebuildMCPServerNames(
  tools: string[] | undefined | null,
  priorNames: string[],
): string[] {
  if (priorNames.length === 0) {
    return extractMCPServerNames(tools);
  }

  const retained = new Set<string>();
  const unmatched: string[] = [];
  for (const tool of tools ?? []) {
    if (!tool || !tool.includes(mcp_delimiter) || isActionTool(tool)) {
      continue;
    }
    const match = priorNames
      .filter((name) => tool.endsWith(`${mcp_delimiter}${name}`))
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      retained.add(match);
    } else {
      unmatched.push(tool);
    }
  }

  for (const name of extractMCPServerNames(unmatched)) {
    retained.add(name);
  }
  return Array.from(retained);
}

export const hasOperatorKeys = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.keys(value as object).length > 0;

/** Resolves a dotted operator path, such as `tool_resources.file_search.file_ids`. */
export function resolveDocumentPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current =
      current instanceof Map ? current.get(segment) : (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Removes a dotted operator path from an in-memory version projection. */
export function deleteDocumentPath(source: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf == null) return;
  let current: Record<string, unknown> = source;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null || next instanceof Map) return;
    current = next as Record<string, unknown>;
  }
  delete current[leaf];
}

/** The values an `$addToSet` specification would add, flattening the `$each` form. */
function addToSetCandidates(spec: unknown): unknown[] {
  if (
    typeof spec === 'object' &&
    spec !== null &&
    Array.isArray((spec as { $each?: unknown }).$each)
  ) {
    return (spec as { $each: unknown[] }).$each;
  }
  return [spec];
}

/**
 * Whether an update's atomic operators can still change the stored document. `$push`
 * always appends and `$pull` matches on arbitrary query criteria, so both count as
 * mutating. `$addToSet` is a no-op once every value it adds is already stored, which is
 * exactly what an idempotent retry looks like, so it is resolved against the document.
 * Whatever cannot be compared cheaply counts as mutating: over-reporting only records a
 * redundant version, while under-reporting would apply a change no version records.
 */
export function operatorsMutateDocument(
  currentObject: Record<string, unknown>,
  $push: unknown,
  $pull: unknown,
  $addToSet: unknown,
  $unset: unknown,
): boolean {
  if (hasOperatorKeys($push) || hasOperatorKeys($pull)) {
    return true;
  }

  if (hasOperatorKeys($unset)) {
    for (const path of Object.keys($unset as Record<string, unknown>)) {
      if (resolveDocumentPath(currentObject, path) !== undefined) return true;
    }
  }

  if (!hasOperatorKeys($addToSet)) {
    return false;
  }

  for (const [path, spec] of Object.entries($addToSet as Record<string, unknown>)) {
    const existing = resolveDocumentPath(currentObject, path);
    const stored = Array.isArray(existing) ? existing : [];
    for (const candidate of addToSetCandidates(spec)) {
      if (typeof candidate === 'object' && candidate !== null) {
        return true;
      }
      if (!stored.includes(candidate)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a version already exists in the versions array, excluding timestamp and author fields.
 */
export function isDuplicateVersion(
  updateData: Record<string, unknown>,
  currentData: Record<string, unknown>,
  versions: Record<string, unknown>[],
  actionsHash: string | null = null,
): Record<string, unknown> | null {
  if (!versions || versions.length === 0) {
    return null;
  }

  const excludeFields = [
    '_id',
    'id',
    'createdAt',
    'updatedAt',
    'author',
    'updatedBy',
    'created_at',
    'updated_at',
    '__v',
    'versions',
    'actionsHash',
  ];

  const {
    $push: _$push,
    $pull: _$pull,
    $addToSet: _$addToSet,
    $unset,
    ...directUpdates
  } = updateData;

  if (Object.keys(directUpdates).length === 0 && !hasOperatorKeys($unset) && !actionsHash) {
    return null;
  }

  const wouldBeVersion = { ...currentData, ...directUpdates } as Record<string, unknown>;
  if (hasOperatorKeys($unset)) {
    for (const path of Object.keys($unset as Record<string, unknown>)) {
      deleteDocumentPath(wouldBeVersion, path);
    }
  }
  const lastVersion = versions[versions.length - 1] as Record<string, unknown>;

  if (actionsHash && lastVersion.actionsHash !== actionsHash) {
    return null;
  }

  const allFields = new Set([...Object.keys(wouldBeVersion), ...Object.keys(lastVersion)]);
  const importantFields = Array.from(allFields).filter((field) => !excludeFields.includes(field));

  let isMatch = true;
  for (const field of importantFields) {
    const wouldBeValue = wouldBeVersion[field];
    const lastVersionValue = lastVersion[field];

    if (!wouldBeValue && !lastVersionValue) {
      continue;
    }

    // Handle arrays
    if (Array.isArray(wouldBeValue) || Array.isArray(lastVersionValue)) {
      let wouldBeArr: unknown[];
      if (Array.isArray(wouldBeValue)) {
        wouldBeArr = wouldBeValue;
      } else if (wouldBeValue == null) {
        wouldBeArr = [];
      } else {
        wouldBeArr = [wouldBeValue];
      }

      let lastVersionArr: unknown[];
      if (Array.isArray(lastVersionValue)) {
        lastVersionArr = lastVersionValue;
      } else if (lastVersionValue == null) {
        lastVersionArr = [];
      } else {
        lastVersionArr = [lastVersionValue];
      }

      if (wouldBeArr.length !== lastVersionArr.length) {
        isMatch = false;
        break;
      }

      if (wouldBeArr.length > 0 && typeof wouldBeArr[0] === 'object' && wouldBeArr[0] !== null) {
        const sortedWouldBe = [...wouldBeArr].map((item) => JSON.stringify(item)).sort();
        const sortedVersion = [...lastVersionArr].map((item) => JSON.stringify(item)).sort();

        if (!sortedWouldBe.every((item, i) => item === sortedVersion[i])) {
          isMatch = false;
          break;
        }
      } else {
        const sortedWouldBe = [...wouldBeArr].sort() as string[];
        const sortedVersion = [...lastVersionArr].sort() as string[];

        if (!sortedWouldBe.every((item, i) => item === sortedVersion[i])) {
          isMatch = false;
          break;
        }
      }
    }
    // Handle objects
    else if (typeof wouldBeValue === 'object' && wouldBeValue !== null) {
      const lastVersionObj =
        typeof lastVersionValue === 'object' && lastVersionValue !== null ? lastVersionValue : {};

      const wouldBeKeys = Object.keys(wouldBeValue as Record<string, unknown>);
      const lastVersionKeys = Object.keys(lastVersionObj as Record<string, unknown>);

      if (wouldBeKeys.length === 0 && lastVersionKeys.length === 0) {
        continue;
      }

      if (JSON.stringify(wouldBeValue) !== JSON.stringify(lastVersionObj)) {
        isMatch = false;
        break;
      }
    }
    // Handle primitive values
    else {
      if (wouldBeValue !== lastVersionValue) {
        if (
          typeof wouldBeValue === 'boolean' &&
          wouldBeValue === false &&
          lastVersionValue === undefined
        ) {
          continue;
        }
        if (
          typeof wouldBeValue === 'string' &&
          wouldBeValue === '' &&
          lastVersionValue === undefined
        ) {
          continue;
        }
        isMatch = false;
        break;
      }
    }
  }

  return isMatch ? lastVersion : null;
}

/**
 * Generates a hash of action metadata for version comparison.
 */
export async function generateActionMetadataHash(
  actionIds: string[] | null | undefined,
  actions: Array<{ action_id: string; metadata: Record<string, unknown> | null }>,
): Promise<string> {
  if (!actionIds || actionIds.length === 0) {
    return '';
  }

  const actionMap = new Map<string, Record<string, unknown> | null>();
  actions.forEach((action) => {
    actionMap.set(action.action_id, action.metadata);
  });

  const sortedActionIds = [...actionIds].sort();

  const metadataString = sortedActionIds
    .map((actionFullId) => {
      const parts = actionFullId.split(actionDelimiter);
      const actionId = parts[1];

      const metadata = actionMap.get(actionId);
      if (!metadata) {
        return `${actionId}:null`;
      }

      const sortedKeys = Object.keys(metadata).sort();
      const metadataStr = sortedKeys
        .map((key) => `${key}:${JSON.stringify(metadata[key])}`)
        .join(',');
      return `${actionId}:{${metadataStr}}`;
    })
    .join(';');

  const encoder = new TextEncoder();
  const data = encoder.encode(metadataString);
  const hashBuffer = await crypto.webcrypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

/* ------------------------------------------------------------------ graph edge cleanup */

/** A graph as the edge cleanup reads it. */
export interface AgentGraphEdges<Id> {
  _id: Id;
  edges?: IAgent['edges'];
}

/** What the edge cleanup reads and writes, per backend. */
export interface AgentEdgeCleanupSteps<Id> {
  /** Up to `limit` graphs matching `filter`, in `_id` order, with their `_id` and `edges`. */
  findGraphs(filter: Record<string, unknown>, limit: number): Promise<AgentGraphEdges<Id>[]>;
  /**
   * Writes each graph's `next` edges only while its stored edges still equal `edges` (the
   * ones read); resolves how many graphs matched.
   */
  compareAndSetEdges(
    writes: Array<{ _id: Id; edges: IAgent['edges']; next: AgentEdge[] }>,
  ): Promise<number>;
}

/**
 * Removes deleted agent references from active graphs in the requested tenant.
 * Graphs are read a page at a time behind an `_id` cursor, and each page's
 * pruned edges are written back behind a compare-and-set on the edges that were
 * read, so a concurrent edit is never overwritten. A graph whose edges changed
 * underneath fails its compare-and-set and is left behind the cursor, so once
 * the cursor is exhausted one more sweep from the top picks up every miss (and
 * any reference added meanwhile); the cleanup ends when a sweep from the top
 * finds nothing, and gives up after a bounded number of sweeps if references
 * keep being added. This is the plain-operator form of what was an
 * aggregation-pipeline update, which Amazon DocumentDB rejects.
 */
export async function removeAgentIdsFromEdges<Id>(
  steps: AgentEdgeCleanupSteps<Id>,
  agentIds: string[],
  tenantId?: string | null,
): Promise<void> {
  if (agentIds.length === 0) {
    return;
  }
  const filter: Record<string, unknown> = {
    /** `null` pins the cleanup to tenantless graphs (matches a missing field). */
    ...(tenantId !== undefined ? { tenantId } : {}),
    $or: [{ 'edges.from': { $in: agentIds } }, { 'edges.to': { $in: agentIds } }],
  };
  const removed = new Set(agentIds);
  let stalledPasses = 0;
  let sweeps = 0;
  let after: Id | undefined;
  for (;;) {
    const graphs = await steps.findGraphs(
      after == null ? filter : { ...filter, _id: { $gt: after } },
      EDGE_CLEANUP_BATCH,
    );
    if (graphs.length === 0) {
      if (after == null) {
        return;
      }
      sweeps += 1;
      if (sweeps >= EDGE_CLEANUP_MAX_SWEEPS) {
        throw new Error(
          `[removeAgentIdsFromEdges] references kept being added during cleanup (${EDGE_CLEANUP_MAX_SWEEPS} sweeps)`,
        );
      }
      after = undefined;
      continue;
    }
    const matchedCount = await steps.compareAndSetEdges(
      graphs.map((graph) => ({
        _id: graph._id,
        edges: graph.edges,
        next: pruneEdges(graph.edges, removed),
      })),
    );
    stalledPasses = matchedCount === 0 ? stalledPasses + 1 : 0;
    if (stalledPasses >= EDGE_CLEANUP_STALLED_PASSES) {
      throw new Error(
        `[removeAgentIdsFromEdges] graph edges kept changing during cleanup (${EDGE_CLEANUP_STALLED_PASSES} passes without progress)`,
      );
    }
    after = graphs[graphs.length - 1]._id;
  }
}

/* ------------------------------------------------------------------ writes */

/** The code environments an agent's data references (its own and its choices). */
export function codeEnvironmentReferences(data: Record<string, unknown>): string[] {
  return [
    data.code_environment_id,
    ...(Array.isArray(data.code_environment_ids) ? data.code_environment_ids : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** The code environments an update leaves the agent referencing, its added choices included. */
export function agentUpdateEnvironmentIds(updateData: Record<string, unknown>): string[] {
  const nextEnvironmentIds = codeEnvironmentReferences({
    ...updateData,
    ...(typeof updateData.$set === 'object' && updateData.$set != null ? updateData.$set : {}),
  });
  for (const operator of ['$push', '$addToSet']) {
    const update = updateData[operator] as { code_environment_ids?: unknown } | undefined;
    const values = update?.code_environment_ids;
    const added =
      values != null && typeof values === 'object' && '$each' in values
        ? (values as { $each: unknown }).$each
        : values;
    nextEnvironmentIds.push(
      ...codeEnvironmentReferences({
        code_environment_ids: Array.isArray(added) ? added : [added],
      }),
    );
  }
  return nextEnvironmentIds;
}

/** Drops the skill ids that no longer exist (the backend's read, with the external registry). */
export type PruneSkillIds = (skillIds: string[]) => Promise<string[]>;

/**
 * The record `createAgent` inserts: `agentData` (its allowlist pruned, skills turned off when
 * that empties a legacy one; `agentData` is updated in place, as callers observe) with its
 * first version, the default category and the MCP server names derived from its tools unless
 * given.
 */
export async function prepareAgentCreate(
  agentData: Record<string, unknown>,
  pruneSkills: PruneSkillIds,
): Promise<Record<string, unknown>> {
  if (Array.isArray(agentData.skills) && agentData.skills.length > 0) {
    const prunedSkills = await pruneSkills(agentData.skills as string[]);
    agentData.skills = prunedSkills;
    /** Fail closed when pruning empties a non-empty allowlist: empty +
     *  enabled means the full catalog, and hygiene must never widen scope.
     *  See `requiresSkillsDisable` for which scopes opt out. */
    if (prunedSkills.length === 0 && requiresSkillsDisable(agentData.skills_scope)) {
      agentData.skills_enabled = false;
    }
  }
  const { author: _author, ...versionData } = agentData;
  const timestamp = new Date();
  return {
    ...agentData,
    versions: [
      {
        ...versionData,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    category: (agentData.category as string) || 'general',
    /** Callers that authorized the tools pass resolved names; deriving from the key
     * alone cannot tell a config server's suffix from a real DB server name. */
    mcpServerNames:
      (agentData.mcpServerNames as string[] | undefined) ??
      extractMCPServerNames(agentData.tools as string[] | undefined),
  };
}

/** What the version rules of `updateAgent` read beyond the agent, per backend. */
export interface AgentUpdateSteps {
  pruneSkills: PruneSkillIds;
  /** The action definitions of these action ids, with their metadata. */
  getActions(actionIds: string[]): Promise<unknown[]>;
  /** The user id as the backend stores it in a version's `updatedBy`. */
  toUserId(userId: string): unknown;
  /** Logs a failed action read (the hash is then left out). */
  onActionsError(error: unknown): void;
}

/**
 * The version rules of `updateAgent`, given the matched agent as a plain record
 * (`currentObject`): prunes a written allowlist, re-derives the MCP server names when tools are
 * written, hashes the agent's action definitions, and adds the version entry to `updateData`
 * (`$push.versions`) unless versioning is skipped or the entry would duplicate the newest one
 * (then the operators judged no-ops are dropped too). `updateData` is updated in place, as
 * callers observe. Resolves whether the version entry was suppressed as a duplicate.
 */
export async function prepareAgentUpdate(
  currentObject: Record<string, unknown>,
  updateData: Record<string, unknown>,
  options: { updatingUserId?: string | null; forceVersion?: boolean; skipVersioning?: boolean },
  steps: AgentUpdateSteps,
): Promise<{ suppressedVersionEntry: boolean }> {
  const { updatingUserId = null, forceVersion = false, skipVersioning = false } = options;
  /** Set when the update would snapshot a version identical to the newest one. The write
   *  still lands; only the `versions` entry is dropped. */
  let suppressedVersionEntry = false;
  const { __v, _id, id: __id, versions, author: _author, ...versionData } = currentObject;
  const { $push, $pull, $addToSet, $unset, ...directUpdates } = updateData;

  /** Self-heal: drop allowlist ids whose skill no longer exists in the
   *  database or the external registry.
   *  A dangling id keeps the allowlist non-empty while scoping the
   *  runtime catalog to an empty intersection, silently disabling
   *  skills for the agent. When pruning empties a non-empty allowlist,
   *  fail closed and disable skills: empty + enabled means the full
   *  catalog, and hygiene must never widen scope. (An explicit user
   *  `skills: []` submission skips this branch and keeps the
   *  full-catalog semantics.)
   *
   *  An `all` or `selected` scope opts out, from the payload or the
   *  stored document, because it already defines what an empty allowlist
   *  means. See `requiresSkillsDisable`. */
  if (Array.isArray(directUpdates.skills) && directUpdates.skills.length > 0) {
    const prunedSkills = await steps.pruneSkills(directUpdates.skills as string[]);
    directUpdates.skills = prunedSkills;
    updateData.skills = prunedSkills;
    const effectiveScope = directUpdates.skills_scope ?? currentObject.skills_scope;
    if (prunedSkills.length === 0 && requiresSkillsDisable(effectiveScope)) {
      directUpdates.skills_enabled = false;
      updateData.skills_enabled = false;
    }
  }

  // Sync mcpServerNames when tools are updated
  if (directUpdates.tools !== undefined) {
    /** Callers that authorized the tools pass resolved names; deriving from the key
     * alone cannot tell a config server's suffix from a real DB server name. */
    const supplied = directUpdates.mcpServerNames as string[] | undefined;
    const mcpServerNames =
      supplied ??
      rebuildMCPServerNames(
        directUpdates.tools as string[],
        (currentObject.mcpServerNames as string[] | undefined) ?? [],
      );
    directUpdates.mcpServerNames = mcpServerNames;
    updateData.mcpServerNames = mcpServerNames;
  }

  let actionsHash: string | null = null;

  // Generate actions hash if agent has actions
  const currentActions = currentObject.actions as string[] | undefined;
  if (currentActions && currentActions.length > 0) {
    const actionIds = currentActions
      .map((action: string) => {
        const parts = action.split(actionDelimiter);
        return parts[1];
      })
      .filter(Boolean);

    if (actionIds.length > 0) {
      try {
        const actions = await steps.getActions(actionIds);

        actionsHash = await generateActionMetadataHash(
          currentActions,
          actions as Array<{ action_id: string; metadata: Record<string, unknown> | null }>,
        );
      } catch (error) {
        steps.onActionsError(error);
      }
    }
  }

  const shouldCreateVersion =
    !skipVersioning &&
    (forceVersion ||
      Object.keys(directUpdates).length > 0 ||
      $push ||
      $pull ||
      $addToSet ||
      $unset);

  if (shouldCreateVersion) {
    const duplicateVersion = isDuplicateVersion(
      updateData,
      versionData,
      versions as Record<string, unknown>[],
      actionsHash,
    );
    /** A duplicate snapshot adds no history, but the write itself must still land: the
     *  document is regularly not equal to its newest version, because `$push`/`$pull`/
     *  `$addToSet` snapshot the pre-update state and `skipVersioning` snapshots nothing.
     *  `isDuplicateVersion` compares direct updates only, so it cannot speak for an
     *  update that also carries an operator that lands a change; suppressing there
     *  would apply a change no version records. An operator that changes nothing, the
     *  shape of an idempotent retry, leaves the snapshot a genuine duplicate. */
    const mutatesOutsideSnapshot = operatorsMutateDocument(
      currentObject,
      $push,
      $pull,
      $addToSet,
      $unset,
    );
    if (duplicateVersion && !forceVersion && !mutatesOutsideSnapshot) {
      suppressedVersionEntry = true;
      /** Every operator that reaches here was judged unable to change the document,
       *  and for `$addToSet` that reading came from a document fetched before the
       *  write, so it cannot bind a concurrent one: a `$pull` landing in between would
       *  leave this update re-adding the value with no version entry to record it.
       *  Drop what was judged a no-op rather than race it, so the suppressed write
       *  carries no operator at all and is true by construction instead of true only
       *  while nothing else writes first. */
      delete updateData.$addToSet;
      delete updateData.$push;
      delete updateData.$pull;
      delete updateData.$unset;
    }
  }

  const versionEntry: Record<string, unknown> = {
    ...versionData,
    ...directUpdates,
    updatedAt: new Date(),
  };
  if (hasOperatorKeys($unset)) {
    for (const path of Object.keys($unset as Record<string, unknown>)) {
      deleteDocumentPath(versionEntry, path);
    }
  }

  if (actionsHash) {
    versionEntry.actionsHash = actionsHash;
  }

  if (updatingUserId) {
    versionEntry.updatedBy = steps.toUserId(updatingUserId);
  }

  if (shouldCreateVersion && !suppressedVersionEntry) {
    updateData.$push = {
      ...(($push as Record<string, unknown>) || {}),
      versions: versionEntry,
    };
  }
  return { suppressedVersionEntry };
}

/** The fields a revert removes when the restored version lacks them. */
const UNSET_ON_RESTORE = [
  'code_environment_id',
  'code_workspace_id',
  'code_environment_ids',
  'repositoryInstructions',
  'git_identity',
  'instructionsPrompt',
  'skills_scope',
  'skill_authoring_enabled',
];

/**
 * The state `revertAgentVersion` restores from `version` (a copy without its identity and
 * authorship, its allowlist pruned) and the update that writes it.
 */
export async function prepareAgentRevert(
  version: Record<string, unknown>,
  pruneSkills: PruneSkillIds,
): Promise<{ revertToVersion: Record<string, unknown>; revertUpdate: Record<string, unknown> }> {
  const revertToVersion = { ...version };
  delete revertToVersion._id;
  delete revertToVersion.id;
  delete revertToVersion.versions;
  delete revertToVersion.author;
  delete revertToVersion.updatedBy;

  /** Version snapshots can predate skill deletions; restoring one verbatim
   *  would resurrect dangling allowlist ids that scope the catalog to
   *  nothing. Same self-heal (and fail-closed-on-empty rule) as
   *  `createAgent`/`updateAgent`. */
  if (Array.isArray(revertToVersion.skills) && revertToVersion.skills.length > 0) {
    const prunedSkills = await pruneSkills(revertToVersion.skills as string[]);
    revertToVersion.skills = prunedSkills;
    /** The snapshot carries its own scope, and an All-scoped version keeps
     *  its allowlist, so failing closed here would restore the version as
     *  Off. See `requiresSkillsDisable`. */
    if (prunedSkills.length === 0 && requiresSkillsDisable(revertToVersion.skills_scope)) {
      revertToVersion.skills_enabled = false;
    }
  }

  const unsetOnRestore: Record<string, 1> = {};
  for (const field of UNSET_ON_RESTORE) {
    if (!Object.prototype.hasOwnProperty.call(revertToVersion, field)) {
      unsetOnRestore[field] = 1;
    }
  }
  const revertUpdate =
    Object.keys(unsetOnRestore).length > 0
      ? { $set: revertToVersion, $unset: unsetOnRestore }
      : { $set: revertToVersion };
  return { revertToVersion, revertUpdate };
}

/** The filter and updates of `removeAgentResourceFiles`: `$pullAll` per tool resource. */
export function agentResourceFilesPull(files: Array<{ tool_resource: string; file_id: string }>): {
  $pullAll: Record<string, string[]>;
} {
  const filesByResource = files.reduce(
    (acc: Record<string, string[]>, { tool_resource, file_id }) => {
      if (!acc[tool_resource]) {
        acc[tool_resource] = [];
      }
      acc[tool_resource].push(file_id);
      return acc;
    },
    {},
  );

  const pullAllOps: Record<string, string[]> = {};
  for (const [resource, fileIds] of Object.entries(filesByResource)) {
    const fileIdsPath = `tool_resources.${resource}.file_ids`;
    pullAllOps[fileIdsPath] = fileIds;
  }
  return { $pullAll: pullAllOps };
}

/** The agents with any of `file_ids` under an agent tool resource. */
export function toolResourceFilesFilter(file_ids: string[]): Record<string, unknown> {
  return {
    $or: TOOL_RESOURCE_KEYS.map((key) => ({
      [`tool_resources.${key}.file_ids`]: { $in: file_ids },
    })),
  };
}

/** The `$pullAll` removing `file_ids` from every agent tool resource. */
export function toolResourceFilesPullAll(file_ids: string[]): {
  $pullAll: Record<string, string[]>;
} {
  return {
    $pullAll: TOOL_RESOURCE_KEYS.reduce<Record<string, string[]>>((acc, key) => {
      acc[`tool_resources.${key}.file_ids`] = file_ids;
      return acc;
    }, {}),
  };
}

/**
 * Which of the requested files the agents read still reference, leaving out the agent
 * `excludeAgentObjectId` under `excludeToolResource` (every resource when omitted).
 */
export function sharedResourceFileIds(
  agents: Array<{ _id: unknown; tool_resources?: IAgent['tool_resources'] }>,
  file_ids: string[],
  excludeAgentObjectId?: string,
  excludeToolResource?: string,
): string[] {
  const requested = new Set(file_ids);
  const shared = new Set<string>();
  for (const agent of agents) {
    const isExcludedAgent =
      excludeAgentObjectId != null && String(agent._id) === excludeAgentObjectId;
    for (const key of TOOL_RESOURCE_KEYS) {
      if (isExcludedAgent && (excludeToolResource == null || key === excludeToolResource)) {
        continue;
      }
      const fileIds = agent.tool_resources?.[key]?.file_ids;
      if (fileIds == null) {
        continue;
      }
      for (const fileId of fileIds) {
        if (requested.has(fileId)) {
          shared.add(fileId);
        }
      }
    }
  }
  return [...shared];
}

/** The avatar compare-and-set filter of `updateAgentAvatar`. */
export function agentAvatarFilter(
  id: string,
  previousAvatar?: { filepath: string; source: string } | null,
): Record<string, unknown> {
  const searchParameter: Record<string, unknown> = { id };
  if (previousAvatar === null) {
    searchParameter.avatar = null;
  } else if (previousAvatar !== undefined) {
    searchParameter['avatar.filepath'] = previousAvatar.filepath;
    searchParameter['avatar.source'] = previousAvatar.source;
  }
  return searchParameter;
}

/** Agent ids per tenant (agent ids are unique per tenant only). */
export function agentIdsByTenant(
  agents: Array<{ id: string; tenantId?: string | null }>,
): Map<string | null, string[]> {
  const idsByTenant = new Map<string | null, string[]>();
  for (const agent of agents) {
    const tenant = agent.tenantId ?? null;
    const bucket = idsByTenant.get(tenant);
    if (bucket) {
      bucket.push(agent.id);
    } else {
      idsByTenant.set(tenant, [agent.id]);
    }
  }
  return idsByTenant;
}

/* ------------------------------------------------------------------ listings */

/** The parameters of `getListAgentsByAccess`. */
export interface AgentListParams<Id = unknown> {
  accessibleIds?: Id[] | null;
  otherParams?: Record<string, unknown>;
  tenantId?: string | null;
  limit?: number | null;
  after?: string | null;
  includeSkillConfig?: boolean;
  includeExecutionConfig?: boolean;
  sort?: AgentListSortOption;
}

/** A page of `getListAgentsByAccess`. */
export interface AgentListPage {
  object: string;
  data: Array<Record<string, unknown>>;
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
  after: string | null;
}

/**
 * The normalized listing: the page size (`null`: unpaged; clamped to 1..1000, 20 when
 * unreadable), the order (an unknown one falls back to `recent`), the match (`otherParams`
 * with the accessible ids, or the tenant for `null` ids; a string `author` cast by
 * `toAuthorId`) and the projection.
 */
export function normalizeAgentList<Id>(
  {
    accessibleIds = [],
    otherParams = {},
    tenantId,
    limit = 100,
    includeSkillConfig = false,
    includeExecutionConfig = false,
    sort: sortInput = 'recent',
  }: AgentListParams<Id>,
  toAuthorId: (author: string) => unknown,
): {
  isPaginated: boolean;
  normalizedLimit: number | null;
  sort: AgentListSortOption;
  baseQuery: Record<string, unknown>;
  projection: Record<string, 1>;
} {
  const isPaginated = limit !== null && limit !== undefined;
  const normalizedLimit = isPaginated
    ? Math.min(Math.max(1, parseInt(String(limit)) || 20), 1000)
    : null;
  // The HTTP layer allowlists `sort`, but this method is also called directly by
  // internal callers, and everything below indexes `AGENT_SORT_CONFIG` by it.
  const sort: AgentListSortOption = AGENT_SORT_CONFIG[sortInput] != null ? sortInput : 'recent';

  const baseQuery: Record<string, unknown> = {
    ...otherParams,
    ...(accessibleIds === null ? { tenantId: tenantId ?? null } : { _id: { $in: accessibleIds } }),
  };

  // `.find()` casts query values against the schema automatically; MongoDB's aggregate
  // branch builds a raw `$match` stage, which does not. Cast unconditionally (both
  // branches) so this stays true even if the `.find()` branch changes later.
  if (typeof baseQuery.author === 'string') {
    baseQuery.author = toAuthorId(baseQuery.author);
  }

  const projection: Record<string, 1> = {
    id: 1,
    _id: 1,
    name: 1,
    avatar: 1,
    author: 1,
    description: 1,
    conversation_starters: 1,
    updatedAt: 1,
    createdAt: 1,
    category: 1,
    support_contact: 1,
    is_promoted: 1,
  };

  if (includeSkillConfig) {
    projection.skills = 1;
    projection.skills_enabled = 1;
    projection.skill_authoring_enabled = 1;
    projection.skills_scope = 1;
  }
  if (includeExecutionConfig) {
    projection.tools = 1;
    projection.stateful_code_sessions = 1;
    projection.code_environment_id = 1;
    projection.code_workspace_id = 1;
    projection.code_environment_ids = 1;
    projection.repositoryInstructions = 1;
    projection.agent_ids = 1;
    projection['edges.from'] = 1;
    projection['edges.to'] = 1;
    projection['subagents.enabled'] = 1;
    projection['subagents.agent_ids'] = 1;
    projection['subagents.graphs.agent_ids'] = 1;
  }
  return { isPaginated, normalizedLimit, sort, baseQuery, projection };
}

/** A listed agent as the response carries it: of the tools only code execution, `author` a string. */
export function finalizeListedAgent(
  agent: Record<string, unknown>,
  includeExecutionConfig: boolean,
): Record<string, unknown> {
  if (includeExecutionConfig) {
    agent.tools =
      Array.isArray(agent.tools) && agent.tools.includes(EToolResources.execute_code)
        ? [EToolResources.execute_code]
        : [];
  }
  if (agent.author) {
    agent.author = (agent.author as { toString(): string }).toString();
  }
  return agent;
}

/** The page envelope, with the internal sort fields removed once the cursor is built. */
export function agentListEnvelope(
  data: Array<Record<string, unknown>>,
  hasMore: boolean,
  nextCursor: string | null,
): AgentListPage {
  for (const agent of data) {
    for (const field of INTERNAL_SORT_FIELDS) {
      delete agent[field];
    }
  }

  return {
    object: 'list',
    data,
    first_id: data.length > 0 ? (data[0].id as string) : null,
    last_id: data.length > 0 ? (data[data.length - 1].id as string) : null,
    has_more: hasMore,
    after: nextCursor,
  };
}

/** The cursor of `after` for `sort`; a cursor that cannot be honored throws, never restarts. */
export function readAgentSortCursor(
  after: string | null | undefined,
  sort: AgentListSortOption,
): AgentSortCursor | null {
  if (!after) {
    return null;
  }
  const decoded = decodeAgentSortCursor(after, sort);
  if (decoded.kind === 'usable') {
    return decoded.cursor;
  }
  throw new AgentSortCursorError(decoded.kind);
}

/** One favorite count: how many users of `tenantId` favor `agentId`. */
export interface AgentFavoriteCount {
  tenantId?: string | null;
  agentId: unknown;
  favoriteCount: number;
}

/** What the popularity listing reads, per backend. */
export interface AgentPopularitySteps<Id> {
  /** The favorite counts per tenant and agent id, scoped to the active tenant. */
  countFavorites(): Promise<AgentFavoriteCount[]>;
  /** The `_id`, `id` and `tenantId` of every agent matching `filter`. */
  findFavoritedRows(
    filter: Record<string, unknown>,
  ): Promise<Array<{ _id: Id; id: string; tenantId?: string | null }>>;
  /** The agents matching `filter`, with `projection`. */
  findAgents(
    filter: Record<string, unknown>,
    projection: Record<string, 1>,
  ): Promise<Array<Record<string, unknown>>>;
  /** Up to `limit` (`null`: every) agents matching `filter` in `_id` order, with `projection`. */
  findTail(
    filter: Record<string, unknown>,
    projection: Record<string, 1>,
    limit: number | null,
  ): Promise<Array<Record<string, unknown>>>;
  /** The id value of a cursor's hex id. */
  toId(hex: string): unknown;
}

/**
 * The `popular` page: the favored agents by count (ties by id), then the rest by id, with the
 * cursor read (`readCursor`) once the favored set is known.
 */
export async function listAgentsByPopularity<Id>(
  params: {
    baseQuery: Record<string, unknown>;
    projection: Record<string, 1>;
    normalizedLimit: number | null;
    readCursor: () => AgentSortCursor | null;
    finalize: (agent: Record<string, unknown>) => Record<string, unknown>;
  },
  steps: AgentPopularitySteps<Id>,
): Promise<AgentListPage> {
  const { baseQuery, projection, normalizedLimit, finalize } = params;
  const sort: AgentListSortOption = 'popular';
  /* Favourites live on user documents, so popularity has to be counted there. The
     group is keyed by tenant as well as agent id because ids collide across
     tenants, and the tenant plugin scopes the aggregation, so the result is
     bounded by the favourited agents in the caller's tenant rather than by the
     size of the marketplace. */
  const countRows = await steps.countFavorites();

  const favoriteCounts = new Map<string, number>();
  const favoritedAgentIds = new Set<string>();
  for (const row of countRows) {
    const agentId = row?.agentId;
    if (typeof agentId !== 'string' || !(row.favoriteCount > 0)) {
      continue;
    }
    favoriteCounts.set(favoriteCountKey(row.tenantId, agentId), row.favoriteCount);
    favoritedAgentIds.add(agentId);
  }

  /* Only favourited agents need ordering by count, and there are at most as many
     of them as there are favourites. Every other accessible agent has count 0 and
     is therefore ordered by `_id` alone, which the index serves as a range scan —
     so a page costs the favourited set plus one page, never the whole corpus. */
  const favoritedRows =
    favoritedAgentIds.size > 0
      ? await steps.findFavoritedRows({
          $and: [baseQuery, { id: { $in: [...favoritedAgentIds] } }],
        })
      : [];
  const decodedCursor = params.readCursor();
  const cursorCount = decodedCursor ? Number(decodedCursor.primary) : null;
  const cursorIdHex = decodedCursor ? decodedCursor.secondary.toLowerCase() : null;
  const favorited = favoritedRows
    .map((row) => ({
      _id: row._id,
      idHex: String(row._id),
      favoriteCount: favoriteCounts.get(favoriteCountKey(row.tenantId, row.id)) ?? 0,
    }))
    // The `$in` matches by agent id, so a row whose own tenant never favourited it
    // belongs to the count-0 tail instead.
    .filter((row) => row.favoriteCount > 0)
    .sort((a, b) => {
      if (a.favoriteCount !== b.favoriteCount) {
        return b.favoriteCount - a.favoriteCount;
      }
      if (a.idHex === b.idHex) {
        return 0;
      }
      return a.idHex < b.idHex ? -1 : 1;
    });

  /* Counts are recomputed for each request. The order and cursor are stable within a
     count bucket while counts stay unchanged; client-side dedup can absorb rows that
     drift backward. An unseen row that gains favorites can cross upward between
     requests and be missed (berry-13/LibreChat#31). Pinning a ranking needs a
     materialized favorite counter and a revision to pin it against
     (berry-13/LibreChat#11); favorites carry no per-favorite timestamp. */
  let startIndex = favorited.length;
  if (cursorCount === null) {
    startIndex = 0;
  } else if (cursorCount > 0 && cursorIdHex) {
    const found = favorited.findIndex((row) =>
      row.favoriteCount !== cursorCount ? row.favoriteCount < cursorCount : row.idHex > cursorIdHex,
    );
    startIndex = found < 0 ? favorited.length : found;
  }

  const pageFavorited =
    normalizedLimit == null
      ? favorited.slice(startIndex)
      : favorited.slice(startIndex, startIndex + normalizedLimit);
  const favoritedHasMore =
    normalizedLimit != null && favorited.length > startIndex + normalizedLimit;

  const favoritedDocs =
    pageFavorited.length > 0
      ? await steps.findAgents(
          { $and: [baseQuery, { _id: { $in: pageFavorited.map((row) => row._id) } }] },
          projection,
        )
      : [];
  const favoritedById = new Map(favoritedDocs.map((agent) => [String(agent._id), agent]));
  const data = pageFavorited
    .map((row) => favoritedById.get(row.idHex))
    .filter((agent): agent is Record<string, unknown> => agent != null)
    .map(finalize);

  /* The count-0 tail is ordered by `_id` alone, so the database applies both the
     cursor predicate and the limit to it. */
  let tailHasMore = false;
  let tailCursorRow: Record<string, unknown> | null = null;
  if (!favoritedHasMore) {
    const remaining = normalizedLimit == null ? null : normalizedLimit - pageFavorited.length;
    const conditions: Record<string, unknown>[] = [baseQuery];
    if (favorited.length > 0) {
      conditions.push({ _id: { $nin: favorited.map((row) => row._id) } });
    }
    if (cursorCount === 0 && decodedCursor) {
      conditions.push({ _id: { $gt: steps.toId(decodedCursor.secondary) } });
    }
    // One extra row answers `has_more` without a second query.
    const tailRows = await steps.findTail(
      { $and: conditions },
      projection,
      remaining != null ? remaining + 1 : null,
    );
    tailHasMore = remaining != null && tailRows.length > remaining;
    const tailPage = remaining != null ? tailRows.slice(0, remaining) : tailRows;
    for (const agent of tailPage) {
      data.push(finalize(agent));
    }
    tailCursorRow = tailPage[tailPage.length - 1] ?? null;
  }

  const hasMore = favoritedHasMore || tailHasMore;
  const favoritedCursorRow = pageFavorited[pageFavorited.length - 1];
  let nextCursor: string | null = null;
  /* The whole row rather than its id alone: `encodeAgentSortCursor` carries the
     row's updatedAt only for the legacy-compatible recent mode. */
  if (hasMore && tailCursorRow) {
    nextCursor = encodeAgentSortCursor(sort, { ...tailCursorRow, favoriteCount: 0 });
  } else if (hasMore && favoritedCursorRow) {
    nextCursor = encodeAgentSortCursor(sort, {
      ...favoritedById.get(favoritedCursorRow.idHex),
      _id: favoritedCursorRow._id,
      favoriteCount: favoritedCursorRow.favoriteCount,
    });
  }
  return agentListEnvelope(data, hasMore, nextCursor);
}

/** The match of a management page (`toId` casts the cursor's id) after `after`. */
export function agentManagementMatch(
  params: { accessibleIds: unknown[] | null; tenantId: string; after?: string | null },
  toId: (hex: string) => unknown,
): Record<string, unknown> {
  const match: Record<string, unknown> = {
    tenantId: params.tenantId,
    ...(params.accessibleIds != null ? { _id: { $in: params.accessibleIds } } : {}),
  };

  if (params.after) {
    const cursor = JSON.parse(Buffer.from(params.after, 'base64').toString('utf8')) as {
      updatedAt: string;
      _id: string;
    };
    match.$or = [
      { updatedAt: { $lt: new Date(cursor.updatedAt) } },
      {
        updatedAt: new Date(cursor.updatedAt),
        _id: { $gt: toId(cursor._id) },
      },
    ];
  }
  return match;
}

/** The management page of the `limit + 1` agents read, with the cursor after its last one. */
export function agentManagementPage<T extends { _id: unknown; updatedAt: Date }>(
  agents: T[],
  limit: number,
): { data: T[]; has_more: boolean; after: string | null } {
  const hasMore = agents.length > limit;
  const data = hasMore ? agents.slice(0, limit) : agents;
  const lastAgent = data[data.length - 1];
  const nextCursor =
    hasMore && lastAgent
      ? Buffer.from(
          JSON.stringify({
            updatedAt: lastAgent.updatedAt.toISOString(),
            _id: String(lastAgent._id),
          }),
        ).toString('base64')
      : null;

  return { data, has_more: hasMore, after: nextCursor };
}
