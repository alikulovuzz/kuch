# Running Kuch on PostgreSQL

> **Stub.** This page will hold the step-by-step cutover from the JSON files to PostgreSQL
> (stop the API, back up `data/`, dry-run, migrate, verify, switch, smoke test, roll back). The
> migration script and the cutover steps are still being written. Until then, this page explains
> how the Postgres backend stores data and what it assumes.

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
