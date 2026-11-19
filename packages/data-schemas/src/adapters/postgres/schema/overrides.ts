/**
 * The overrides of the PostgreSQL mapping (docs/postgres-port/PHASE4.md §1.6): the only
 * hand-written part of the schema descriptor. Everything else follows the mapping rules of
 * §1.2 mechanically. Each entry states its reason, and the generator fails when an entry no
 * longer matches the schema it names (a stale override is a schema change to review).
 *
 * Plain data: no `mongoose` import (the plugin path definitions use the JavaScript constructors
 * mongoose reads, `Boolean`, `String`, `Number`). The generator (`generate.ts`) applies the
 * plugin paths and indexes to a copy of the schema before introspecting it; the builder
 * (`descriptor.ts`) applies the rest.
 */

/** A `Mixed` path stored in a typed column instead of `json`. */
export interface ColumnTypeOverride {
  collection: string;
  path: string;
  /** `objectIdOrString`: `text COLLATE "C"`, ObjectId-like values stored as their hex. */
  type: 'objectIdOrString';
  reason: string;
}

/**
 * Subpaths of a `json` column that queries compare by equality: each gets a `CHECK` that no
 * step of it is an array and its leaf is a scalar, which makes `#>` equality (type-exact, served
 * by btree expression indexes) equal to MongoDB's path semantics on every stored row.
 */
export interface JsonHintOverride {
  collection: string;
  path: string;
  subpaths: readonly string[];
  reason: string;
}

/** A scalar array stored as an element table `<table>__<path>(_parent, _ord, value)`. */
export interface ElementTableOverride {
  collection: string;
  path: string;
  reason: string;
}

/** A schema field definition, as `Schema#add` takes it. */
export type PluginPathDefinition = Readonly<Record<string, unknown>>;

/** A schema index, as `Schema#index` takes it. */
export type PluginIndexDefinition = readonly [
  Readonly<Record<string, 1 | -1>>,
  Readonly<Record<string, unknown>>,
];

/** Paths (and indexes) a plugin adds only in some environments, applied whatever the environment. */
export interface PluginPathsOverride {
  collection: string;
  paths: Readonly<Record<string, PluginPathDefinition>>;
  indexes: readonly PluginIndexDefinition[];
  reason: string;
}

/** Collections whose new indexes a migration builds `CONCURRENTLY` (§5). */
export interface LargeTablesOverride {
  collections: readonly string[];
  reason: string;
}

/** Every override of the mapping. */
export interface SchemaOverrides {
  columnTypes: readonly ColumnTypeOverride[];
  jsonHints: readonly JsonHintOverride[];
  elementTables: readonly ElementTableOverride[];
  pluginPaths: readonly PluginPathsOverride[];
  largeTables: LargeTablesOverride;
}

const PRINCIPAL_ID_REASON =
  'Mixed (an ObjectId or a string) indexed five times, once unique, and matched by equality: a ' +
  'text column with ids as hex serves those indexes (an ObjectId no longer differs from its hex ' +
  'string, R7)';

const SEARCH_TOKEN_REASON =
  'buildSearchTokenFilter matches the search tokens with anchored prefix regexes, which need a ' +
  'per-element btree range scan';

/**
 * The `mongoMeili` plugin's paths, as it adds them (`models/plugins/mongoMeili.ts`), applied
 * whether or not `MEILI_HOST`/`MEILI_MASTER_KEY` are set: a schema index references
 * `_meiliIndex`, and the search index sync (I3) reads and writes all five.
 */
const MEILI_PLUGIN_PATHS: Readonly<Record<string, PluginPathDefinition>> = {
  _meiliIndex: { type: Boolean, required: false, select: false, default: false },
  _meiliIndexAttempted: { type: Boolean, required: false, select: false },
  _meiliIndexVersion: { type: String, required: false, select: false },
  _meiliIndexSchemaVersion: { type: Number, required: false, select: false },
  _meiliCleanupVersion: { type: Number, required: false, select: false },
};

/**
 * The cleanup indexes the `mongoMeili` plugin declares with `excludeFromIndexPath` (same names,
 * keys and partial filters), which serve `SearchIndexSync.cleanupExcluded`.
 */
