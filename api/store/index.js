/* Where the API keeps its data: the one place server.js and the Coach read and write accounts
   and training documents. STORAGE_BACKEND picks the backend; `file` (the default) is the JSON
   files under DATA_DIR (store/file.js).

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
   - readStateStrict(uid)   the same, but UNREADABLE when it exists and cannot be read.
   - readStateCached(uid)   readState, cheap to repeat; the document is shared, never mutate it.
   - writeState(uid, text)  replaces the document with `text` (JSON). Throws when it could not, and
                            then nothing changed.
   - deleteState(uid)       removes the document; never throws.
   - listStateUids()        the uid of every profile that has a document.

   Nothing here makes a read and the write after it atomic: another request runs while either is
   awaited. PUT /api/data, the one read-compare-write on a document, runs it under a per-profile
   lock (server.js stateLock). Callers that change `db` change it synchronously, then await saveDb,
   and answer only after it resolved: "saved" means committed (durable.js). */
import { createFileStore, UNREADABLE } from './file.js';

export { UNREADABLE };

const BACKENDS = { file: createFileStore };

export function openStore({ backend = process.env.STORAGE_BACKEND || 'file', dir = process.env.DATA_DIR || '/data' } = {}) {
  const create = BACKENDS[backend];
  if (!create) throw new Error(`STORAGE_BACKEND "${backend}" is not one of: ${Object.keys(BACKENDS).join(', ')}`);
  return create({ dir });
}

// One per process, resolved at import like DATA_DIR everywhere else (test/helpers.mjs).
export const store = openStore();
