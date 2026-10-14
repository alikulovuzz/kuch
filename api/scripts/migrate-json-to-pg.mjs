#!/usr/bin/env node
/* Copies the JSON files under DATA_DIR into the Postgres database DATABASE_URL names (spec §2.5):
   db.json into the account tables, every state-<uid>.json into user_state. The API must be stopped;
   docs/POSTGRES_MIGRATION.md has the whole cutover.

     DATA_DIR=/data DATABASE_URL=postgres://… node scripts/migrate-json-to-pg.mjs [--dry-run] [--from-bak] [--replace]

   - Everything is written in ONE transaction, and verified inside it before it commits: the row
     count of every table matches the files, the accounts read back deep-equal db.json, and every
     stored document deep-equals its file with rev and wid matching its _rev and _wid. Anything
     else rolls back and exits 1, so the database is never left half migrated or unverified.
   - Idempotent. Only rows that differ are written (the same diff store/pg.js saves with), so a
     second run writes nothing and verifies again.
   - --dry-run does all of it, prints the counts and the verdict, and rolls back. Only the schema
     is left behind: an empty database gets its tables first, as the API's first start would.
   - The JSON files are only read. db.json.bak is used only with --from-bak, and only when db.json
     cannot be read. A state file that cannot be parsed, is not a document, has no profile in
     db.json or holds text Postgres cannot store is reported and skipped, never made up. A db.json
     the tables cannot hold as it is (a passkey of a profile that does not exist, say) is refused
     whole: the API needs every account.
   - A database that already holds something else than the files (not empty, not an earlier run
     of the same files) is only overwritten with --replace: rows the files no longer have are
     deleted. While MIGRATED-TO-POSTGRES exists it never is, --replace or not, because the API may
     have been running on the database since and its data is newer than the files.
   - After a committed, verified run it writes DATA_DIR/MIGRATED-TO-POSTGRES (when, and what): the
     MCP server in file mode refuses to answer while it exists. Going back to STORAGE_BACKEND=file
     means deleting it.

   Exit status: 0 migrated (or would be, with --dry-run) and verified; 1 refused or failed; 2 usage. */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { atomicWrite } from '../durable.js';
import { migrate } from '../store/migrate.js';
import { encodeAll, diffRows, readAccounts, refuses, types, STATE_COLUMNS, LOCK_KEY } from '../store/pg.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const MARKER = 'MIGRATED-TO-POSTGRES';

// Every collection db.json holds, by its table (store/pg.js).
const COLLECTIONS = { users: 'users', credentials: 'creds', invites: 'invites', push_subscriptions: 'subs', device_links: 'deviceLinks' };
const UNSTORABLE = 'holds a NUL character (U+0000) or a lone surrogate, which Postgres cannot store';

// Why the migration did not (or would not) go ahead: said as it is, no stack.
export class MigrationRefused extends Error {
  constructor(message) { super(message); this.name = 'MigrationRefused'; }
}

// db.json as the file backend's loadDb has it: every collection an array, whatever an older
// db.json left out.
function normalize(db) {
  return { ...db, users: db.users || [], creds: db.creds || [], subs: db.subs || [], invites: db.invites || [], deviceLinks: db.deviceLinks || [] };
}

// What user_state's rev, wid and wids are for a document (STATE_COLUMNS, in JavaScript).
function stateColumns(S) {
  return {
    rev: typeof S._rev === 'number' && /^[0-9]{1,15}$/.test(JSON.stringify(S._rev)) ? S._rev : 0,
    wid: typeof S._wid === 'string' ? S._wid : null,
    wids: Array.isArray(S._wids) ? S._wids : []
  };
}

// db.json, or with fromBak db.json.bak when db.json cannot be read. → { db, source }
function readDb(dir, fromBak) {
  const parse = file => {
    const v = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  };
  try { return { db: normalize(parse('db.json')), source: 'db.json' }; }
  catch (e) {
    const why = e.code === 'ENOENT' ? `there is no db.json in ${dir}` : `db.json cannot be read (${e.message})`;
    if (!fromBak) throw new MigrationRefused(`${why}. Check DATA_DIR; to migrate db.json.bak instead, run again with --from-bak.`);
    try { return { db: normalize(parse('db.json.bak')), source: 'db.json.bak' }; }
    catch (e2) { throw new MigrationRefused(`${why}, and db.json.bak cannot be read either (${e2.message}).`); }
  }
}

