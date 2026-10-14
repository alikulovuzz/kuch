/* The JSON-to-Postgres migration (scripts/migrate-json-to-pg.mjs), against a real database: a
   fresh schema per test (pg-helpers.mjs) and a data/ folder written here. Skipped without
   DATABASE_URL_TEST. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { openStore } from '../store/index.js';
import { types } from '../store/pg.js';
import { migrateJsonToPg, verify, MigrationRefused } from '../scripts/migrate-json-to-pg.mjs';
import { NO_PG, freshSchema } from './pg-helpers.mjs';

const MARKER = 'MIGRATED-TO-POSTGRES';

// A db.json with something in every collection, a field no column is for, a key nobody knows,
// and a collection missing (old instances have no deviceLinks).
function sampleDb() {
  return {
    users: [
      { id: 'u_a', name: 'Ann', created: '2026-01-01T00:00:00.000Z', admin: true, sv: 2, lastPull: 1760000000123, email: 'ann@example.com' },
      { id: 'u_b', name: 'Bo', created: '2026-01-02T00:00:00.000Z', pw: { h: 'scrypt$x', set: '2026-01-02T00:00:00.000Z' }, favourite: 'teal' },
      { id: 'u_c', name: 'Cy', created: '2026-01-03T00:00:00.000Z' }
    ],
    creds: [{ id: 'cred-1', userId: 'u_a', publicKey: 'pk1', counter: 7, transports: ['internal'], created: '2026-01-01T00:00:00.000Z' }],
    subs: [{ userId: 'u_a', endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' }, created: '2026-02-01T00:00:00.000Z' }],
    invites: [{ code: 'INV1', note: '', createdBy: 'u_a', created: '2026-01-01T00:00:00.000Z', usedBy: 'u_b', usedAt: '2026-01-02T00:00:00.000Z', revoked: false }],
    settings: { theme: 'dark' }
  };
}
const stateOf = (uid, rev, extra = {}) => ({ _rev: rev, _wid: 'w-' + uid + '-' + rev, _wids: ['w-' + uid + '-' + rev], routines: [{ id: 'r1', name: 'Push' }], workouts: [], ...extra });

// → { dir, write(name, value|text), hashes() }: a data/ folder with db.json and a state per user.
function dataDir(t, { db = sampleDb(), states = { u_a: stateOf('u_a', 5), u_b: stateOf('u_b', 1, { _wid: undefined, _wids: undefined }) } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuch-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  write('db.json', db);
  for (const [uid, S] of Object.entries(states)) write(`state-${uid}.json`, S);
  const hashes = () => Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.json') || f.endsWith('.bak'))
    .map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));
  return { dir, write, hashes };
}

// The migration with its output kept, not printed.
async function run(data, pgs, opts = {}) {
  const lines = [];
  const report = await migrateJsonToPg({ dir: data.dir, url: pgs.url, log: l => lines.push(l), ...opts });
  return { report, out: lines.join('\n') };
}

// What the API would load from the database.
async function loaded(t, pgs) {
  const store = openStore({ backend: 'postgres', url: pgs.url });
  t.after(() => store.close());
  const db = await store.loadDb();
  const states = {};
  for (const uid of await store.listStateUids()) states[uid] = await store.readStateStrict(uid);
  await store.close();
  return { db, states };
}

const count = async (pgs, table) => +(await pgs.query(`SELECT count(*) FROM ${table}`)).rows[0].count;

test('a migration stores every account and document, verifies them and leaves the JSON files untouched', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  const before = data.hashes();

  const { report, out } = await run(data, pgs);
  assert.equal(report.verified, true);
  assert.deepEqual(report.counts, { users: 3, credentials: 1, invites: 1, push_subscriptions: 1, device_links: 0, db_extra: 1, user_state: 2 });
  assert.match(out, /verified/i);

  const { db, states } = await loaded(t, pgs);
  assert.deepEqual(db, { ...sampleDb(), deviceLinks: [] });
  assert.deepEqual(states, { u_a: stateOf('u_a', 5), u_b: JSON.parse(JSON.stringify(stateOf('u_b', 1, { _wid: undefined, _wids: undefined }))) });
  const cols = (await pgs.query('SELECT uid, rev::int AS rev, wid, wids FROM user_state ORDER BY uid')).rows;
  assert.deepEqual(cols, [{ uid: 'u_a', rev: 5, wid: 'w-u_a-5', wids: ['w-u_a-5'] }, { uid: 'u_b', rev: 1, wid: null, wids: [] }]);

  const marker = fs.readFileSync(path.join(data.dir, MARKER), 'utf8');
  assert.match(marker, /\d{4}-\d\d-\d\dT/, 'the marker says when');
  assert.match(marker, /3 users/, 'and what');
  assert.deepEqual(data.hashes(), before, 'no JSON file changed');
});

test('running it again changes nothing', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  await run(data, pgs);
  // xmin is the transaction that last wrote a row: an untouched row keeps it.
  const versions = async () => (await pgs.query(`SELECT 'users' AS t, id AS k, xmin::text AS x FROM users
    UNION ALL SELECT 'state', uid, xmin::text FROM user_state UNION ALL SELECT 'extra', key, xmin::text FROM db_extra ORDER BY 1, 2`)).rows;
  const before = await versions();

  const { report } = await run(data, pgs);
  assert.equal(report.verified, true);
  assert.deepEqual(report.writes, { insert: 0, update: 0, delete: 0 });
  assert.deepEqual(await versions(), before, 'no row was written again');
});

test('--dry-run reports what it would write, verifies it, and commits nothing', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  const { report, out } = await run(data, pgs, { dryRun: true });
  assert.equal(report.verified, true);
  assert.equal(report.counts.users, 3);
  assert.equal(report.writes.insert, 3 + 1 + 1 + 1 + 1 + 2);
  assert.match(out, /dry run/i);
  assert.match(out, /users\s+3/);
  for (const table of ['users', 'credentials', 'invites', 'push_subscriptions', 'db_extra', 'user_state']) assert.equal(await count(pgs, table), 0, table);
  assert.ok(!fs.existsSync(path.join(data.dir, MARKER)), 'no marker');
});

test('an unreadable state file is reported and skipped, never fabricated', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  data.write('state-u_b.json', '{"_rev": 3, "workouts": [');          // a write cut short
  data.write('state-u_c.json', '[]');                                  // not a document
  data.write('state-u_gone.json', stateOf('u_gone', 1));               // no such profile
  data.write('state-u_c.json.tmp', 'ignored');                         // not a state file at all
  const before = data.hashes();

  const { report, out } = await run(data, pgs);
  assert.equal(report.verified, true);
  assert.deepEqual(report.skipped.map(s => s.file).sort(), ['state-u_b.json', 'state-u_c.json', 'state-u_gone.json']);
  for (const f of ['state-u_b.json', 'state-u_c.json', 'state-u_gone.json']) assert.match(out, new RegExp(f.replace('.', '\\.')));
  assert.equal(report.counts.user_state, 1);
  assert.deepEqual((await pgs.query('SELECT uid FROM user_state')).rows, [{ uid: 'u_a' }], 'only the readable one, nothing made up');
  assert.deepEqual(data.hashes(), before, 'the unreadable files are left as they are');
  assert.match(fs.readFileSync(path.join(data.dir, MARKER), 'utf8'), /skipped 3/);
});

test('a document Postgres cannot store is skipped with the reason', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  data.write('state-u_b.json', stateOf('u_b', 2, { note: 'a\u0000b' }));
  const { report } = await run(data, pgs);
  assert.equal(report.verified, true);
  assert.deepEqual(report.skipped.map(s => s.file), ['state-u_b.json']);
  assert.match(report.skipped[0].reason, /NUL|surrogate/);
  assert.equal(await count(pgs, 'user_state'), 1);
});

test('verification finds every difference between the files and the database', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  await run(data, pgs);
  const source = { db: sampleDb(), states: new Map([['u_a', stateOf('u_a', 5)], ['u_b', JSON.parse(JSON.stringify(stateOf('u_b', 1, { _wid: undefined, _wids: undefined })))]]) };
  const check = async () => {
    const client = new pg.Client({ connectionString: pgs.url, types });   // BIGINT as numbers, as the script reads
    await client.connect();
    try { return await verify(client, source); } finally { await client.end(); }
  };
  assert.deepEqual(await check(), []);

  await pgs.query("UPDATE users SET name = 'Anne' WHERE id = 'u_a'");
  await pgs.query("INSERT INTO invites (code, pos) VALUES ('EXTRA', 9)");
  await pgs.query("UPDATE user_state SET doc = jsonb_set(doc, '{routines}', '[]') WHERE uid = 'u_a'");
  await pgs.query("UPDATE user_state SET wid = 'other' WHERE uid = 'u_b'");
  const problems = (await check()).join('\n');
  assert.match(problems, /invites: 2 rows, the source has 1/);
  assert.match(problems, /accounts/);
  assert.match(problems, /u_a.*document/);
  assert.match(problems, /u_b.*wid/);
});

test('a document the database would change fails verification and nothing is committed', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  data.write('state-u_a.json', '{"_rev": 5, "big": 1e400}');   // JSON.parse gives Infinity, which JSONB cannot hold
  await assert.rejects(run(data, pgs), err => err instanceof MigrationRefused && /verif/i.test(err.message) && /u_a/.test(err.message));
  assert.equal(await count(pgs, 'users'), 0, 'rolled back');
  assert.ok(!fs.existsSync(path.join(data.dir, MARKER)));
});

test('a database that already differs from the files is replaced only with --replace', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  await run(data, pgs);
  // Back to the files (the marker is deleted, as the rollback steps say) and changed there.
  fs.unlinkSync(path.join(data.dir, MARKER));
  const db = sampleDb();
  db.users = db.users.filter(u => u.id !== 'u_c');
  db.users[0].name = 'Anne';
  data.write('db.json', db);
  data.write('state-u_a.json', stateOf('u_a', 6));

  await assert.rejects(run(data, pgs), err => err instanceof MigrationRefused && /--replace/.test(err.message));
  assert.equal(await count(pgs, 'users'), 3, 'nothing written');

  const { report } = await run(data, pgs, { replace: true });
  assert.equal(report.verified, true);
  assert.deepEqual(report.writes, { insert: 0, update: 2, delete: 1 });
  const { db: now, states } = await loaded(t, pgs);
  assert.deepEqual(now, { ...db, deviceLinks: [] });
  assert.equal(states.u_a._rev, 6);
});

test('while MIGRATED-TO-POSTGRES exists, a database that differs is never overwritten', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  await run(data, pgs);
  const db = sampleDb();
  db.users[0].name = 'Stale';
  data.write('db.json', db);
  await assert.rejects(run(data, pgs, { replace: true }), err => err instanceof MigrationRefused && new RegExp(MARKER).test(err.message));
  assert.deepEqual((await pgs.query("SELECT name FROM users WHERE id = 'u_a'")).rows, [{ name: 'Ann' }]);
});

test('db.json.bak is read only with --from-bak, and only when db.json cannot be', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const data = dataDir(t);
  data.write('db.json.bak', sampleDb());
  data.write('db.json', '{"users": [');
  await assert.rejects(run(data, pgs), err => err instanceof MigrationRefused && /--from-bak/.test(err.message));
  fs.unlinkSync(path.join(data.dir, 'db.json'));
  await assert.rejects(run(data, pgs), err => err instanceof MigrationRefused && /db\.json/.test(err.message), 'a missing db.json is not an empty instance');

  const { report, out } = await run(data, pgs, { fromBak: true });
  assert.equal(report.verified, true);
  assert.equal(report.source, 'db.json.bak');
  assert.match(out, /db\.json\.bak/);
  assert.equal(await count(pgs, 'users'), 3);
});

test('a db.json the database cannot hold is refused before anything is written', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const db = sampleDb();
  db.creds.push({ id: 'cred-x', userId: 'u_nobody', publicKey: 'pk' });
  db.users[2].name = 'C\u0000y';
  const data = dataDir(t, { db });
  await assert.rejects(run(data, pgs), err => err instanceof MigrationRefused && /cred-x/.test(err.message) && /u_nobody/.test(err.message) && /u_c/.test(err.message));
  assert.equal((await pgs.query("SELECT to_regclass('users') AS t")).rows[0].t, null, 'the database was not even touched');
});

test('it refuses to run while an API is using the database', { skip: NO_PG }, async t => {
  const pgs = await freshSchema(t);
  const api = openStore({ backend: 'postgres', url: pgs.url });
  t.after(() => api.close());
  await api.loadDb();                       // started: holds the single-instance lock
  const data = dataDir(t);
  await assert.rejects(run(data, pgs), err => err instanceof MigrationRefused && /stop the API/i.test(err.message));
  assert.equal(await count(pgs, 'users'), 0);
});
