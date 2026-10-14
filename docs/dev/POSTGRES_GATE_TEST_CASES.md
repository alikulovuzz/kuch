# Phase 2 gate: PostgreSQL test cases

The test cases for the Phase 2 gate (spec §2.8), as run against `i20-gate`: all tests green on
both storage backends, the full manual flow on PostgreSQL through `docker compose`, and a
migration of an app-written `data/` folder that verifies cleanly. Each case gives its
preconditions, steps, expected result, how it was verified, and its status at the checkpoint
below. Run them again, in order, for any later change to the storage layer.

The automated suites carry most of the weight (CAS concurrency, cascade, DB-down, migration
idempotency are unit and integration tests). These cases add what only a real browser, a real
passkey and a real compose stack show.

## Checkpoint: 2026-10-14

| | Cases | Status |
|---|---|---|
| A. Automated suites | TC-01 to TC-04 | **pass** |
| B. Stack on the JSON files | TC-05 to TC-07 | **pass** |
| C. Cutover (runbook steps 2 to 7) | TC-08 to TC-13 | **pass** (TC-08 with a Windows caveat) |
| D. Manual flow on PostgreSQL | TC-14 to TC-22 | **pass**, except **TC-17 (409) pending** |
| E. Optional, not run | TC-23 to TC-25 | not run |

Stack: `i20-gate` at `a9255f80` plus this file, Docker 29.2.0, Compose v5.0.2, `postgres:17`,
Chrome 155 on Windows 11 with Windows Hello passkeys. The stack lives in the worktree
(`./data`, `.env`, both gitignored).

## Setup used by every case

```bash
# from the repo root of the branch under test
cp .env.example .env
# then append:
#   COMPOSE_PROFILES=postgres
#   POSTGRES_PASSWORD=<letters and digits, e.g. openssl rand -hex 16>
#   (STORAGE_BACKEND stays unset until TC-13)
docker compose build
docker compose up -d
```

Database checks (the bundled service publishes no port, so go through the container):

```bash
docker compose exec -T postgres psql -U kuch -d kuch -c "<sql>"
```

Request checks: `docker compose logs web --no-log-prefix` is nginx's access log, one line per
`/api/...` request with its status.

## A. Automated suites

