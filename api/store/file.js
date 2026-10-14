/* The file backend of the storage interface (store/index.js): everything in JSON files under
   DATA_DIR, the way the API has always kept it.

   - db.json: every account, passkey, invite, push subscription and device link. Read once at
     boot (loadDb); the caller then owns the object in memory and hands it back whole to saveDb.
   - state-<uid>.json: one profile's training document, read from disk on every access.

   Every method is async, like every backend's (store/index.js). Under that, readState and
   readStateStrict really read in the background (fs.promises): a state can be megabytes. The rest
   do their work synchronously inside the call: saveDb serialises and writes `db` in the turn it
   is called, so saves land in the order they were asked for; and readStateCached and casWriteState
   share the stat cache, which a read still in flight across a write would refill with the old
   document. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

// What readStateStrict answers for a state that exists but cannot be read. A registered symbol,
// so every backend hands out the same one.
export const UNREADABLE = Symbol.for('kuch.store.unreadable');

// The tick reads every subscribed user's state file every 10 s. Most of those files do not
// change between ticks; a stat is far cheaper than a read and a parse of a state that can be
// megabytes, and it keeps the tick short — a slow tick was one more way to miss the minute.
//
// What it holds is a whole parsed state per user, and a state can be megabytes, so the two
// bounds below are what keep it a cache rather than a leak on an instance with more than one
// person on it: an entry nobody has touched for ten minutes is dropped, and the map never holds
// more than STATE_CACHE_MAX users. Map iteration order is insertion order, so re-inserting on
// every hit makes the first key the least recently hit one — which is the one to evict.
const STATE_CACHE_MAX = 64;
// Ten minutes: far longer than the gap between a client's polls (30 s) or the reminder tick's
// (10 s), so nobody who is actually using the instance is ever evicted by age; the tests shorten
// it, as they do REMINDER_TICK_MS.
const STATE_CACHE_TTL_MS = Math.max(50, +(process.env.STATE_CACHE_TTL_MS || 600000) || 600000);

export function createFileStore({ dir }) {
  const dbFile = path.join(dir, 'db.json');
  const stateFile = uid => path.join(dir, 'state-' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');

  // Every account, passkey and invite. Only a missing file starts empty: an unreadable one (a write
  // cut short by a power loss, a damaged restore) used to boot with no users at all, and the first
  // save then replaced it — every profile locked out, every training history orphaned, and with
  // FIRST_USER_ADMIN the first visitor made admin. Now the damaged file is kept aside and the copy
  // saveDb keeps of each version it writes (db.json.bak) is used; with neither readable the server
  // refuses to start, saying why, rather than start as a new instance.
  function readDb() {
    let raw;
    try { raw = fs.readFileSync(dbFile, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { users: [], creds: [], subs: [], invites: [] }; throw e; }
    const parse = text => { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); return v; };
    try { return parse(raw); } catch (err) {
      const aside = `${dbFile}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(dbFile, aside); } catch { /* the original stays where it is anyway */ }
      console.error(`db.json cannot be read (${err.message}); kept a copy as ${path.basename(aside)}`);
      try {
        const bak = parse(fs.readFileSync(dbFile + '.bak', 'utf8'));
        console.error('db.json: using db.json.bak, the copy of the last save');
        return bak;
      } catch {
        console.error('db.json: no readable db.json.bak either. Refusing to start: restore db.json from a backup.');
        process.exit(1);
      }
    }
  }
  // Every collection is there as an array, whatever an older db.json left out. Every other key and
  // field round-trips untouched through saveDb.
  async function loadDb() {
    const db = readDb();
    db.users = db.users || [];
    db.creds = db.creds || [];
    db.subs = db.subs || [];
    db.invites = db.invites || [];
    db.deviceLinks = db.deviceLinks || [];   // unused one-time device links, hashed (device-link.js)
    return db;
  }
  // 0600: db.json holds passkey credential material. It used to be covered by a blanket 0700 on
  // the whole directory; now that the directory stays traversable, the file carries its own mode.
  // Once the new version is on disk, a second copy of it goes to db.json.bak, the same durable
  // way: loadDb falls back to it. A copy of the version being replaced, as it used to be, lost
  // whatever the last save wrote (a profile just created) when db.json was later found unreadable.
  // A write cut short leaves the previous db.json.bak whole (temporary file and rename).
  // A failure to write db.json throws to the caller; one to write the .bak is only logged.
  async function saveDb(db) {
    const text = JSON.stringify(db, null, 2);
    atomicWrite(dbFile, text, 0o600);
    try { atomicWrite(dbFile + '.bak', text, 0o600); }
    catch (e) { console.error('db.json.bak could not be written', e.message); }
  }

  // Lenient: a state that is missing or cannot be read is null.
  async function readState(uid) {
    try { return JSON.parse(await fsp.readFile(stateFile(uid), 'utf8')); } catch { return null; }
  }
  // The same, synchronous: the stat cache's own read (see the header).
  function readStateNow(uid) {
    try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
  }
  // GET and PUT /api/data tell a profile with no state yet from one whose file cannot be read: the
  // second answers 503 instead of an empty profile, which a device would adopt, or a write would
  // replace, losing what a restore could still bring back.
  async function readStateStrict(uid) {
    let raw;
    try { raw = await fsp.readFile(stateFile(uid), 'utf8'); }
    catch (e) { return e.code === 'ENOENT' ? null : UNREADABLE; }
    try { return JSON.parse(raw); } catch { return UNREADABLE; }
  }
  // readState through the stat cache above. The document it returns is shared with later readers:
  // never mutate it.
  const stateCache = new Map(); // uid -> { mtimeMs, size, hitAt, S }
  async function readStateCached(uid) {
    let st;
    try { st = fs.statSync(stateFile(uid)); } catch { stateCache.delete(uid); return null; }
    const now = Date.now();
    for (const [k, v] of stateCache) if (now - v.hitAt > STATE_CACHE_TTL_MS) stateCache.delete(k);
    const hit = stateCache.get(uid);
    stateCache.delete(uid);                       // re-inserted below, so the map stays in hit order
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      hit.hitAt = now;
      stateCache.set(uid, hit);
      return hit.S;
    }
    const S = readStateNow(uid);
    stateCache.set(uid, { mtimeMs: st.mtimeMs, size: st.size, hitAt: now, S });
    while (stateCache.size > STATE_CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
    return S;
  }
  // The revision and write id GET /api/data/rev answers, through the stat cache.
  async function readStateRev(uid) {
    const S = await readStateCached(uid);
    return S ? { rev: S._rev || 0, wid: typeof S._wid === 'string' ? S._wid : null } : null;
  }
  // Replaces the document. The compare half of the compare-and-swap is the caller's per-profile
  // lock (server.js stateLock): this process is the only writer of a state file, and its writes to
  // one profile run one at a time, so the document the caller read under the lock is still the one
  // on disk. Checking again here would read and parse a document that can be megabytes, on every
  // write, to learn nothing. So this always lands, and answers true. Throws if it could not be
  // written, and then nothing changed on disk (the rename is atomic); JSON.stringify's RangeError
  // for a document nested too deep is thrown before anything is touched.
  async function casWriteState(uid, expectedRev, expectedWid, doc) {
    atomicWrite(stateFile(uid), JSON.stringify(doc));
    // The stat cache cannot see this write on its own: mtime granularity is 4 ms here (ext4 on
    // this kernel — 3901 of 3999 back-to-back same-size writes shared one timestamp), and a
    // `_rev` going from 7 to 8 does not change the file's size, so two writes inside one 4 ms
    // tick are the same (mtimeMs, size) key. A reader that sampled between them would then serve
    // the old revision until some later write happened to land on a different tick. This is the
    // only writer of a state file in the tree, so evicting here is the whole fix.
    stateCache.delete(uid);
    return true;
  }
  // Never throws: a state that is already gone is what was asked for.
  async function deleteState(uid) {
    try { fs.unlinkSync(stateFile(uid)); } catch { /* already gone */ }
  }
  // Every profile with a state file — the population a Coach cohort is drawn from.
  async function listStateUids() {
    try {
      return fs.readdirSync(dir).filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f)).map(f => f.slice(6, -5));
    } catch { return []; }
  }

  // Nothing to report beyond the data directory, which GET /api/health already probes.
  async function health() { return null; }
  async function close() {}

  return { loadDb, saveDb, readState, readStateStrict, readStateCached, readStateRev, casWriteState, deleteState, listStateUids, health, close };
}
