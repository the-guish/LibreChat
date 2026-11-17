/**
 * The skill store's domain rules, shared by the MongoDB methods (`./skill`) and the PostgreSQL
 * store (`adapters/postgres/stores/skill.ts`; docs/postgres-port/PHASE4.md §8, S8): the pure
 * validation helpers (names, descriptions, bodies, titles, frontmatter, relative paths), the
 * structured columns derived from the frontmatter and their read-time backfill, the always-apply
 * cascade over the explicit flag, the frontmatter and the SKILL.md body, the create document and
 * the versioned update write, the keyset listings' filters, cursors and pages, the agent
 * allowlist pruning, the deletion mark, and the file rows' fields, conflicts and the cleanup
 * reference a replaced blob leaves. Nothing here may import `mongoose` or the MongoDB driver:
 * ids are whatever the backend hands out.
 */
import {
  SkillsScope,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_DESCRIPTION_SHORT_THRESHOLD as SKILL_DESCRIPTION_SHORT_THRESHOLD_SHARED,
  SKILL_DISPLAY_TITLE_MAX_LENGTH,
  SKILL_BODY_MAX_LENGTH,
  SKILL_NAME_PATTERN as SKILL_NAME_PATTERN_SHARED,
} from 'librechat-data-provider';
import type { CodeEnvRef } from 'librechat-data-provider';
import type {
  ValidationIssue,
  CreateSkillInput,
  UpdateSkillInput,
  DeleteSkillResult,
  UpsertSkillFileInput,
} from '~/types/skill';
import { isValidObjectIdString } from '~/utils/objectId';
import { stripYamlTrailingComment } from '~/utils/yaml';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

/** Partition an issue list into blocking errors and non-blocking warnings. */
/** Partition an issue list into blocking errors and non-blocking warnings. */
export function partitionIssues(issues: ValidationIssue[]): {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const issue of issues) {
    if (issue.severity === 'warning') {
      warnings.push(issue);
    } else {
      errors.push(issue);
    }
  }
  return { errors, warnings };
}

const SKILL_NAME_MAX = SKILL_NAME_MAX_LENGTH;
const SKILL_DESCRIPTION_MAX = SKILL_DESCRIPTION_MAX_LENGTH;
const SKILL_DESCRIPTION_SHORT_THRESHOLD = SKILL_DESCRIPTION_SHORT_THRESHOLD_SHARED;
const SKILL_DISPLAY_TITLE_MAX = SKILL_DISPLAY_TITLE_MAX_LENGTH;
const SKILL_BODY_MAX = SKILL_BODY_MAX_LENGTH;
const SKILL_FILE_PATH_MAX = 500;
const SKILL_NAME_PATTERN = SKILL_NAME_PATTERN_SHARED;
const RELATIVE_PATH_CHARS = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Brand namespaces reserved for Anthropic-published skills and first-party
 * bundles. Matched as prefixes, so `anthropic-helper` is rejected but
 * `research-anthropic-helper` is fine.
 */
const RESERVED_NAME_PREFIXES = ['anthropic-', 'claude-'];

/**
 * Slash-command names that collide with LibreChat / Claude Code CLI commands.
 * A skill with one of these names would shadow a real command in any
 * slash-command UI. Matched exactly (not as prefix).
 */
const RESERVED_NAME_WORDS = new Set([
  'help',
  'clear',
  'compact',
  'model',
  'exit',
  'quit',
  'settings',
  'anthropic',
  'claude',
]);

export function validateSkillName(name: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof name !== 'string' || name.length === 0) {
    issues.push({ field: 'name', code: 'REQUIRED', message: 'Name is required' });
    return issues;
  }
  if (name.length > SKILL_NAME_MAX) {
    issues.push({
      field: 'name',
      code: 'TOO_LONG',
      message: `Name must be ${SKILL_NAME_MAX} characters or less`,
    });
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push({
      field: 'name',
      code: 'INVALID_FORMAT',
      message:
        'Name must be kebab-case: start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens',
    });
  }
  const lowered = name.toLowerCase();
  if (RESERVED_NAME_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    issues.push({
      field: 'name',
      code: 'RESERVED_PREFIX',
      message: `Name cannot start with ${RESERVED_NAME_PREFIXES.map((p) => `"${p}"`).join(' or ')}`,
    });
  }
  if (RESERVED_NAME_WORDS.has(lowered)) {
    issues.push({
      field: 'name',
      code: 'RESERVED_WORD',
      message: `"${name}" is a reserved name`,
    });
  }
  return issues;
}

export function validateSkillDescription(description: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof description !== 'string' || description.trim().length === 0) {
    issues.push({
      field: 'description',
      code: 'REQUIRED',
      message: 'Description is required',
    });
    return issues;
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    issues.push({
      field: 'description',
      code: 'TOO_LONG',
      message: `Description must be ${SKILL_DESCRIPTION_MAX} characters or less`,
    });
  }
  if (description.trim().length < SKILL_DESCRIPTION_SHORT_THRESHOLD) {
    issues.push({
      field: 'description',
      code: 'TOO_SHORT',
      severity: 'warning',
      message:
        'Short descriptions may cause the agent to miss triggering opportunities — aim for a concrete "when to use this skill" sentence.',
    });
  }
  return issues;
}

export function validateSkillBody(body: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (body !== undefined && typeof body !== 'string') {
    issues.push({ field: 'body', code: 'INVALID_TYPE', message: 'Body must be a string' });
    return issues;
  }
  if (typeof body === 'string' && body.length > SKILL_BODY_MAX) {
    issues.push({
      field: 'body',
      code: 'TOO_LONG',
      message: `Body must be ${SKILL_BODY_MAX} characters or less`,
    });
  }
  return issues;
}

export function validateSkillDisplayTitle(displayTitle: unknown): ValidationIssue[] {
  if (displayTitle === undefined || displayTitle === null) {
    return [];
  }
  if (typeof displayTitle !== 'string') {
    return [
      { field: 'displayTitle', code: 'INVALID_TYPE', message: 'Display title must be a string' },
    ];
  }
  if (displayTitle.length > SKILL_DISPLAY_TITLE_MAX) {
    return [
      {
        field: 'displayTitle',
        code: 'TOO_LONG',
        message: `Display title must be ${SKILL_DISPLAY_TITLE_MAX} characters or less`,
      },
    ];
  }
  return [];
}

