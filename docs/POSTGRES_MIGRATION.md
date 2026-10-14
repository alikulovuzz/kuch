# Running Kuch on PostgreSQL

> **Stub.** This page will hold the step-by-step cutover from the JSON files to PostgreSQL
> (stop the API, back up `data/`, dry-run, migrate, verify, switch, smoke test, roll back). The
> cutover steps are still being written. Until then, this page explains the migration script, how
> the Postgres backend stores data, and what it assumes.

## Migrating the JSON files

`api/scripts/migrate-json-to-pg.mjs` copies `db.json` and every `state-<uid>.json` under
`DATA_DIR` into the database `DATABASE_URL` names. Stop the API first. The script refuses to run
while an API is using the database.

```bash
docker compose run --rm api node scripts/migrate-json-to-pg.mjs --dry-run
docker compose run --rm api node scripts/migrate-json-to-pg.mjs
```

- It writes everything in **one transaction** and verifies it before committing. Every table's row
  count must match the files, the accounts must read back equal to `db.json`, and every stored
  document must equal its file, with `rev` and `wid` matching its `_rev` and `_wid`. Anything else
  rolls back, prints what differs and exits 1.
- `--dry-run` does the same, prints the counts and the verdict, and rolls back.
- Running it again writes nothing and verifies again.
- It never changes or deletes a JSON file. A state file it cannot read, that has no profile in
  `db.json`, or that holds text Postgres cannot store (U+0000, a lone surrogate) is reported and
  skipped. A `db.json` the tables cannot hold as it is (a passkey of a profile that does not
  exist, say) is refused whole, with the reasons.
- `--from-bak` migrates `db.json.bak` when `db.json` cannot be read. Without the flag, the script
  stops instead.
- A database that already holds other data than the files (for example, after going back to the
  files for a while) is only overwritten with `--replace`, which also deletes the rows the files no
  longer have.
- After a committed run it writes `DATA_DIR/MIGRATED-TO-POSTGRES`, which says when the migration
  ran and what it copied. The MCP server in file mode refuses to answer while that file exists.
  While it exists the script never overwrites a database that differs from the files, `--replace`
  or not: the API may have been running on Postgres since.

**Rolling back** is `STORAGE_BACKEND=file` and a restart: the JSON files are as the migration left
them. Delete `MIGRATED-TO-POSTGRES` at the same time. Anything written while the API ran on
Postgres stays only in the database.

## Switching it on

| Variable | Meaning |
|---|---|
| `STORAGE_BACKEND` | `file` (the default: `db.json` and `state-<uid>.json` under `DATA_DIR`) or `postgres` |
| `DATABASE_URL` | The database, e.g. `postgres://kuch:PASSWORD@postgres:5432/kuch`. Keep it out of git. |
| `DB_WAIT_MS` | How long startup waits for the database to answer, in milliseconds (default `60000`) |

Some data stays in files under `DATA_DIR` on either backend: `secret`, `vapid.json`, `coach.json`
and `coach/`, `audit.log` and `uploads/`. Back them up as before.

At startup the API waits for the database, retrying with backoff for up to `DB_WAIT_MS`. A wrong
password or a database that does not exist fails at once. The API then applies the migrations in
`api/migrations/` that are not yet recorded in `schema_migrations`, each in its own transaction.
Any failure stops the process with the reason on one line before it listens. `GET /api/health`
then also reports `"database": "ok"`, and answers 503 with `"database": "down"` when the database
stops answering.

## How `saveDb` works: a write-through copy

The decision and the alternatives are in
[ADR 0001](adr/0001-postgres-write-through-db.md). In short:

- **Accounts stay in memory.** Every account, passkey, invite, push subscription and device link
  is loaded into one in-memory object at startup, as with `db.json`. Every lookup is answered from
  memory, and every change is made there first.
- **`saveDb()` writes only what changed.** The store keeps a snapshot of what the last commit left
  in the tables. A save compares memory with it and, in **one transaction**, deletes the rows that
  are gone and upserts the rows whose content changed. A route answers only after that commit.
- **Saves run one at a time**, in the order they were asked for. Each compares memory when its
  turn comes, so the save a route waits for always includes that route's change.
- **A failed save changes nothing**, and the next save retries the same rows. If Postgres refuses
  a row (a duplicate e-mail address, say), the log names the table and the key, and every later
  save fails on that row until it is fixed. Memory runs ahead of the database meanwhile, as it
  runs ahead of `db.json` after a failed write today.

Why not one SQL statement per operation: the sign-up and sign-in rules (first user becomes admin,
unique e-mail addresses and passkeys, single-use invites and reset codes, the profile-name rule)
hold because nothing runs between a check and the change it guards. Rebuilding each one as a
constraint or a serializable transaction is a rewrite of the auth routes. The profile-name rule
cannot be a constraint at all.

## Training documents and the compare-and-swap

Each profile's training document stays one JSON document, in `user_state.doc`. Beside it are its
`rev`, `wid` and `wids`, written in the same statement, so they always mirror the document's
`_rev`, `_wid` and `_wids`. `PUT /api/data` stores a document with one conditional statement that
lands only if the stored revision and write id are still the ones the request was checked
against. Otherwise it answers 409 with the current document, exactly as the file backend does.
`GET /api/data/rev` reads only those two columns.

A document containing the NUL character (U+0000) cannot be stored in Postgres, and `PUT /api/data`
answers 400. No shipped client produces one.

## One API process per database

The API holds a Postgres advisory lock for as long as it runs. A second API process on the same
database (more precisely, the same schema) refuses to start with
`another kuch-api owns this database`. If the connection holding the lock drops, the API exits
and its restart policy brings it back. Run exactly one replica (`replicas: 1`,
`strategy: Recreate` on Kubernetes). Other in-process state (WebAuthn challenges, device pairings,
rate limits, rest timers, the state cache) assumed one process already.

## Tables

`api/migrations/001_init.sql` is the schema. The tables are `users`, `credentials`, `invites`,
`push_subscriptions` and `device_links`, one per `db.json` collection, plus `db_extra` and
`user_state`. Columns keep the JavaScript types (ISO dates as text, epoch milliseconds as
`bigint`). Any field without a column, or whose value does not fit its column, is kept in that
row's `extra` JSONB, and unknown top-level `db.json` keys go to `db_extra`. `pos` keeps each
record's place in its array. So the tables hold exactly what `db.json` held, and the migration can
be checked by comparing the two.