function meiliPluginIndexes(
  primaryKey: string,
  excludeFromIndexPath: string,
): PluginIndexDefinition[] {
  return [
    [
      { _meiliIndex: 1, [primaryKey]: 1 },
      {
        name: 'meili_excluded_indexed_cleanup_v3',
        partialFilterExpression: {
          [excludeFromIndexPath]: { $exists: true },
          _meiliIndex: { $eq: true },
        },
      },
    ],
    [
      { _meiliIndexAttempted: 1, [primaryKey]: 1 },
      {
        name: 'meili_excluded_attempted_cleanup_v3',
        partialFilterExpression: {
          [excludeFromIndexPath]: { $exists: true },
          _meiliIndexAttempted: { $eq: true },
        },
      },
    ],
    [
      { _meiliIndex: 1, _meiliCleanupVersion: 1, [primaryKey]: 1 },
      {
        name: 'meili_excluded_legacy_cleanup_v4',
        partialFilterExpression: {
          [excludeFromIndexPath]: { $exists: true },
          _meiliIndex: { $eq: false },
          _meiliCleanupVersion: { $eq: null },
        },
      },
    ],
  ];
}

const MEILI_REASON =
  'the mongoMeili plugin adds these paths and indexes only when MEILI_HOST and MEILI_MASTER_KEY ' +
  'are set; the tables carry them whatever the environment (the options are those of ' +
  'models/convo.ts and models/message.ts)';

/** The overrides of the mapping (PHASE4.md §1.6). */
export const SCHEMA_OVERRIDES: SchemaOverrides = {
  columnTypes: [
    {
      collection: 'aclentries',
      path: 'principalId',
      type: 'objectIdOrString',
      reason: PRINCIPAL_ID_REASON,
    },
    {
      collection: 'systemgrants',
      path: 'principalId',
      type: 'objectIdOrString',
      reason: PRINCIPAL_ID_REASON,
    },
  ],
  jsonHints: [
    {
      collection: 'agenttriggerdeliveries',
      path: 'envelope',
      subpaths: [
        'event.source.type',
        'event.source.id',
        'event.type',
        'event.payload.taskId',
        'target.bindingId',
        'target.conversationId',
        'target.parentMessageId',
        'target.agentId',
      ],
      reason:
        'the trigger delivery methods query these eight envelope paths by equality in 54 places, ' +
        'and a compound index covers three of them',
    },
    {
      collection: 'assistants',
      path: 'avatar',
      subpaths: ['filepath'],
      reason: 'indexed and matched by equality (avatar file lookups)',
    },
    {
      collection: 'skills',
      path: 'sourceMetadata',
      subpaths: ['upstreamId', 'sourceId'],
      reason: 'indexed and matched by equality (skill sync)',
    },
  ],
  elementTables: [
    { collection: 'users', path: 'nameTokens', reason: SEARCH_TOKEN_REASON },
    { collection: 'users', path: 'emailTokens', reason: SEARCH_TOKEN_REASON },
    { collection: 'users', path: 'usernameTokens', reason: SEARCH_TOKEN_REASON },
    { collection: 'groups', path: 'nameTokens', reason: SEARCH_TOKEN_REASON },
    { collection: 'groups', path: 'emailTokens', reason: SEARCH_TOKEN_REASON },
  ],
  pluginPaths: [
    {
      collection: 'conversations',
      paths: MEILI_PLUGIN_PATHS,
      indexes: meiliPluginIndexes('conversationId', 'subagentThread'),
      reason: MEILI_REASON,
    },
    {
      collection: 'messages',
      paths: MEILI_PLUGIN_PATHS,
      indexes: meiliPluginIndexes('messageId', 'subagentTask'),
      reason: MEILI_REASON,
    },
  ],
  largeTables: {
    collections: ['messages', 'conversations', 'files', 'transactions', 'agenttriggerdeliveries'],
    reason:
      'the largest tables in long-running deployments: a new index on them is built ' +
      'CONCURRENTLY, outside the migration transaction',
  },
};

/** No overrides: the mapping rules alone (hand-made schemas in specs). */
export const NO_SCHEMA_OVERRIDES: SchemaOverrides = {
  columnTypes: [],
  jsonHints: [],
  elementTables: [],
  pluginPaths: [],
  largeTables: { collections: [], reason: '' },
};
