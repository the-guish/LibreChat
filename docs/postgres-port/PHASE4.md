# PostgreSQL port, phases 4 and 5: adapter and test suites

Companion to [PLAN.md](PLAN.md) (status and decisions) and [UNIT_BRIEF.md](UNIT_BRIEF.md) (rules per unit). This file is the detailed design and unit breakdown for phase 4 (PostgreSQL adapter) and phase 5 (test suites against PostgreSQL). It refines the phase 4 row of PLAN.md. The sketch there said "columns for queried fields, jsonb for free-form ones". It becomes typed columns for **every** declared field, child tables for arrays of subdocuments, and `json` for `Mixed`/`Map` and arrays of `Mixed`.

Prerequisite: Milestone A (every Jest suite and the full e2e mock suite green on MongoDB). It is the baseline every unit below is compared against.

Decisions taken (details in §10):

|     | Decision                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Typed columns.** One table per collection with a relational column per schema path. Single subdocuments and nested objects are flattened. Arrays of subdocuments go to child tables. Schema changes need migrations, and a generator writes them.                                                                                               |
| D2  | **Mongoose without a connection** builds inserted and replaced documents (casting, defaults, setters, validators, subdocument ids). A generated descriptor casts filter and update values.                                                                                                                                                        |
| D3  | Port contract suites on both backends, the query, extended and tenant corpora on PostgreSQL, the full e2e mock suite on PostgreSQL (one test-only PR to the e2e DB helpers), and the no-DB Jest suites in PostgreSQL mode. **Plus about 20 curated DB-backed route suites** converted to a backend-neutral fixture helper in small test-only PRs. |
| D4  | **Keep MeiliSearch.**                                                                                                                                                                                                                                                                                                                             |
| D5  | **The copy tool migrates LangGraph checkpoints** into the `PostgresSaver` format. `@langchain/langgraph-checkpoint-postgres` ^1.1.3, after a separate dependency PR that bumps `@langchain/langgraph-checkpoint` to ^1.2.2.                                                                                                                       |
| D6  | **PostgreSQL 15 minimum** (nothing needs 16), with CI on 15 and 16. **Migrations on boot by default** (`POSTGRES_AUTO_MIGRATE=true`), plus `npm run db:migrate`.                                                                                                                                                                                  |
| D7  | **Keep legacy and off-schema values in `_extra`** (one `jsonb` column per table, `NULL` on new rows): the copy is lossless and reads keep returning old fields, as MongoDB lean reads do.                                                                                                                                                         |
| D8  | **U+0000 is replaced with U+FFFD on write** (text columns and inside `json`), counted in a metric; the copy tool reports affected documents.                                                                                                                                                                                                      |

## 0. Size of the job (measured)

- 56 stores in `DataStore` plus `transactions`; **713 store methods** (from `getDataStoreBackend().createMethods()`; the flat export has 733 keys).
- The 20 flat members that belong to no store:
  - pure helpers, shared as they are: `tokenValues`, `premiumTokenValues`, `getValueKey`, `getMultiplier`, `getPremiumRate`, `getCacheMultiplier`, `defaultRate`, `cacheTokenValues`, `generateActionMetadataHash`, `calculateRelevanceScore`, `sortPrincipalsByRelevance`, `SessionError`;
  - database-neutral domain functions built on port steps, rebuilt on the PostgreSQL stores: `saveConvo`, `bulkSaveConvos`, `deleteConvos`, `searchConversation`;
  - MongoDB-only reads with no production caller left: `aggregateAclEntries`, `getMessagesByCursor`, `searchMessages`;
  - `conversations` (an alias of `stores.conversations`).
- Largest stores (method count, lines of the MongoDB methods file): conversations 65 / 4206, agentTriggerDeliveries 54 / 4893, schedules 51 / 2294, codeEnvironments 37 / 1317, files 35 / 1965, skillLifecycle 32 / 684, users 28 / 1053, messages 27 / 4465, agentQueuedTurns 25 / 2908, agents 24 / 2801.
- `methods/*.ts` without specs: 51.4k lines. Method specs: 92 files, 93.8k lines.
- **Data model, introspected** (`createModels(new Mongoose())`, walking `schema.paths`):
  - 53 models, all `strict: true`. `_id` is an ObjectId on 50 and a String on 3 (`subagentcontents`, `agenttriggerlanesequences`, `agentqueuedturnsequences`). `timestamps` on 41. `__v` on 52 (all but `subagentcontents`). 54 hidden (`select: false`) paths.
  - 59 single subdocuments (2 with an `_id`: `users.personalization`, `messages.feedback`) and 21 nested plain objects.
  - **25 arrays of subdocuments, none with an `_id`, none nested inside another array of subdocuments.** 6 sit under a single subdocument, for example `conversations.agentEventActor.compactionSemanticIndex.entries`. 3 subdocuments sit inside array elements (`agentEventActorReconciliations[].checkpoint`, `[].action`, `agenttriggerdeliveries.history[].error`). 2 scalar arrays sit inside array elements (`conversations`/`presets` `codeWorkspaces[].agentIds`).
  - 57 scalar arrays: 52 String, 3 ObjectId, 1 Number (`schedules.cadence.daysOfWeek`), 1 Date (`schedules.countedFor`). No array of arrays.
  - 29 `Mixed` paths (some inside subdocuments), 9 arrays of `Mixed` (`messages.content`, `files`, `attachments`; `agents.versions`, `edges`, `tool_kwargs`; `users.plugins`; `conversations`/`presets` `examples`), 2 `Map`s (`users.skillStates` of Boolean, `tokens.metadata` of Mixed), 1 `Buffer` (`passkeys.publicKey`). No Decimal128, Long or UUID.
  - Raw collections without a mongoose model:
    - `browser_setup_sessions`, `browser_setup_budget`, `browser_setup_requests`;
    - `code_environment_tombstones`, `code_environment_reconciliation`;
    - `mcp_authorization_fence_retries`;
    - `librechatCredentialMetadata`;
    - `agent_checkpoint_stores`, `agent_checkpoint_deletions`;
    - the checkpoint and checkpoint-write collections per storage;
    - Keyv collections and their GridFS buckets.
- **Indexes** (`schema.indexes()`): 351, of which 58 unique, 35 partial, 15 sparse, 19 TTL.
  - Partial filters use only `$exists` (24), `$type` (2) and equality.
  - 13 indexes cover scalar-array paths: the search tokens, `agents.mcpServerNames`, `agents.code_environment_ids`, `groups.memberIds`.
  - 2 cover child-table paths: `users {tenantId, favorites.agentId}` and the sparse `conversations {agentEventActorReconciliations.status, .observedAt}`.
  - 10 cover `Mixed` paths: 5 on `principalId`, one of them unique; `agents.edges.to`; `assistants.avatar.filepath`; 2 on `skills.sourceMetadata.*`; one compound on three `agenttriggerdeliveries.envelope.*` paths.
  - **No unique index covers an array or child path.** No schema uses a collation.
- Validation: 289 `default:` declarations in `schema/*.ts` (13 function defaults), about 400 `required`, 120 enums, 16 custom validators, 14 `lowercase`/`trim` setters.
- Operators the methods use that the query language excludes:

  | Operator                                 | Files                                                                                                                                                                                                                                                            |
  | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `$elemMatch`                             | 37 sites in 10 files (conversation 17, message 7, browserSetup 3, schedule, scheduleConsent, user 2 each, transaction, codeEnvironment, skill, insights)                                                                                                         |
  | Positional `$` / `$[x]` + `arrayFilters` | conversation (`agentEventActorReconciliations.$.*`), user (`backupCodes.$`, `subagentAdmissionFences.$`), codeEnvironment (`pendingAgentReferences.$`), conversationTag (`tags.$`), transaction (`reservations.$[held]`), message (13 `content.$[part].*` paths) |
  | Aggregation pipelines                    | 10 files, see §4                                                                                                                                                                                                                                                 |
  | `bulkWrite`                              | browserSetup, checkpoint saver, checkpoint store                                                                                                                                                                                                                 |
  | Cursors                                  | auditLog, skillLifecycle, subagentContent, user, checkpoints                                                                                                                                                                                                     |
  | `$bitsAnySet` / `$bitsAllSet`            | aclEntry, mcpServer                                                                                                                                                                                                                                              |
  | `$expr`                                  | browserSetup, conversation, message                                                                                                                                                                                                                              |
  | `$type`                                  | agent (`mcpServerNames`), conversation (`attachments.*`, `content.*`), message (`content`)                                                                                                                                                                       |
  | `$size`                                  | 6 files                                                                                                                                                                                                                                                          |

  There is no `$text` anywhere: all search is MeiliSearch.

## 1. Storage model: typed tables

### 1.1 Overview

Each collection is a table named after the collection (`conversations`, `agenttriggerdeliveries`, ...). That keeps the e2e facade and the copy tool a mapping by name. An excerpt of what the generator emits:

```sql
CREATE DOMAIN lc_object_id AS text COLLATE "C" CHECK (VALUE ~ '^[0-9a-f]{24}$');

CREATE TABLE conversations (
  _id                    lc_object_id PRIMARY KEY,
  "conversationId"       text COLLATE "C",
  "title"                text COLLATE "C",
  "titleRevision"        double precision,
  "messages"             lc_object_id[],          -- array of ObjectId
  "tags"                 text[] COLLATE "C",      -- array of String
  "examples"             json,                    -- array of Mixed
  "laneGit"              boolean,                 -- shape of an object path: true = present
  "laneGit__branch"      text COLLATE "C",
  "laneGit__pullRequest" double precision,
  "codeWorkspaces"       integer,                 -- shape of a child array: its element count
  "expiredAt"            timestamptz,
  "tenantId"             text COLLATE "C",
  "createdAt"            timestamptz,
  "updatedAt"            timestamptz,
  "__v"                  integer,
  _nulls                 text[] COLLATE "C",      -- declared paths explicitly set to null
  _extra                 jsonb                    -- values the schema does not describe (D7)
);
CREATE TABLE "conversations__codeWorkspaces" (
  _parent         lc_object_id NOT NULL REFERENCES conversations (_id) ON DELETE CASCADE,
  _ord            integer NOT NULL,
  "environmentId" text COLLATE "C",
  "workspaceId"   text COLLATE "C",
  "checkout"      text COLLATE "C",
  "agentIds"      text[] COLLATE "C",
  _nulls          text[] COLLATE "C",
  _extra          jsonb,
  PRIMARY KEY (_parent, _ord)
);
CREATE UNIQUE INDEX conversations__agentEventBinding_bindingId ON conversations ("agentEventBinding__bindingId") NULLS NOT DISTINCT
  WHERE "agentEventBinding__bindingId" IS NOT NULL OR 'agentEventBinding.bindingId' = ANY (_nulls);
```

### 1.2 Mapping rules (mongoose schema → tables)

The generator (unit F2) applies these rules mechanically. Exceptions are only the overrides in §1.6.

**Scalars → one column each.**

| Schema type | Column                                                                            | Notes                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `String`    | `text COLLATE "C"`                                                                | Code point order whatever the database locale. No `CHECK` for `enum`/`maxlength`.                                                                                                                         |
| `Number`    | `double precision`                                                                | Exactly a JS number, including `-0`. `bigint`/`integer` would reject `1.5`, which mongoose accepts on any `Number`. `__v` and system columns are `integer`. Bit tests cast to `bigint` in the expression. |
| `Boolean`   | `boolean`                                                                         |                                                                                                                                                                                                           |
| `Date`      | `timestamptz`                                                                     | Written with millisecond precision. Dates outside PostgreSQL's range are refused on write.                                                                                                                |
| `ObjectId`  | `lc_object_id` (24 lowercase hex, `text COLLATE "C"`)                             | Read back as strings (R7). Ids still sort oldest first.                                                                                                                                                   |
| `Buffer`    | `bytea`                                                                           | `passkeys.publicKey`.                                                                                                                                                                                     |
| `_id`       | `lc_object_id PRIMARY KEY`, or `text COLLATE "C"` for the 3 String-id collections |                                                                                                                                                                                                           |

**Objects (single subdocuments and nested plain objects) → flattened.**

- Each leaf becomes a column named by the path with `__` between segments (`agentEventActor__contextMeta__fading__v`). A subdocument `_id` becomes `<path>___id` (`personalization___id`, `feedback___id`).
- The object path also gets a **shape column** of its own name, `boolean`. `true` means the object is present (even `{}`). `NULL` means missing or null, told apart by `_nulls`.
- Assigning an object path (`$set: { agentEventActor: {...} }`) replaces every column and every child table beneath it. `$unset` clears them.
- Rejected alternative: one `json` column per subdocument. It is simpler, but it loses typed indexes on subdocument paths (`message.subagentTask.parentRunId`, `agentEventBinding.bindingId`, `files.metadata.runFile.*`, `actorReceipt.resolution`) and goes against D1.

**Arrays of scalars → PostgreSQL arrays (`T[]`).**

- Array-contains equality: `col @> ARRAY[$1]`. `$in`: `col && $1`. Both use a GIN index.
- `$addToSet`: append the elements not present, keeping first-occurrence order. `$pull`/`$pullAll`: `array_remove`, or `unnest ... WITH ORDINALITY` filtered. `$push`/`$each`: `||`. `$size`: `cardinality(col)`.
- Missing versus empty is native: `NULL` versus `'{}'`.
- Range and `$regex` on elements: `EXISTS (SELECT 1 FROM unnest(col) e WHERE ...)`.
- This covers every scalar-array operation in the methods except per-element range or prefix _indexes_. For those, an override stores the array as an **element table** `<table>__<path>(_parent, _ord, value)` with a btree on `value`. Today that is only the 5 search-token arrays (§1.6).

**Arrays of subdocuments → child tables `<table>__<path>`.**