/**
 * Validate the top-level `alwaysApply` column input. Mirrors the boolean
 * check on `frontmatter['always-apply']` so a loosely-typed API caller
 * sending `{"alwaysApply": "false"}` (string) gets a clean 400 at the
 * validation boundary instead of relying on Mongoose casting quirks to
 * coerce the value.
 *
 * `undefined` is the only pass-through value (meaning "don't touch this
 * field"). `null` is rejected: PATCH forwards any non-`undefined` value
 * straight into `$set`, so a `null` payload would persist `null` in a
 * boolean column, leaving the skill in a state that is neither "on" nor
 * "off" while `listAlwaysApplySkills` only matches `true`.
 */
export function validateAlwaysApply(alwaysApply: unknown): ValidationIssue[] {
  if (alwaysApply === undefined) {
    return [];
  }
  if (typeof alwaysApply !== 'boolean') {
    return [
      {
        field: 'alwaysApply',
        code: 'INVALID_TYPE',
        message: 'alwaysApply must be a boolean',
      },
    ];
  }
  return [];
}

/**
 * Known fields allowed inside a skill's YAML frontmatter. Anything else is
 * reported as a warning (see `validateSkillFrontmatter`) rather than rejected:
 * the frontmatter convention keeps growing, and a single unrecognized key in
 * one `SKILL.md` used to fail its whole GitHub sync source. The list is derived
 * from Anthropic's Agent Skills spec plus the fields LibreChat needs to pass
 * through (`name`/`description` are duplicated from the top-level columns
 * because real `SKILL.md` files include them in their frontmatter block).
 */
const ALLOWED_FRONTMATTER_KEYS = new Set<string>([
  'name',
  'description',
  'when-to-use',
  'allowed-tools',
  'arguments',
  'argument-hint',
  'user-invocable',
  'disable-model-invocation',
  'always-apply',
  'alwaysApply',
  'model',
  'effort',
  'context',
  'agent',
  'paths',
  'shell',
  'hooks',
  'version',
  'license',
  'compatibility',
  'metadata',
  'references',
]);

const CANONICAL_FRONTMATTER_KEYS = new Map(
  Array.from(ALLOWED_FRONTMATTER_KEYS, (key) => [key.toLowerCase(), key]),
);

export function getCanonicalSkillFrontmatterKey(key: string): string | undefined {
  return CANONICAL_FRONTMATTER_KEYS.get(key.toLowerCase());
}

export function normalizeSkillFrontmatterKeys(
  frontmatter: Record<string, unknown>,
): { frontmatter: Record<string, unknown> } | { error: string } {
  const normalized = Object.create(null) as Record<string, unknown>;
  const recognizedKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(frontmatter)) {
    const canonicalKey = getCanonicalSkillFrontmatterKey(key);
    if (canonicalKey) {
      const previousKey = recognizedKeys.get(canonicalKey);
      if (previousKey) {
        return {
          error: `Recognized frontmatter keys "${previousKey}" and "${key}" both resolve to "${canonicalKey}"`,
        };
      }
      recognizedKeys.set(canonicalKey, key);
    }
    normalized[canonicalKey ?? key] = value;
  }
  return { frontmatter: normalized };
}

const FRONTMATTER_MAX_STRING = 2000;
const FRONTMATTER_MAX_ARRAY = 100;
const FRONTMATTER_MAX_DEPTH = 4;
const NON_PERSISTABLE_FRONTMATTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type FrontmatterKind = 'string' | 'number' | 'boolean' | 'stringArray';

const FRONTMATTER_KIND: Record<string, FrontmatterKind | FrontmatterKind[]> = {
  name: 'string',
  description: 'string',
  'when-to-use': 'string',
  'allowed-tools': ['string', 'stringArray'],
  arguments: ['string', 'stringArray'],
  'argument-hint': 'string',
  'user-invocable': 'boolean',
  'disable-model-invocation': 'boolean',
  'always-apply': 'boolean',
  alwaysApply: 'boolean',
  model: 'string',
  effort: ['string', 'number'],
  context: 'string',
  agent: 'string',
  paths: ['string', 'stringArray'],
  shell: 'string',
  version: 'string',
  license: 'string',
  compatibility: 'string',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidFrontmatterKey(key: string): boolean {
  return !key.includes('\u0000') && !NON_PERSISTABLE_FRONTMATTER_KEYS.has(key);
}

function containsInvalidFrontmatterKey(value: unknown, depth = 0): boolean {
  if (depth > FRONTMATTER_MAX_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((nestedValue) => containsInvalidFrontmatterKey(nestedValue, depth + 1));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nestedValue]) =>
      !isValidFrontmatterKey(key) || containsInvalidFrontmatterKey(nestedValue, depth + 1),
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= FRONTMATTER_MAX_ARRAY &&
    value.every((v) => typeof v === 'string' && v.length <= FRONTMATTER_MAX_STRING)
  );
}

