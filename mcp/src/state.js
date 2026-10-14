/* kuch-mcp state — read-only, from one of two places:
   - files (default): ./data/state-<uid>.json + db.json, cached with an fs.watch + mtime fallback
     so a session the api server just wrote is visible on the next tool call without a restart;
   - Postgres, when KUCH_DATABASE_URL (or DATABASE_URL) is set: the API's user_state and users
     tables, for an API on STORAGE_BACKEND=postgres. The cached doc is kept until user_state.rev
     moves, which the API bumps on every write.
   Once a data directory has moved to Postgres its files never change again, so file mode refuses
   to answer while the migration's marker file is there, rather than serve the cutover day forever. */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

// KUCH_* are this fork's names; OPENGYM_* (upstream's) still work, so an existing client config
// keeps reading the right profile.
const DATA_DIR = process.env.KUCH_DATA || process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')
const DATABASE_URL = process.env.KUCH_DATABASE_URL || process.env.DATABASE_URL || ''

// Written into DATA_DIR by the API's migration to Postgres; never written or removed here.
export const MIGRATED_MARKER = 'MIGRATED-TO-POSTGRES'

// null = no state file (brand-new account); undefined = not yet loaded.
let _state = undefined
let _db = undefined
let _uid = null
let _init = null        // the init() in flight or done; reset on failure so a fixed config retries
let _seeded = false     // _seedStateForTests: serve _state as is, from neither files nor database
let _watcher = null
let _loadedMtime = 0    // mtimeMs we last read at — used to catch watcher omissions
let _pool = null
let _rev = null         // user_state.rev of the cached doc (Postgres mode)

// null means one thing only: the file is not there (an account that never synced from a device).
// Every other failure — no permission on the mount, a truncated or corrupt file — is a real fault,
// and reporting it as "no synced state yet, sign in from a device" sends the operator to fix the
// wrong thing while the data sits there unreadable.
function readJsonOrNull(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    // Node's own message repeats the path it was given, and that is the server's absolute path:
    // the basename identifies the file just as well.
    const base = path.basename(file)
    const err = new Error(`cannot read ${base}: ${e.code || e.name} — ${String(e.message).replaceAll(file, base)}`)
    err.code = 'EIO'
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`${path.basename(file)} is not valid JSON: ${e.message}`)
    err.code = 'EIO'
    throw err
  }
}

// Checked on every call, not once: the migration may run while a client is attached.
function refuseIfMigrated() {
  if (!fs.existsSync(path.join(DATA_DIR, MIGRATED_MARKER))) return
  console.error(`[kuch-mcp] ${path.join(DATA_DIR, MIGRATED_MARKER)} exists — set KUCH_DATABASE_URL to the database the API now uses`)
  const err = new Error(`this Kuch data directory was migrated to PostgreSQL, so its files no longer change — set KUCH_DATABASE_URL to the database the API uses (see the kuch-mcp README)`)
  err.code = 'EMIGRATED'
  throw err
}

function reloadDb() { _db = readJsonOrNull(path.join(DATA_DIR, 'db.json')) || { users: [], creds: [], subs: [], invites: [] } }

function stateFile(uid) {
  return path.join(DATA_DIR, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
}

// KUCH_UID env (or OPENGYM_UID), or '' when unset.
function envUid() {
  const uid = (process.env.KUCH_UID || process.env.OPENGYM_UID || '').trim()
  if (uid && !/^[a-zA-Z0-9_-]+$/.test(uid)) throw new Error(`KUCH_UID contains characters that aren't safe in a filename: ${JSON.stringify(uid)}`)
  return uid
}

// Pick the uid: KUCH_UID env (or OPENGYM_UID), else the only state-* file, else the only user in db.json.
// Throws listing the options if ambiguous. The sanitiser on stateFile() keeps a sneaky
// '..' in KUCH_UID harmless.
function resolveUid() {
  const pinned = envUid()
  if (pinned) return pinned
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/^state-/, '').replace(/\.json$/, ''))
  if (files.length === 1) return files[0]
  if (files.length === 0) {
    reloadDb()
    if (_db.users.length === 1) return _db.users[0].id
    if (_db.users.length === 0) throw new Error(`no Kuch users found in ${path.join(DATA_DIR, 'db.json')} — sign in at least once on a device`)
    // Multiple users in db.json but no state file yet — hit when accounts exist but none has
    // signed in on a device.
    throw ambiguousUid(_db.users.map(u => u.id), 'data directory', 'in db.json under "users"[].id', DATA_DIR)
  }
  throw ambiguousUid(files, 'data directory', 'in db.json under "users"[].id', DATA_DIR)
}

// "Which profile?" is a config question for the operator, and this message travels as a tool
// result: into the model's context and into whatever transcript it lands in. Every account id on
// the box, plus the server's absolute paths, has no business there. The count and the setting to
// change are what the model can act on; the ids and the path go to the server log on stderr,
// where the operator is already reading the startup line. The database's location stays out of
// both: its URL may carry a password.
function ambiguousUid(ids, store, where, location) {
  console.error(`[kuch-mcp] ${ids.length} Kuch profiles in ${location}: ${ids.join(', ')} — set KUCH_UID to one of them`)
  const err = new Error(`this Kuch ${store} holds ${ids.length} profiles — set KUCH_UID to the one this server should read (the ids are on the server's stderr, and ${where})`)
  err.code = 'EINVAL'
  return err
}

/* ---------- Postgres ---------- */

// BIGINT (rev) as a number, as the API reads it (api/store/pg.js).
const types = { getTypeParser: (oid, format) => (oid === 20 ? Number : pg.types.getTypeParser(oid, format)) }

