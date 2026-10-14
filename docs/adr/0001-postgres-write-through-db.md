# Postgres is a write-through copy of the in-memory db, behind one API instance

With `STORAGE_BACKEND=postgres` the API still loads every account, passkey, invite, push
subscription and device link into one in-memory `db` object at boot, answers every lookup from
it, and changes it in place; `saveDb()` persists the change as one transaction that upserts the
rows whose JSON differs from the last committed snapshot and deletes the rows that are gone.
We kept this shape because the auth routes' guarantees (first user becomes admin, e-mail and
credential-id uniqueness, single-use invites and reset codes, the re-checks after each await, the
push-subscription cap) hold today only because nothing yields between a check and its in-memory
change, and the profile-name rule (a name is taken only while its profile has a password or a live
reset code) cannot be a SQL constraint at all. Per-training-document state is different: it stays
a document in `user_state` and `PUT /api/data` is a real compare-and-swap in SQL.

## Consequences

- **Exactly one API process per database.** At startup the API takes a session-level
  `pg_try_advisory_lock` and exits loudly if another process holds it. Kubernetes and Helm run
  `replicas: 1` with `strategy: Recreate`. In-process state (WebAuthn challenges, pairings, rate
  limits, rest timers, the state cache) already assumed this.
- Saves run one at a time through an in-process queue; each diffs memory when its turn comes, and
  a route answers 200 only after a commit that includes its change.
- A failed save leaves memory ahead of the database, as a failed `db.json` write does today; the
  snapshot is unchanged, so the next save retries those rows.
- Columns keep the JavaScript value types (ISO strings as `TEXT`, epoch milliseconds as `BIGINT`)
  and unknown fields live in `extra` JSONB, so a round trip is byte-for-byte and the migration can
  verify by deep equality.

## Considered options

- **Per-operation SQL at each of the 30 `saveDb()` call sites.** Rejected: every guarantee above
  would have to be rebuilt as a constraint or a serializable transaction, the name rule needs a
  lock, and the single-instance assumption would remain anyway because of the in-process state.