function matchesKind(value: unknown, kind: FrontmatterKind): boolean {
  if (kind === 'string') {
    return typeof value === 'string' && value.length <= FRONTMATTER_MAX_STRING;
  }
  if (kind === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (kind === 'boolean') {
    return typeof value === 'boolean';
  }
  return isStringArray(value);
}

/**
 * Shallow structural sanity check for `hooks`/`metadata` objects. We don't
 * know their full schema yet, so we just verify they are plain objects with
 * JSON-serializable leaf values up to a max depth — enough to block pathological
 * payloads without constraining legitimate frontmatter extensions.
 */
function isJsonSafe(value: unknown, depth: number): boolean {
  if (depth > FRONTMATTER_MAX_DEPTH) {
    return false;
  }
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string') return (value as string).length <= FRONTMATTER_MAX_STRING;
  if (t === 'number') return Number.isFinite(value);
  if (t === 'boolean') return true;
  if (Array.isArray(value)) {
    if (value.length > FRONTMATTER_MAX_ARRAY) return false;
    return value.every((v) => isJsonSafe(v, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).every(
      ([key, nestedValue]) => isValidFrontmatterKey(key) && isJsonSafe(nestedValue, depth + 1),
    );
  }
  return false;
}

/**
 * Validate a skill's structured YAML frontmatter. Known keys are type-checked
 * against `FRONTMATTER_KIND`; `hooks`, `metadata` and `references` fall back to
 * a shallow JSON-safety check because their full schemas live outside this
 * module. Unknown keys are reported as warnings, not errors: authors regularly
 * carry keys from other tooling, and failing the skill for one of them takes
 * down every other skill in the same GitHub sync source.
 */
export function validateSkillFrontmatter(frontmatter: unknown): ValidationIssue[] {
  if (frontmatter === undefined || frontmatter === null) {
    return [];
  }
  if (!isPlainObject(frontmatter)) {
    return [
      {
        field: 'frontmatter',
        code: 'INVALID_TYPE',
        message: 'Frontmatter must be a plain object',
      },
    ];
  }

  const normalized = normalizeSkillFrontmatterKeys(frontmatter);
  if ('error' in normalized) {
    return [
      {
        field: 'frontmatter',
        code: 'DUPLICATE_KEY',
        message: normalized.error,
      },
    ];
  }

  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(normalized.frontmatter)) {
    if (!isValidFrontmatterKey(key)) {
      issues.push({
        field: 'frontmatter',
        code: 'INVALID_KEY',
        message: 'Frontmatter keys must be persistable object property names',
      });
      continue;
    }
    if (containsInvalidFrontmatterKey(value)) {
      issues.push({
        field: `frontmatter.${key}`,
        code: 'INVALID_KEY',
        message: `"${key}" contains a frontmatter key that cannot be persisted`,
      });
      continue;
    }
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      issues.push({
        field: `frontmatter.${key}`,
        code: 'UNKNOWN_KEY',
        severity: 'warning',
        message: `"${key}" is not a recognized frontmatter key and is stored as-is`,
      });
      /* The key is tolerated, its value still is not: an unrecognized key is
         persisted, so it stays inside the same depth, array and string bounds
         every structured key is held to. */
      if (!isJsonSafe(value, 0)) {
        issues.push({
          field: `frontmatter.${key}`,
          code: 'INVALID_SHAPE',
          message: `"${key}" must be a JSON-safe value (max depth ${FRONTMATTER_MAX_DEPTH}, max string ${FRONTMATTER_MAX_STRING}, max array ${FRONTMATTER_MAX_ARRAY})`,
        });
      }
      continue;
    }

    if (key === 'references') {
      if (!isJsonSafe(value, 0)) {
        issues.push({
          field: 'frontmatter.references',
          code: 'INVALID_SHAPE',
          message: `"references" must be a JSON-safe value (max depth ${FRONTMATTER_MAX_DEPTH}, max string ${FRONTMATTER_MAX_STRING})`,
        });
      }
      continue;
    }

    if (key === 'hooks' || key === 'metadata') {
      if (!isPlainObject(value) || !isJsonSafe(value, 0)) {
        issues.push({
          field: `frontmatter.${key}`,
          code: 'INVALID_SHAPE',
          message: `"${key}" must be a plain JSON-safe object (max depth ${FRONTMATTER_MAX_DEPTH}, max string ${FRONTMATTER_MAX_STRING})`,
        });
      }
      continue;
    }

    const expected = FRONTMATTER_KIND[key];
    if (!expected) {
      continue;
    }
    const kinds = Array.isArray(expected) ? expected : [expected];
    if (!kinds.some((kind) => matchesKind(value, kind))) {
      issues.push({
        field: `frontmatter.${key}`,
        code: 'INVALID_TYPE',
        message: `"${key}" must be ${kinds.join(' or ')}`,
      });
    }
  }
  return issues;
}

export function validateRelativePath(relativePath: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    issues.push({
      field: 'relativePath',
      code: 'REQUIRED',
      message: 'Relative path is required',
    });
    return issues;
  }
  if (relativePath.length > SKILL_FILE_PATH_MAX) {
    issues.push({
      field: 'relativePath',
      code: 'TOO_LONG',
      message: `Relative path must be ${SKILL_FILE_PATH_MAX} characters or less`,
    });
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    issues.push({
      field: 'relativePath',
      code: 'ABSOLUTE_PATH',
      message: 'Relative path must not start with a slash',
    });
  }
  if (!RELATIVE_PATH_CHARS.test(relativePath)) {
    issues.push({
      field: 'relativePath',
      code: 'INVALID_CHARS',
      message: 'Relative path contains invalid characters',
    });
  }
  const segments = relativePath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    issues.push({
      field: 'relativePath',
      code: 'TRAVERSAL',
      message: 'Relative path cannot contain empty segments or "." / ".."',
    });
  }
  if (relativePath === 'SKILL.md' || segments[0] === 'SKILL.md') {
    issues.push({
      field: 'relativePath',
      code: 'RESERVED',
      message: 'SKILL.md is managed via the skill body, not file uploads',
    });
  }
  return issues;
}

export function inferSkillFileCategory(
  relativePath: string,
): 'script' | 'reference' | 'asset' | 'other' {
  const [top] = relativePath.split('/');
  if (top === 'scripts') return 'script';
  if (top === 'references') return 'reference';
  if (top === 'assets') return 'asset';
  return 'other';
}

/**
 * Maps the runtime-enforced frontmatter fields onto their first-class
 * column equivalents. Returns only the keys that were explicitly set on the
 * frontmatter so callers can decide whether to write `undefined` (skip the
 * `$set`) versus a concrete value.
 *
 * `allowed-tools` accepts string or string[] per the validator; both are
 * normalized to an array. Empty strings are filtered out so a stray comma
 * in YAML doesn't leak through as `''`.
 */
export function deriveStructuredFrontmatterFields(
  frontmatter: Record<string, unknown> | undefined,
): {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
} {
  if (!frontmatter || typeof frontmatter !== 'object') {
    return {};
  }
  const normalized = normalizeSkillFrontmatterKeys(frontmatter);
  if ('error' in normalized) {
    return {};
  }
  frontmatter = normalized.frontmatter;
  const derived: {
    disableModelInvocation?: boolean;
    userInvocable?: boolean;
    allowedTools?: string[];
  } = {};
  const disableModelInvocationRaw = frontmatter['disable-model-invocation'];
  if (typeof disableModelInvocationRaw === 'boolean') {
    derived.disableModelInvocation = disableModelInvocationRaw;
  }
  const userInvocableRaw = frontmatter['user-invocable'];
  if (typeof userInvocableRaw === 'boolean') {
    derived.userInvocable = userInvocableRaw;
  }
  const allowedToolsRaw = frontmatter['allowed-tools'];
  if (typeof allowedToolsRaw === 'string') {
    /**
     * YAML scalars like `allowed-tools: web_search` are parsed as a single
     * string. Wrap into a one-element array; we deliberately do NOT split
     * on commas — the validator already accepts string-array form and
     * trying to "be helpful" by splitting `"web_search, file_search"`
     * would silently invent semantics the spec doesn't promise.
     */
    if (allowedToolsRaw.length > 0) {
      derived.allowedTools = [allowedToolsRaw];
    }
  } else if (Array.isArray(allowedToolsRaw)) {
    derived.allowedTools = allowedToolsRaw.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
  }
  return derived;
}

