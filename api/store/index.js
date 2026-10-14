/* Where the API keeps its data: the one place server.js and the Coach read and write accounts
   and training documents. STORAGE_BACKEND picks the backend: `file` (the default) is the JSON
   files under DATA_DIR (store/file.js); `postgres` is the database DATABASE_URL names
   (store/pg.js, docs/adr/0001-postgres-write-through-db.md).

   The interface, the same for every backend. Every method returns a promise; "throws" below means
   it rejects.
   - loadDb()               every account, passkey, invite, push subscription and device link, as
                            one object `{ users, creds, subs, invites, deviceLinks, ... }` with each
                            collection an array. Boot only: the caller keeps it in memory and
                            changes it in place. Refuses to start the process when what is stored
                            cannot be read.
   - saveDb(db)             persists that whole object as it is when called, and resolves once
                            that is committed. Saves land in the order they were called. Throws
                            when it could not.
   - readState(uid)         a profile's training document, or null when there is none or it cannot
                            be read.
   - readStateStrict(uid)   the same, but UNREADABLE when it exists and cannot be read (file), and
                            throws when the database cannot be reached (postgres).
   - readStateCached(uid)   readState, cheap to repeat; the document is shared, never mutate it.
   - readStateRev(uid)      { rev, wid } of the document (wid null when it has none), or null when
                            there is none; never the document itself.
   - casWriteState(uid, expectedRev, expectedWid, doc)
                            stores `doc` if the document is still revision `expectedRev` with write
                            id `expectedWid` — or there is none, when `expectedRev` is null — and
                            answers whether it did. Throws InvalidDocument for a document the
                            backend cannot hold, a RangeError for one too deep to serialise, and
                            otherwise when it could not write; then nothing changed.
   - deleteState(uid)       removes the document; never throws.
   - listStateUids()        the uid of every profile that has a document.
   - health()               { ok } for a backend with a server to reach, null for one without.
   - close()                lets go of connections (tests; the API never closes its store).

   Errors: StoreUnavailable means the database cannot be reached right now (the API answers 503).

   PUT /api/data, the one read-compare-write on a document, runs it under a per-profile lock
   (server.js stateLock), since another request runs while the read is awaited. In the file
   backend that lock is the whole compare; Postgres checks again in the write itself, so a write
   from anywhere else (psql, a restore) is a conflict too. Callers that change `db` change it
   synchronously, then await saveDb, and answer only after it resolved: "saved" means committed
   (durable.js). */
import { createFileStore, UNREADABLE } from './file.js';
import { createPgStore } from './pg.js';
import { StoreUnavailable, InvalidDocument } from './errors.js';

export { UNREADABLE, StoreUnavailable, InvalidDocument };

const BACKENDS = { file: createFileStore, postgres: createPgStore };

export function openStore({ backend = process.env.STORAGE_BACKEND || 'file', dir = process.env.DATA_DIR || '/data', url = process.env.DATABASE_URL } = {}) {
  const create = BACKENDS[backend];
  if (!create) throw new Error(`STORAGE_BACKEND "${backend}" is not one of: ${Object.keys(BACKENDS).join(', ')}`);
  return create({ dir, url });
}

// One per process, resolved at import like DATA_DIR everywhere else (test/helpers.mjs).
export const store = openStore();