- Columns: `_parent` (the parent's `_id`, FK `ON DELETE CASCADE`), `_ord integer` (`PRIMARY KEY (_parent, _ord)`), then the element's columns by the same rules. Subdocuments inside elements are flattened with shape columns, scalar arrays are `T[]`, `Mixed` is `json`. Each child table also has `_nulls` and `_extra`.
- No element schema has an `_id`. If one appears upstream, it becomes an `lc_object_id` column.
- Order: `_ord` ascending. Gaps are allowed after `$pull`, and `$push` uses `max(_ord) + 1` under the parent's row lock. Numeric path segments (`arr.0.f`) are resolved by position: `ORDER BY _ord OFFSET n LIMIT 1`.
- The parent's shape column holds the element count. It gives `$size`, `arr.0` existence and a cheap "skip the subselect" guard on reads.
- Child arrays under subdocuments (`agentEventActor.skillManifest`) are keyed to the parent row too. The path is in the table name.
- Null elements in a child array are refused on write. The copy tool moves such legacy arrays to `_extra` (§3.7).

**`Mixed`, arrays of `Mixed`, `Map` → `json` columns** (text JSON, cast to `jsonb` in queries).

- Values use the tagged encoding of §1.3. Paths into them are translated to lax jsonpath (§2), never refused, because methods query into them (§1.4).
- Why `json` and not `jsonb`: `jsonb` normalizes object key order. `agent.ts` `isDuplicateVersion` compares `JSON.stringify` of values read from `versions` (an array of `Mixed`) with the caller's object. With `jsonb`, a reordered `model_parameters` would create a version MongoDB does not create.
- `json` keeps the text as written, `pg` parses it with `JSON.parse` (order kept), and `col::jsonb` is immutable, so expression and GIN indexes work.
- Cost: subpath updates into a `json` column are read-modify-write in JS (§3.3), never `jsonb_set`, which would reorder keys. Hand-written SQL that needs equality or `GROUP BY` casts to `jsonb`.
- `Map` keys containing `.` or starting with `$` are refused, as mongoose does.

**Missing versus null → `_nulls`.**

- MongoDB tells a missing field from an explicit `null`: 484 `$exists` conditions in the methods, `default: null` fields, `$set: { f: null }`.
- A typed column holds one `NULL`, so each row (and child row) lists the declared paths explicitly set to null in `_nulls` (`NULL` when none).
- Rules:
  - `{ f: null }` → `f IS NULL`;
  - `$exists: true` → `f IS NOT NULL OR 'f' = ANY(_nulls)`;
  - `$exists: false` → the negation;
  - reads emit `f: null` for listed paths and omit other `NULL` columns.
- PostgreSQL's predicate prover still uses partial indexes written in this form for plain equality lookups: `f = $1` implies `f IS NOT NULL`, which implies the `OR`.

**Strict mode and unknown fields → stripped, or `_extra` (D7).**

- All 53 schemas are strict and `strictQuery` is `true` (`adapters/mongo/connection.ts`). So writes through mongoose silently drop undeclared paths today, and the primitive does the same.
- Undeclared values reach a table only through the copy tool and raw seeding (e2e facade, contract `seedRaw`). Old fields from long-running deployments and values that cannot be cast to the declared type go to `_extra`, under their path.
- Reads merge `_extra` after the declared keys, as lean reads return such fields today. Filters and updates never touch `_extra`, except `$unset` of an `_extra` path. Two methods need exactly that: `clearLegacySharedLinkVisibility` (`isPublic`) and `initializeRoles` (`permissions.*.SHARED_GLOBAL`).
- Filters on undeclared paths are **refused** (`StoreQueryError`). Mongoose's `strictQuery` would strip the condition and match everything (R9).

**System fields.**

- `__v`: an `integer` column, `0` on insert where the schema has a version key. Compare-and-set `$inc: { __v: 1 }` (messages) is a column update.
- `createdAt`/`updatedAt`: `timestamptz` columns, set by the primitive per the schema's `timestamps`: both on insert; `updatedAt` on update unless the call passes `timestamps: false`; `createdAt` through `$setOnInsert` on upsert.
- `tenantId`: a `text` column on tenant-scoped tables. Child tables carry no tenant; isolation is enforced on the parent.
- `select: false` (54 paths): ordinary columns, left out by the default projection. `+field` and inclusions return them.
- Defaults are applied on insert only, never on read (the lean-read semantics found in #52).
- The database enforces types, ids, primary and foreign keys, and the unique indexes. It never enforces `required`, `enum`, `min`/`max` or custom validators. Mongoose validates writes as today, and legacy rows that break those rules must stay readable.

**Naming.**

- Columns are the path with `.` → `__`, quoted, case kept.
- Identifiers longer than 63 bytes become their first 54 bytes plus `_` and an 8-hex hash. The descriptor records every mapping.
- Today only `conversations__agentEventActor__compactionSemanticIndex__entries` (64 bytes) is affected; no column name is.
- The generator fails on a schema field containing `__` (other than the top-level `__v`), or on a field name that collides with a system column (`_parent`, `_ord`, `_nulls`, `_extra`).

### 1.3 Encoding inside `json` columns

| MongoDB value inside `Mixed`                                          | In the `json` text                                                 | Read back as                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `Date`                                                                | `{"$date":"YYYY-MM-DDTHH:mm:ss.sssZ"}`                             | `Date`                                                  |
| `Buffer` / Binary                                                     | `{"$binary":"<base64>"}`                                           | `Buffer`                                                |
| ObjectId                                                              | lowercase hex string                                               | string (the language equates an id with its hex string) |
| numbers, strings, booleans, null, arrays, objects                     | as JSON, key order kept                                            | same                                                    |
| `undefined`                                                           | key dropped                                                        | absent                                                  |
| keys starting with `$`, objects shaped like `{"$date"}`/`{"$binary"}` | refused on write (`StoreQueryError`); the copy tool scans for them |                                                         |

Encoding uses a replacer that reads `this[key]`, to get past `Date#toJSON`. Decoding is a `JSON.parse` reviver per `json` column. Fixed-width ISO dates compare correctly as strings inside jsonpath. U+0000 follows D8.

As built in F1 (`adapters/postgres/values.ts`): the encoder is a recursive walk producing the JSON tree (equivalent to the replacer: `toJSON` is never consulted), and the `pg` pool reads `json`/`jsonb` as text so the reviver applies. Also refused with `StoreQueryError`, since JSON has no spelling for them and storing something else would change the data: non-finite numbers (`NaN`, `±Infinity`), `bigint`, symbols, `RegExp`, `Map`, `Set`, invalid dates, circular structures. `-0` inside `json` reads back as `0` (typed `double precision` columns keep it). The U+0000 counter counts each string (value or key) that had at least one replaced.

### 1.4 Problem shapes per schema, and how each is handled

| Table                                                               | Shape                                                                                                                                                                                                                                                                                                                                                                                           | Handling                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations` (157 columns, 6 child tables)                       | `agentEventActor` subtree, 3 levels deep, with 3 child arrays (`skillManifest`, `contextMeta.fadingTiers`, `compactionSemanticIndex.entries`)                                                                                                                                                                                                                                                   | Flattened columns plus the 3 child tables. Replacing the subtree is one column-set plus delete and insert of child rows (§3.3).                                                                                                                                                                                                         |
|                                                                     | `agentEventActorReconciliations`: about 20 `$elemMatch` (also under `$not`), positional `$.status`/`.error`/`.resolution`/`.observedAt`/`.action`/`.checkpoint`, `$pull` by predicate, `$push`, the sparse compound index on two element paths, nested `checkpoint` and `action` objects                                                                                                        | Child table with flattened element objects. `$elemMatch` is `EXISTS`, positional updates are `UPDATE child ... WHERE _ord = (first match)`, `$pull` is `DELETE ... WHERE`. Child index `(status, observedAt)` with the sparse rule (§1.7). Element `_nulls` serves `'checkpoint.checkpointId': { $exists: false }` inside `$elemMatch`. |
|                                                                     | `agentEventActorCleanup` (`$addToSet` of a subdocument), `codeWorkspaces` (`$size: 0`, `$in: [null]`, array inside elements)                                                                                                                                                                                                                                                                    | Child tables. `$addToSet` is `INSERT ... WHERE NOT EXISTS` (all element columns `IS NOT DISTINCT FROM`). `$size` uses the shape column.                                                                                                                                                                                                 |
|                                                                     | `agentEventActorSuspension.suspension` (Mixed in a subdocument), `examples`                                                                                                                                                                                                                                                                                                                     | `json` columns.                                                                                                                                                                                                                                                                                                                         |
|                                                                     | `_meiliIndex` (plus 4 more flags) added by the `mongoMeili` plugin only when `MEILI_HOST`/`MEILI_MASTER_KEY` are set, though a schema index references `_meiliIndex`                                                                                                                                                                                                                            | The generator always applies the plugin's paths (§1.6).                                                                                                                                                                                                                                                                                 |
| `messages` (91 columns, 3 child tables)                             | `content` (array of Mixed): 13 positional `content.$[part].tool_call.*` paths with `arrayFilters`, `$elemMatch`, `$type: 'array'`, `$not $type`, nested projection exclusions in `CLIENT_MESSAGE_SELECT`                                                                                                                                                                                        | `json`. `$elemMatch` and `$type` are jsonpath on `content::jsonb`. Positional updates are read-modify-write in JS under `FOR UPDATE` (keeps key order). Projection exclusions run in JS after the fetch.                                                                                                                                |
|                                                                     | `attachments`, `files` (arrays of Mixed; `attachments.file_id` `$type` checks from conversation.ts), `metadata` (Mixed; `-metadata.thoughtSignatures`), `feedback` (subdocument with `_id`, Mixed `tag`)                                                                                                                                                                                        | `json` columns. `feedback___id` and `feedback__tag` (`json`) are columns.                                                                                                                                                                                                                                                               |
|                                                                     | `subagentTask.controlReceipts` (array under a subdocument), partial index on `subagentTask.parentRunId`                                                                                                                                                                                                                                                                                         | Child table. Partial index on the flattened column.                                                                                                                                                                                                                                                                                     |
| `agenttriggerdeliveries` (119 columns)                              | `envelope` (Mixed) queried by 8 paths in 54 places (`event.source.type`/`.id`, `target.bindingId`/`.conversationId`/`.parentMessageId`/`.agentId`, `event.payload.taskId`, `event.type`); one compound index over three of them                                                                                                                                                                 | `json` plus **path hints** (§1.6). Hinted paths get a `CHECK` that no step is an array and the leaf is scalar, so the translator uses `(envelope::jsonb #> '{event,source,type}') = $1::jsonb`, which is type-exact and uses btree expression indexes. Unhinted paths use the lax jsonpath form.                                        |
|                                                                     | `history[]` (child with a nested `error` object), `actorDetachedActionHistory[]`                                                                                                                                                                                                                                                                                                                | Child tables.                                                                                                                                                                                                                                                                                                                           |
| `users`                                                             | `backupCodes` (`$elemMatch`, `backupCodes.$.used`), `subagentAdmissionFences` (`$not $elemMatch`, `$pull` by predicate, `$.expiresAt`), `favorites` (`$pull` by `agentId`/`$in`, index on `favorites.agentId`), `refreshToken`, `pendingBackupCodes`                                                                                                                                            | Child tables. Child index on `favorites (agentId)`. The parent's `tenantId` index covers the compound's other key.                                                                                                                                                                                                                      |
|                                                                     | `skillStates` (Map of Boolean; `skillStates.<id>` updates), `plugins` (array of Mixed; `$pull` by value, `$addToSet`), search-token arrays                                                                                                                                                                                                                                                      | `json` (Map), `json` (plugins), element tables (tokens).                                                                                                                                                                                                                                                                                |
| `tokens`                                                            | `metadata` (Map of Mixed)                                                                                                                                                                                                                                                                                                                                                                       | `json`.                                                                                                                                                                                                                                                                                                                                 |
| `balances`                                                          | `reservations` (`$push`, `$pull` by `id`, `reservations.$[held].expiresAt` with `arrayFilters`), `pendingRefill`                                                                                                                                                                                                                                                                                | Child table, `arrayFilters` as `UPDATE child ... WHERE <filter>`. Flattened columns.                                                                                                                                                                                                                                                    |
| `codeenvironments`                                                  | `pendingAgentReferences` (`$push`, `$pull` by predicate, `$.expiresAt`, `$size: 0`, `$not $elemMatch`), `settings.permissions` (2-level object)                                                                                                                                                                                                                                                 | Child table. Flattened columns.                                                                                                                                                                                                                                                                                                         |
| `schedules` / `scheduleruns`                                        | `lastRun.mcp` (child under a subdocument), `scheduleruns.mcp` (`$nor` with `'mcp.detail'` and `$elemMatch`, `$addToSet`), `cadence` (nested object with `daysOfWeek` `double precision[]`), `countedFor` (`timestamptz[]`, `$push`)                                                                                                                                                             | Child tables. Flattened columns plus arrays.                                                                                                                                                                                                                                                                                            |
|                                                                     | `mcpConsent` (Mixed): `'mcpConsent.consents': { $elemMatch: {...} }`, `'mcpConsent.consents.0': { $exists: true }` (scheduleConsent.ts)                                                                                                                                                                                                                                                         | `json`. jsonpath `$elemMatch` and index paths on `mcpConsent::jsonb`.                                                                                                                                                                                                                                                                   |
| `agents`                                                            | `edges` (array of Mixed; `edges.from`/`edges.to` `$in`, projection `edges.to`, index on `edges.to`), `tool_resources` (Mixed; `tool_resources.<r>.file_ids` with `$in`, `$addToSet`, `$pull`), `versions` (array of Mixed; `$push`, `$size` in aggregations, key-order-sensitive duplicate check), `skills` (`$in` with `$not: { $elemMatch: { $nin } }`), `mcpServerNames` (`$type: 'string'`) | `json` with a GIN expression index `((edges::jsonb) jsonb_path_ops)` and lax `@?` (`to` may be a string or an array). `tool_resources` subpath updates are read-modify-write. `skills <@ $ids AND skills && $ids`. `$type: 'string'` on a `text[]` is "has a non-null element".                                                         |
| `aclentries`, `systemgrants`                                        | `principalId` (Mixed, ObjectId or string) in 5 indexes, one unique, matched by equality                                                                                                                                                                                                                                                                                                         | Override to a `text COLLATE "C"` column ("id or string"), §1.6.                                                                                                                                                                                                                                                                         |
| `roles`                                                             | `permissions` (2-level object, 42 booleans); off-schema legacy `permissions.*.SHARED_GLOBAL` read and unset through the raw driver                                                                                                                                                                                                                                                              | 42 flattened `boolean` columns (67 columns in all). Legacy key via `_extra`. A churn hotspot: every new permission type needs a migration (R6).                                                                                                                                                                                         |
| `files`                                                             | `metadata` (nested object with declared children plus Mixed `codeEnvRefs`/`workspaceImports`; `fileContentUpdate` sets `metadata.<key>` dynamically), `storageOperations.provisioning` (`$addToSet`/`$pull`), partial uniques on `context`, `metadata.runFile.*`                                                                                                                                | Flattened columns. Dynamic keys resolve to declared children, the rest is stripped, as mongoose does.                                                                                                                                                                                                                                   |
| `sharedlinks`                                                       | `fileSnapshots[]`, `messages` (array of ObjectId), off-schema legacy `isPublic`                                                                                                                                                                                                                                                                                                                 | Child table, `lc_object_id[]`, `_extra`.                                                                                                                                                                                                                                                                                                |
| `assistants`, `skills`                                              | Indexes on Mixed subpaths (`avatar.filepath`, `sourceMetadata.upstreamId`/`.sourceId`)                                                                                                                                                                                                                                                                                                          | Path hints with expression indexes.                                                                                                                                                                                                                                                                                                     |
| `skillsyncstatuses`, `agentqueuedturns`, `presets`, `conversations` | `skippedSkills[]`, `skippedFiles[]`, `files[]`, `codeWorkspaces[]`                                                                                                                                                                                                                                                                                                                              | Child tables.                                                                                                                                                                                                                                                                                                                           |
| Raw collections                                                     | browser setup `allocations[]` (with a nested `session` object; `$elemMatch`), `nonces[]` (`$push`, `$pull` by predicate), `peers` (`Record<string, number>`), tombstones, reconciliation checkpoint, fence retries, credential marker, checkpoint descriptors and deletion intents                                                                                                              | Declared as mongoose schemas under `schema/raw/` (never registered as models), mapped by the same rules.                                                                                                                                                                                                                                |

### 1.5 Counts

- **53 collection tables plus 9 raw-collection tables**, plus `key_value_entries` (§4). The `PostgresSaver` tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) live in one PostgreSQL schema per checkpoint storage.
- **25 child tables** for arrays of subdocuments, plus a few more for raw collections (browser setup `allocations`, `nonces`), plus **5 element tables** (search tokens).
- About 1,110 scalar leaf columns at parent level, 77 object shape columns, 25 child-array shape columns, 55 array columns (50 after the element-table override), and **40 `json` columns** (38 after the `principalId` override). About 220 columns across the child tables.
- Widest tables: `conversations` 157 columns, `agenttriggerdeliveries` 119, `messages` 91, `files` 71, `roles` 67. PostgreSQL allows 1,600.

### 1.6 Overrides (`adapters/postgres/schema/overrides.ts`)

The only hand-written part of the mapping. Each entry has a reason and a spec.

1. **`principalId` on `aclentries` and `systemgrants`**: `Mixed` → `text COLLATE "C"` (ObjectId-like values stored as hex). It is indexed five times, once unique, and matched by equality. The MongoDB distinction "an ObjectId never equals its hex string" disappears (R7).
2. **Mixed path hints**: `agenttriggerdeliveries.envelope` (the 8 paths above), `assistants.avatar.filepath`, `skills.sourceMetadata.upstreamId`, `.sourceId`. Each gets a `CHECK` making the hint sound, plus a btree expression index where mongoose declares one.
3. **Element tables** for `users.nameTokens`, `emailTokens`, `usernameTokens` and `groups.nameTokens`, `emailTokens`. `buildSearchTokenFilter` matches them with anchored prefix regexes, which need a per-element btree range scan (`value >= 'abc' AND value < 'abd'`, then the regex recheck).
4. **Plugin paths**: the 5 `mongoMeili` flags on `conversations` and `messages` (`_meiliIndex`, `_meiliIndexAttempted`, `_meiliIndexVersion`, `_meiliIndexSchemaVersion`, `_meiliCleanupVersion`), applied whatever the environment.
5. **Raw-collection schemas**: the list in `schema/raw/index.ts`.

### 1.7 Indexes, partial and TTL indexes, uniqueness

Generated from `schema.indexes()` and the raw-collection declarations:

- **Btree keys on columns.** `{f: 1}` → `f ASC NULLS FIRST`, `{f: -1}` → `f DESC NULLS LAST`, so the index order is MongoDB's order and index scans serve sorts.
- Keys on hinted `json` paths are expressions `((col::jsonb) #> '{a,b}')`.
- **Scalar-array keys** (multikey) → GIN on the array, plus a separate btree on the scalar keys of a compound. No `btree_gin` extension is needed; the planner bitmap-ANDs the two.
- **Child-path keys** → an index on the child table's columns.
- **Unique** → `CREATE UNIQUE INDEX ... NULLS NOT DISTINCT`. That is MongoDB's rule (missing equals `null`) and needs PostgreSQL 15. Tenant-scoped uniques include `tenantId`.
- The generator **fails** on a unique index over an array or child path. MongoDB's multikey uniqueness (across documents, not within one) has no PostgreSQL equivalent, so it would need a hand-written guard. There are none today.
- **Partial** (`partialFilterExpression`) → `WHERE` on columns:
  - `$exists: true` → `c IS NOT NULL OR 'p' = ANY(_nulls)`;
  - equality → `c = <value>` (`{deleting: false}` excludes missing, as in MongoDB);
  - `$type: 'number'|'string'` on a typed column → `c IS NOT NULL`.
- **Sparse** → `WHERE` any key `IS NOT NULL OR` listed in `_nulls` (a sparse index includes explicit nulls). Example: `tokens.scope` unique sparse; child-table sparse compound on reconciliations.
- **TTL** (19, plus `browser_setup_sessions.deleteAfter` and the KV `expiresAt`): a TTL descriptor (table, column, `expireAfterSeconds`, partial predicate such as `schedules` `erased = true`) read by the sweeper (I4), plus the btree.
- **Names:** `<table>__<keys>[__p]`, hashed past 63 bytes. The descriptor maps each index name to `{ fields, mongoName, unique }` for duplicate-key errors.

### 1.8 Tenant isolation

Unchanged from the draft: `models/plugins/tenantIsolation.ts` is only the mongoose binding of the engine-neutral `tenant/policy.ts`. That module provides:

- `resolveTenantScope`, `tenantFilter`, `tenantPartition` (which already documents `tenant_id IS NULL OR tenant_id = ''`);
- `sanitizeTenantMutation`, `scopeReplacement`, `tenantWritePredicate`, `stampTenantOnDocument`;
- strict mode through `TENANT_ISOLATION_STRICT`.

The PostgreSQL primitive calls the same functions:

- it ANDs `tenantFilter` (now a plain column predicate) into every read and write;
- it stamps `tenantId` on insert;
- it sanitizes updates;
- it uses `tenantPartition` for merged reads.

It proves this with `describeTenantIsolationConformance(harness)` from `tenant/conformance.ts`, through a new PostgreSQL `TenantEngineHarness`. Row-level security can come later as defence in depth. It is not the mechanism, because the policy (system scope, unscoped non-strict reads) lives in JavaScript.

### 1.9 Casting, defaults and validation (D2: kept)

**Inserts and replacements.**

- A private `new Mongoose()` without a connection, in `schema/engine.ts` (allowed by the lint rule), carries the same schemas: `new Model(doc)`, then `validate()`, then `toObject({ depopulate: true, versionKey: true })`.
- That gives today's casting, defaults (289 declarations, 13 functions), setters, enums, `required`, the 16 custom validators, `minimize` and subdocument `_id`s.
- The record codec then decomposes the result into a parent row, child rows and `_nulls`.
- Mongoose's public statics are not enough on their own: `Model.castObject` does not apply setters (checked on 8.24.1), and `Model.applyDefaults` does not cast.

**Filter and update values.**

- The descriptor caster casts filter and update values per leaf type: strings to numbers, dates and ids; `lowercase`/`trim` on filter values, as mongoose does on queries.
- It shares the translator's path resolver, so a path is resolved once.
- A generated differential spec compares it with mongoose's own query and update casting, over a table of inputs for every path kind of every schema. `utils/fieldCasts.ts` is the precedent.
- Values that cannot be cast raise `StoreQueryError`, as mongoose raises `CastError`.

**`runValidators` updates (23 sites).** `Model.validate(postImageSubset, changedPaths, context)` (public API) on the computed post-image. `setDefaultsOnInsert` (9 sites, and mongoose's default) comes for free, because upsert inserts are built through `new Model(...)`.

**Hooks** are re-expressed as collection hooks in the primitive, each with a spec against the mongoose behavior:

- derived search tokens (written into the element tables);
- `auditLog` append-only;
- `mcpServer` pre-validate normalization;
- search index flags (I3).

**Why keep it with typed columns.** Typed columns make the descriptor richer (it needs the types for the DDL), but they do not remove the need for defaults, validators and setters. Re-implementing those would be the risky part of a mongoose-free path, and mongoose does exactly that, already proven, with no connection.

## 2. Query language → SQL translator

`adapters/postgres/query/`: filters, projections, sorts and paging over a **table descriptor**, returning Kysely `RawBuilder`s.

### 2.1 Path resolution

A dotted path is resolved against the descriptor tree. At each step it takes the longest declared prefix, then dispatches on the node kind:

| Node reached                                                   | Translates to                                                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scalar leaf                                                    | the column                                                                                                                                                                             |
| object path (shape column)                                     | the shape column for `null`/`$exists`. Comparison operators against an object path are refused: the language has no object values.                                                     |
| scalar array                                                   | the `T[]` column, element semantics                                                                                                                                                    |
| element table                                                  | `EXISTS (SELECT 1 FROM <t>__<p> e WHERE e._parent = t._id AND ...)`                                                                                                                    |
| child array, then a path inside it (`a.f`, `a.obj.g`, `a.arr`) | `EXISTS (SELECT 1 FROM <t>__a c WHERE c._parent = t._id AND <cond on c.f>)`, with the remaining path resolved in the child descriptor                                                  |
| child array with a numeric segment (`a.0.f`)                   | `(SELECT c.f FROM <t>__a c WHERE c._parent = t._id ORDER BY c._ord OFFSET 0 LIMIT 1)`                                                                                                  |
| child array itself                                             | shape column: `$size` → `"a" = n`, `{a: []}` → `"a" = 0`, `$exists`/`null` by the `_nulls` rule                                                                                        |
| `json` column, then any subpath                                | lax jsonpath on `col::jsonb` (`'lax $.a.b ? (@ == $v)'`, variables bound with `PASSING`-style `vars`). Hinted paths use `#>` equality. Numeric segments are array indexes in jsonpath. |
| `Map` (`skillStates.<key>`)                                    | `json` subpath; the value is cast by the Map's declared type                                                                                                                           |
| undeclared                                                     | `StoreQueryError` (R9)                                                                                                                                                                 |

### 2.2 MongoDB semantics preserved

- **null matches missing:** `c IS NULL` on columns. On child paths, `{ 'a.f': null }` follows the evaluator (missing array, or an element with `f` null or missing); the typed corpus pins the empty-array case. In jsonpath it is the `exists`-or-null form.
- **`$ne`/`$nin` match missing:** `c IS DISTINCT FROM $1`; `c IS NULL OR c <> ALL($1)` (and `IS NOT NULL` when `null` is in the list). On arrays and child paths: `NOT EXISTS`/`NOT (c @> ...)`, true when the array is missing.
- **Array-contains equality:** `@>`/`&&` on `T[]`, `EXISTS` on child and element tables, lax unwrapping in jsonpath.
- **Type brackets:** a typed column holds one type, and filter values are cast to it first (so `{n: '5'}` on a Number matches `5`, as with mongoose). Brackets only matter in `json`, where jsonpath comparisons across types are _unknown_ (no match), which is MongoDB's bracket rule. Tagged dates compare only with dates.
- **`$exists`:** the `_nulls` rule on columns, the shape rule on objects and child arrays, `@? 'lax $.p'` in `json` (true for a stored null).
- **`$or`/`$and`/`$nor`:** boolean composition; `$nor` is `NOT (... OR ...)`.

### 2.3 Sort, projection, paging

**Sort.**

- Columns: `ASC NULLS FIRST` / `DESC NULLS LAST`, `COLLATE "C"`.
- Scalar arrays and child paths: the minimum element ascending, the maximum descending, with an empty array before null. That is a composite key `(rank, value)`, with `(SELECT min(e) FROM unnest(c) e)` or a child subselect.
- `json` paths: `lc_sort_key(jsonb, asc boolean)`, an immutable SQL function encoding MongoDB's type rank and value, with array min or max.
- Ties: the methods' own `_id` tie-breaks; `_id` sorts as ObjectId order.

**Projection.**

- String and record forms, `+hidden`, `CLIENT_MESSAGE_SELECT` recognized by value.
- Pushed down **to columns**: only the projected columns, shape columns and child subselects are selected.
- Projections _into_ `json` values (inclusions like `edges.to`, `envelope.event.payload.taskId`; exclusions like `-attachments.web_search.*`) are applied in JS after the fetch, so key order is kept.

**Paging.** `LIMIT`/`OFFSET`. Keyset paging for cursors (§4).

### 2.4 Regex

- JavaScript regex is translated to PostgreSQL ARE: `\b`→`\y`, `\d`/`\w`/`\s` kept, character class checks. Anything it cannot translate is refused with `StoreQueryError`: lookbehind, named groups, backreferences beyond ARE, inline flags.
- Case-sensitive: `c ~ $1 COLLATE "C"`.
- **Case-insensitive (`i`): `c ~* $1 COLLATE "und-x-icu"`**. Under `"C"`, PostgreSQL folds ASCII only, while MongoDB's PCRE folds Unicode. The corpus already has `'$regex i folds non-ASCII letters'` (`^élo` matching `Élodie`). Boot checks that `und-x-icu` exists (ICU builds: PGDG, Debian, the official image, managed services).
- `$regex` on Number, Date, Boolean or ObjectId columns is refused, as mongoose casting does.
- On arrays, child and element tables, and `json`: element-wise `EXISTS` / jsonpath `like_regex` (flag `"i"`).
- Anchored literal prefixes (`^abc`) also emit a `COLLATE "C"` range condition, for btree use.

### 2.5 Testing the translator

**Corpus A, the existing 302 cases** (`ports/query.corpus.ts`, unchanged; schemaless on purpose, `strict: false`).

- The PostgreSQL spec builds a corpus descriptor: `_id` typed, and every top-level key found in the records and in the update and upsert cases declared `Mixed` (`json`), with `secret`/`pin` hidden.
- It creates that table through the F2 emitter, inserts the records, and runs every filter, projection, sort, paging, update and upsert case. Results must equal the reference evaluator (and so MongoDB).
- This exercises the whole `json` side of the translator, which serves the 38 `json` columns.
- It runs on a C database and on an ICU `en-US` database, to catch a missing `COLLATE "C"`.

**Corpus B, new: typed** (`ports/query.corpus.typed.ts`, test data only).

- A field-type table: `name` String with `lowercase` on `email`, `n` Number, `flag` Boolean, `at` Date, `tags` [String], `scores` [Number], `ref` ObjectId, `refs` [ObjectId], `profile` object `{city, zip: Number, tags, geo: {lat, lng}}`, `items` array of `{sku, qty: Number, tags}`, hidden `secret`/`pin`, `subagentTask` object, `memberIds` [String].
- Records are corpus A's, cast through the typed schema (non-castable values dropped).
- Cases are corpus A's cases on declared paths, plus typed-only cases:
  - filter-value casting (`'5'`→5, hex→ObjectId, ISO→Date, `lowercase` on filter values);
  - cast failures;
  - explicit null versus missing on scalars, objects, `T[]` and child arrays;
  - `$size`, numeric segments (`items.0.sku`);
  - sorts over arrays and child paths.
- **Ground truth is MongoDB through a mongoose model of the same typed schema** (new spec `query.typed.differential.spec.ts`). It asserts `evaluator ∘ descriptorCast == mongoose`, and a cast failure equals `CastError` ↔ `StoreQueryError`. The PostgreSQL spec then asserts SQL == evaluator ∘ cast.

**Corpus C, extended operators** (C2): one case per call-site shape of §1.4 and §4, on the typed schema, differential against MongoDB and PostgreSQL.

**Corpus D, generated per production table** (R1 and Q1):

- a round trip: a generated document exercising every path → engine → insert → assemble equals `toObject()`;
- equality, `null` and `$exists` on every leaf path.

This catches mapping bugs across all 53 tables mechanically.

`EXPLAIN` specs show index use for the main reads: conversation list, message page, ACL lookups, queue claims, trigger-delivery envelope lookups, the token prefix search.

## 3. Collection primitive: reads and writes

### 3.1 Assembling records

One statement per read. The parent columns are selected, and each **projected, non-empty** child array is a correlated subselect:

```sql
CASE WHEN t."codeWorkspaces" > 0 THEN
  (SELECT json_agg(json_build_array(c."environmentId", c."workspaceId", c."checkout", c."agentIds", c._nulls, c._extra) ORDER BY c._ord)
   FROM "conversations__codeWorkspaces" c WHERE c._parent = t._id) END
```

- The shape-column guard skips the subselect for empty arrays (most rows).
- Values are decoded per the descriptor: dates, bytea hex, arrays.
- Streaming and keyset generators, which already hold a parent batch, read children with one batched query per child table (`WHERE _parent = ANY($1) ORDER BY _parent, _ord`).
- **Key order:** `_id`, then declared paths in `schema.paths` order (timestamps after declared fields, as mongoose builds documents), then `__v`, then `_extra` keys. A spec checks that this equals `new Model(doc).toObject()` order. Documents later extended by `$set` of new fields keep schema order here but not in MongoDB (R7). `json` contents keep their order exactly.

### 3.2 Inserts

- The engine builds the document (D2), and the codec decomposes it.
- One statement with data-modifying CTEs inserts the parent and every non-empty child table (`WITH p AS (INSERT ... RETURNING _id), c1 AS (INSERT INTO t__a SELECT ... FROM unnest(...)) ...`).
- `insertMany` is one multi-row insert per table in a transaction, with `ON CONFLICT DO NOTHING RETURNING _id`. Skipped rows become the duplicate-key error's write errors. For `ordered: true`, rows after the first skipped one are deleted before commit, so the committed prefix matches MongoDB's.
- **Raw mode** is used by the e2e facade, contract `seedRaw` and the copy tool. It applies descriptor casting only: no defaults or validators, like a driver insert. Undeclared or uncastable values go to `_extra`.

### 3.3 Updates

**Tier 1, compiled to SQL** (C1 for parent rows, C2 for child tables).

Parent rows:

- scalar columns:
  - `$set`/`$unset`, with `_nulls` maintenance through `lc_nulls_*` helpers;
  - `$inc` (`coalesce(c, 0) + $v`, and `lc_fail()` on an explicit null, as MongoDB errors);
  - `$min`/`$max` with MongoDB's null rules;
  - `$setOnInsert`;
- object paths: all columns beneath, plus their child tables;
- `T[]`: `$push`/`$each`, `$addToSet`, `$pull` (value, `$in`, condition), `$pullAll`;
- `json` columns assigned or unset as a whole.

Child tables:

- `$push` → `INSERT` with `_ord = max + 1 ...` and a shape-count update;
- `$pull` by predicate → `DELETE ... WHERE`, then a recount;
- positional `$` → `UPDATE child ... WHERE _parent = $id AND _ord = (SELECT min(_ord) ... WHERE <array condition from the filter>)`;
- `$[x]` with `arrayFilters` → `UPDATE child ... WHERE _parent = ANY($ids) AND <x condition>`;
- `$addToSet` of subdocuments → `INSERT ... WHERE NOT EXISTS` (element columns `IS NOT DISTINCT FROM`).

`$push` modifiers `$slice`/`$position`/`$sort` are refused: no method uses them (the `$slice` hits are aggregation operators).

**Tier 2, read-modify-write under `SELECT ... FOR UPDATE`.**

- The record is assembled, the new record is computed by `applyStoreUpdate` or the extended evaluator, and the diff is written: changed columns, plus delete and insert of each changed child table.
- Used for subpath updates into `json` values (message `content.$[part]`, `tool_resources.<r>.file_ids`, `mcpConsent.consents`, `skillStates.<k>`), which keeps `json` key order.
- C1 also uses it for every child-table operation until C2 lands, so C1 is functionally complete.

**Shadow check (tests).** With `POSTGRES_UPDATE_SHADOW_CHECK=true` (on in every PostgreSQL spec), each tier-1 update also computes the evaluator's post-image from the locked pre-image and asserts equality.

### 3.4 Upserts

- The update is tried first. If nothing matches, the insert document is built from `storeFilterInsertSeed(filter)`, the update applied by the evaluator, `$setOnInsert`, timestamps and engine defaults, then inserted.
- On 23505 it retries once as an update; MongoDB retries such upserts too.

### 3.5 Compare-and-set and concurrency rules

These are pinned by specs.

- **Parent-only filters and writes:**

  ```sql
  UPDATE t SET ... FROM (SELECT * FROM t WHERE <filter> ORDER BY <sort> LIMIT 1 FOR UPDATE [SKIP LOCKED]) old
  WHERE t._id = old._id AND <filter> RETURNING old.* | t.*
  ```

  `RETURNING old.*` gives `findOneAndUpdate`'s pre-image. READ COMMITTED's recheck (EvalPlanQual) re-evaluates the parent-row conditions.

- **`LIMIT 1 FOR UPDATE` can return no row although another row matches.** The primitive retries when the claim came back empty but a match existed, or uses `SKIP LOCKED` for queue claims.
- **Filters that read child tables, and writes that touch them:**
  1. `SELECT _id FROM t WHERE <full filter> ... FOR UPDATE`;
  2. **in a new statement**, re-evaluate the full filter for the locked ids;
  3. write.

  The recheck re-reads only the target row; `EXISTS` subqueries keep the statement's old snapshot. Only a new statement sees child rows committed while the lock was awaited. Rows rejected in step 2 are skipped, and single-document operations move to the next candidate. Never update a row that does not match at write time; missing a row that started to match during the wait is acceptable, and MongoDB has the same race.

- **A statement that locks a parent never reads that parent's child rows**; it reads them in the following statement of the same transaction.
- **JavaScript recheck:** `matchesStoreFilter` re-checks every row computed in JS before writing it.
- Partial unique indexes keep their role as concurrency guards (23505 becomes a duplicate-key error).

### 3.6 Duplicate keys

- SQLSTATE 23505 becomes a `StoreDuplicateKeyError`. The constraint name is looked up in the descriptor's index map, and `keyValue` is filled from the written document's values for those fields.
- Unique indexes are on real columns, and partial uniques are `WHERE` clauses on columns.
- There is no uniqueness inside child tables today. The generator refuses multikey uniques (§1.7).
- A skill's duplicate name keeps the message `A skill with name "…" already exists`.

### 3.7 Deletes, counts, distinct, bulk

- `deleteOne`/`deleteMany` cascade to child tables through the foreign keys.
- `count(*)`.
- `distinct`: `SELECT DISTINCT c` / `unnest(c)` / child columns.
- `bulk`: one transaction; multi-row `INSERT ... ON CONFLICT` or `UPDATE ... FROM (VALUES ...)`; counts returned in the neutral shape.

## 4. Methods outside the query language

The ports' `EXCLUDED` lists hold only `aclEntry.aggregateAclEntries`, `agent.generateActionMetadataHash` (pure), `message.getMessagesByCursor` and `searchMessages`, `session.SessionError` (a class), and `userGroup.calculateRelevanceScore` and `sortPrincipalsByRelevance` (pure). The PostgreSQL backend omits the three MongoDB-only reads and re-exports the pure helpers.

What remains are named port methods whose MongoDB bodies use non-portable features. Typed columns turn most of them into plain SQL on columns and joins on child tables:

| Kind                                                                                              | Methods (store.method)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PostgreSQL implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregation with `$lookup`                                                                        | `aclEntries.listResourcePermissionPrincipals` and `listUserPermissionHolders`; `agents.getAgentWithVersionCount`, `getAgentManagementListByAccess`, `getListAgentsByAccess`; `prompts.getPromptGroup` and `getPrompt`; `codeEnvironments.findOrphanedCodeEnvironments`; `conversations.getConvoLaneContext`; `insights.getInsights`; browserSetup `restoreAllocations`                                                                                                                                                    | Joins on columns, `LEFT JOIN ... IS NULL` anti-joins. Whole joined records are assembled by the codec.                                                                                                                                                                                                                                                                                                                                                                                       |
| Group, count, facet                                                                               | `aclEntries.getSoleOwnedResourceIds`; `agentCategories.getCategoriesWithCounts`; `chatProjects.listChatProjects`; `conversations.countConvosByUser` and `getAgentEventActorReconciliationStorageMetrics` (now `count(*)` and sizes over the child table); `messages.countMessagesByUser` and the activity and byte budgets; `mcpAuthorities.loadCurrentProof`; `agentQueuedTurns.quarantineDuplicateAdmissionLanes`; `tokenTransactions.findBalanceCreditsByUsers`; trigger-delivery aggregations; `insights.getInsights` | `GROUP BY`, `count(*) FILTER`, `date_trunc`/`to_char`, window functions, `octet_length`/`char_length` on columns. `json_array_length` / `octet_length(col::text)` for `json` (`versions` `$size`, message `content`).                                                                                                                                                                                                                                                                        |
| `distinct`                                                                                        | `aclEntries.findAccessibleResources` and `findPublicResourceIds`; `agents.findFavoriteHolders`; `codeEnvironments.listCodeEnvironmentIds`; `conversations.getMessageFileConversationIds` and `getSharedConversationIds`; `conversationImports.deleteImportedConversations`; `mcpServers.findMCPServerOAuthTokenUserIds` and `findMCPServerTokenHolderIds`; `agentQueuedTurns.enqueueAgentQueuedTurn`; startup checks                                                                                                      | `SELECT DISTINCT`, `unnest`, child columns                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Positional and pipeline updates                                                                   | `messages.settleToolCallResult`, `confirmBackgroundToolResultClaim`, `releaseBackgroundToolResultClaims` (`content.$[part]`, `$cond`, `$concatArrays`); `tokenTransactions.renewBalanceReservation` (`reservations.$[held]`); conversation reconciliation `$` updates; `users` `backupCodes.$`/fences `$`; `codeEnvironments` `pendingAgentReferences.$`; `conversationTags` `tags.$`; `conversations.addConvoToolApprovalAllows` (`$setUnion`)                                                                           | Child tables: `UPDATE child ... WHERE` (§3.3). `json` content: read-modify-write under `FOR UPDATE`. `tags.$` on `T[]`: replace at `array_position`. `$setUnion` on `T[]`: the `$addToSet` expression.                                                                                                                                                                                                                                                                                       |
| `$elemMatch` (filter, `$not`, projection), `$size`, `$all`, `$type`, `$expr`                      | Reconciliations (about 20), message `content`, `schedules`/`scheduleRuns` `mcp`, `scheduleConsents` `mcpConsent.consents`, `users` (`backupCodes`, `subagentAdmissionFences`), `tokenTransactions` reservations, `codeEnvironments` `pendingAgentReferences`, browserSetup nonces and allocations, `skills` (`$not $elemMatch $nin` on `agents.skills`), `agents.mcpServerNames` `$type`                                                                                                                                  | Child tables: `EXISTS`/`NOT EXISTS` with the element conditions; the `$elemMatch` projection is a child subselect `LIMIT 1`. `json`: jsonpath filters. `T[]`: `<@`, `&&`, `cardinality`. `$expr`: hand-written SQL.                                                                                                                                                                                                                                                                          |
| Bit tests                                                                                         | `aclEntries` (`permBits`), `mcpServers.findMCPServerViewAclEntries`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `("permBits"::bigint & $mask) <> 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bulkWrite`                                                                                       | browserSetup `writeSessions`; checkpoint `saveDeletionIntents`; saver identity; ACL bulk writes                                                                                                                                                                                                                                                                                                                                                                                                                           | §3.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Cursors and streaming                                                                             | `auditLogs.streamAuditLogEntries` and `verifyAuditChain`; `skillLifecycle` journal and `getSkillUploadIntent`; `subagentContent.getSubagentContentHead`; `users.resetTermsAcceptance`; checkpoints                                                                                                                                                                                                                                                                                                                        | Keyset paging (`WHERE (sort, _id) > ($1, $2) ORDER BY ... LIMIT n`) in an async generator, with batched child reads. No server-side cursor held across awaits.                                                                                                                                                                                                                                                                                                                               |
| Compare-and-set and leases (178 `findOneAndUpdate` with filter and sort, 192 guarded `updateOne`) | `agentQueuedTurns`, `agentTriggerDeliveries`, `schedules`, `codeEnvironments`, `mcpAuthorities`, `resourceLocks`, `openidRefreshFlights`, `tokenTransactions`, `messages` (`__v`)                                                                                                                                                                                                                                                                                                                                         | §3.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Internal transactions                                                                             | `userGroups`, `systemGrants`, `mcpAuthorities`, browserSetup, ACL (`DataStore.transactions`)                                                                                                                                                                                                                                                                                                                                                                                                                              | A Kysely transaction. `StoreTransaction` is an opaque wrapper mapped through a `WeakMap`; `runAfterCommit` queues work after the commit.                                                                                                                                                                                                                                                                                                                                                     |
| Search engine (D4: MeiliSearch)                                                                   | `messages.searchUserMessages` (with `hydrate`), the title search inside `getConvosByCursor` and `searchConversation`, `share` hydration, `SearchIndexSync`                                                                                                                                                                                                                                                                                                                                                                | The same MeiliSearch client. Hydration matches by user and `messageId` (fixing the leak in PLAN). The `_meili*` flags are columns. Primitive write hooks replace the `mongoMeili` hooks (I3).                                                                                                                                                                                                                                                                                                |
| Raw collections                                                                                   | Browser setup, tombstones, reconciliation checkpoint, fence retries, credential marker, checkpoint descriptors and deletion intents, the `users`/`roles`/`prompts`/`agents` raw reads in startup checks                                                                                                                                                                                                                                                                                                                   | Typed tables from `schema/raw/` (§1.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Key-value store (GridFS for `largeValues`)                                                        | `KeyValueStore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `key_value_entries(store, key, value text, value_bytes bytea, expires_at timestamptz, PRIMARY KEY (store, key))`. `largeValues` uses `bytea` (TOAST), so GridFS is not needed. `clear(ns)` is `DELETE ... WHERE key LIKE ns \|\| ':%'`. Expired rows are filtered on read and removed by the sweeper.                                                                                                                                                                                        |
| LangGraph checkpointer (D5)                                                                       | `CheckpointStore.createSaver` and the owner, namespace and deletion operations                                                                                                                                                                                                                                                                                                                                                                                                                                            | `PostgresSaver` (`@langchain/langgraph-checkpoint-postgres` ^1.1.3) on the shared `pg` `Pool`, wrapped like `OwnedMongoSaver`/`LazyMongoSaver` (generation namespaces, lazy persistence, size guard, storage descriptors). Ownership keeps the owner-prefixed `thread_id`/`checkpoint_ns`, so owner and namespace queries are `~ '^…'` patterns, already written in the syntax both engines share. One storage is one PostgreSQL schema (`schema` option) in place of a pair of collections. |
| `StoreDocuments`                                                                                  | Import size check, checkpoint size guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `maxDocumentBytes` stays 16 MiB (parity). `measureDocument` is the UTF-8 byte length of the record's canonical JSON with `_id` and `__v`.                                                                                                                                                                                                                                                                                                                                                    |
| `StoreErrors`                                                                                     | Duplicate keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §3.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Domain rules: where a MongoDB method body is mostly rules rather than storage (key encryption in `userKeys`, balance rules, share visibility, agent version duplicate detection), the unit first extracts a database-neutral function on port steps, following the `saveConvo` pattern. That extraction is a refactor PR on the MongoDB side with no behavior change and existing tests untouched. Storage-heavy methods (compare-and-set, leases) are written directly in SQL.

## 5. Migrations and schema drift

**Generator** (`packages/data-schemas`, run with `npm run db:generate`). It builds the descriptor from:

- `createModels(new Mongoose())`, with the overrides' plugin paths applied;
- `schema/raw/*`;
- `overrides.ts`.

It emits:

- `adapters/postgres/schema/descriptor.generated.ts`: tables, path tree, column and identifier names, kinds and types, hidden paths, setters, timestamps, version key, indexes (name → fields), TTL descriptors, hints;
- `adapters/postgres/schema/db.generated.ts`: Kysely `Database` table interfaces. With real columns, Kysely's typing now pays off for the hand-written SQL in the S units;
- `adapters/postgres/schema/snapshot.json`: the descriptor as of the latest migration;
- `migrations/<YYYYMMDDHHmm>_<slug>.ts`: the DDL diff between `snapshot.json` and the new descriptor, plus the static import list in `migrations/index.ts`.

**What the generator emits per change:**

- **New field** → `ALTER TABLE ... ADD COLUMN` (nullable, no default: instant).
- **New subdocument array** → `CREATE TABLE` (child table).
- **New collection** → `CREATE TABLE`.
- **New index** → `CREATE INDEX`. `CONCURRENTLY` (outside the migration transaction) is used for tables flagged large: messages, conversations, files, transactions, trigger deliveries.
- **Removed field** → a migration that moves its non-null values into `_extra` (so reads keep returning them, as MongoDB lean reads keep returning removed fields), then `DROP COLUMN`. A rename is a remove plus an add.
- **Type change** → `ALTER COLUMN TYPE ... USING` only when the cast is total (String → `json`, Number → String). Otherwise generation fails and asks for a hand-written migration.
- The generator never changes a checked-in migration.

**Migrator.**

- Kysely `Migrator` with an **in-code provider**: migration modules imported statically, because tsdown bundles the package.
- `allowUnorderedMigrations: true`, because parallel units and upstream merges interleave timestamps.
- Kysely's migration lock (a session-level `pg_advisory_lock`, plus its lock table) serializes concurrent boots (`E2E_REPLICAS=2`).
- Kysely applies the pending migrations **in one transaction** (F1 finding): a failure rolls back the whole batch, and `CREATE INDEX CONCURRENTLY` cannot run inside it, so the large-table indexes need their own step outside the migrator (a second run with `disableTransactions`, or a post-migration step), decided in F3.
- `0001_initial` holds every table, the `lc_object_id` domain and the `lc_*` helper functions (`lc_nulls_set`, `lc_sort_key`, `lc_fail`).
- Migrations run on `connect()` unless `POSTGRES_AUTO_MIGRATE=false` (D6). `npm run db:migrate` (`config/db-migrate.js`) runs them explicitly, for deployments that migrate before rolling out.

**Drift specs:**

1. The checked-in descriptor equals a freshly generated one. It fails when a schema changed and the generator was not run.
2. All migrations applied to an empty database and introspected (`information_schema`, `pg_indexes`, `pg_constraint`) equal the descriptor's expected DDL. It fails on a missing or hand-edited migration.
3. Every mongoose index has a PostgreSQL index with the same keys, uniqueness and partial filter.

**Upstream merges.** After merging upstream LibreChat, a schema change makes drift spec 1 fail. Run `npm run db:generate`, review, and commit the new migration, descriptor and snapshot. Conflicts in `snapshot.json` between parallel branches are resolved by rebasing and regenerating.

## 6. Libraries, configuration, dependencies, test server

### Libraries

- **`pg` 8.x + Kysely 0.28/0.29**: peer dependencies of `data-schemas` (like `mongoose`), dependencies of `api`. One driver everywhere: `PostgresSaver` takes the same `Pool`. F1 installed `pg` ^8.23.1 (with `@types/pg` ^8.23.1 as a dev dependency) and **Kysely ^0.28.19**: 0.29 ships ESM only and requires Node 22, while the server and the Jest suites load the package as CommonJS.
- Kysely provides `sql` composition (the translator returns `RawBuilder`s), transactions, a `log` hook feeding `DataStoreQueryObserver` (the `mongoose_queries_*` metrics stay), the Migrator, and typed tables from `db.generated.ts`.
- No PostgreSQL extensions are required: ids are generated in Node, there is no `btree_gin` or `pg_trgm`, and ICU is a build feature, not an extension.

### Dependency bump for D5 (unit DEP1, verified)

| Package                                    | Where                                                                                                                          | Today                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@langchain/langgraph-checkpoint`          | `packages/api` `dependencies` `^1.1.2`; `packages/data-schemas` `peerDependencies` `^1.1.2`; not in root or `api/package.json` | 1.1.3 installed, one copy in the lockfile                                                                                                                        |
| `@langchain/langgraph-checkpoint-mongodb`  | same places, `^1.4.0`                                                                                                          | 1.4.0, peer `@langchain/langgraph-checkpoint ^1.0.0` (accepts 1.2)                                                                                               |
| `@librechat/agents`                        | `api` `dependencies` `^4.2.1`, `packages/api` peer                                                                             | 4.2.1 installed (4.2.2 latest). **No direct dependency on the checkpoint package**: it pins `@langchain/langgraph` 1.4.8 and `@langchain/core` 1.2.8 exactly.    |
| `@langchain/langgraph`                     | `packages/api` `devDependencies` `^1.4.5`, and through `@librechat/agents`                                                     | 1.4.8, depends on `@langchain/langgraph-checkpoint ^1.1.3` (**accepts 1.2.x**)                                                                                   |
| `@langchain/core`                          | through `@librechat/agents`                                                                                                    | 1.2.8 fits checkpoint 1.2.2's peer `^1.1.48` and the postgres saver's `^1.1.44`                                                                                  |
| `@langchain/langgraph-checkpoint-postgres` | not installed                                                                                                                  | latest 1.1.3 (1.1.0 onward peer `@langchain/langgraph-checkpoint ^1.2.0`; 1.0.5 and 1.0.6 `^1.1.4`; 1.0.4 `^1.0.0`); dependencies `pg ^8.12.0`, `postgres-array` |

- The checkpoint 1.1.3 → 1.2.2 API diff (`dist/base.d.ts`) is additive: `putWrites(config, writes, taskId, taskPath?)` gains an optional argument, and `writesSortKey`, `compareWritesSortKeys` and `WritesSortKey` are new exports. `OwnedMongoSaver.putWrites(config, writes, taskId)` stays type-compatible, and langgraph 1.4.8 does not pass `taskPath`.
- **So the bump is a separate dependency-only PR first (DEP1):**
  - `@langchain/langgraph-checkpoint` `^1.2.2` in `packages/api` (dependency) and `data-schemas` (peer);
  - the lockfile regenerated (langgraph 1.4.8's `^1.1.3` dedupes onto 1.2.2);
  - `@langchain/langgraph-checkpoint-mongodb` kept at `^1.4.0`: 1.5.x would change the MongoDB saver, which is out of scope.
- Verify: the three Jest baselines plus the checkpoint and HITL suites (`packages/api/src/agents/checkpointer.integration.spec.ts`, `hitl/modes.integration.spec.ts`, the `data-schemas` checkpoint store specs) and the e2e HITL specs, all unchanged on MongoDB.
- I2 then adds `@langchain/langgraph-checkpoint-postgres ^1.1.3`, mirroring the mongodb saver: a peer of `data-schemas` and a dependency of `packages/api`.

### Configuration

- `DATABASE_BACKEND=mongo|postgres` (default `mongo`), read once in `getDataStoreBackend()`.
- `POSTGRES_URI` (required for postgres), `POSTGRES_SCHEMA`, `POSTGRES_POOL_MAX`, `POSTGRES_AUTO_MIGRATE` (default `true`), `POSTGRES_TTL_INTERVAL_MS`.
- Boot checks:
  - `server_version_num >= 150000`;
  - the `und-x-icu` collation exists;
  - `standard_conforming_strings = on`;
  - with auto-migrate off, the migration level equals the code's.

### Test server

**This container:**

- PostgreSQL 16.15 server binaries are installed (`/usr/lib/postgresql/16/bin/{initdb,pg_ctl,postgres}`).
- The system cluster is down and there is no Docker daemon.
- Tests run as root, which `initdb` refuses; the `postgres` user exists (uid 102), and `runuser`/`setpriv` are available.
- Only the C locales are installed; ICU locales work regardless.

**Harness** (`packages/data-schemas/src/test/postgres/`, new):

- It uses `POSTGRES_TEST_URI` when set (CI: `postgres:16` and `postgres:15` service containers).
- Otherwise it runs `initdb` into a temp directory owned by `postgres` (through `runuser -u postgres --` when uid is 0), with `--auth=trust --encoding=UTF8 --locale=C`, and starts `postgres` on a free port.
- It migrates once into `lc_template`. Each suite runs `CREATE DATABASE lc_t_<worker>_<n> TEMPLATE lc_template` (about 100 ms), and `TRUNCATE ... CASCADE` resets between tests.
- As built in F1 (`src/test/postgres/`, `jest.postgres.mjs`): every database of a run carries the run's prefix (`lc_t_<run id>_template`, `lc_t_<run id>_<worker>_<n>`), so runs sharing one `POSTGRES_TEST_URI` server never collide. The Jest global setup only creates a run directory; the first suite that needs PostgreSQL starts the server there (so a run without PostgreSQL specs starts nothing), and the global teardown stops it and removes the run's databases (and cleans up runs of killed processes). Measured here: `initdb` about 0.6 s, start about 0.1 s, a suite database about 70 ms. Without that global setup (another Jest config), each suite starts its own server. `describePostgres` and `usePostgresTestDatabase()` are the suite helpers.
- The translator corpora also run on a database with `LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`.
- Without PostgreSQL the specs skip with a warning, unless `REQUIRE_POSTGRES_TESTS=true` (CI), which makes them fail.

**PGlite** is rejected as the test server: it runs one in-process backend connection, so contention specs prove nothing on it; `pg.Pool` and `PostgresSaver` need `pglite-socket`; and real PostgreSQL is available locally and in CI.

## 7. Tests (D3)

### How the suites use MongoDB today

| Package                 | Test files | With `MongoMemoryServer` | Importing mongoose directly | DB through stores only                    |
| ----------------------- | ---------- | ------------------------ | --------------------------- | ----------------------------------------- |
| `api`                   | 292        | 52                       | 59                          | 3                                         |
| `packages/api`          | 915        | 72                       | 124                         | 0                                         |
| `packages/data-schemas` | 233        | 103                      | 180                         | 1 (`tenant/conformance.mongoose.spec.ts`) |

DB-backed suites seed and assert through mongoose (`require('~/db/models')`, `mongoose.models.X`, `createModels`/`createMethods` inside `jest.mock` factories, `new ObjectId()`, `dropDatabase`). So they cannot be switched by an environment variable.

The `data-schemas` method specs (93.8k lines) assert MongoDB documents. They stay as the MongoDB adapter's tests and are replaced, for PostgreSQL, by port contract suites.

Remapping `mongoose` or `mongodb-memory-server` through `moduleNameMapper` is rejected: the suites would test the shim.

### Definition of done for phase 5

1. **Port contract suites** (new files):
   - `contracts/<store>.contract.ts` exports `describe<Store>Contract(harness)`, following `tenant/conformance.ts` with its `jest/no-export` header;
   - `<store>.mongo.spec.ts` and `<store>.postgres.spec.ts` run it;
   - the harness has `createStores()`, `reset()`, `seedRaw(collection, records)` (raw mode, §3.2), `readRaw(collection)` and `ids`;
   - every port method gets at least one case, derived from the existing method specs (ported, never edited);
   - each suite goes green on MongoDB first, then on PostgreSQL.
2. Corpora A, B and D on PostgreSQL; corpus C on both backends; tenant conformance on PostgreSQL.
3. **The full e2e mock suite on PostgreSQL**, with one and two replicas.
4. The no-DB Jest suites (about 240 in `api`, about 840 in `packages/api`) under `DATABASE_BACKEND=postgres`.
5. **About 20 curated DB-backed suites** converted to the neutral fixture helper (`createTestDataStore()` from `@librechat/data-schemas/testing`: backend from `DATABASE_BACKEND`, `methods`, `seed`, `read`, `reset`, `close`). Test-only PRs of about 5 suites each, smallest first:
   - **H2a**: `api/server/routes/__tests__/admin-config-reload.spec.js`, `__tests__/grants.spec.js`, `accessPermissions.test.js`, `__tests__/messages-delete.spec.js`, `__tests__/auth.tenant.spec.js`.
   - **H2b**: `skills.tenant.test.js`, `agents/__tests__/openapi.contract.spec.js`, `__tests__/messages-tool-previews.spec.js`, `packages/api/src/conversations/save.spec.ts`, `packages/api/src/shared-links/access.test.ts`.
   - **H2c**: `assistants/avatar.spec.js`, `files/images.agents.test.js`, `agents/__tests__/responses.spec.js`, `packages/api/src/admin/config.integration.spec.ts`, `packages/api/src/acl/accessControlService.spec.ts`.
   - **H2d**: `files/files.agents.test.js`, `skills.test.js`, `files/files.test.js`, `prompts.test.js`, `__tests__/mcp.spec.js`.
   - Paths without a prefix are under `api/server/routes/`; together these are the 16 DB-backed suites there, plus 4 from `packages/api`.
   - Each PR is green on MongoDB at merge. Each suite's PostgreSQL run is enabled in CI (a list in the PostgreSQL Jest config) once the stores it touches are complete, and all of them are enabled by milestone B.

### e2e mock suite on PostgreSQL (E1, one test-only PR)

**Today:**

- `e2e/setup/start-server.js` and `start-server-cluster.js` start a memory MongoDB (`E2E_USE_MEMORY_MONGO=auto`) and write `MONGO_URI` to the runtime env file.
- 99 specs import `e2e/specs/mock/db.ts`: 162 `withMongo(` calls on 27 collections. The operations are `find` 128, `findOne` 82, `deleteMany` 57, `insertOne` 35, `updateOne` 29, `countDocuments` 29, `insertMany` 23, `deleteOne` 14, `updateMany` 2; the operators only `$in`, `$set`, `$unset`, `$setOnInsert`, `$regex`.
- 23 specs import `mongodb` directly.
- `e2e/setup/cleanupUser.ts` uses the MongoDB-only `@librechat/backend/db/models`.

**Changes:**

- `start-server*.js` with `E2E_DATABASE_BACKEND=postgres`: use `POSTGRES_URI` or start a temp cluster through the harness, set `DATABASE_BACKEND=postgres`, and write `POSTGRES_URI` to the runtime env file.
- `db.ts`: `withMongo(fn)` hands `fn` a driver-like `db` whose `collection(name)` is a facade over the primitive's raw mode (tables carry the collection names). Casting follows the descriptor, there are no defaults, and undeclared fields go to `_extra`. Ids are 24-hex strings. The 99 specs need **no edits**.
- `cleanupUser.ts`: through `~/models` stores only.
- The 23 direct-driver specs, `no-auto-index.cjs` and the MongoDB-specific scenarios skip under PostgreSQL, unless moved to `db.ts` in the same PR.

**E2** then runs the full mock suite on PostgreSQL with `E2E_REPLICAS=1` and `2`. Failures are fixed in adapter PRs, never in the specs.

## 8. Units

Conventions:

- Each unit is one subagent and one PR into `feature/postgres`, squash-merged, following UNIT_BRIEF.md.
- Checks: typecheck, build, lint, circular deps, and the three Jest baselines on MongoDB, unchanged. New PostgreSQL specs must be green.
- Parallel units use separate worktrees (`git worktree add ../lc-<unit> -b <branch> origin/feature/postgres`), each with its own `npm ci` and build, and its own test cluster port or database prefix.
- With 4 cores and 15 GB, at most 2 to 3 code-writing subagents at once. Every Jest run is serialized through a shared lock (`flock <scratch>/jest.lock npx jest ...`).
- A unit that changes a schema runs `npm run db:generate` and commits the migration.

### Wave 0 (sequential)

**F0: neutral composition root** (MongoDB side, no behavior change; being implemented)

- **Scope:** `composeDataMethods(factories, deps)` with the cross-store wiring of `methods/index.ts`, and the neutral `DataMethods` type. `getDataStoreBackend()` returns `DataStoreBackend<DataMethods, CreateMethodsDeps>`.
- **Verify:** baselines unchanged; `composeDataMethods` with the MongoDB factories gives the same 733 keys.

**F1: PostgreSQL foundation**

- **Scope:**
  - `pg` and `kysely`, as peer and dev dependencies of `data-schemas` and dependencies of `api`;
  - `adapters/postgres/connection.ts`;
  - `values.ts`: column value conversions (ids, dates, `bytea`), the tagged JSON codec for `json` columns, the U+0000 policy (D8);
  - `storeIds.ts` (ObjectId-layout generator, strict 24-hex `isValid`, lowercase canonical form), `storeDocuments.ts`, `storeErrors.ts`, `storeTransactions.ts`, `migrator.ts` (in-code provider, lock), `backend.ts`;
  - the `DATABASE_BACKEND` switch. Stores not yet implemented are stubs throwing `StoreNotImplementedError`, and `connect()` refuses an incomplete backend unless `POSTGRES_ALLOW_INCOMPLETE_STORES=true`;
  - boot checks;
  - the test harness;
  - the contract harness interface with its MongoDB implementation.
- **Verify:** specs for ids, codec round trips, errors, documents, transactions (commit, rollback, `runAfterCommit`), connection, migrator lock. The MongoDB default is unchanged.
- **Done.** Choices and deviations recorded while building it:
  - No bootstrap migration: the migration list is empty, and the `lc_object_id` domain and `lc_*` helpers stay in F3's `0001_initial`.
  - Every member the backend lacks throws `StoreNotImplementedError` when used (store methods; `getSearchIndexSync`, `getCredentialMarkerStore`, `getCheckpointStore`; the first operation of a key-value store or startup check) rather than answering `null`, so nothing is silently skipped. `registerModels` is already a no-op. The backend lists what is missing (`unimplemented`), and `connect` refuses with `IncompletePostgresBackendError` before opening anything.
  - The pure helpers that still live inside MongoDB method modules (`generateActionMetadataHash`, `calculateRelevanceScore`, `sortPrincipalsByRelevance`) and the four conversation domain functions are stand-ins too, until extracted or rebuilt (S7, S2, S6a); `tx` and `SessionError` are shared as they are. The PostgreSQL methods have the MongoDB keys minus `aggregateAclEntries`, `getMessagesByCursor` and `searchMessages` (731).
  - `getDataStoreBackend()` stays typed `MongoDataStoreBackend` (and `StoreIdValue` an ObjectId) for the callers F0 named; with `DATABASE_BACKEND=postgres` the PostgreSQL backend is returned under that type until B1 retypes them. A value other than `mongo`/`postgres` throws.
  - A client losing its server mid-transaction emits `error` on the checked-out `pg` client, which would end the process; the pool attaches a logging handler to every client.
  - The contract harness also has `name`, `setup()` and `teardown()` (as `TenantEngineHarness`). On MongoDB, `seedRaw` casts declared top-level fields with `Model.castObject` and keeps undeclared or uncastable ones as given; `readRaw` returns ids as hex strings and binaries as `Buffer`s.
  - The neutral lint block covers `adapters/postgres/`, `contracts/` and `test/postgres/` (specs excepted); the schema generator got its own exception with F2 (see below).

**DEP1: checkpoint dependency bump** (D5)

- Dependency-only PR, §6. It can run in parallel with F1 or F2, and must land before I2.

### Wave 1

**F2: typed schema descriptor and DDL generator** (large; sequential, everything depends on it)

- **Scope:**
  - `adapters/postgres/schema/{descriptor.ts,generate.ts,naming.ts,overrides.ts,emitDdl.ts,emitKysely.ts,diff.ts}`: the descriptor types and builder (rules of §1.2, overrides of §1.6), identifier naming, the DDL emitter (tables, child and element tables, shape columns, `_nulls`/`_extra`, indexes, partial, sparse and TTL rules, hint `CHECK`s), the Kysely type emitter, and the snapshot diff;
  - `schema/raw/*.ts` (mongoose schemas for the raw collections, KV and credential marker included);
  - the generator CLI.
  - The generator fails on unsupported shapes: an array of subdocuments inside another, a multikey unique index, `__` in field names, collisions.
- **Verify:**
  - the descriptor matches mongoose introspection for every path and index of the 53 models;
  - the emitted DDL applies on a scratch database;
  - identifiers are 63 bytes or less;
  - specs on hand-made schemas for each rule (one per row of §1.2).
- **Done.** What it built, and the choices and deviations recorded while building it:
  - `adapters/postgres/schema/`: `naming.ts` (identifiers, 63-byte shortening, collision registry), `overrides.ts`, `descriptor.ts` (descriptor types and the builder, which works on plain introspected data and never loads mongoose), `generate.ts` (the introspection of `createModels(new Mongoose())` and `schema/raw/`), `emitDdl.ts`, `emitKysely.ts`, `diff.ts`, `cli.ts`, and `raw/` (the 9 raw collections of §0 plus `key_value_entries`).
  - Measured on the current schemas: 53 models and 10 raw tables; 95 tables (53 collection, 10 raw, 27 child: the 25 of the models plus browser setup `nonces` and `allocations`, 5 element); 1,527 columns on collection tables and 302 on child tables (`conversations` 162, `agenttriggerdeliveries` 119, `messages` 96, `files` 71, `roles` 67); 40 `json` columns (38 in the models); 356 SQL indexes (58 unique, 56 partial or sparse, 4 GIN) from 361 MongoDB index declarations (351 schema indexes, 6 `mongoMeili` cleanup indexes, 4 raw); 21 TTL rules; 11 hint `CHECK`s. No production shape was rejected.
  - Generator CLI: `node packages/data-schemas/scripts/postgres-schema.cjs [--out <dir>] [--previous <snapshot.json>]`. It prints the counts and, with `--out`, writes `snapshot.json`, `descriptor.generated.ts`, `db.generated.ts`, `schema.sql` and (with `--previous`) `migration.sql`. The launcher transpiles the TypeScript sources with the package's own `typescript` (no new dependency, no build); F3 wires `npm run db:generate` and checks the outputs in.
  - Lint: `schema/generate.ts` and `schema/raw/**` have their own block of `data-layer/no-database-driver` that allows `mongoose` only (`mongodb`, `bson` and the LangGraph MongoDB checkpointer stay banned); the rest of `schema/` keeps the neutral rule. R1's schema engine (`schema/engine.ts`) will need the same exception.
  - Element tables (§1.2, §1.6) also give the parent an `integer` element-count column named by the path, like child arrays, so missing versus empty and `$size` work the same way. Element tables have no `_nulls`/`_extra`.
  - `key_value_entries` is a raw schema keyed by `(store, key)` (no `_id`, `_nulls` or `_extra`), with a TTL rule on `expires_at`.
  - The `mongoMeili` override carries the plugin's three cleanup indexes (`meili_excluded_*`, which `SearchIndexSync.cleanupExcluded` needs) as well as its five paths; a spec checks both against the plugin. It carries the paths' `select: false` but not their defaults: the engine (R1) applies `_meiliIndex: false` and `_meiliCleanupVersion` as the plugin declares them.
  - Index names: `<table>__<keys>` with each key path's dots as `_` and `_desc` for `-1`, then `__gin` for GIN and `__p` for a partial or sparse predicate; names that collide get `_<8-hex hash of the definition>` (and are shortened past 63 bytes). Identical SQL indexes are merged (8 today: duplicated `tenantId` btrees and the token `value` indexes), and one MongoDB index may give several (13: GIN plus btree, or child and parent parts); each SQL index lists the MongoDB indexes it serves in `sources` (name, keys, options), which the duplicate-key mapping reads. Constraint names: `<table>__pkey`, `<table>__parent_fkey`, `<table>__<column>__<subpath>__hint`.
  - Hinted keys and checks use `(("col"::jsonb) #> '{"a","b"}')`; Q1 builds its equality on the descriptor's `expression`. A unique index may cover a hinted subpath; one on an unhinted `Mixed` path fails like any multikey unique.
  - Partial filters translated: `$exists: true`, equality (`null` gives `IS NULL`), `$gt`/`$gte`/`$lt`/`$lte`, `$type` matching the column's type (`IS NOT NULL`), `$and`. A filter on another table than the indexed one (a child index with a parent condition), a presence condition on an unhinted `Mixed` subpath and any other operator fail the generation. A TTL index needs one top-level `Date` key.
  - Also refused: `Decimal128` and the other types §1.2 has no column for, arrays of arrays, `Map`s of subdocuments or arrays, text/hashed/geo keys, collations, index keys on a whole object or subdocument array, and overrides that match nothing (stale).
  - The version key path is added by the introspection when a schema lacks it (mongoose adds it when compiling a model), so hand-made and raw schemas map like models.
  - `pg` returns an array of a domain (`lc_object_id[]`) as unparsed text (`'{…}'`): the record codec (R1) selects such columns as `col::text[]` or registers a parser for the array type at connect. `db.generated.ts` types them `string[]`.
  - Diff (§5): `String → json` uses `to_json`, `Number → String` uses `::text` (PostgreSQL's shortest float text, which can differ from JavaScript's `String()` for exotic values such as `-0`); removed fields move into `_extra` in the tagged encoding of §1.3 (explicit nulls as `null`, then removed from `_nulls`), a removed object path as `{}` with its leaves merged in. A removed table (a collection or a subdocument array), a changed primary key or parent, a removed system column and a removed field of a table without `_extra` fail and ask for a hand-written migration.

### Wave 2 (parallel, 3 worktrees)

**F3: initial migration and drift**

- **Scope:** run the generator; check in `descriptor.generated.ts`, `db.generated.ts`, `snapshot.json`, `migrations/0001_initial.ts` with `migrations/index.ts`, and the `lc_*` SQL helpers; `npm run db:generate`/`db:migrate`; the three drift specs (§5).
- **Builds on:** F2.
- **Verify:** the migration applies on an empty database; the drift specs pass; a deliberately added test schema field makes spec 1 fail (spec-local).

**R1: record codec and schema engine**

- **Scope:**
  - `schema/engine.ts` (D2);
  - `adapters/postgres/records/{decompose,assemble,cast,nulls,extra}.ts`: document → rows, rows → record (json_agg subselects, batched child reads, key order), the descriptor caster for filter and update values, raw mode.
- **Builds on:** F2. Tables are created in specs by the emitter.
- **Verify:**
  - corpus D round trips on every production table;
  - caster versus mongoose `Query#cast` and update casting (generated inputs);
  - `_nulls` and `_extra` rules;
  - key order versus `toObject()`;
  - the U+0000 policy.
- **Done.** What it built, and the choices and deviations recorded while building it:
  - `schema/engine.ts`: `createSchemaEngine()` (and the process-wide `getSchemaEngine()`) compiles the generator's models on a private `new Mongoose()` that never connects. `generate.ts` now builds them through `createOfflineModels`, which both share; the generated descriptor is byte-identical. The engine offers:
    - `buildDocument(collection, doc, { validate })`: `new Model(doc)`, `validate()`, then `toObject()` with the options `save` uses, plus `flattenMaps`. It sets no timestamps and no `__v`: C1 sets them on insert, as `save` does.
    - `validatePaths` (`Model.validate` for `runValidators`).
    - `castUpdateValue`: mongoose's own update casting, for the subdocuments an update writes (defaults, `_id`s).
    - `isImmutable`.
    - The `mongoMeili` paths carry the plugin's defaults (`_meiliIndex: false`, `_meiliCleanupVersion: MEILI_CLEANUP_VERSION`, now exported by the plugin); a spec checks them against the plugin.
    - The raw collections get models too.
    - `engine.ts` joins the generator's mongoose-only lint block.
  - `records/`:
    - `tables.ts`: lookups over the descriptor.
    - `paths.ts`: the path resolver, for the caster and Q1. It takes the longest declared prefix, handles child-table hops, element positions (`a.0`, and in updates `$`, `$[]`, `$[x]`) and `json` subpaths. An undeclared path raises `UndeclaredPathError`, a `StoreQueryError`.
    - `cast.ts`: the caster.
    - `decompose.ts`: document → rows, plus `insertStatements` (multi-row `INSERT`s for specs, seeding and the raw facade).
    - `assemble.ts`: `selectRecord`, `readChildRows`, `readRecords`.
    - `nulls.ts`: `presenceSql`, `absenceSql`, `updateNulls`.
    - `extra.ts`: encode/decode/merge/set/unset.
    - `corpusD.ts`: the corpus D generator, which Q1 reuses.
  - **Caster interface (for Q1 and C1):**
    - `createRecordCaster(indexRecordTables(descriptor), { engine })` gives:
      - `castFilter(collection, filter)` / `castFilterOn(table, filter)`: whole filters, with `$and`/`$or`/`$nor` and `$elemMatch` handled recursively;
      - `castCondition(resolved, operator | null, value)`: one operand on a path already resolved by `resolveRecordPath`;
      - `castUpdate(collection, update, { undeclared: 'strip' | 'refuse' | 'keep' })`;
      - `castAssignment`.
    - `castScalar(type, value, { transforms, countNul })` casts one value.
    - `castTargetOf(tables, resolved)` names what a path casts to: `scalar`, `array`, `object`, `children`, `json` or `map`.
    - Results are in canonical form: ids as lowercase hex, `Date`, `Buffer`, and strings with U+0000 → U+FFFD. The replacement is counted for update values only.
  - **Key order:**
    - A record is assembled as `_id`, then the descriptor's fields in `schema.paths` order (timestamps and plugin paths after the declared fields), then the version key, then the `_extra` keys.
    - Objects and child elements keep their schema's order (a subdocument's `_id` last). `json` keeps its text order.
    - The corpus D spec compares this order exactly with `toObject()` (with `_id` moved first, where MongoDB puts it, and `__v` last, where `save` puts it), for full, all-null and top-level-null documents of every table.
  - **Corpus D:** 4 variants per root table (`full`, `nulls`, `topNulls`, `empty`). Each one goes engine → decompose → insert → assemble, with both child read modes, on all 63 root tables (53 collections and 10 raw), so every child and element table is covered. That is 504 round trips.
  - **Deviations:**
    - **Key order (R7):**
      - Defaults that mongoose applies after the given paths (arrays of subdocuments, Maps) sit at their schema position here, so the `empty` variant is compared without key order.
      - `_extra` keys come back in `jsonb` order.
    - **Caster versus mongoose:**
      - Equal on the generated differential (every path of the 53 models; filters, updates, Maps, subdocuments).
      - Refused on purpose, as R7 allows: 12-character ObjectId strings; non-id, non-string values for `principalId`; `$push`/`$addToSet` of an array or object into a scalar array; `$push` modifiers; plain-object operands of `$inc`/`$min`/`$max` (mongoose leaves them uncast); filters on undeclared paths; unknown `$` operators.
      - Equality with an array on a scalar path becomes `$in`, as mongoose does.
      - Immutable paths are stripped from updates (outside `$setOnInsert`) only when the engine is given.
    - **`_nulls`:** a `null` top-level `json` value is stored as SQL `NULL` and listed in `_nulls`, not as JSON `null`. `$exists: false` needs `absenceSql`, because a plain `NOT` of the presence form is `NULL` when `_nulls` is `NULL`. A table without system columns (`key_value_entries`) reads an explicit null back as missing.
    - **Raw mode:**
      - `rawValues: 'cast'` (the default) casts without setters and wraps a scalar into an array, like `castObject`. `'exact'` (for X1) accepts only values that already have their type.
      - Misfits go to `_extra`, and are reported in `diverted`. Misfits are a wrong type, a non-object or null element in a child array, and `$`-keyed `Mixed` contents. `values.ts` gained `allowDollarKeys` for this, which `_extra` uses; it still refuses a single-key tag-shaped object.
      - Document mode puts undeclared keys back into `_extra`, so records computed in JavaScript from an assembled record round-trip.
    - **Encoding:**
      - Inside `json_agg`, dates travel as epoch milliseconds (exact, and no BC formatting).
      - `lc_object_id[]` is selected as `::text[]`.
      - `-0` is sent as the text `-0`.
      - `NaN`/`±Infinity` are read back from their JSON spelling.
      - `json_build_array` is chunked past 90 columns.
      - `values.ts` also gained `reviveTaggedJson`.

**Q1: query language → SQL translator over the descriptor**

- **Scope:** `adapters/postgres/query/{resolve,filter,projection,sort,paging,regex,jsonpath}.ts` per §2.
- **Builds on:** F2 (descriptor), and R1's caster interface (stubbed by identity until R1 lands, or Q1 lands after R1's caster commit).
- **Verify:**
  - `query.postgres.differential.spec.ts` (corpus A on the `json` corpus table, C and ICU databases);
  - `query.typed.differential.spec.ts` on MongoDB plus `query.typed.postgres.spec.ts` (corpus B);
  - corpus D filters;
  - `EXPLAIN` specs.
  - Q1 must also check that jsonpath string comparison is code point order; otherwise compare through `COLLATE "C"` text extraction.

**K0: contract suites, contract first** (runs all the way through, from F1 on)

- Writes port contract suites against the MongoDB adapter only (new files, green on MongoDB), store group by store group, ahead of the matching S unit. It pins today's behavior and is the main schedule lever (R4).

### Wave 3

**C1: collection primitive over typed tables** (large)

- **Scope:** `adapters/postgres/collection/`:
  - the `PgCollection` lean-subset API (`find`/`findOne`, `count`, `exists`, `distinct`, `insertOne`/`insertMany`, `updateOne`/`updateMany` with upsert, `findOneAndUpdate` with before/after and sort, `findOneAndDelete`, `deleteOne`/`deleteMany`, `bulk`);
  - tier-1 SQL updates for parent rows, tier-2 read-modify-write for everything else (child tables included);
  - the shadow check, upserts, the concurrency rules of §3.5;
  - timestamps and `__v`, duplicate-key mapping;
  - the tenant policy plus a PostgreSQL `TenantEngineHarness`;
  - collection hooks (search tokens into element tables, `auditLog` append-only, `mcpServer` normalization, search flags as a no-op until I3);
  - transaction executor resolution;
  - the `@librechat/data-schemas/testing` entry (raw facade for e2e and fixtures).
- **Builds on:** F3, R1, Q1.
- **Verify:**
  - corpus A and B update and upsert cases through `PgCollection`;
  - tenant conformance on PostgreSQL;
  - concurrency specs: parallel claims on separate pool clients get distinct rows; upsert races give one row; partial unique guards hold; the child-filter rule (a write racing a child change never updates a non-matching row).

### Wave 4 (parallel, 2 to 3 at a time)

**C2: extended operators and child-table SQL**

- **Scope:**
  - `$elemMatch` (filter, `$not`, projection), `$size`, `$all`, `$type`, `$bitsAnySet`/`$bitsAllSet`, positional `$`, `$[x]` with `arrayFilters`, `$setUnion`-style merges, on child tables, `T[]` and `json`;
  - tier-1 SQL for child-table `$push`, `$pull` and `$addToSet` (§3.3);
  - the extended reference evaluator inside `adapters/postgres` (the port language is not widened).
- **Builds on:** C1.
- **Verify:** corpus C differential against MongoDB (evaluator = MongoDB) and PostgreSQL (SQL = evaluator); shadow check on.

**I1: key-value store and credential marker**

- **Scope:** `keyValueStore.ts`, `credentialMarker.ts` on their tables from `0001_initial`.
- **Builds on:** F3.
- **Verify:** KV and marker contract suites on both backends (from `adapters/mongo/keyValueStore.spec.ts` and `credentialMarker.spec.ts`); `packages/api/src/cache/keyvMongo.ts` exercised on PostgreSQL by a new spec.

**I4: TTL sweeper**

- **Scope:** TTL descriptors from F3. Runs every `POSTGRES_TTL_INTERVAL_MS` (default 60 s), deleting in batches of 1,000 per table under `pg_try_advisory_lock`. Handles partial TTLs, `expireAfterSeconds` offsets, KV and browser-setup tables. Child rows go by cascade.
- **Builds on:** F3.
- **Verify:** a fake-clock spec on every TTL table; a two-connection lock spec.

**S3** starts here (needs C1 only).

### Wave 5: store adapters (parallel, 2 to 3 at a time)

Each S unit covers:

- `adapters/postgres/stores/<module>.ts`, typed `const store: XStore = …`;
- registration in the PostgreSQL factories;
- the hand-written SQL of §4 (Kysely typed by `db.generated.ts`);
- the domain-rule extractions it needs (a separate MongoDB refactor PR if large);
- its contract suites, green on both backends;
- the store completeness list in PLAN.md.

| Unit                     | Stores (methods)                                                                                                                                                                                             | Typed-storage notes                                                                                                                                                                                 | Needs |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| S1 identity and auth     | users 28, sessions 7, tokens 5, refreshTokenBridges 3, openidRefreshFlights 8, passkeys 8, userKeys 5, pluginAuths 5, agentApiKeys 6                                                                         | `backupCodes`/fences/`favorites` child tables, search-token element tables, `skillStates` Map, `plugins` `json` `$pull`, `bytea`, cursor `resetTermsAcceptance`. First, because e2e login needs it. | C2    |
| S2 authorization         | roles 15, accessRoles 6, aclEntries 19, systemGrants 14, userGroups 20, principals 2, resourceLocks 3                                                                                                        | `principalId` text override, bit masks, joins, bulk writes, transactions, flattened role permissions, legacy `SHARED_GLOBAL` through `_extra`                                                       | C2    |
| S3 small and config      | configOverrides 15, banners 4, categories 1, agentCategories 5, toolFavorites 4, tokenLists 1, presets 3, actions 4, assistants 7, toolCalls 3, auditLogs 6, memories 9, fileStorage 5, toolApprovalGrants 3 | `tenantPartition` merged reads, the `auditLog` hash chain and streaming. **`scheduleConsents` moved to S10a**: it queries `schedules.mcpConsent` with `$elemMatch`.                                 | C1    |
| S4 balance               | tokenTransactions 15, tokenSpending 2 (+ pure tx helpers)                                                                                                                                                    | `reservations` child table (`$[held]`, `$push`, `$pull`), null-balance compare-and-set; extra concurrency specs                                                                                     | C2    |
| S5 messages              | messages 27, subagentContent 4                                                                                                                                                                               | `content` `json` (`$[part]` read-modify-write, jsonpath `$elemMatch`/`$type`), `__v` compare-and-set, budget aggregations, `CLIENT_MESSAGE_SELECT`, `getMessagesPage`                               | C2    |
| S6a conversations        | conversations 65 (+ `saveConvo`, `bulkSaveConvos`, `deleteConvos`, `searchConversation` composed)                                                                                                            | Reconciliation child table (about 20 `$elemMatch`, `$` updates, `$pull` predicates), the `agentEventActor` subtree with 3 child tables, lane-context join, storage metrics on the child table       | C2    |
| S6b sharing and projects | sharedLinks 19, conversationTags 7, conversationImports 2, chatProjects 9, insights 1                                                                                                                        | `fileSnapshots` child table, legacy `isPublic` through `_extra`, `tags.$` on `T[]`, insights SQL                                                                                                    | C2    |
| S7 files and agents      | files 35, agents 24                                                                                                                                                                                          | `tool_resources` subpath read-modify-write, `edges` GIN, `versions` `json` (key order kept for `isDuplicateVersion`), partial unique files indexes, version-count and management-list SQL           | C2    |
| S8 prompts and skills    | prompts 20, skills 20, skillSync 10, skillLifecycle 32                                                                                                                                                       | `agents.skills` `<@`/`&&`, journal cursors, skip-list child tables, duplicate-name message                                                                                                          | C2    |
| S9 MCP and code          | mcpServers 14, mcpAuthorities 2, mcpAuthorizationFenceRetries 4, codeEnvironments 37, browserSetup 4                                                                                                         | `pendingAgentReferences` child table, browser-setup raw tables with child tables, orphan anti-join, bulk writes, transactions                                                                       | C2    |
| S10a schedules           | schedules 51, scheduleConsents 4                                                                                                                                                                             | `lastRun.mcp` / `scheduleruns.mcp` child tables (`$nor`, `$elemMatch`, `$addToSet`), `mcpConsent` jsonpath, `countedFor` `timestamptz[]`, run-slot partial uniques, erased TTL                      | C2    |
| S10b queued turns        | agentQueuedTurns 25                                                                                                                                                                                          | `files` child table, claims and fences, admission-slot partial uniques, quarantine aggregation                                                                                                      | C2    |
| S11 trigger deliveries   | agentTriggerDeliveries 54                                                                                                                                                                                    | `envelope` hinted paths and expression indexes, `history`/`actorDetachedActionHistory` child tables, the largest compare-and-set surface; `releaseBatchProjections` depends on S5                   | C2    |

Dependencies between S units:

- None at the table level: every table exists after F3, and an adapter may read any table.
- Contract suites seed other stores' data through `seedRaw`.
- S6a composes with S5, S10b and S11 through `composeDataMethods`.

Infrastructure after the matching stores:

- **I2: checkpoint store and saver** (after DEP1, S5, S6a).
  - **Scope:** `checkpointStore.ts` and `checkpointSaver.ts` on `PostgresSaver` (§4); descriptor and deletion-intent tables; the saver's own migrations (`setup()`) run per storage schema.
  - **Verify:** a contract suite from `adapters/mongo/checkpointStore.spec.ts` on both backends; a LangGraph HITL resume spec on PostgreSQL.
- **I3: search index sync and MeiliSearch writer** (after S5, S6a).
  - **Scope:** first a MongoDB refactor PR extracting `search/meiliIndexer.ts` from `models/plugins/mongoMeili.ts` (`mongoMeili.spec.ts` unchanged). Then the PostgreSQL write hooks, `SearchIndexSync` (`getSyncProgress`, `syncIndex`, `cleanupExcluded`, `resetSyncFlags`) on the flag columns, hydration by user and `messageId`, and the title search.
  - **Verify:** the sync contract suite on both backends with a fake MeiliSearch client; `api/db/indexSync.js` against PostgreSQL in a new spec.
- **B1: startup checks and completeness gate.**
  - **Scope:** `createStartupChecks` on PostgreSQL; `getSearchIndexSync`; `registerModels` as a no-op; removing the incomplete-store escape hatch from production paths; a docker-compose profile with `postgres:16`; `.env.example` and deployment docs (PostgreSQL 15 or later, ICU build, migrations on boot or `db:migrate`).
  - **Verify:** `api/server/index.js` boots on PostgreSQL in a smoke spec (login, a conversation, a message, an agent); the `DATA_STORE_METHODS` completeness spec (no stub left).

### Phase 5

- **H1: backend-neutral Jest harness** (new files only, after F3).
  - **Scope:** `jest.postgres.config.*` per package (global setup starts the harness cluster, `DATABASE_BACKEND=postgres`, the list of PostgreSQL-enabled DB suites); `createTestDataStore()` in `@librechat/data-schemas/testing`; `test:postgres` scripts; CI jobs (`postgres:16` for everything, `postgres:15` for the contract and corpus suites, `REQUIRE_POSTGRES_TESTS=true`).
  - **Verify:** the no-DB suites green under `DATABASE_BACKEND=postgres`; all contract, corpus and tenant suites green on PostgreSQL in CI.
- **H2a to H2d: the about 20 curated suites** (test-only PRs, §7), any time after H1. Each suite's PostgreSQL run is enabled when its stores are done.
- **E1: e2e harness on PostgreSQL** (one test-only PR, after C1; its PostgreSQL smoke subset after B1).
- **E2: full e2e mock suite on PostgreSQL** with one and two replicas (after B1). A triage loop: adapter fixes, never spec edits. Exit: green except the documented MongoDB-only specs.
- **X1: MongoDB → PostgreSQL copy tool** (after C1, I1, I2).
  - **Scope:** `config/migrate-mongo-to-postgres.js`, a legacy-style script exempt from the lint rule by name.
  - **Run order:**
    1. run the MongoDB-only legacy scripts still needed (PLAN.md);
    2. stop the app;
    3. migrate PostgreSQL to the descriptor matching the source's LibreChat version (the tool refuses a mismatch);
    4. copy;
    5. verify;
    6. switch `DATABASE_BACKEND`.
  - **Per collection:**
    - stream with the driver;
    - **decompose in raw mode** into parent rows, child rows and `_nulls`, with ObjectId → hex, Date → `timestamptz`, Binary → `bytea`, `Mixed` → tagged JSON;
    - any declared path whose value does not fit its storage (wrong type, non-object or null element in a child array, `$`-keys inside `Mixed`) goes **whole to `_extra`** with a per-path report, and so do undeclared fields (D7);
    - batched `INSERT ... ON CONFLICT (_id) DO NOTHING`, parent and children in one transaction (resumable);
    - **verify** by re-assembling each record and comparing its canonical form (ids as hex, key order ignored, `_extra` merged) with the source document;
    - report U+0000 replacements (D8), Long values over 2^53, and counts.
  - KV collections and GridFS entries go into `key_value_entries`. `_meili*` flags are copied as they are, so the MeiliSearch index stays valid.
  - **Checkpoints (D5)**, per storage descriptor and per `(thread_id, checkpoint_ns)`:
    - read with `MongoDBSaver.list()` (serde-decoded tuples, owner-prefixed ids kept);
    - write oldest first with `PostgresSaver.put(config, checkpoint, metadata, newVersions = the checkpoint's channel_versions)`;
    - then `putWrites(config, pendingWrites per task, taskId)`. No `taskPath`, so the writes sort first by task id, which is the 1.2 contract for rows without a path.
    - Storage descriptors and deletion intents are copied to their tables.
  - **Verify:**
    - a spec seeds a memory MongoDB through the MongoDB stores (including legacy shapes through the raw driver), copies, and compares every store's reads on both backends;
    - for checkpoints, `getTuple`/`list` deep-equal between the two savers, and an interrupted HITL run resumes on PostgreSQL after the copy.

### Order and parallelism

```text
F0 → F1 → F2 → { F3 ∥ R1 ∥ Q1 } → C1 → { C2 ∥ I1 ∥ I4 ∥ S3 }
   → S1 → { S2 ∥ S4 ∥ S5 ∥ S6a ∥ S6b ∥ S7 ∥ S8 ∥ S9 ∥ S10a ∥ S10b ∥ S11 }   (2–3 at a time)
   → { I2 ∥ I3 } → B1 → E2 (loop)
DEP1: any time after F0, before I2 (recommended alongside F1/F2)
K0:   from F1 on, ahead of each S unit
H1:   after F3; H2a–H2d any time after H1 (PostgreSQL runs enabled per suite)
E1:   after C1 (MongoDB half), PostgreSQL smoke after B1
X1:   after C1 + I1 + I2
```

Milestones:

- **B:** every store on PostgreSQL, every contract suite green on both backends (after B1).
- **C:** the full e2e mock suite green on PostgreSQL (after E2).

## 9. Risks

- **R1 Regex dialect.** MongoDB uses PCRE; PostgreSQL uses ARE (`\b` is backspace, no named groups). The translator handles the safe subset and refuses the rest. Case-insensitive matching needs the `und-x-icu` collation (§2.4). Callers mostly pass `escapeRegExp`'d input with `^`. Checkpoint patterns are already in the shared syntax.
- **R2 Concurrency.** The `LIMIT 1 FOR UPDATE` empty-result case. The child-table snapshot rule (§3.5): a single-statement write with an `EXISTS` over a child table would be checked against a stale snapshot. Read-modify-write round trips under contention. The compare-and-set-heavy stores (S10b, S11, S9, S4) get dedicated contention specs.
- **R3 Performance.**
  - Typed columns give real btree indexes. The remaining risks:
    - `json` paths without hints (lax jsonpath, no btree);
    - `EXISTS` over child tables without a child index;
    - wide-row assembly (conversations has 157 columns), handled by projection pushdown and the shape guard;
    - read-modify-write for `json` subpath updates (message `content` settles).
  - `EXPLAIN` specs on the main reads guard regressions. Child indexes are added from `EXPLAIN` evidence with a generated migration.
- **R4 Effort concentration.** Typed columns make F2, R1, Q1 and C2 bigger than in the JSONB design. Five stores (conversations, trigger deliveries, messages, queued turns, schedules) hold about 220 methods and about 19k lines of MongoDB code. K0 is still the long pole and the main schedule lever.
- **R5 Mongoose fidelity gaps.** Hydrated-document behavior (`.save()` ×8, `populate` ×2, `toObject`/`toJSON` transforms) differs from lean reads; contract cases must cover those methods. Update casting is descriptor-driven, guarded by the generated differential spec.
- **R6 Upstream schema churn.** **Every new field now needs a migration.** The generator writes it, and drift spec 1 fails until it is committed. Hotspots:
  - conversation and preset fields (`schema/defaults.ts`);
  - role permission types (flattened booleans);
  - message subagent fields;
  - trigger-delivery and queued-turn state.

  Removed fields move to `_extra`; type changes may need hand-written migrations. (Churn could not be measured here: the clone is shallow.)

- **R7 Observable differences between backends** (accepted and documented):
  - ids read back as strings;
  - top-level key order is schema order (MongoDB keeps write order for fields added later by `$set`), while `json` contents keep exact order;
  - `StoreIds.isValid` accepts only 24 hex characters (MongoDB's `ObjectId.isValid` also accepts 12-byte buffers; with the installed driver it no longer accepts 12-character strings);
  - TTL lag (same order as MongoDB's);
  - `principalId` no longer tells an ObjectId from its hex string;
  - U+0000 handling per D8;
  - `$`-prefixed keys inside `Mixed` are refused;
  - unknown filter paths are refused instead of stripped (R9).
- **R8 Worktree resources.** Each worktree needs its own install and build. Jest stays serialized: the parallelism is in writing code, not in testing.
- **R9 Fields written or queried but not declared.**
  - Verified: every model is strict and `strictQuery` is `true`, so no method persists an undeclared path through mongoose.
  - The raw-driver writes to mongoose collections are:
    - `role.ts` (`$unset` of legacy `SHARED_GLOBAL`);
    - `share.ts` `clearLegacySharedLinkVisibility` (`$unset isPublic`);
    - `mongoMeili` flag updates (paths declared through the plugin, forced into the DDL);
    - `auditLog` `deleteMany`;
    - `prompt` `dropIndex` (MongoDB-only maintenance).
  - Raw collections get declared schemas.
  - Filters on undeclared paths are silently stripped by mongoose (match-all) but refused here. A contract case failing on PostgreSQL with `StoreQueryError` reveals a latent MongoDB bug, to be fixed in a MongoDB PR.
- **R10 `Mixed` queried by path.**
  - The cases: `envelope` (8 paths, 54 sites), `tool_resources.<r>.file_ids`, `edges.from`/`.to`, `mcpConsent.consents`, message `content`/`attachments` (`$elemMatch`, `$[part]`, `$type`), `avatar.filepath`, `sourceMetadata.*`.
  - Correctness comes from lax jsonpath (corpus A). Speed comes from hints, which are sound through their `CHECK`s; a write violating a hint fails loudly rather than being silently missed by queries.
  - A new upstream query into a `Mixed` path is correct without a hint but slow; the `EXPLAIN` specs catch the hot ones.
- **R11 `json` versus `jsonb`.** `json` keeps key order (needed by `isDuplicateVersion`), but every query cast `col::jsonb` fails on a value containing `\u0000`, hence D8. Hand-written SQL must not return `jsonb`-rewritten `Mixed` values to callers.
- **R12 Identifiers.** The 63-byte limit and the `__` separator are handled by the generator with hashed names and collision checks. A rename upstream produces a remove plus an add, so the generator flags it for review.

## 10. Decisions

Taken: D1 typed columns; D2 mongoose without a connection for document construction (kept, §1.9); D3 baseline plus about 20 route suites; D4 MeiliSearch; D5 checkpoints migrated, checkpoint-postgres ^1.1.3 after DEP1; D6 PostgreSQL 15 minimum (nothing in this design needs 16; CI runs the PostgreSQL suites on 15 and 16, e2e and docs on 16) and migrations on boot by default.

Also taken (answered after the first draft):

- **D7 Legacy and off-schema values: keep them in `_extra` (recommended) or drop them in the copy tool.**
  - With `_extra` (one `jsonb` column per table, `NULL` on all new rows), the copy is lossless and reads keep returning old fields, as MongoDB lean reads do. Removed-upstream fields keep their data, and values that cannot be cast survive with a report.
  - Dropping is simpler: no merge step on reads, and no `_extra` handling in the e2e facade and contract `seedRaw`. But legacy data is lost at the switch, and the two legacy cleanups (`isPublic`, `SHARED_GLOBAL`) become no-ops.
- **D8 U+0000 in strings.** PostgreSQL `text` cannot store it, and `json` → `jsonb` casts fail on it (which would break every query touching such a row).
  - Recommended: replace it with U+FFFD on write everywhere (text columns and inside `json`), count replacements in a metric, and have the copy tool report affected documents.
  - Alternatives: refuse such writes with `StoreQueryError` (MongoDB accepts them, and LLM output occasionally contains NUL), or a reversible escape (affects regex and equality semantics).
  - The NUL-joined keys found in `packages/api` (`subagentThreads.ts`, `admin/secrets.ts`, `admin/config.ts`, `agents/run.ts`) look like in-memory map keys. The S units confirm none reaches a column.