/**
 * Read-time fallback for skills authored before the structured columns
 * existed: if the column is unset but the matching key is present in
 * `frontmatter`, fill the column in on the returned object so downstream
 * runtime checks (`skill.userInvocable === false`,
 * `skill.disableModelInvocation === true`, `skill.allowedTools`) behave
 * the same way they would for a freshly-created skill.
 *
 * Side-effect-free w.r.t. the DB (no writes), but mutates its argument
 * in place and returns the same reference. Callers passing a `lean()`
 * doc this is fine — the doc is a fresh JS object owned by the caller.
 * When the skill is next updated, `updateSkill` re-derives and persists
 * the columns naturally, so this fallback gradually becomes a no-op.
 *
 * Skills with the columns already populated short-circuit to no-op.
 */
export function backfillDerivedFromFrontmatter<
  T extends {
    frontmatter?: Record<string, unknown>;
    disableModelInvocation?: boolean;
    userInvocable?: boolean;
    allowedTools?: string[];
  },
>(skill: T | null): T | null {
  if (!skill || !skill.frontmatter) {
    return skill;
  }
  const derived = deriveStructuredFrontmatterFields(skill.frontmatter);
  if (skill.disableModelInvocation === undefined && derived.disableModelInvocation !== undefined) {
    skill.disableModelInvocation = derived.disableModelInvocation;
  }
  if (skill.userInvocable === undefined && derived.userInvocable !== undefined) {
    skill.userInvocable = derived.userInvocable;
  }
  if (skill.allowedTools === undefined && derived.allowedTools !== undefined) {
    skill.allowedTools = derived.allowedTools;
  }
  return skill;
}

function getAlwaysApplyFrontmatterValue(
  frontmatter: Record<string, unknown> | undefined,
): boolean | undefined {
  const canonical = frontmatter?.['always-apply'];
  if (typeof canonical === 'boolean') {
    return canonical;
  }
  const camelAlias = frontmatter?.alwaysApply;
  if (typeof camelAlias === 'boolean') {
    return camelAlias;
  }
  return undefined;
}

export type BodyAlwaysApplyResult =
  | { status: 'absent' }
  | { status: 'valid'; value: boolean }
  | { status: 'invalid' };

/**
 * Extractor for the `always-apply` / `alwaysApply` flag sitting inside a SKILL.md body's
 * YAML frontmatter block. The REST edit flow lets users rewrite the full
 * SKILL.md text via `update.body` without a structured `frontmatter`
 * object, so this is the only signal we have for "user flipped
 * `always-apply:` or `alwaysApply:` inline in their editor".
 *
 * Returns a discriminated union so callers can tell:
 *  - `absent` — no always-apply key (leave column alone; could be
 *    "user removed the flag" or "user hasn't written it yet" — both
 *    resolve to no-op). An empty value (`always-apply:` with nothing
 *    after the colon) is also treated as absent to allow mid-edit
 *    placeholder states without rejecting a save.
 *  - `valid` — parsed cleanly as `true` / `false` (case-insensitive,
 *    quote-tolerant, YAML inline-comment-tolerant).
 *  - `invalid` — key is present with a non-empty value that isn't a
 *    recognizable boolean (e.g. `tru`, `yes`, `1`). Validation rejects
 *    this rather than silently ignoring so `always-apply: tru` typos
 *    surface as 400s instead of drifting the column from what the
 *    saved SKILL.md text says. When both forms are present, the canonical
 *    `always-apply` form wins because existing files may already rely on it.
 */
function extractAlwaysApplyFromBody(body: string | undefined): BodyAlwaysApplyResult {
  if (typeof body !== 'string' || body.length === 0) {
    return { status: 'absent' };
  }
  const trimmed = body.trim();
  if (!trimmed.startsWith('---')) {
    return { status: 'absent' };
  }
  const after = trimmed.slice(3);
  const closingIdx = after.indexOf('\n---');
  if (closingIdx === -1) {
    return { status: 'absent' };
  }
  const block = after.slice(0, closingIdx);
  let aliasResult: BodyAlwaysApplyResult | undefined;
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const normalizedKey = key.toLowerCase();
    if (normalizedKey !== 'always-apply' && normalizedKey !== 'alwaysapply') {
      continue;
    }
    // Strip the YAML inline comment BEFORE unquoting — a line like
    // `always-apply: "true" # note` has both, and if we only handled
    // whole-line quoting first, the quoted branch wouldn't match and
    // the comment-strip would leave `"true"` which parses as invalid.
    let value = stripYamlTrailingComment(line.slice(colon + 1).trim()).trim();
    if (value === '') {
      const result: BodyAlwaysApplyResult = { status: 'absent' };
      if (normalizedKey === 'always-apply') {
        return result;
      }
      aliasResult = result;
      continue;
    }
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.trim();
    if (value === '') {
      const result: BodyAlwaysApplyResult = { status: 'absent' };
      if (normalizedKey === 'always-apply') {
        return result;
      }
      aliasResult = result;
      continue;
    }
    const lowered = value.toLowerCase();
    let result: BodyAlwaysApplyResult;
    if (lowered === 'true') {
      result = { status: 'valid', value: true };
    } else if (lowered === 'false') {
      result = { status: 'valid', value: false };
    } else {
      result = { status: 'invalid' };
    }
    if (normalizedKey === 'always-apply') {
      return result;
    }
    aliasResult = result;
  }
  return aliasResult ?? { status: 'absent' };
}

/**
 * Resolve the effective `alwaysApply` boolean for a create/update call.
 *
 * The indexed `alwaysApply` column is the source of truth for auto-priming
 * queries; it can also be carried inline inside the SKILL.md `body` or in
 * the structured `frontmatter` bag. All three surfaces must stay in sync
 * or a skill edit that flips `always-apply:` in the body would leave the
 * column stale and the UI / auto-priming query would use the old value.
 *
 * Precedence:
 *  1. An explicit top-level `alwaysApply` wins (caller overrides).
 *  2. Otherwise, derive from `frontmatter['always-apply']` or the accepted
 *     alias `frontmatter.alwaysApply` when either is a strict boolean.
 *  3. Otherwise, parse `always-apply:` / `alwaysApply:` out of the SKILL.md body
 *     frontmatter block (covers the UI edit flow that sends only
 *     `body` without a structured `frontmatter` object).
 *  4. Otherwise, return `fallback` (typically `false` on create, or the
 *     current column value on update so an update that doesn't touch
 *     any of the three sources leaves the column alone).
 */
