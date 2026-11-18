# Running LibreChat on PostgreSQL

LibreChat stores its data in MongoDB by default. It can store all of it in PostgreSQL instead:
set `DATABASE_BACKEND=postgres`. The whole database moves at once; there is no per-feature
choice. MeiliSearch, Redis and the RAG API are configured as before.

## Requirements

- **PostgreSQL 15 or later.** The server refuses older versions at startup.
- **ICU support** in the server build: the `und-x-icu` collation must exist. The official
  `postgres` images and the usual distribution packages have it. Check with
  `SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu';`.
- `standard_conforming_strings = on` (the default).
- No extensions. The database user needs to create tables, indexes and schemas in its database.

## Settings

| Variable                   | Default  | Meaning                                                                                                                                      |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_BACKEND`         | `mongo`  | `postgres` selects PostgreSQL. Any value other than `mongo` or `postgres` stops the server.                                                  |
| `POSTGRES_URI`             | (none)   | Required with `postgres`, e.g. `postgresql://librechat:secret@db:5432/LibreChat`.                                                            |
| `POSTGRES_SCHEMA`          | `public` | The schema of every table (a lowercase identifier).                                                                                          |
| `POSTGRES_POOL_MAX`        | `10`     | Connections in the pool, per server process.                                                                                                 |
| `POSTGRES_AUTO_MIGRATE`    | `true`   | Apply pending schema migrations when the server starts. With `false`, the server refuses to start on a database whose migrations are behind. |
| `POSTGRES_TTL_INTERVAL_MS` | `60000`  | How often expired rows (sessions, tokens, temporary records) are removed.                                                                    |

`MONGO_URI` and the other `MONGO_*` variables are ignored with `DATABASE_BACKEND=postgres`.
`POSTGRES_UPDATE_SHADOW_CHECK` is a diagnostic for the test suites; leave it unset.

## Migrations

By default the server migrates the database when it starts. Replicas starting together are
serialized by a lock, so only one applies the migrations.

To migrate before rolling out instead, set `POSTGRES_AUTO_MIGRATE=false` on the servers and run,
with the same `POSTGRES_URI` and `POSTGRES_SCHEMA`:

```sh
npm run db:migrate
```

It applies the pending migrations, then builds any missing indexes on the large tables
`CONCURRENTLY`, so writes are not blocked while they build.

## Docker Compose

`docker-compose.yml` has a `postgres` service (`postgres:16`) in the `postgres` profile. Add to
`.env`:

```sh
DATABASE_BACKEND=postgres
POSTGRES_PASSWORD=change-me
POSTGRES_URI=postgresql://librechat:change-me@postgres:5432/LibreChat
```

Then start it with the profile:

```sh
docker compose --profile postgres up -d
```

The `mongodb` service still starts, because `api` depends on it, but nothing connects to it. A
`docker-compose.override.yml` can remove it.

## Coming from MongoDB

A new PostgreSQL database starts empty. A tool to copy an existing MongoDB database is planned;
until it exists, switching `DATABASE_BACKEND` does not bring the MongoDB data along.

The legacy MongoDB migration scripts (`npm run migrate:agent-permissions`,
`migrate:prompt-permissions`, `migrate:search-tokens` and the other `config/migrate-*` scripts)
run on MongoDB only. Run the ones your deployment still needs on MongoDB before copying it. On
PostgreSQL the startup checks still warn about records that one of them would have changed (agents
or prompt groups without an owner permission entry, users or groups without search tokens), and
say where to run it.
