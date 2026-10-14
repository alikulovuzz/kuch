/* The Postgres backend of the storage interface (store/index.js), STORAGE_BACKEND=postgres with
   DATABASE_URL. The tables are api/migrations/*.sql; why it is shaped this way is
   docs/adr/0001-postgres-write-through-db.md.

   - Accounts are a write-through copy. loadDb reads every table into the one `db` object the API
     keeps in memory; saveDb(db) then writes, in one transaction, only the rows whose content
     differs from what the last commit left (a snapshot kept here) and deletes the rows that are
     gone. Saves run one at a time, in the order they were asked for, and each diffs `db` when its
     turn comes, so the save a route awaits includes the change the route made before calling it.
   - Training documents stay documents (user_state), with rev/wid/wids beside each one.
     casWriteState is the compare-and-swap PUT /api/data needs: one conditional statement that
     writes only if the stored (rev, wid) is still the one the caller read.
   - One API process per schema. Startup waits for the database, takes a session-level advisory
     lock on a connection held for the life of the process, then runs the migrations; a second
     process on the same schema refuses to start, and losing that connection ends the process. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from './migrate.js';
import { StoreUnavailable, InvalidDocument } from './errors.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// BIGINT columns hold epoch milliseconds and counters, all safe integers: read them as numbers,
// as db.json had them, not as the strings node-postgres gives by default.
const types = { getTypeParser: (oid, format) => (oid === 20 ? Number : pg.types.getTypeParser(oid, format)) };

/* Every db.json collection and its table, parents before children (the order rows are written
   in; deletes go the other way). Each column is [column, field, kind]; the first is the key. */
const TABLES = [
  { table: 'users', coll: 'users', unique: ['email'], cols: [
    ['id', 'id', 'text'], ['name', 'name', 'text'], ['created', 'created', 'text'], ['admin', 'admin', 'bool'],
    ['disabled', 'disabled', 'bool'], ['invited_by', 'invitedBy', 'text'], ['sv', 'sv', 'int'],
    ['last_pull', 'lastPull', 'bigint'], ['last_reminder', 'lastReminder', 'text'], ['last_nudge', 'lastNudge', 'text'],
    ['pw', 'pw', 'json'], ['pw_reset', 'pwReset', 'json'], ['email', 'email', 'text']] },
  { table: 'credentials', coll: 'creds', cols: [
    ['id', 'id', 'text'], ['user_id', 'userId', 'text'], ['public_key', 'publicKey', 'text'], ['counter', 'counter', 'bigint'],
    ['transports', 'transports', 'json'], ['created', 'created', 'text'], ['last_used', 'lastUsed', 'text'], ['name', 'name', 'text']] },
  { table: 'invites', coll: 'invites', cols: [
    ['code', 'code', 'text'], ['note', 'note', 'text'], ['created_by', 'createdBy', 'text'], ['created', 'created', 'text'],
    ['used_by', 'usedBy', 'text'], ['used_at', 'usedAt', 'text']] },
  { table: 'push_subscriptions', coll: 'subs', cols: [
    ['endpoint', 'endpoint', 'text'], ['user_id', 'userId', 'text'], ['keys', 'keys', 'json'], ['device_id', 'deviceId', 'text'],
    ['created', 'created', 'text']] },
  { table: 'device_links', coll: 'deviceLinks', cols: [
    ['h', 'h', 'text'], ['user_id', 'userId', 'text'], ['exp', 'exp', 'bigint'], ['created', 'created', 'bigint']] }
];
const COLLECTIONS = new Set(TABLES.map(t => t.coll));

