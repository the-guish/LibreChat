# Moving an existing deployment from MongoDB to PostgreSQL

`npm run migrate:mongo-to-postgres` copies a MongoDB deployment's data into PostgreSQL, so that
the deployment can switch to `DATABASE_BACKEND=postgres` with its users, conversations, files,
agents and everything else. It copies every collection of LibreChat's data model, the key-value
entries (the Keyv collections and their GridFS buckets) and the agent checkpoints, and checks
every record after writing it.

## Steps

1. **Run the MongoDB migrations your deployment still needs**, on MongoDB, with this LibreChat
   version (`npm run migrate:agent-permissions`, `migrate:prompt-permissions`,
   `migrate:search-tokens`, `migrate:tenant-indexes` and the other `config/migrate-*` scripts
   your upgrade notes ask for). The copy takes the data as it is.
2. **Stop LibreChat** (every replica), so nothing writes to MongoDB during the copy.
3. **Copy**, with the same LibreChat version, built (`npm run build:data-schemas`):

   ```bash
   MONGO_URI=mongodb://mongo:27017/LibreChat \
   POSTGRES_URI=postgresql://librechat:secret@db:5432/LibreChat \
   npm run migrate:mongo-to-postgres
   ```

   `POSTGRES_SCHEMA` is read as the server reads it. The tool migrates the PostgreSQL schema
   first, so the database may be empty.

4. **Read the summary.** The command exits with 1 if a record could not be copied or reads back
   different from MongoDB; fix the cause and run it again.
5. **Switch**: set `DATABASE_BACKEND=postgres` (and `POSTGRES_URI`) and start LibreChat. Keep the
   MongoDB database until you are satisfied.

## Options

| Option                                                       | Meaning                                                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--dry-run` (or `npm run migrate:mongo-to-postgres:dry-run`) | Reads and checks everything, reports what it found, and writes nothing (no migration either).                   |
| `--collections=users,messages`                               | Copies only these MongoDB collections (a GridFS bucket by `<name>.files`, a checkpoint storage by either name). |
| `--batch-size=500`                                           | Documents per batch; each batch is one transaction.                                                             |
| `--checkpoint-storage=<checkpoints>:<writes>`                | A checkpoint storage to copy besides the default one and those LibreChat recorded (repeatable).                 |
| `--allow-source-index-mismatch`                              | Copy although MongoDB lacks indexes of this version (deployments that manage indexes by hand).                  |
| `--json`                                                     | Also prints the whole report as JSON.                                                                           |

## What the tool checks

- **Versions.** The copy is refused, before anything is written, when MongoDB lacks indexes this
  LibreChat version builds at startup (the source has not run this version, or a migration of
  step 1 is missing), when the PostgreSQL schema holds migrations this version does not know (it
  belongs to a newer version), or when the PostgreSQL tables do not match this version's schema.
- **Every record.** Each record is read back from PostgreSQL and compared with its MongoDB
  document (ids as hex, key order ignored). Each checkpoint is read back through the PostgreSQL
  checkpointer and compared with what the MongoDB checkpointer reads.

## Resuming

Run the same command again. Rows already in PostgreSQL are kept as they are (and checked
again), so an interrupted copy picks up where it stopped, and a repeated copy changes nothing.
Copy into a fresh database or one an earlier run of the tool filled, not into a database
LibreChat has already written to.

## What the summary reports

- **Values kept aside (`_extra`).** Fields the schema does not declare (left by older versions)
  and values that do not fit their declared type (a number where a string belongs, a `null` in a
  list of objects, keys starting with `$` inside free-form data) are copied whole into the
  record's `_extra` column, per table and path. LibreChat reads them back as MongoDB returned
  them.
- **U+0000.** PostgreSQL text cannot hold the NUL character; it is replaced with U+FFFD, and the
  records affected are listed.
- **Large integers.** A 64-bit integer beyond 2^53 is stored as the nearest number and reported.
  Other BSON types LibreChat never writes (`Decimal128`, `Timestamp`, ...) are converted and
  reported.
- **Key-value entries.** MongoDB allows several entries with the same key; the one MongoDB
  reads is kept, and the others are counted. For GridFS, the newest revision of each file is
  kept.
- **Collections left out.** Collections that are not part of LibreChat's data model are listed
  with their document counts and not copied.
- **Checkpoints.** Checkpoint writes whose checkpoint no longer exists are counted and left out.
  Copied checkpoints restart their expiry window (the approval window) at the time of the copy.
  The search index flags are copied as they are, so the MeiliSearch index stays valid.