// Every way db.json cannot go into the tables as it is, all at once.
function dbProblems(db) {
  const problems = [];
  try { encodeAll(db); } catch (e) { problems.push(e.message); }
  const uids = new Set(db.users.map(u => u?.id));
  for (const [coll, key] of [['users', 'id'], ['creds', 'id'], ['subs', 'endpoint'], ['invites', 'code'], ['deviceLinks', 'h']]) {
    if (!Array.isArray(db[coll])) continue;
    db[coll].forEach((rec, i) => {
      const name = `db.${coll}[${i}] (${rec?.[key]})`;
      if (refuses(rec)) problems.push(`${name} ${UNSTORABLE}`);
      if (coll !== 'users' && coll !== 'invites' && rec && !uids.has(rec.userId)) problems.push(`${name} belongs to profile ${rec.userId}, which is not in db.users`);
    });
  }
  for (const [key, value] of Object.entries(db)) {
    if (!Object.values(COLLECTIONS).includes(key) && refuses({ [key]: value })) problems.push(`db.${key} ${UNSTORABLE}`);
  }
  return problems;
}

// Every state-<uid>.json, matched to its profile the way the API names the file. → { states:
// Map uid → doc, texts: Map uid → JSON, skipped: [{ file, uid?, reason }] }
function readStates(dir, db) {
  const byFile = new Map(db.users.map(u => ['state-' + String(u.id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json', u.id]));
  const states = new Map(), texts = new Map(), skipped = [];
  for (const file of fs.readdirSync(dir).filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f)).sort()) {
    const uid = byFile.get(file);
    if (uid === undefined) { skipped.push({ file, reason: 'no profile in db.json has this id' }); continue; }
    let S;
    try { S = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) { skipped.push({ file, uid, reason: `cannot be read (${e.message})` }); continue; }
    if (!S || typeof S !== 'object' || Array.isArray(S)) { skipped.push({ file, uid, reason: `is not a training document (${Array.isArray(S) ? 'an array' : JSON.stringify(S)})` }); continue; }
    if (refuses(S)) { skipped.push({ file, uid, reason: UNSTORABLE }); continue; }
    let text;
    try { text = JSON.stringify(S); } catch (e) { skipped.push({ file, uid, reason: `cannot be serialised (${e.message})` }); continue; }
    states.set(uid, S);
    texts.set(uid, text);
  }
  return { states, texts, skipped };
}

/* What differs between the source and the database `client` sees, as one sentence per difference;
   [] when nothing does. `source` is { db, states: Map uid → doc, keep: uids whose stored document
   is left as it is (its file was skipped) }. */
export async function verify(client, { db, states, keep = [] }) {
  db = normalize(db);
  const problems = [];
  const rows = encodeAll(db);
  const expected = Object.fromEntries(Object.keys(COLLECTIONS).map(t => [t, rows.get(t).size]));
  expected.db_extra = rows.get('db_extra').size;
  expected.user_state = states.size + keep.length;
  for (const [table, n] of Object.entries(expected)) {
    const got = +(await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count;
    if (got !== n) problems.push(`${table}: ${got} rows, the source has ${n}`);
  }

  const stored = await readAccounts(client);
  for (const [table, coll] of Object.entries(COLLECTIONS)) {
    const a = stored[coll], b = db[coll];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (!isDeepStrictEqual(a[i], b[i])) { problems.push(`accounts: ${table} row ${i} differs from db.${coll}[${i}]`); break; }
    }
  }
  for (const key of new Set([...Object.keys(stored), ...Object.keys(db)])) {
    if (Object.values(COLLECTIONS).includes(key)) continue;
    if (!isDeepStrictEqual(stored[key], db[key])) problems.push(`accounts: db_extra ${key} differs from db.${key}`);
  }

  const docs = new Map((await client.query('SELECT uid, rev, wid, wids, doc FROM user_state WHERE uid = ANY($1::text[])', [[...states.keys()]])).rows.map(r => [r.uid, r]));
  for (const [uid, S] of states) {
    const row = docs.get(uid);
    if (!row) { problems.push(`${uid}: no document stored`); continue; }
    if (!isDeepStrictEqual(row.doc, S)) problems.push(`${uid}: the stored document differs from its state file`);
    const want = stateColumns(S);
    if (row.rev !== want.rev) problems.push(`${uid}: rev is ${row.rev}, the document's _rev gives ${want.rev}`);
    if (row.wid !== want.wid) problems.push(`${uid}: wid is ${row.wid}, the document's _wid gives ${want.wid}`);
    if (!isDeepStrictEqual(row.wids, want.wids)) problems.push(`${uid}: wids differ from the document's _wids`);
  }
  return problems;
}

const INSERT_STATE = `INSERT INTO user_state (uid, rev, wid, wids, doc) SELECT $1, ${STATE_COLUMNS} FROM (SELECT $2::jsonb AS d) s`;
const UPDATE_STATE = `UPDATE user_state SET (rev, wid, wids, doc, updated_at) = (SELECT ${STATE_COLUMNS}, now() FROM (SELECT $2::jsonb AS d) s) WHERE uid = $1`;
const DELETE_STATES = 'DELETE FROM user_state WHERE uid = ANY($1::text[])';

/* The migration. → { source, counts, skipped, writes: { insert, update, delete }, verified, dryRun }.
   Throws MigrationRefused for every reason it did not go ahead; then nothing was committed. */
export async function migrateJsonToPg({ dir = process.env.DATA_DIR || '/data', url = process.env.DATABASE_URL, dryRun = false, fromBak = false, replace = false, log = console.log } = {}) {
  if (!url) throw new MigrationRefused('DATABASE_URL is not set: say which database to migrate into.');
  const { db, source } = readDb(dir, fromBak);
  const problems = dbProblems(db);
  if (problems.length) throw new MigrationRefused(`${source} cannot be stored as it is; fix it first:\n  ${problems.join('\n  ')}`);
  const { states, texts, skipped } = readStates(dir, db);
  const rows = encodeAll(db);
  const counts = Object.fromEntries(Object.keys(COLLECTIONS).map(t => [t, rows.get(t).size]));
  counts.db_extra = rows.get('db_extra').size;
  counts.user_state = states.size;

  log(`Source: ${path.join(dir, source)}`);
  for (const [table, n] of Object.entries(counts)) log(`  ${table.padEnd(20)}${String(n).padStart(6)}`);
  for (const s of skipped) log(`Skipped ${s.file}: ${s.reason}`);

  const client = new pg.Client({ connectionString: url, types });
  await client.connect();
  try {
    // Held until the client ends: no API can start on this database meanwhile, and none is running.
    const { rows: [lock] } = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok, current_schema() AS schema`);
    if (!lock.ok) throw new MigrationRefused(`a kuch-api is running on this database (schema ${lock.schema}): stop the API first.`);
    const applied = await migrate(client, MIGRATIONS);
    if (applied.length) log(`Database: applied schema migrations ${applied.join(', ')}`);

    await client.query('BEGIN');
    try {
      // The accounts: what the tables hold now → what db.json holds.
      const ops = diffRows(encodeAll(await readAccounts(client)), rows);
      // The documents: a skipped file's stored document stays; one whose file is gone goes,
      // unless its profile does, which takes it along.
      const skippedUids = new Set(skipped.map(s => s.uid).filter(Boolean));
      const users = new Set(db.users.map(u => u.id));
      const existing = (await client.query('SELECT uid FROM user_state')).rows.map(r => r.uid);
      const keep = existing.filter(uid => skippedUids.has(uid) && users.has(uid));
      for (const [uid, text] of texts) {
        if (!existing.includes(uid)) ops.push({ kind: 'insert', table: 'user_state', key: uid, sql: INSERT_STATE, params: [uid, text] });
        else if (!(await client.query('SELECT doc = $2::jsonb AS same FROM user_state WHERE uid = $1', [uid, text])).rows[0].same) {
          ops.push({ kind: 'update', table: 'user_state', key: uid, sql: UPDATE_STATE, params: [uid, text] });
        }
      }
      const gone = existing.filter(uid => !texts.has(uid) && !skippedUids.has(uid) && users.has(uid));
      if (gone.length) ops.push({ kind: 'delete', table: 'user_state', key: gone.join(', '), sql: DELETE_STATES, params: [gone] });

      const writes = { insert: 0, update: 0, delete: 0 };
      for (const op of ops) writes[op.kind] += op.kind === 'delete' ? op.params[0].length : 1;
      log(`Writes: ${writes.insert} inserted, ${writes.update} updated, ${writes.delete} deleted`);

      if (writes.update || writes.delete) {
        const what = [...new Set(ops.filter(o => o.kind !== 'insert').map(o => o.table))].join(', ');
        if (fs.existsSync(path.join(dir, MARKER))) {
          throw new MigrationRefused(`the database already differs from the files (${what}) and ${MARKER} is in ${dir}: the API may have run on Postgres since, ` +
            `and its data would be replaced by the files' older copy. Nothing was written. If you went back to STORAGE_BACKEND=file, delete ${MARKER} first.`);
        }
        if (!replace) {
          throw new MigrationRefused(`the database already holds data that differs from the files (${what}). Nothing was written. ` +
            'Run again with --replace to make it match the files: rows the files do not have are deleted.');
        }
      }

      let op = null;
      try { for (op of ops) await client.query(op.sql, op.params); }
      catch (e) { throw new MigrationRefused(`the database refused ${op.table} ${op.key}: ${e.message}${e.detail ? ` (${e.detail})` : ''}. Nothing was written.`); }

      const wrong = await verify(client, { db, states, keep });
      if (wrong.length) throw new MigrationRefused(`verification failed, nothing was written:\n  ${wrong.join('\n  ')}`);
      log('Verified: every row count matches the files, every account and document deep-equals its file, rev and wid match.');

      if (dryRun) {
        await client.query('ROLLBACK');
        log('Dry run: rolled back, nothing was written.');
      } else {
        await client.query('COMMIT');
        const skips = skipped.length ? `; skipped ${skipped.length} state file${skipped.length === 1 ? '' : 's'} (${skipped.map(s => s.file).join(', ')})` : '';
        atomicWrite(path.join(dir, MARKER), [
          `The data in this folder was migrated to PostgreSQL at ${new Date().toISOString()} (api/scripts/migrate-json-to-pg.mjs, from ${source}).`,
          `${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ')}${skips}.`,
          'With STORAGE_BACKEND=postgres the API no longer writes the JSON files here, and the MCP server in file mode',
          'refuses to answer while this file exists. Going back to STORAGE_BACKEND=file: delete this file (docs/POSTGRES_MIGRATION.md).',
          ''].join('\n'), 0o600);
        log(`Committed. Wrote ${path.join(dir, MARKER)}.`);
      }
      return { source, counts, skipped, writes, verified: true, dryRun };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const USAGE = `usage: DATA_DIR=/data DATABASE_URL=postgres://… node scripts/migrate-json-to-pg.mjs [--dry-run] [--from-bak] [--replace]

  --dry-run   migrate and verify inside a transaction, print the counts, roll back
  --from-bak  use db.json.bak when db.json cannot be read
  --replace   let the run update and delete rows the database holds that differ from the files`;

async function main(argv) {
  const flags = { '--dry-run': 'dryRun', '--from-bak': 'fromBak', '--replace': 'replace' };
  const opts = {};
  for (const a of argv) {
    if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    if (!flags[a]) { console.error(`unknown option ${a}\n${USAGE}`); return 2; }
    opts[flags[a]] = true;
  }
  try { await migrateJsonToPg(opts); return 0; }
  catch (e) {
    console.error(e instanceof MigrationRefused ? `Refused: ${e.message}` : e);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
