# Unit brief: shared rules for every PostgreSQL-port unit

Rules every unit of the PostgreSQL port follows (see [PLAN.md](PLAN.md)). Repository: fork `the-guish/LibreChat`; run commands from the repository root unless noted, with dependencies installed and packages built.

## Background
LibreChat's whole data layer is being moved behind database-neutral ports so that a PostgreSQL implementation can later replace MongoDB all at once (the whole database is switched at once, never per module; an adapter may read any collection it needs, while callers and database-neutral code only see ports). Infrastructure on `feature/postgres` — study it and follow it exactly:
- `packages/data-schemas/src/ports/common.ts` (`IdLike`, `WithIdLike`, `DeleteCount`, `PortMethodSet`/`listPortMethods`), `ports/conformance.ts` (`SameSignatures`, `Satisfies`, `EveryMethodPlaced`, `ExclusionsHold`), `ports/index.ts` (`DataStore`, `DATA_STORE_METHODS`).
- Template port + spec: `ports/key.ts` + `ports/key.spec.ts`, `ports/memory.ts` + spec, `ports/token.ts` + spec (Satisfies + IdLike + exclusions).
- `adapters/mongo/pickStore.ts`, `adapters/mongo/dataStore.ts` (+ `dataStore.spec.ts`), `methods/index.ts` (`createMethods` builds each instance once and returns `stores: DataStore`), `api/models/index.js` (spreads every store over the flat `~/models` export).
- Database-neutral domain functions built on port steps (for methods whose bodies are mostly rules): `methods/saveConvo.ts`, `methods/deleteConvos.ts` (pattern: no mongoose import, own store/deps types proven equal to the port in the spec, built per instance in the module's factory, public signature unchanged).

## Per module
- Verify it is a `create*Methods`-style factory wired into `createMethods`. If it is only pure helpers, or is constructed outside `createMethods` by its callers, skip it and say why (do not change call sites).
- Port interface in `ports/<module>.ts` (no mongoose imports, neither runtime nor type), method list via `listPortMethods`, store built with `pickStore` from the existing instance (never a second instance), added to `DataStore`/`DATA_STORE_METHODS`/`createMongoDataStore`/`createMethods`, conformance spec `ports/<module>.spec.ts` with an `EXCLUDED` list and reasons.
- Signatures copied exactly where already neutral (`SameSignatures`). `Types.ObjectId` parameters → `IdLike`/`WithIdLike`; driver result types (`DeleteResult`, `UpdateResult`, `BulkWriteResult`, …) → a neutral shape in `ports/common.ts` that the driver result satisfies and that covers every field any caller reads (check callers); use `Satisfies` there.
- Sessions: if a method's only Mongo-specific part is an optional trailing `ClientSession` parameter (or a `session` key in an optional options object) and no non-test caller passes a session, put the method in the port WITHOUT that parameter/key (the MongoDB method still satisfies it; use `Satisfies`) and note it in the port header. If some non-test caller does pass a real session, exclude the method and report the caller (a later unit adds a database-neutral `DataStore.transaction()`).
- A method whose signature takes a raw Mongo filter, update, projection, sort, `QueryOptions`, session (passed by a caller) or pipeline (`FilterQuery`, `UpdateQuery`, `ClientSession`, `PipelineStage`, projection strings/objects, sort records, …) does not go in the port: list it in `EXCLUDED` with the reason, and in the report give its non-test call sites and the argument shapes they pass.
- Record types declared in a methods file and needed by a port: move to `~/types` and re-export from the old location (rename if `~/schema` already exports the name; keep the old name exported).
- Retype TypeScript consumers in `packages/api` (and elsewhere) from the `*Methods` types to the ports, type-only, where every picked method is in the port.
- No runtime behavior change, no public method signature change, no call-site change. No two stores may share a method name (the dataStore spec checks it); report collisions.

## Test policy (strict)
Do NOT edit any existing test file (`*.spec.*`, `*.test.*`, `__tests__`, `__mocks__`, `__test-utils__`, e2e, `misc/`). If one fails because of the unit, stop, leave it failing and report which, why, and the minimal edit it would need. New tests only in new files.
Single exception: the port conformance specs this refactor created (`packages/data-schemas/src/ports/*.spec.ts`) may have their `EXCLUDED` list (and its reason comments) updated when the unit moves a method into or out of that port, and may switch their conformance assertion from `SameSignatures` to `Satisfies` when the port now states a method with `Store*`/`IdLike` types — nothing else in them. List every such edit in the report.

## Checks (all must pass or match baseline)
From the repository root unless noted:
1. `cd packages/data-schemas && npm run typecheck && npm run build`; then `npm run build:api` from the root.
2. `cd packages/api && npm run typecheck`.
3. `npx eslint <changed files>` and `npx prettier --check <changed files>` from the root.
4. `node config/circular-deps.mjs` (counts type-only imports).
5. Jest, sequentially (never two at once; 4 cores). Run long commands in the background and wait; don't poll with sleep. Output dir given in the unit prompt.
   - `cd packages/data-schemas && npx jest --ci --silent --json --outputFile=<dir>/ds.json` — baseline given in the unit prompt.
   - `cd packages/api && npx jest --ci --silent --json --outputFile=<dir>/pkgapi.json --testPathIgnorePatterns='\.*integration\.|\.*helper\.|__tests__/helpers/|\.*manual\.spec\.'` — baseline: exactly 5 failing suites, environment-related: `src/endpoints/openai/config.spec.ts`, `src/endpoints/openai/config.anthropic.spec.ts`, `src/endpoints/openai/config.backward-compat.spec.ts`, `src/files/mistral/crud.spec.ts`, `src/files/documents/libreoffice.spec.ts`. A one-off load timeout in a suite that passes when rerun alone is acceptable — rerun it alone and report it.
   - `cd api && npx jest --ci --silent --json --outputFile=<dir>/api.json` — baseline: 289/291 suites (2 skipped), 0 failed.
   - Known order-dependent `packages/api` suite: `src/agents/__tests__/run-summarization.test.ts` may fail in the full run and pass alone; rerun it alone and report it.

## Git
- Work on the branch named in the unit prompt, created from up-to-date `feature/postgres`.
- Commit in the repo's style (emoji + conventional prefix, e.g. `🔌 refactor: Add Ports for …`) with an explanatory body, ending with
  any attribution trailers your tooling requires. Let the pre-commit hook run.
- `git push -u origin <branch>` (retry with backoff only on network errors). Never force-push, never push another branch, do not open or merge a PR.

## Report back (concise)
- Per module: store key, port name, method count, exact vs `Satisfies`, excluded methods with reasons and (for filter-taking ones) call sites + argument shapes; skipped modules and why; kept leaks.
- Shared types added, types moved to `~/types`, consumers retyped (file count), collisions.
- Diff stat, pushed commit SHA, Jest numbers vs baseline, failing suites, typecheck/lint/circular results, any existing test that failed.

## Neutralization units (moving excluded methods into their ports)
Some units move methods that were excluded from a port (because their signatures take raw MongoDB filters/projections/sorts/updates) into that port. The tool for this is the portable query language in `packages/data-schemas/src/ports/query.ts` (`StoreFilter`, `StoreProjection`, `StoreSort`, `StoreQueryOptions`, `StoreUpdate`, validator, reference evaluator; read its header and `ports/query.spec.ts`, which already has draft ports for several of these methods).
- Restate the method in the port with `Store*` types in place of `FilterQuery`/`UpdateQuery`/projection/sort/options types (and `IdLike` for ids); the MongoDB method must still satisfy it (`Satisfies`). Remove it from the port spec's `EXCLUDED` list (the allowed exception in the test policy).
- Do not change the MongoDB method's signature or behavior unless a real caller's argument is outside the language; prefer leaving the implementation untouched.
- Verify every non-test call site (TypeScript and JavaScript) passes arguments inside the language. For TypeScript callers the typecheck proves it once they are typed against the port; for JavaScript callers check by reading. List any call site outside the language and how you handled it.
- If a method genuinely cannot be expressed in the language (aggregation pipelines, bulk operations, cursors, search-engine parameters, real sessions), keep it excluded and say why; do not widen the language in a neutralization unit without saying so explicitly in the report.
- Retype TypeScript consumers (type-only) that can now be typed fully against the port.