function resolveAlwaysApplyFromInput(
  explicit: boolean | undefined,
  frontmatter: Record<string, unknown> | undefined,
  body: string | undefined,
  fallback: boolean,
  /* Callers that have already parsed the body (e.g. because they also
     ran body-level validation) can thread the result in to avoid a
     second parse. Leave undefined to let the helper parse on demand. */
  precomputedBody?: BodyAlwaysApplyResult,
): boolean {
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  const fromFrontmatter = getAlwaysApplyFrontmatterValue(frontmatter);
  if (typeof fromFrontmatter === 'boolean') {
    return fromFrontmatter;
  }
  const fromBody = precomputedBody ?? extractAlwaysApplyFromBody(body);
  if (fromBody.status === 'valid') {
    return fromBody.value;
  }
  return fallback;
}

/** ---------- Store rules shared by the backends ---------- */

/** The error a create, update or file write throws for blocking validation issues. */
function validationFailure(message: string, code: string, issues: ValidationIssue[]): Error {
  const error = new Error(message);
  (error as Error & { issues?: ValidationIssue[]; code?: string }).issues = issues;
  (error as Error & { code?: string }).code = code;
  return error;
}

/** The message of the duplicate-name error a create raises for a name the author uses. */
export function skillNameTakenMessage(name: string): string {
  return `A skill with name "${name}" already exists for this author`;
}

/** The error a file write throws for a skill whose deletion has begun (or that is absent). */
export function skillDeletingError(): Error {
  return Object.assign(new Error('Skill is being deleted'), { code: 'SKILL_DELETING' });
}

/** The error a conditional file write throws when it lost to another writer. */
export function skillFileConflictError(message: string): Error {
  return Object.assign(new Error(message), { code: 'SKILL_FILE_CONFLICT' });
}

/** A create's input as the rules read it: the author is the backend's id or a hex string. */
export type SkillCreateRuleInput = Omit<CreateSkillInput, 'author'> & { author: unknown };

/**
 * Checks a create's input: resolves the canonical frontmatter and the always-apply flag of the
 * SKILL.md body, and throws `SKILL_VALIDATION_FAILED` (with the issues) on a blocking issue.
 * Resolves the warnings with them.
 */
export function prepareSkillCreate(data: SkillCreateRuleInput): {
  frontmatter: Record<string, unknown> | undefined;
  bodyAlwaysApply: BodyAlwaysApplyResult | undefined;
  warnings: ValidationIssue[];
} {
  const normalizedFrontmatter = isPlainObject(data.frontmatter)
    ? normalizeSkillFrontmatterKeys(data.frontmatter)
    : undefined;
  const frontmatter =
    normalizedFrontmatter && 'frontmatter' in normalizedFrontmatter
      ? normalizedFrontmatter.frontmatter
      : data.frontmatter;
  const bodyIssues = validateSkillBody(data.body);
  /* Parse body's always-apply status once — reused for validation
     (below) and derivation in `resolveAlwaysApplyFromInput`. Avoids
     parsing the same YAML frontmatter block twice per create. */
  const bodyAlwaysApply =
    bodyIssues.length === 0 && data.body !== undefined
      ? extractAlwaysApplyFromBody(data.body)
      : undefined;
  const issues: ValidationIssue[] = [
    ...validateSkillName(data.name),
    ...validateSkillDescription(data.description),
    ...bodyIssues,
    ...validateSkillDisplayTitle(data.displayTitle),
    ...validateSkillFrontmatter(frontmatter),
    ...validateAlwaysApply(data.alwaysApply),
  ];
  if (typeof data.author === 'string' && !isValidObjectIdString(data.author)) {
    issues.push({
      field: 'author',
      code: 'INVALID_FORMAT',
      message: 'Author must be a 24-character hex string',
    });
  }
  /* Body-level `always-apply:` only needs to be well-formed when a
     higher-precedence source won't override it (see
     `resolveAlwaysApplyFromInput` for the cascade). A caller sending
     an explicit top-level `alwaysApply` or a structured
     an always-apply value in structured `frontmatter` has the body value overridden at
     derivation time, so rejecting them for a typo they aren't relying
     on would be user-hostile. */
  if (
    bodyAlwaysApply?.status === 'invalid' &&
    typeof data.alwaysApply !== 'boolean' &&
    getAlwaysApplyFrontmatterValue(frontmatter) === undefined
  ) {
    issues.push({
      field: 'body.frontmatter.alwaysApply',
      code: 'INVALID_TYPE',
      message:
        '"always-apply" or "alwaysApply" in SKILL.md frontmatter must be a boolean (true or false)',
    });
  }
  const { errors, warnings } = partitionIssues(issues);
  if (errors.length > 0) {
    throw validationFailure('Skill validation failed', 'SKILL_VALIDATION_FAILED', errors);
  }
  return { frontmatter, bodyAlwaysApply, warnings };
}

/**
 * The record a create stores, from the input checked by {@link prepareSkillCreate} and the author
 * as the backend's id: version 1, no files, the defaults for what the input leaves out, and the
 * structured columns derived from the frontmatter.
 */
export function skillCreateDocument<Author>(
  data: SkillCreateRuleInput,
  author: Author,
  prepared: Pick<ReturnType<typeof prepareSkillCreate>, 'frontmatter' | 'bodyAlwaysApply'>,
): Record<string, unknown> {
  const { frontmatter, bodyAlwaysApply } = prepared;
  const derived = deriveStructuredFrontmatterFields(frontmatter);
  return {
    name: data.name,
    displayTitle: data.displayTitle,
    description: data.description,
    body: data.body ?? '',
    frontmatter: frontmatter ?? {},
    category: data.category ?? '',
    author,
    authorName: data.authorName,
    version: 1,
    source: data.source ?? 'inline',
    sourceMetadata: data.sourceMetadata,
    fileCount: 0,
    alwaysApply: resolveAlwaysApplyFromInput(
      data.alwaysApply,
      frontmatter,
      data.body,
      false,
      bodyAlwaysApply,
    ),
    tenantId: data.tenantId,
    ...derived,
  };
}

/**
 * Checks an update and builds its write: `$set` of the given fields (the structured columns
 * re-derived from new frontmatter, the always-apply column kept in step with the explicit flag,
 * the frontmatter and the SKILL.md body), `$unset` of the derived columns the new frontmatter
 * omits, and the version bump. Throws `SKILL_VALIDATION_FAILED` (with the issues) on a blocking
 * issue; resolves the warnings with the write.
 */