### TC-01: api suite on both backends, Linux CI
- **Pre:** a PR whose diff touches `api/**` (the `Tests` workflow's path filter).
- **Steps:** push; the `api` job runs `npm test` (files) then `npm run test:pg` against its
  `postgres:17` service (`DATABASE_URL_TEST`).
- **Expected:** both passes 0 failures; the pg pass skips only the file-only tests, each with
  its reason.
- **Status:** **pass.** [Run 38529296029](https://github.com/alikulovuzz/kuch/actions/runs/38529296029):
  files 643/643; Postgres 636 pass, 0 fail, 7 skipped.

### TC-02: mcp, frontend, api-image and compose jobs
- **Steps:** same run.
- **Expected:** `mcp` (including `state-pg.test.js` on Postgres), `test` (frontend, locale and
  source-string checks, build), `api-image` (both targets boot) and `compose` (stack up on
  Postgres, `/api/health` through web says `"database":"ok"`) all green.
- **Status:** **pass**, all four.

### TC-03: suites on the Windows dev PC
- **Pre:** `kuch-postgres` on 127.0.0.1:5433, password in `%APPDATA%\postgresql\pgpass.conf`.
- **Steps:** in `api/`, `npm ci --omit=optional && npm test`, then
  `DATABASE_URL_TEST=postgres://kuch@127.0.0.1:5433/kuch_test npm run test:pg`; `npm test` in
  `mcp/` and `frontend/`.
- **Expected:** only the known Windows-only failures (Coach fixture `URL.pathname`, POSIX modes,
  CRLF byte checks, unwritable `./data`, the `media-*` rmdir race, `sh` not on the PowerShell
  PATH). Nothing Postgres-specific.
- **Status:** **pass with the known exceptions.** api files 615 pass / 27 fail / 1 skip; api
  Postgres 612 / 23 / 8; mcp 113/114 (the `chmod` test); frontend 5,051/5,060 (`api-base` needs
  `sh`, plus the baseline `check-mobile-bundle` file).
- **Note:** mcp also logs 7 `EPERM watch` errors on Windows: `mcp/src/state.js`'s `fs.watch` has
  no `error` listener (pre-Phase 2 code, green on Linux).

### TC-04: the images build and the stack starts
- **Steps:** `docker compose build`, `docker compose up -d`, `docker compose ps`.
- **Expected:** `postgres` healthy, `api` and `web` up; `curl -s localhost:8080/api/health`
  gives `{"ok":true,"users":0,"writable":true}` (no `database` field on the files).
- **Status:** **pass**, after one fix: on a Windows checkout that predates `.gitattributes`, the
  `.sh` files stay CRLF and `web` crash-loops with `05-check-base-path.sh: not found` (exit
  127). Re-check them out (`git rm --cached -r . -q && git reset --hard`, or delete the `.sh`
  files and `git checkout` them), then `docker compose up -d --build web`.

## B. Stack on the JSON files (the data the cutover migrates)

### TC-05: register the first profile with a passkey
- **Pre:** TC-04; empty `./data` apart from `secret` and `vapid.json`.
- **Steps:** browser profile 1 at `http://localhost:8080` → **Create new profile** → name →
  **Create passkey** → Windows Hello.
- **Expected:** signed in on Home; `POST /api/register/verify` 200; health `users: 1`;
  `data/db.json` holds the user and one credential.
- **Status:** **pass.** Profile "Azamat" (`e7gNqNqfH2LupCuO`), 08:21:59 UTC.

### TC-06: a routine and a finished workout reach the server
- **Steps:** Plan → create a routine; Start → log sets → **Finish**.
- **Expected:** `PUT /api/data` 200 for each change; `data/state-<uid>.json` appears and its
  `_rev` climbs; the document has `routines` and `workouts` entries.
- **Verify:** `node -e 'const j=require("./data/state-<uid>.json");console.log(j._rev, j.routines.length, j.workouts.length)'`
- **Status:** **pass.** `_rev` 1 to 7; at 7: `routines=1 workouts=1 _wids=6`.
- **Note:** registering alone writes no state file. The first `PUT /api/data` comes with the
  first change.

### TC-07: the files backend has no admin by default
- **Expected:** `FIRST_USER_ADMIN` is off in `.env.example`, so the first profile is *not*
  admin, and Settings shows no Admin dashboard row. An admin comes from `ADMIN_UIDS=<uid>` or
  `FIRST_USER_ADMIN=1` (before the first sign-up).
- **Status:** **pass** (as designed). `users.admin` is empty in both `db.json` and, after the
  migration, the table.

## C. Cutover (docs/POSTGRES_MIGRATION.md steps 2 to 7)

### TC-08: stop the API and back up `./data`
- **Steps:** `docker compose stop web api`; `tar czf kuch-backup-pre-postgres-$(date +%F).tar.gz data/`.
- **Expected:** `tar tzvf` lists `db.json`, `db.json.bak`, every `state-*.json`, `secret`,
  `vapid.json`, `audit.log`.
- **Status:** **pass with a caveat.** Run from Windows PowerShell, `tar.exe` (bsdtar) wrote an
  empty 29-byte archive (`Couldn't visit directory`). Git Bash's GNU tar wrote a correct one
  (all seven files). On Windows, run the runbook's `tar` from Git Bash or WSL, and always
  `tar tzvf` the archive before going on.

### TC-09: dry run
- **Steps:** `docker compose up -d postgres` (wait for healthy);
  `docker compose run --rm --no-deps api node scripts/migrate-json-to-pg.mjs --dry-run`.
- **Expected:** source counts printed, `001_init` applied, "Verified: every row count matches
  the files, every account and document deep-equals its file, rev and wid match.", "Dry run:
  rolled back", exit 0; no marker file.
- **Status:** **pass.** users 1, credentials 1, user_state 1, the rest 0; 3 inserts rolled back.

### TC-10: migrate
- **Steps:** the same command without `--dry-run`.
- **Expected:** writes, verifies, "Committed. Wrote /data/MIGRATED-TO-POSTGRES.", exit 0; the
  JSON files unchanged.
- **Status:** **pass.** 3 inserted, verified, marker written (time and counts).

### TC-11: migrate again (idempotent)
- **Expected:** "Writes: 0 inserted, 0 updated, 0 deleted", verified, exit 0.
- **Status:** **pass.**

### TC-12: a second API cannot share the database
- Covered by the automated `store-pg` / migration tests (advisory lock, "refuses while an API
  holds the database"). Not repeated by hand.

### TC-13: start on PostgreSQL
- **Steps:** `.env`: `STORAGE_BACKEND=postgres`; `docker compose up -d`;
  `docker compose logs api | tail -3`; `curl -s localhost:8080/api/health`.
- **Expected:** api log ends with `kuch-api on :3000 (rpID=localhost, …)`; health
  `{"ok":true,"users":1,"writable":true,"database":"ok"}` with `users` equal to the dry run's.
- **Status:** **pass.**

## D. Manual flow on PostgreSQL

### TC-14: the migrated data is what the app shows
- **Steps:** profile 1: reload (no new sign-in).
- **Expected:** still signed in (the session cookie is HMAC'd with `data/secret`, which stays a
  file); Home and History show the workout from TC-06.
- **Status:** **pass.** Home shows "Freestyle (Done)" and "1 workout total".

### TC-15: writes land in PostgreSQL
- **Steps:** change anything in profile 1.
- **Expected:** `PUT /api/data` 200; `user_state.rev` moves past the migrated value.
- **Verify:** `select uid, rev, wid, jsonb_array_length(wids), updated_at from user_state;`
- **Status:** **pass.** rev 7 (migrated) to 8 at 08:34:29 UTC.

### TC-16: sessions survive API restarts
- **Steps:** `docker compose up -d api` after an `.env` change (done twice: `ADMIN_UIDS`,
  `INVITE_ONLY`).
- **Expected:** no sign-out in the open tabs; health back to `database: ok`.
- **Status:** **pass.**

### TC-17: a concurrent edit from a second browser profile gets a 409 and resolves  ⏳
- **Pre:** profile 1 signed in as the TC-05 profile.
- **Steps:**
  1. Browser profile 2 (another Chrome profile or Edge) at `http://localhost:8080`, signed in to
     the **same** profile: **Sign in with passkey** if the passkey is available there, or in
     profile 1 Settings → Account → **Add another device**, then in profile 2 **Use a code from
     your other device** with that code.
  2. Profile 2: DevTools → Network → **Offline**. Make a change (rename the routine).
  3. Profile 1: make a different change (log a weigh-in). Wait for it to sync.
  4. Profile 2: Network → **No throttling**. Wait up to ~10 s.
- **Expected:** profile 2's `PUT /api/data` answers **409** with the current document; the
  client merges and its retry is 200; both profiles end up showing both changes;
  `user_state.rev` advances by the two writes, and `wids` holds both write ids.
- **Verify:** `docker compose logs web --no-log-prefix | grep "PUT /api/data"` shows a `409`
  followed by a `200`; the SQL from TC-15.
- **Status:** **pending.** No 409 in the log at the checkpoint, and rev still 8.

### TC-18: admin dashboard
- **Pre:** `ADMIN_UIDS=<TC-05 uid>` in `.env`, api restarted, app hard-reloaded (Ctrl+Shift+R:
  the app reads the admin flag from `/api/me` at start).
- **Steps:** gear → **Admin dashboard**, or `http://localhost:8080/#/admin` (hash routing; plain
  `/admin` does not route).
- **Expected:** every profile listed, with workout history.
- **Status:** **pass.**

### TC-19: open signup, second user
- **Pre:** `INVITE_ONLY` unset.
- **Steps:** an incognito window → **Create new profile** → passkey.
- **Expected:** a new `users` row and credential; its first change creates its `user_state` row.
- **Status:** **pass.** "Dadam" (`5vjKslaHWQmq-98H`).
- **Note:** **Use a code from your other device** is device linking, *not* invites: an invite
  code there answers `POST /api/device-link/options` 400, "That code is wrong, already used or
  expired".

### TC-20: invite-only signup refuses a missing or wrong code
- **Pre:** `INVITE_ONLY=1`, api restarted; `/api/config` says `"invite_only":true`; the signup
  page **reloaded** after the switch (it reads `invite_only` once at page load, and without it
  shows no invite field).
- **Steps:** Create new profile with no code, or with a wrong code.
- **Expected:** `POST /api/register/options` 403; toast "That invite code is not valid."; audit
  `auth.register.denied … invite-rejected`; no new `users` row.
- **Status:** **pass.**

### TC-21: invite-only signup with a valid code
- **Steps:** admin dashboard → generate an invite; a freshly loaded incognito window → Create
  new profile → name + **Invite code** → passkey.
- **Expected:** `register/verify` 200; the invite's `used_by` is the new uid; audit
  `auth.register.ok` with the code; the same code then refused.
- **Verify:** `select code, used_by from invites;`
- **Status:** **pass.** "Dad" (`_yGSQnJybiuaS5It`) used `EFFD82363DA41144`.

### TC-22: admin deletes a user, and everything of theirs goes
- **Steps:** admin dashboard → delete a profile.
- **Expected:** `POST /api/admin/user/delete` 200; the profile's `users`, `credentials`,
  `push_subscriptions`, `device_links` and `user_state` rows gone (FK cascade); no
  `data/uploads/<uid>` or `data/coach-auth-<uid>.json` left; other profiles untouched; the
  invite it used stays used.
- **Verify:**
  ```sql
  select id, name from users;
  select user_id, count(*) from credentials group by 1;
  select uid from user_state;
  ```
- **Status:** **pass.** Dadam deleted 10:58:05 UTC: no rows in any table, no uploads or coach
  file; Azamat and Dad intact.

## E. Optional, not run at this checkpoint

### TC-23: health when the database stops
- **Steps:** `docker compose stop postgres`; `curl -s localhost:8080/api/health`; start it again.
- **Expected:** 503 with `"database":"down"`; the API exits on the lost lock connection and its
  restart policy brings it back once Postgres is healthy.
- Covered by the automated DB-down tests; not run by hand.

### TC-24: rollback to the files
- **Steps:** runbook "Rollback": stop web and api, `STORAGE_BACKEND=file`, `rm data/MIGRATED-TO-POSTGRES`, up.
- **Expected:** the instance as at TC-08; writes made on Postgres are not there (as documented).

### TC-25: MCP reader against the stack
- **Steps:** `KUCH_DATABASE_URL` pointed at the stack's database with a read-only role (mcp
  README); file mode refuses while `MIGRATED-TO-POSTGRES` exists.
- Covered by `mcp/test/state-pg.test.js` and `state.test.js` in CI.