// One connection is plenty for a single client's tool calls. allowExitOnIdle, or an idle
// connection alone holds the event loop open and the process outlives the client that spawned it.
function pool() {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, allowExitOnIdle: true, types })
    _pool.on('error', e => console.error(`[kuch-mcp] database: idle connection lost: ${e.message}`))
  }
  return _pool
}

// A failed query names what went wrong (refused, no such table, permission denied) and nothing
// of the connection string, which may carry the password.
async function q(sql, params) {
  try {
    return (await pool().query(sql, params)).rows
  } catch (e) {
    const err = new Error(`cannot read the Kuch database: ${e.code || e.name} — ${e.message}`)
    err.code = 'EIO'
    throw err
  }
}

// Same rules as resolveUid(): the only synced profile, else the only user.
async function resolveUidPg() {
  const pinned = envUid()
  if (pinned) return pinned
  const synced = (await q('SELECT uid FROM user_state ORDER BY uid')).map(r => r.uid)
  if (synced.length === 1) return synced[0]
  if (synced.length > 1) throw ambiguousUid(synced, 'database', 'in its users table', 'the database')
  const users = (await q('SELECT id FROM users ORDER BY id')).map(r => r.id)
  if (users.length === 1) return users[0]
  if (users.length === 0) throw new Error('no Kuch users found in the database — sign in at least once on a device')
  throw ambiguousUid(users, 'database', 'in its users table', 'the database')
}

// The doc travels only when rev has moved since the cached copy.
async function getStatePg() {
  const rows = await q('SELECT rev, CASE WHEN rev = $2 THEN NULL ELSE doc END AS doc FROM user_state WHERE uid = $1', [_uid, _rev])
  if (!rows.length) {
    _state = null           // never synced, or the profile was deleted
    _rev = null
  } else if (rows[0].rev !== _rev) {
    _state = Object.assign({}, defaultsShape(), rows[0].doc)
    _rev = rows[0].rev
  }
  return _state
}

/* ---------- the interface ---------- */

async function doInit() {
  if (DATABASE_URL) {
    _uid = await resolveUidPg()
    return
  }
  if (!fs.existsSync(DATA_DIR)) throw new Error(`KUCH_DATA dir does not exist: ${DATA_DIR}`)
  _uid = resolveUid()
  reloadDb()
  const file = stateFile(_uid)
  if (fs.existsSync(file)) {
    _state = readJsonOrNull(file)
    if (_state) _state = Object.assign({}, defaultsShape(), _state)
    try { _loadedMtime = fs.statSync(file).mtimeMs } catch {}
  }
  if (_watcher) _watcher.close()
  // fs.watch is best-effort: the api server's atomic write at PUT /api/data is the source of
  // truth, and a stale read just gets corrected on the next change or the next tool call.
  try {
    _watcher = fs.watch(file, () => {
      // On change, simply clear the cache — the next getState() will re-read. Avoids reading
      // twice if the watcher fires multiple events for one atomic-write (rename + create).
      _state = undefined
      _loadedMtime = 0
    })
    // Unref'd, or the watcher alone holds the event loop open and the process outlives the
    // client that spawned it — "exits when the LLM client disconnects" stops being true the
    // moment there is a state file to watch. Most clients kill the child anyway, but one that
    // merely closes the pipe would leak a process per session. Watching is unaffected: the
    // stdio transport is what keeps the loop alive while a client is actually attached.
    _watcher.unref()
  } catch { /* fs.watch unsupported on this platform; tools will re-read on mtime change */ }
}

// Idempotent. Picks the uid; in file mode also loads db.json, attaches the watcher, primes state.
export async function init() {
  if (_seeded) return
  if (!DATABASE_URL) refuseIfMigrated()
  if (!_init) _init = doInit().catch(e => { _init = null; throw e })
  return _init
}

// Returns the state object, or null for a fresh account that never signed in on a device.
export async function getState() {
  if (_seeded) return _state
  await init()
  if (DATABASE_URL) return getStatePg()
  const file = stateFile(_uid)
  // Re-read if the file's mtime changed since our last load — covers watcher omissions and
  // platforms with no fs.watch.
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch {
    return _state === undefined ? null : _state
  }
  if (_state === undefined || mtime !== _loadedMtime) {
    const fresh = readJsonOrNull(file)
    if (fresh) {
      // Same shape the frontend builds on pullState — defaults merged with stored state so any
      // field the app added since the snapshot was last saved shows up undefined-safe.
      _state = Object.assign({}, defaultsShape(), fresh)
      _loadedMtime = mtime
    } else if (_state === undefined) {
      _state = null  // no state file at all — never signed in on a device
    }
  }
  return _state
}

// Returns the user record (id + name). No passkey material, no VAPID keys, no push subs.
export async function getUser() {
  if (!_seeded) await init()
  const u = DATABASE_URL && !_seeded
    ? (await q('SELECT id, name, created FROM users WHERE id = $1', [_uid]))[0]
    : _db.users.find(x => x.id === _uid)
  const user = u || { id: _uid, name: 'Profile', created: null }
  return { id: user.id, name: user.name, created: user.created || null }
}

export const dataDir = () => DATA_DIR

// Where the profile is read from, for the startup line: never the database URL (it may carry a
// password).
export const source = () => DATABASE_URL ? 'Postgres' : DATA_DIR

// Ends the database pool, if one was opened. The server never needs it (the pool lets the process
// exit on its own); tests do, between schemas.
export async function close() {
  const p = _pool
  _pool = null
  if (p) await p.end()
}

// Test-only: work against a passed-in state, not the disk or the database.
export function _seedStateForTests(state) {
  _seeded = true
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }], creds: [], subs: [], invites: [] }
  _state = state
  _loadedMtime = Number.MAX_SAFE_INTEGER   // never re-read from disk in a test
  if (_watcher) { _watcher.close(); _watcher = null }
}

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}