export function prepareSkillUpdate(update: UpdateSkillInput): {
  updateOps: Record<string, unknown>;
  warnings: ValidationIssue[];
} {
  const normalizedFrontmatter = isPlainObject(update.frontmatter)
    ? normalizeSkillFrontmatterKeys(update.frontmatter)
    : undefined;
  const frontmatter =
    normalizedFrontmatter && 'frontmatter' in normalizedFrontmatter
      ? normalizedFrontmatter.frontmatter
      : update.frontmatter;

  const bodyIssues = update.body !== undefined ? validateSkillBody(update.body) : [];
  /* Parse body's always-apply status once — reused for validation
     (precedence-aware, below) and the derivation cascade further
     down. Avoids parsing the same YAML frontmatter block twice per
     update. */
  const bodyAlwaysApply =
    bodyIssues.length === 0 && update.body !== undefined
      ? extractAlwaysApplyFromBody(update.body)
      : undefined;
  const issues: ValidationIssue[] = [];
  if (update.name !== undefined) issues.push(...validateSkillName(update.name));
  if (update.description !== undefined)
    issues.push(...validateSkillDescription(update.description));
  issues.push(...bodyIssues);
  if (update.displayTitle !== undefined)
    issues.push(...validateSkillDisplayTitle(update.displayTitle));
  if (update.frontmatter !== undefined) issues.push(...validateSkillFrontmatter(frontmatter));
  if (update.alwaysApply !== undefined) issues.push(...validateAlwaysApply(update.alwaysApply));
  /* Body-level `always-apply:` only needs to be well-formed when a
     higher-precedence source won't override it (see
     `resolveAlwaysApplyFromInput` for precedence). Rejecting a typo
     the caller is already overriding would be user-hostile, and the
     body-inline derivation branch below is skipped for those
     payloads anyway. */
  if (
    bodyAlwaysApply?.status === 'invalid' &&
    update.alwaysApply === undefined &&
    getAlwaysApplyFrontmatterValue(frontmatter) === undefined
  ) {
    issues.push({
      field: 'body.frontmatter.alwaysApply',
      code: 'INVALID_TYPE',
      message:
        '"always-apply" or "alwaysApply" in SKILL.md frontmatter must be a boolean (true or false)',
    });
  }
  const { errors, warnings } = partitionIssues(issues);
  if (errors.length > 0) {
    throw validationFailure('Skill validation failed', 'SKILL_VALIDATION_FAILED', errors);
  }

  const setPayload: Record<string, unknown> = {};
  const unsetPayload: Record<string, ''> = {};
  if (update.name !== undefined) setPayload.name = update.name;
  if (update.displayTitle !== undefined) setPayload.displayTitle = update.displayTitle;
  if (update.description !== undefined) setPayload.description = update.description;
  if (update.body !== undefined) setPayload.body = update.body;
  if (update.source !== undefined) setPayload.source = update.source;
  if (update.sourceMetadata !== undefined) setPayload.sourceMetadata = update.sourceMetadata;
  if (update.frontmatter !== undefined) {
    setPayload.frontmatter = frontmatter;
    /**
     * Derived columns track frontmatter — when frontmatter changes, the
     * derived view must follow. Fields the new frontmatter omits are
     * unset (back to schema default) so removing `disable-model-invocation`
     * from a SKILL.md re-enables model invocation on the next save.
     */
    const derived = deriveStructuredFrontmatterFields(frontmatter);
    for (const key of ['disableModelInvocation', 'userInvocable', 'allowedTools'] as const) {
      if (derived[key] !== undefined) {
        setPayload[key] = derived[key];
      } else {
        unsetPayload[key] = '';
      }
    }
  }
  if (update.category !== undefined) setPayload.category = update.category;
  /**
   * Keep the indexed `alwaysApply` column in sync with whatever the update
   * is carrying: an explicit top-level `alwaysApply` always wins; a
   * structured `frontmatter` with `always-apply: true/false` or the
   * accepted `alwaysApply` alias is next; and a `body` update is scanned last for an inline `always-apply:` line
   * inside the SKILL.md frontmatter block. The body path is load-bearing
   * for the REST edit flow — the current UI sends `body` without a
   * parallel `frontmatter` object, so inline edits to `always-apply:` / `alwaysApply:`
   * would otherwise leave the column stale and auto-priming / pin
   * badges would keep using the old value.
   *
   * When a `body` is submitted with NO `always-apply:` line (e.g. the
   * user removed the line from SKILL.md), that counts as a positive
   * declaration of "not always-apply" — the column flips to `false`.
   * Leaving it untouched would leave a skill that was once always-apply
   * silently auto-priming even after its own SKILL.md no longer
   * declares the flag.
   *
   * Important: the gates key off the *presence of an always-apply value*
   * at each level, not the presence of the parent field. An API caller
   * that sends both `body` and an unrelated `frontmatter` bag (e.g.
   * editing category + rewriting SKILL.md in one PATCH) still gets the
   * body-inline flag respected because no structured always-apply key
   * is absent in that payload.
   */
  let derivedAlwaysApply: boolean | undefined;
  if (update.alwaysApply !== undefined) {
    derivedAlwaysApply = update.alwaysApply;
  }
  if (derivedAlwaysApply === undefined && update.frontmatter !== undefined) {
    const fromFrontmatter = getAlwaysApplyFrontmatterValue(frontmatter);
    if (typeof fromFrontmatter === 'boolean') {
      derivedAlwaysApply = fromFrontmatter;
    }
  }
  if (derivedAlwaysApply === undefined && bodyAlwaysApply !== undefined) {
    if (bodyAlwaysApply.status === 'valid') {
      derivedAlwaysApply = bodyAlwaysApply.value;
    } else if (bodyAlwaysApply.status === 'absent') {
      /* An `absent` result means the user submitted a new body that
         declares no `always-apply:` key (either the key was removed or
         no frontmatter block was ever there). The body is the
         authoritative source for this skill's declared state: editing
         it to drop the flag intends to turn auto-priming off, so flip
         the column to `false`. Without this, a skill that was once
         `alwaysApply: true` would keep auto-priming after the user
         removed the declaration from SKILL.md — a persistent,
         invisible mismatch between the file and runtime behavior.
         `invalid` is rejected by the inline check above
         so this branch only handles the legitimate absence case. */
      derivedAlwaysApply = false;
    }
  }
  if (derivedAlwaysApply !== undefined) {
    setPayload.alwaysApply = derivedAlwaysApply;
  }

  const updateOps: Record<string, unknown> = {
    $set: setPayload,
    $inc: { version: 1 },
  };
  if (Object.keys(unsetPayload).length > 0) {
    updateOps.$unset = unsetPayload;
  }
  return { updateOps, warnings };
}

/** The page size of the skill listings: 1 to 100, 20 for none (or zero). */
export function skillListLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, limit || 20), 100);
}

