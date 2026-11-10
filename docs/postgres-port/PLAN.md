# PostgreSQL port: plan and status

Living document for the `feature/postgres` branch of `the-guish/LibreChat`. Update it in the PR that changes the status of a phase.

## Goal

Make LibreChat able to run on PostgreSQL instead of MongoDB, switching the whole database at once, without changing caller behavior. Every database access goes through database-neutral ports; MongoDB and PostgreSQL are two adapters behind them.

## Decisions

| Decision | Choice |
|---|---|
| Scope | The whole data layer behind ports (not only conversations). |
| Switch | All or nothing: the backend is chosen once for the whole database, never per module. An adapter may therefore read any table or collection it needs; callers and database-neutral code only see ports. |
| Branching | One branch per unit from `feature/postgres`, one PR per unit into `feature/postgres`, squash-merged. Always in the fork `the-guish/LibreChat`. |
| Callers | Public method signatures and call sites stay unchanged wherever possible. |
| Tests | Do not edit existing tests. When an edit is unavoidable, it goes in its own small test-only PR, never mixed with large code changes. The only standing exception is the port conformance specs this refactor creates (`packages/data-schemas/src/ports/*.spec.ts`): their `EXCLUDED` lists and conformance assertion may change together with the port. |
| Raw MongoDB filters in signatures | Expressed with a portable store query language (`ports/query.ts`), a typed subset of MongoDB query syntax that callers already use, rather than rewriting ~300 call sites into named methods. Hot paths can later be replaced by named methods incrementally. |

## Architecture

```text
packages/data-schemas/src/
├── ports/
│   ├── <module>.ts          # one port per module (XStore), no mongoose imports
│   ├── <module>.spec.ts     # conformance: MongoDB methods satisfy the port; every method placed or excluded
│   ├── common.ts            # IdLike, WithIdLike, DeleteCount, listPortMethods
│   ├── conformance.ts       # SameSignatures, Satisfies, EveryMethodPlaced, ExclusionsHold (types only)
│   ├── query.ts             # StoreFilter/Projection/Sort/QueryOptions/Update + validator + reference evaluator
│   ├── query.corpus.ts      # database-agnostic differential corpus (302 cases)
│   └── index.ts             # DataStore (one store per module) + DATA_STORE_METHODS
├── adapters/mongo/
│   ├── pickStore.ts         # a store = the existing methods instance's own functions
│   └── dataStore.ts         # createMongoDataStore(instances)
└── methods/
    ├── index.ts             # createMethods(...) builds each instance once, returns `stores: DataStore`
    ├── saveConvo.ts         # database-neutral domain functions built on port steps,
    ├── deleteConvos.ts      #   keeping the public signature (pattern for methods whose
    ├── bulkSaveConvos.ts    #   bodies are mostly rules rather than storage)
    └── searchConversation.ts
api/models/index.js          # spreads every store over the flat `~/models` export (backend chosen here)
```

- **Port**: the module's operations with neutral types: plain values, `IdLike` for ids, `Store*` query types for filters/projections/sorts/updates, neutral result shapes (`DeleteCount`, …).
- **MongoDB adapter**: today's methods, unchanged, picked from the same instance (instances hold state).
- **Domain functions**: logic that must be identical on every backend (`saveConvo`, `deleteConvos`, …) is written once without mongoose and built on port steps plus injected dependencies.
- **Query language** (`ports/query.ts`): filters (equality, dotted paths, array-contains, `$in`, `$nin`, `$ne`, `$exists`, `$gt`/`$gte`/`$lt`/`$lte`, `$regex` with optional `i`, `$or`, `$and`), projections (`'a b'`, `'-a'`, `'+hidden'`, `{a: 0|1}`), sorts (`{a: 1|-1}`), `limit`/`offset`, updates (plain fields, `$set`, `$unset`, `$inc`, `$max`, `$min`, `$push`, `$pull`, `$pullAll`, `$addToSet`, `$setOnInsert`). Excluded on purpose: aggregation pipelines, `$elemMatch`, `$where`/`$expr`, `$text`, positional paths, sessions. The reference evaluator defines the semantics (including MongoDB corner cases such as `null` matching a missing field) and agrees with MongoDB on all 302 corpus cases; the PostgreSQL translator will be tested against the same corpus.

## Status