for (const spec of TABLES) {
  const names = ['pos', ...spec.cols.map(c => c[0]), 'extra'];
  const values = ['$1', ...spec.cols.map((c, i) => `$${i + 2}${c[2] === 'json' ? '::jsonb' : ''}`), `$${names.length}::jsonb`];
  spec.upsert = `INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${values.join(', ')})
    ON CONFLICT (${spec.cols[0][0]}) DO UPDATE SET ${names.filter(n => n !== spec.cols[0][0]).map(n => `${n} = EXCLUDED.${n}`).join(', ')}`;
  spec.remove = `DELETE FROM ${spec.table} WHERE ${spec.cols[0][0]} = ANY($1::text[])`;
}

// A table row → the record db.json had: the fields whose column is not NULL, then `extra`.
function decode(spec, row) {
  const rec = {};
  for (const [col, field] of spec.cols) if (row[col] !== null) rec[field] = row[col];
  return Object.assign(rec, row.extra);
}

// Whether a value can sit in a column of this kind without changing what loadDb gives back.
function fits(kind, v) {
  switch (kind) {
    case 'text': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'int': return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    case 'bigint': return Number.isSafeInteger(v);
    case 'json': return v !== null;
  }
}

// A record at `pos` in its collection → the upsert's parameters: pos, every column, extra. A
// field that is absent (or undefined, which JSON drops too) is NULL; one that does not fit its
// column (an explicit null, a wrong type) goes to `extra` with every field that has no column.
function encode(spec, rec, pos) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error(`db.${spec.coll}[${pos}] is not a record`);
  const params = [pos];
  const stored = new Set();
  for (const [, field, kind] of spec.cols) {
    const v = rec[field];
    if (v !== undefined && fits(kind, v)) { params.push(kind === 'json' ? JSON.stringify(v) : v); stored.add(field); }
    else params.push(null);
  }
  const extra = {};
  for (const [k, v] of Object.entries(rec)) if (v !== undefined && !stored.has(k)) extra[k] = v;
  params.push(JSON.stringify(extra));
  if (params[1] === null) throw new Error(`db.${spec.coll}[${pos}] has no ${spec.cols[0][1]}`);
  return params;
}

// The whole `db` as rows: table → key → { params, sig }, sig being what the diff compares.
function encodeAll(db) {
  const all = new Map();
  for (const spec of TABLES) {
    const rows = new Map();
    const list = db[spec.coll] ?? [];
    if (!Array.isArray(list)) throw new Error(`db.${spec.coll} is not an array`);
    list.forEach((rec, pos) => {
      const params = encode(spec, rec, pos);
      if (rows.has(params[1])) throw new Error(`db.${spec.coll} holds ${spec.cols[0][1]} ${params[1]} twice`);
      rows.set(params[1], { params, sig: JSON.stringify(params) });
    });
    all.set(spec.table, rows);
  }
  const extra = new Map();
  for (const [key, value] of Object.entries(db)) {
    if (COLLECTIONS.has(key) || value === undefined) continue;
    const json = JSON.stringify(value);
    extra.set(key, { params: [key, json], sig: json });
  }
  all.set('db_extra', extra);
  return all;
}
const EXTRA_UPSERT = 'INSERT INTO db_extra (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
const EXTRA_REMOVE = 'DELETE FROM db_extra WHERE key = ANY($1::text[])';

