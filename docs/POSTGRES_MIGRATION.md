# Running Kuch on PostgreSQL

By default the API keeps accounts and training data in JSON files under `./data`. It can keep
them in PostgreSQL instead. This page covers switching a new instance on, moving an existing
instance across (the [cutover](#moving-an-existing-instance-the-cutover)), the same move
[on Kubernetes](#on-kubernetes), going [back](#rollback), and how the Postgres backend stores data.

## Switching it on

| Variable | Meaning |
|---|---|
| `STORAGE_BACKEND` | `file` (the default: `db.json` and `state-<uid>.json` under `DATA_DIR`) or `postgres` |
| `COMPOSE_PROFILES` | `postgres` starts the bundled `postgres` service in `docker-compose.yml` |
| `POSTGRES_PASSWORD` | The bundled database's password, read when it is first created. Letters and digits only, e.g. `openssl rand -hex 24` |
| `POSTGRES_USER`, `POSTGRES_DB` | Its role and database, both `kuch` by default. Set them before the first start, if at all |
| `DATABASE_URL` | Built from the three above for the bundled service. Set it yourself only for a database somewhere else, e.g. `postgres://kuch:PASSWORD@db.example.com:5432/kuch` |
| `DB_WAIT_MS` | How long startup waits for the database to answer, in milliseconds (default `60000`) |

All of them go in `.env`, which is gitignored: never commit a password or a `DATABASE_URL`.
`.env.example` explains each one. A **new** instance needs only this in `.env`, then
`docker compose up -d`:

```bash
COMPOSE_PROFILES=postgres
STORAGE_BACKEND=postgres
POSTGRES_PASSWORD=<openssl rand -hex 24>
```

An instance that **already has data** must not do that: the API would start on an empty database
and the instance would look brand new, with the first profile to register becoming admin where
`FIRST_USER_ADMIN` is on. Migrate first, as below.

Some data stays in files under `DATA_DIR` on either backend: `secret`, `vapid.json`, `coach.json`
and `coach/`, `audit.log` and `uploads/`. Backups therefore have two parts, a `pg_dump` and the
files: [SELF_HOSTING.md §6](SELF_HOSTING.md#on-postgresql).

## Moving an existing instance: the cutover

The migration copies `db.json` and every `state-<uid>.json` into PostgreSQL in one transaction,
then checks the copy: the row counts match the files, and every profile's document is equal to
its file, with the same revision and write id. It never changes or deletes the JSON files, so
until the API has run on PostgreSQL, going back costs nothing.

Before you start:

- Docker Compose **2.20 or newer** (`docker compose version`). The api's optional dependency on the
  `postgres` service needs it.
- This version of Kuch or newer, pulled or checked out, with its `docker-compose.yml`.
- A short maintenance window. The API is down from step 2 to step 7, which takes a few minutes for
  a household instance.
- The commands use the bundled `postgres` service and the default names (`kuch`). Run them in the
  folder with `docker-compose.yml`.

**1. Configure, but do not start.** Add the three lines above to `.env` (`COMPOSE_PROFILES`,
`STORAGE_BACKEND`, `POSTGRES_PASSWORD`). Nothing reads them until the containers are recreated.

**2. Stop the API**, so nothing writes to `./data` from here on. (The script also refuses to run
while an API holds the database.)

```bash
docker compose stop web api
```

**3. Back up `./data`**, and keep a copy off this machine:

```bash
tar czf kuch-backup-pre-postgres-$(date +%F).tar.gz data/
```

**4. Start PostgreSQL on its own**, and wait until `docker compose ps postgres` says `healthy`:

```bash
docker compose up -d postgres
```

**5. Dry run.** It reads everything, writes nothing, and prints what it would copy: profiles,
passkeys, invites, push subscriptions, device links and training documents. A state file it cannot
read, that has no profile in `db.json`, or that holds text PostgreSQL cannot store (U+0000, a lone
surrogate) is reported and skipped, never invented. Look into any it names before going on: its
profile would be on PostgreSQL without its training data. A `db.json` the tables cannot hold as it
is (a passkey of a profile that does not exist, say) is refused whole, with the reasons.

```bash
docker compose run --rm --no-deps api node scripts/migrate-json-to-pg.mjs --dry-run
```

If `db.json` itself cannot be read, the script stops. It reads `db.json.bak`, the copy before the
last save, only when you add `--from-bak`.

**6. Migrate.** The same command without `--dry-run`. It writes in one transaction, verifies, and
says whether the copy verified. It exits with an error if it did not. Then it writes
`data/MIGRATED-TO-POSTGRES` (the time and the counts). While that file exists, the
[MCP server](../mcp/README.md) refuses to read the stale JSON files.

```bash
docker compose run --rm --no-deps api node scripts/migrate-json-to-pg.mjs
```

Run it a second time. A second run finds nothing to change and verifies again. If either run
reports a mismatch, **stop here** and do not start the API: go to [Rollback](#rollback). The API
has not run on PostgreSQL yet, so rolling back loses nothing.

**7. Start everything**, which now runs on PostgreSQL:

```bash
docker compose up -d
docker compose logs api | tail -3      # ends with "kuch-api on :3000 (rpID=…)"
curl -s http://localhost:8080/api/health
```

The health answer has `"database":"ok"`, and its `"users"` is the number of profiles the dry run
counted. Use your `WEB_PORT` if it is not 8080.

**8. Smoke test**, from a device that used the instance before:

- Sign in with an existing passkey (an existing session cookie also keeps working).
- History shows the last workout you logged before step 2.
- Log a set, then open the app on a second device or browser: the change arrives there.
- An admin's dashboard lists every profile.
- A rest timer's push still arrives (`vapid.json` did not change, so subscriptions keep working).

**9. Afterwards.** Back up the new way from tonight on: `pg_dump` plus `./data`
([SELF_HOSTING.md §6](SELF_HOSTING.md#on-postgresql)). The `db.json` and `state-*.json` files stay
in `./data` as they were at step 2, and nothing updates them any more. Keep them, and the step 3
archive, until you are sure you will not roll back.

## Rollback

Going back to the JSON files takes the instance back to where it was at step 2:

```bash
docker compose stop web api
# in .env: STORAGE_BACKEND=file (or delete the line). COMPOSE_PROFILES can stay;
# the postgres service keeps its data and does no harm.
rm data/MIGRATED-TO-POSTGRES          # or file-mode MCP keeps refusing
docker compose up -d
```

**What is lost:** everything written after step 7 (workouts, new profiles and passkeys, settings).
It exists only in PostgreSQL, and nothing copies it back to the files. Roll back early, or not at
all.

**Trying again later:** the database still holds the first attempt, plus whatever was written to
it after step 7. The script refuses a database that differs from the files, unless you add
`--replace`, which also deletes the rows the files no longer have. It never does that while
`MIGRATED-TO-POSTGRES` exists. Starting from an empty database is the plainer way. First take a
`pg_dump` of the old one, in case. Then the following deletes the database for good:

```bash
docker compose rm -sf postgres
docker volume rm kuch_pgdata          # <compose project>_pgdata; see `docker volume ls`
```

Then begin again at step 2.

## On Kubernetes

The same steps, with a temporary pod that mounts the data volume in place of `docker compose run`.
Set up the Secret first, as in
[SELF_HOSTING_KUBERNETES.md](SELF_HOSTING_KUBERNETES.md#postgresql), but leave `kustomization.yaml`
and `deployment.yaml` as they are until the last step.

```bash
kubectl -n fitness apply -f kubernetes/postgres.yaml
kubectl -n fitness rollout status statefulset/kuch-postgres
kubectl -n fitness scale deploy/kuch --replicas=0        # stop the API (and web)
```

Save this as `kuch-migrate.yaml`, with the API image tag from `deployment.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kuch-migrate
  namespace: fitness
spec:
  restartPolicy: Never
  containers:
    - name: api
      image: ghcr.io/alikulovuzz/kuch-api:<the tag in deployment.yaml>
      command: ["sleep", "86400"]
      env:
        - name: DATA_DIR
          value: /data
        - name: STORAGE_BACKEND
          value: postgres
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: kuch-postgres
              key: DATABASE_URL
      volumeMounts:
        - name: kuch-data
          mountPath: /data
  volumes:
    - name: kuch-data
      persistentVolumeClaim:
        claimName: kuch-data
```

```bash
kubectl apply -f kuch-migrate.yaml
kubectl -n fitness wait --for=condition=Ready pod/kuch-migrate
kubectl -n fitness exec kuch-migrate -- tar czf - -C /data . > kuch-backup-pre-postgres-$(date +%F).tar.gz
kubectl -n fitness exec kuch-migrate -- node scripts/migrate-json-to-pg.mjs --dry-run
kubectl -n fitness exec kuch-migrate -- node scripts/migrate-json-to-pg.mjs
kubectl -n fitness exec kuch-migrate -- node scripts/migrate-json-to-pg.mjs     # verifies again
kubectl -n fitness delete pod kuch-migrate
```

Then uncomment `- postgres.yaml` in `kustomization.yaml` and the two env entries in
`deployment.yaml`, and `kubectl apply -k kubernetes/`, which also brings the Deployment back to
one replica. Smoke test as in step 8. To roll back, comment those env entries out again,
`kubectl apply -k kubernetes/`, and remove the marker with
`kubectl -n fitness exec deploy/kuch -c api -- rm /data/MIGRATED-TO-POSTGRES`.

## Startup and health

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