| Phase | Content | PRs | State |
|---|---|---|---|
| 0–1 | Conversation port; `saveConvo`, `deleteConvos`, `bulkSaveConvos`, `searchConversation` as database-neutral functions on port steps | #1–#4 | done |
| 2 | A port + MongoDB adapter for every methods factory (56 stores in `DataStore`; `tx` is pure helpers); session-only methods brought in without the session | #5–#16 | done |
| N0 | Portable store query language with validator, evaluator and differential tests | #17 | done |
| Neutralization | Previously excluded methods moved into their ports with the query language: user/role/mcpServer (#18), message/file (#19), agent (#20); smaller modules (token, preset, assistant, transaction, prompt, conversationTag, schedule, userGroup) | #18–#20, NU4 | in progress |
| NU5 | ACL: `deleteAclEntries`, `replaceRoleBits`, `bulkWriteAclEntries`, `aggregateAclEntries` (dedicated operations); `findEntriesByPrincipalsAndResource`/`grantPermission` (real sessions from `acl/accessControlService.ts`, `PermissionService.js`) via a database-neutral `DataStore.transaction()`; `modifyPermissionBits` | | todo |
| Search | Database-neutral message/conversation search port replacing MeiliSearch parameters (`searchMessages`, conversation title search); `getMessagesByCursor` as `getMessagesPage` with an opaque cursor | | todo |
| Factories outside `createMethods` | `browserSetup`, `mcpAuthorizationFenceRetry`, `skillDeletionAdapter` (built by callers) | | todo |
| 3 | Direct mongoose use outside the data layer (~75 files in `api/` and `packages/api`: connection in `api/db`, `indexSync`, models used directly in controllers/services, agent checkpoint deletion/pruning); `DataStore` lifecycle (`connect`/`close`/`health`) and `transaction()`; lint rule confining mongoose to `adapters/mongo`, `models`, `schema` | | todo |
| Milestone A | All Jest suites + full e2e mock suite green on MongoDB (known environment failures only) | | todo |
| 4 | PostgreSQL adapter: `pg` + Kysely, migrations, `DATABASE_BACKEND=mongo\|postgres` switch (default `mongo`), 24-hex id generation, schema per module (columns for queried fields, `jsonb` for free-form ones), query-language → SQL translator, per-module adapters (parallel units), tenant scoping, transactions, search sync, TTL cleanup, MongoDB → PostgreSQL data copy tool | | todo |
| 5 | Contract suites per port run against both adapters (test-only PRs); e2e harness made backend-neutral (test-only PR); full e2e mock suite on PostgreSQL | | todo |

## Process per unit

See [UNIT_BRIEF.md](UNIT_BRIEF.md): the rules every unit follows (port conventions, sessions rule, neutralization rules, test policy, checks and their baselines, git rules, report format).

Baseline in this environment: `packages/data-schemas` all suites green; `packages/api` exactly 5 environment-related failing suites (`endpoints/openai/config.spec.ts`, `config.anthropic.spec.ts`, `config.backward-compat.spec.ts`, `files/mistral/crud.spec.ts`, `files/documents/libreoffice.spec.ts`), plus `agents/__tests__/run-summarization.test.ts`, which is order-dependent (may fail in the full run, passes alone); `api` all suites green (2 skipped).

## Open items and known leaks

Contracts a PostgreSQL adapter must honor, or caller changes still needed:

- `CLIENT_MESSAGE_SELECT` (in `ports/message.ts`) excludes nested paths, outside the query language; a non-MongoDB store must recognize it by value.
- Creating a skill with a duplicate name throws with MongoDB's duplicate-key code `11000`, which `packages/api/src/skills/handlers.ts` and `skills/import.ts` check: keep that contract or move callers to a database-neutral error.
- Some reads match ids inside aggregations without casting (`getAgentWithVersionCount`, `getListAgentsByAccess` in the author sort, `getAgentManagementListByAccess`); ACL `principalId` is stored untyped and matched exactly as given. Callers must pass ids as the store returned them.
- A string queued-turn `user` must be lowercase hex (the lane key hashes `user.toString()`); a code environment's `createdBy` must be an ObjectId (an owner-slot id is derived from it).
- Ids compare as their lowercase hex string; strings compare by code point (a PostgreSQL translator needs "C" collation).
- Record types still extending mongoose's `Document` or carrying `ObjectId` fields (`IUser`, `IConversation`, `IMessage`, `IAgent`, `IMongoFile`, …): compile-time leaks only, documented in each port header.
- Some `getMessages` calls filter without `user` (`api/server/middleware/error.js`, `api/server/controllers/agents/resume.js` ×2): allowed, but relevant for future user/tenant scoping.
- Optional test-only change: a narrowing cast in `packages/api/src/images/authorization.spec.ts` would let `images/authorization.ts` be typed against `AgentStore`.