/**
 * The filter of `listSkillsByAccess`: every skill of `manageTenantId`, or those among
 * `accessibleIds`, not being deleted, optionally of one category and matching `search` (a
 * literal, case-insensitive substring) in name, description or title.
 */
export function skillListFilter(params: {
  accessibleIds: unknown[];
  category?: string;
  search?: string;
  manageTenantId?: string;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = params.manageTenantId
    ? { tenantId: params.manageTenantId, deletingAt: { $exists: false } }
    : { _id: { $in: params.accessibleIds }, deletingAt: { $exists: false } };
  if (params.category && params.category.length > 0) {
    filter.category = params.category;
  }
  if (params.search && params.search.length > 0) {
    const rx = new RegExp(escapeRegExp(params.search), 'i');
    filter.$or = [{ name: rx }, { description: rx }, { displayTitle: rx }];
  }
  return filter;
}

/** A position in the skill listings' order (update time, then id), as its cursor carries it. */
export interface SkillListCursor {
  updatedAt: Date;
  _id: string;
}

/** The position `cursor` names, or `null` when it is missing or malformed (first page). */
export function decodeSkillCursor(cursor: string | null | undefined): SkillListCursor | null {
  if (!cursor || cursor === 'undefined' || cursor === 'null') {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      updatedAt?: string;
      _id?: string;
    };
    if (
      !decoded.updatedAt ||
      !decoded._id ||
      Number.isNaN(new Date(decoded.updatedAt).getTime()) ||
      !isValidObjectIdString(decoded._id)
    ) {
      return null;
    }
    return { updatedAt: new Date(decoded.updatedAt), _id: decoded._id };
  } catch (error) {
    logger.warn(`[skill.decodeCursor] Invalid cursor: ${(error as Error).message}`);
    return null;
  }
}

/** The cursor after `row` in the skill listings' order. */
export function encodeSkillCursor(row: { updatedAt: Date; _id: { toString(): string } }): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: row.updatedAt.toISOString(), _id: row._id.toString() }),
  ).toString('base64');
}