// Errors from a connection that is gone, refused or not accepting yet: worth waiting out at
// startup, and a 503 rather than a 500 afterwards. A SQLSTATE means the server answered; only
// its connection-exception (08), operator-intervention (57) and resource (53) classes count.
function transient(e) {
  const code = e?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return /^(08|57|53)/.test(code);
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The bounds of readStateCached, the file backend's (store/file.js has the reasoning).
const STATE_CACHE_MAX = 64;
const STATE_CACHE_TTL_MS = Math.max(50, +(process.env.STATE_CACHE_TTL_MS || 600000) || 600000);

export function createPgStore({
  url = process.env.DATABASE_URL,
  waitMs = Math.max(0, +(process.env.DB_WAIT_MS ?? 60000) || 0),
  onLockLost = () => process.exit(1)
} = {}) {
  if (!url) throw new Error('STORAGE_BACKEND=postgres needs DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, types });
  // An idle pooled connection the server dropped; the next query opens a new one.
  pool.on('error', e => console.error('database: idle connection lost:', e.message));
  let lockClient = null;
  let closing = false;

  // Wait for the database (a container started alongside it, a server restarting), up to waitMs
  // with backoff, then lock and migrate. An error that waiting will not cure (wrong password, no
  // such database) fails at once.
  async function open() {
    const started = Date.now();
    for (let delay = 250; ; delay = Math.min(delay * 2, 5000)) {
      const client = new pg.Client({ connectionString: url, types });
      try { await client.connect(); lockClient = client; break; }
      catch (e) {
        await client.end().catch(() => {});
        const left = waitMs - (Date.now() - started);
        if (!transient(e) || left <= 0) throw new Error(`cannot reach the database: ${e.message}`);
        console.error(`database not reachable yet (${e.message}); retrying in ${Math.min(delay, left)} ms`);
        await sleep(Math.min(delay, left));
      }
    }
    lockClient.on('error', e => {
      if (closing) return;
      console.error('database: lost the connection holding the single-instance lock:', e.message, '— exiting');
      onLockLost(e);
    });
    const { rows: [lock] } = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext('kuch-api:' || coalesce(current_schema(), ''))) AS ok, current_schema() AS schema");
    if (!lock.ok) throw new Error(`another kuch-api owns this database (schema ${lock.schema}): run one API process per database`);
    const applied = await migrate(lockClient, MIGRATIONS);
    if (applied.length) console.log('database: applied migrations', applied.join(', '));
  }
  let opening = null;
  const ready = () => (opening ||= open());

  // A query on the pool, with a connection failure turned into StoreUnavailable.
  async function query(sql, params) {
    try { return await pool.query(sql, params); }
    catch (e) { throw transient(e) ? new StoreUnavailable(e) : e; }
  }

  async function loadDb() {
    await ready();
    const client = await pool.connect().catch(e => { throw new StoreUnavailable(e); });
    try {
      // One consistent view of every table.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const db = {};
      for (const spec of TABLES) {
        const { rows } = await client.query(`SELECT * FROM ${spec.table} ORDER BY pos`);
        db[spec.coll] = rows.map(row => decode(spec, row));
      }
      for (const { key, value } of (await client.query('SELECT key, value FROM db_extra ORDER BY key')).rows) {
        if (!COLLECTIONS.has(key)) db[key] = value;
      }
      await client.query('COMMIT');
      snapshot = encodeAll(db);
      return db;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw transient(e) ? new StoreUnavailable(e) : e;
    } finally { client.release(); }
  }

  // What the last commit left in the tables, as encodeAll has it: the base every save diffs against.
  let snapshot = null;
  // The statements that take the tables from `snapshot` to `next`: deletes children first, then
  // upserts parents first, so no foreign key is ever left dangling inside the transaction.
  function diff(next) {
    const ops = [];
    const gone = (table, sql) => {
      const keys = [...snapshot.get(table).keys()].filter(k => !next.get(table).has(k));
      if (keys.length) ops.push({ table, key: keys.join(', '), sql, params: [keys] });
    };
    const changed = (table, sql) => {
      for (const [key, row] of next.get(table)) {
        if (snapshot.get(table).get(key)?.sig !== row.sig) ops.push({ table, key, sql, params: row.params });
      }
    };
    for (const spec of [...TABLES].reverse()) gone(spec.table, spec.remove);
    gone('db_extra', EXTRA_REMOVE);
    for (const spec of TABLES) {
      // Unique values are checked row by row, so an address handed from one profile to another
      // in the same save would clash with its old row if that row is written second: clear the
      // unique columns of every stored row whose value moves first. Only a real duplicate in
      // memory is then refused.
      for (const col of spec.unique || []) {
        const i = 1 + spec.cols.findIndex(c => c[0] === col);
        const prev = snapshot.get(spec.table);
        const moving = [...next.get(spec.table)].filter(([key, row]) => prev.has(key) && prev.get(key).params[i] !== row.params[i]).map(([key]) => key);
        if (moving.length) ops.push({ table: spec.table, key: moving.join(', '), sql: `UPDATE ${spec.table} SET ${col} = NULL WHERE ${spec.cols[0][0]} = ANY($1::text[])`, params: [moving] });
      }
      changed(spec.table, spec.upsert);
    }
    changed('db_extra', EXTRA_UPSERT);
    return ops;
  }
  async function write(next) {
    const ops = diff(next);
    if (!ops.length) return;
    const client = await pool.connect().catch(e => { throw new StoreUnavailable(e); });
    let op = null;
    try {
      await client.query('BEGIN');
      for (op of ops) await client.query(op.sql, op.params);
      op = null;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (transient(e)) throw new StoreUnavailable(e);
      // The snapshot stays as it was, so the next save retries this same row: say which one.
      if (op) console.error(`database refused ${op.table} ${op.key}: ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
      throw e;
    } finally { client.release(); }
    snapshot = next;
  }
  let saving = Promise.resolve();
  function saveDb(db) {
    const run = saving.then(async () => {
      if (!snapshot) await loadDb();         // a save before any load diffs against the tables
      return write(encodeAll(db));
    });
    saving = run.catch(() => {});
    return run;
  }

  // A lenient read (readState, readStateCached, listStateUids) answers "none" when the database
  // is down, as the file backend does for a file it cannot read; said once a minute, not per read.
  let quietUntil = 0;
  function lenient(what, e) {
    if (Date.now() < quietUntil) return;
    quietUntil = Date.now() + 60000;
    console.error(`database: ${what} failed:`, e.message);
  }

  // Lenient: a document that is missing, or that cannot be read right now, is null.
  async function readState(uid) {
    try { return await readStateStrict(uid); } catch (e) { lenient('reading a training document', e); return null; }
  }
  // null when there is none. Never UNREADABLE (a row is either there whole or not); a database
  // that cannot be reached throws StoreUnavailable, which the API answers 503.
  async function readStateStrict(uid) {
    await ready();
    const { rows } = await query('SELECT doc FROM user_state WHERE uid = $1', [uid]);
    return rows.length ? rows[0].doc : null;
  }
  // What GET /api/data/rev answers, without the document: { rev, wid } or null.
  async function readStateRev(uid) {
    await ready();
    const { rows } = await query('SELECT rev, wid FROM user_state WHERE uid = $1', [uid]);
    return rows.length ? { rev: rows[0].rev, wid: rows[0].wid } : null;
  }
  /* readState, cheap to repeat: the reminder tick reads every subscribed profile's document every
     10 s. The same bounded LRU as the file backend (64 profiles, 10 min untouched), but checked
     against the row's (rev, wid) — one tiny query — instead of a file's mtime and size. A
     revision moved by anything, a write here or an edit in psql, is a fetch. The document it
     returns is shared with later readers: never mutate it. */
  const stateCache = new Map(); // uid -> { rev, wid, hitAt, S }
  async function readStateCached(uid) {
    let cur;
    try { cur = await readStateRev(uid); }
    catch (e) { lenient('reading a training document', e); return null; }
    if (!cur) { stateCache.delete(uid); return null; }
    const now = Date.now();
    for (const [k, v] of stateCache) if (now - v.hitAt > STATE_CACHE_TTL_MS) stateCache.delete(k);
    const hit = stateCache.get(uid);
    stateCache.delete(uid);                       // re-inserted below, so the map stays in hit order
    if (hit && hit.rev === cur.rev && hit.wid === cur.wid) {
      hit.hitAt = now;
      stateCache.set(uid, hit);
      return hit.S;
    }
    // Fetched by its revision too, so a write landing between the two queries is not cached
    // under the older revision: it is simply fetched again on the next read.
    let row;
    try { row = (await query('SELECT rev, wid, doc FROM user_state WHERE uid = $1', [uid])).rows[0]; }
    catch (e) { lenient('reading a training document', e); return null; }
    if (!row) return null;
    stateCache.set(uid, { rev: row.rev, wid: row.wid, hitAt: now, S: row.doc });
    while (stateCache.size > STATE_CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
    return row.doc;
  }
  /* The compare-and-swap of PUT /api/data: stores `doc` only if the profile's document is still
     the one the caller read — revision `expectedRev` with write id `expectedWid` (null when it had
     none), or no document at all when `expectedRev` is null — and answers whether it did. One
     statement, so nothing can land between the check and the write: a false is the 409. rev, wid
     and wids are taken from the document in that same statement, so they always mirror it.
     Throws InvalidDocument for a document JSONB refuses (see errors.js), and the RangeError of
     JSON.stringify for one nested too deep. */
  async function casWriteState(uid, expectedRev, expectedWid, doc) {
    const text = JSON.stringify(doc);
    await ready();
    const cols = `CASE WHEN jsonb_typeof(d->'_rev') = 'number' AND d->>'_rev' ~ '^[0-9]{1,15}$' THEN (d->>'_rev')::bigint ELSE 0 END,
      CASE WHEN jsonb_typeof(d->'_wid') = 'string' THEN d->>'_wid' END,
      CASE WHEN jsonb_typeof(d->'_wids') = 'array' THEN d->'_wids' ELSE '[]'::jsonb END, d`;
    let res;
    try {
      res = expectedRev == null
        ? await query(`INSERT INTO user_state (uid, rev, wid, wids, doc) SELECT $1, ${cols} FROM (SELECT $2::jsonb AS d) s
            ON CONFLICT (uid) DO NOTHING RETURNING rev, wid`, [uid, text])
        : await query(`UPDATE user_state SET (rev, wid, wids, doc, updated_at) = (SELECT ${cols}, now() FROM (SELECT $4::jsonb AS d) s)
            WHERE uid = $1 AND rev = $2 AND wid IS NOT DISTINCT FROM $3 RETURNING rev, wid`, [uid, expectedRev, expectedWid, text]);
    } catch (e) {
      // Class 22, data exception: here only the document can be at fault (a NUL, a lone surrogate).
      if (/^22/.test(e.code || '')) throw new InvalidDocument(e);
      throw e;
    }
    if (res.rowCount !== 1) return false;
    // The write is the newest document: the cache holds it from here, shared like any cached read.
    stateCache.delete(uid);
    stateCache.set(uid, { rev: res.rows[0].rev, wid: res.rows[0].wid, hitAt: Date.now(), S: doc });
    while (stateCache.size > STATE_CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
    return true;
  }
  // Never throws: a document that is already gone is what was asked for.
  async function deleteState(uid) {
    stateCache.delete(uid);
    try { await ready(); await query('DELETE FROM user_state WHERE uid = $1', [uid]); }
    catch (e) { console.error('database: could not delete the training document of', uid + ':', e.message); }
  }
  // Every profile with a document — the population a Coach cohort is drawn from.
  async function listStateUids() {
    try { await ready(); return (await query('SELECT uid FROM user_state ORDER BY uid')).rows.map(r => r.uid); }
    catch (e) { lenient('listing training documents', e); return []; }
  }

  // For GET /api/health: whether the database answers a query now.
  async function health() {
    try { await query('SELECT 1'); return { ok: true }; }
    catch (e) { console.error('health: database:', e.message); return { ok: false }; }
  }

  async function close() {
    closing = true;
    await pool.end().catch(() => {});
    if (lockClient) await lockClient.end().catch(() => {});
  }

  return { loadDb, saveDb, readState, readStateStrict, readStateCached, readStateRev, casWriteState, deleteState, listStateUids, health, close };
}