/** `baseFilter` limited to the skills after `cursor`, its id given as the backend's id. */
export function skillCursorFilter<Id>(
  baseFilter: Record<string, unknown>,
  cursor: SkillListCursor | null,
  toId: (hex: string) => Id,
): Record<string, unknown> {
  if (!cursor) {
    return baseFilter;
  }
  const cursorCondition = {
    $or: [
      { updatedAt: { $lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, _id: { $gt: toId(cursor._id) } },
    ],
  };
  return { $and: [baseFilter, cursorCondition] };
}

/** The order of the skill listings: most recently updated first, then by id. */
export const SKILL_LIST_SORT = { updatedAt: -1, _id: 1 } as const;

/**
 * The fields of a listed skill summary. `frontmatter` is deliberately NOT projected: the
 * structured columns (disableModelInvocation / userInvocable / allowedTools / alwaysApply) are
 * always populated by `createSkill` / `updateSkill`, so summaries need no read-time backfill.
 */
export const SKILL_SUMMARY_FIELDS =
  'name displayTitle description category author authorName version source sourceMetadata fileCount alwaysApply tenantId disableModelInvocation userInvocable allowedTools createdAt updatedAt';

/** The fields `listAlwaysApplySkills` reads. */
export const ALWAYS_APPLY_SKILL_FIELDS =
  'name body author frontmatter updatedAt allowedTools version';

/** A listing page from the rows read (one more than `limit`): the page, whether more follow, the cursor after it. */
export function skillListPage<Row extends { updatedAt?: unknown; _id?: unknown }>(
  rows: Row[],
  limit: number,
): { sliced: Row[]; has_more: boolean; after: string | null } {
  const has_more = rows.length > limit;
  const sliced = has_more ? rows.slice(0, limit) : rows;
  const last = sliced[sliced.length - 1];
  const after =
    has_more && last
      ? encodeSkillCursor({
          updatedAt: last.updatedAt as Date,
          _id: last._id as { toString(): string },
        })
      : null;
  return { sliced, has_more, after };
}

/**
 * An always-apply listing row: id, name, body (empty when missing), author, version and
 * frontmatter, plus `allowedTools` when the skill declares it.
 */
export function alwaysApplySkillRow<Id>(row: {
  _id?: unknown;
  name?: unknown;
  body?: unknown;
  author?: unknown;
  version?: unknown;
  frontmatter?: unknown;
  allowedTools?: unknown;
}): {
  _id: Id;
  name: string;
  body: string;
  author: Id;
  version: number;
  frontmatter?: Record<string, unknown>;
  allowedTools?: string[];
} {
  const result: {
    _id: Id;
    name: string;
    body: string;
    author: Id;
    version: number;
    frontmatter?: Record<string, unknown>;
    allowedTools?: string[];
  } = {
    _id: row._id as Id,
    name: row.name as string,
    body: (row.body as string | undefined) ?? '',
    author: row.author as Id,
    version: row.version as number,
    frontmatter: row.frontmatter as Record<string, unknown> | undefined,
  };
  if (row.allowedTools !== undefined) {
    result.allowedTools = row.allowedTools as string[];
  }
  return result;
}

/**
 * The two writes that prune deleted skill ids (lower-cased) from the agents' `skills`
 * allowlists, without touching their update times: an allowlist made only of deleted ids is
 * emptied and skills disabled, unless the agent's `skills_scope` (`all`, `selected`) already says
 * what an empty allowlist means; then the deleted ids are pulled from every other allowlist.
 */
export function agentAllowlistPruneWrites(skillIds: string[]): {
  emptied: { filter: Record<string, unknown>; update: Record<string, unknown> };
  pulled: { filter: Record<string, unknown>; update: Record<string, unknown> };
} {
  const ids = skillIds.map((id) => id.toLowerCase());
  return {
    emptied: {
      filter: {
        skills: { $in: ids, $not: { $elemMatch: { $nin: ids } } },
        /** Only `all` and `selected` opt out: each already defines what an
         *  empty allowlist means. A missing field (matched here because
         *  `$nin` also matches absent) is the legacy shape, and an explicit
         *  `none` with the master flag still true is a contradictory shape
         *  the API accepts, which `skillDeps` would otherwise keep reading
         *  as permission to expose the skill-authoring tools. */
        skills_scope: { $nin: [SkillsScope.all, SkillsScope.selected] },
      },
      update: { $set: { skills: [], skills_enabled: false } },
    },
    pulled: {
      filter: { skills: { $in: ids } },
      update: { $pull: { skills: { $in: ids } } },
    },
  };
}

/** What `deleteSkill` reports for an id that is not a store id: nothing done. */
export function malformedSkillDeletion(): DeleteSkillResult {
  return { deleted: false, skillAbsent: false, cleanupComplete: false, failedCleanupSteps: [] };
}

/** What the deletion steps report while the skill's file rows remain (or it is not deleting). */
export function skillFilesPending(): DeleteSkillResult {
  return {
    deleted: false,
    skillAbsent: false,
    cleanupComplete: false,
    failedCleanupSteps: ['skill_files'],
  };
}

/**
 * The mark that begins a skill's deletion: the reserved name (which skill validation cannot
 * create, so the public name is released under the unique index), the deletion time and the
 * flag that asks for the journal.
 */
export function skillDeletionMark(id: string, deletingAt: Date): Record<string, unknown> {
  return { name: `__deleted__${id}`, deletingAt, deletionNeedsJournal: true };
}

/** The candidate ids that can name a stored skill: well-formed, lower-cased, each once, in order. */
export function skillIdCandidates(skillIds: string[]): string[] {
  return [...new Set(skillIds.filter(isValidObjectIdString).map((id) => id.toLowerCase()))];
}

/** A file write's input as the rules read it: ids are the backend's ids or hex strings. */
export type SkillFileRuleInput = Omit<UpsertSkillFileInput, 'skillId' | 'author'> & {
  skillId: unknown;
  author: unknown;
};

/** Throws `SKILL_FILE_VALIDATION_FAILED` (with the issues) for an invalid relative path. */
export function assertSkillFilePath(relativePath: unknown): void {
  const issues = validateRelativePath(relativePath);
  if (issues.length > 0) {
    throw validationFailure('Skill file validation failed', 'SKILL_FILE_VALIDATION_FAILED', issues);
  }
}

/** Whether a write of the same file id would move it to another storage location. */
export function movesSkillFileStorage(
  previous: { filepath?: unknown; source?: unknown; storageKey?: unknown; storageRegion?: unknown },
  row: { filepath?: unknown; source?: unknown; storageKey?: unknown; storageRegion?: unknown },
): boolean {
  return (
    previous.filepath !== row.filepath ||
    previous.source !== row.source ||
    (previous.storageKey ?? null) !== (row.storageKey ?? null) ||
    (previous.storageRegion ?? null) !== (row.storageRegion ?? null)
  );
}

/**
 * The cleanup reference a replacement leaves for the replaced blob: an upsert of the old file's
 * upload intent (committed, created as `legacy-replacement` when the file predates intents)
 * requesting its cleanup. With `cleanupHoldOwner`, the intent must be committed, not cleaned, not
 * claimed by a sweeper and not held by another owner, and the hold is recorded on it.
 */
export function replacedSkillBlobIntentWrite(
  row: Pick<SkillFileRuleInput, 'skillId' | 'cleanupHoldOwner'>,
  previous: {
    file_id: string;
    source?: unknown;
    storageKey?: unknown;
    filepath?: unknown;
    author?: unknown;
    tenantId?: unknown;
  },
  now: Date,
): { filter: Record<string, unknown>; update: Record<string, unknown> } {
  // A multi-step writer may roll this replacement back. Its hold and the
  // sweeper's claim must contend on the same intent before the file CAS;
  // an already-claimed blob is not a safe rollback candidate.
  const filter = row.cleanupHoldOwner
    ? {
        fileId: previous.file_id,
        state: 'committed',
        cleanedAt: { $exists: false },
        claimOwner: { $exists: false },
        $or: [{ cleanupHoldOwner: { $exists: false } }, { cleanupHoldOwner: row.cleanupHoldOwner }],
      }
    : { fileId: previous.file_id };
  const update = {
    $setOnInsert: {
      skillId: row.skillId,
      fileId: previous.file_id,
      source: previous.source,
      storageKey: previous.storageKey ?? previous.filepath,
      author: previous.author,
      tenantId: previous.tenantId,
      writerId: 'legacy-replacement',
      state: 'committed',
    },
    $set: {
      cleanupRequestedAt: now,
      ...(row.cleanupHoldOwner ? { cleanupHoldOwner: row.cleanupHoldOwner } : {}),
    },
    $unset: { cleanedAt: '', nextCheckAt: '' },
  };
  return { filter, update };
}

/** The fields a file write stores, the category inferred from the path. */
export function skillFileFields(row: SkillFileRuleInput): Record<string, unknown> {
  return {
    skillId: row.skillId,
    relativePath: row.relativePath,
    file_id: row.file_id,
    filename: row.filename,
    filepath: row.filepath,
    storageKey: row.storageKey,
    storageRegion: row.storageRegion,
    source: row.source,
    sourceMetadata: row.sourceMetadata,
    mimeType: row.mimeType,
    bytes: row.bytes,
    category: inferSkillFileCategory(row.relativePath),
    isExecutable: row.isExecutable ?? false,
    author: row.author,
    tenantId: row.tenantId,
  };
}

/** The caches a replacement clears: the content, the binary flag and the code-env references. */
export const SKILL_FILE_REPLACED_CACHES = {
  content: '',
  isBinary: '',
  codeEnvRef: '',
  codeEnvRefs: '',
} as const;

/** The filter of a file at `relativePath`, only while it is `expectedFileId` when one is given. */
export function skillFilePathFilter(
  skillId: unknown,
  relativePath: string,
  expectedFileId?: string | null,
): Record<string, unknown> {
  return {
    skillId,
    relativePath,
    ...(expectedFileId != null ? { file_id: expectedFileId } : {}),
  };
}

/** The write that records a file's code-environment reference, singly and per route key. */
export function skillFileCodeEnvWrite(update: {
  skillId: unknown;
  relativePath: string;
  codeEnvRef: CodeEnvRef;
}): { filter: Record<string, unknown>; update: Record<string, unknown> } {
  const routeKey =
    update.codeEnvRef.executionRouteKey ?? update.codeEnvRef.executionProfile ?? 'default';
  return {
    filter: { skillId: update.skillId, relativePath: update.relativePath },
    update: {
      $set: {
        codeEnvRef: update.codeEnvRef,
        [`codeEnvRefs.${routeKey}`]: update.codeEnvRef,
      },
    },
  };
}

/** Logs a code-environment write that persisted fewer references than it was given. */
export function warnPartialCodeEnvWrite(
  requested: number,
  result: { matchedCount: number; modifiedCount: number },
): void {
  if (result.modifiedCount < requested) {
    logger.warn(
      `[updateSkillFileCodeEnvIds] Persisted ${result.modifiedCount}/${requested} codeEnvRefs (matched ${result.matchedCount}). Subsequent primes for unmatched files will re-upload.`,
    );
  }
}
