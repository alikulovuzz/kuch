/* server.js on the Postgres backend (STORAGE_BACKEND=postgres), as a child process against a
   fresh schema (pg-helpers.mjs): sync, the conflict a stale device gets, the document Postgres
   cannot hold, health, an admin delete, and the two ways startup refuses. The rest of the suite
   runs on the file backend; running all of it on both is the dual-backend harness's job.
   Skipped without DATABASE_URL_TEST. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { NO_PG, PG_URL, freshSchema } from './pg-helpers.mjs';
import { openStore } from '../store/index.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: ORIGIN });
const ADMIN = 'u_adm', ONE = 'u_one';

function spawnServer(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-pg-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const child = spawn(process.execPath, ['--no-deprecation', 'server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', STORAGE_BACKEND: 'postgres', ...env }
  });
  const h = { child, dataDir, log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  h.exited = new Promise(r => child.once('exit', code => r(code)));
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return h;
}

// A schema with two profiles saved (and the rows `more` adds to db), and a server on it.
async function startServer(t, more = {}) {
  const pg = await freshSchema(t);
  const seed = openStore({ backend: 'postgres', url: pg.url });
  const db = await seed.loadDb();
  db.users.push({ id: ADMIN, name: 'Admin', created: new Date().toISOString(), admin: true },
    { id: ONE, name: 'One', created: new Date().toISOString() });
  db.creds.push({ id: 'c-one', userId: ONE, publicKey: 'x', counter: 0, transports: [] });
  for (const [coll, rows] of Object.entries(more)) (db[coll] ||= []).push(...rows);
  await seed.saveDb(db);
  await seed.close();

  const h = spawnServer(t, { DATABASE_URL: pg.url });
  h.pg = pg;
  h.port = await boundPort(h.child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.req = async (method, p, { uid = ONE, body } = {}) => {
    const r = await fetch(h.api + p, { method, headers: as(uid), ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  h.put = (state, extra = {}) => h.req('PUT', '/api/data', { body: { state, stamped: true, ...extra } });
  return h;
}

test('a profile syncs through Postgres, and a stale device gets the 409 with the current document', { skip: NO_PG }, async t => {
  const h = await startServer(t);
  assert.deepEqual((await h.req('GET', '/api/data')).body, { state: null, rev: 0 });

  const first = await h.put({ unit: 'kg', workouts: [], routines: [] });
  assert.equal(first.status, 200);
  assert.equal(first.body.rev, 1);
  assert.deepEqual((await h.req('GET', '/api/data/rev')).body, { rev: 1, wid: first.body.wid });

  const second = await h.put({ unit: 'lb', workouts: [], routines: [] }, { baseRev: 1, baseWid: first.body.wid });
  assert.equal(second.status, 200);
  assert.equal(second.body.rev, 2);
  const got = (await h.req('GET', '/api/data')).body;
  assert.equal(got.rev, 2);
  assert.equal(got.state.unit, 'lb');
  assert.deepEqual(got.state._wids, [first.body.wid]);

  // The device that only saw revision 1.
  const stale = await h.put({ unit: 'st', workouts: [], routines: [] }, { baseRev: 1, baseWid: first.body.wid });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 2);
  assert.equal(stale.body.state.unit, 'lb');

  // What the table holds beside the document mirrors it.
  const row = (await h.pg.query('SELECT rev, wid, wids FROM user_state WHERE uid = $1', [ONE])).rows[0];
  assert.deepEqual(row, { rev: '2', wid: second.body.wid, wids: [first.body.wid] });
});

test('two devices pushing over the same revision at once: one 200, one 409 carrying the winner', { skip: NO_PG }, async t => {
  const h = await startServer(t);
  const base = (await h.put({ unit: 'kg', workouts: [], routines: [] })).body;
  for (let round = 0; round < 5; round++) {
    const cur = (await h.req('GET', '/api/data')).body;
    const wid = (await h.req('GET', '/api/data/rev')).body.wid;
    const [a, b] = await Promise.all(['a', 'b'].map(d =>
      h.put({ unit: 'kg', device: d, workouts: [], routines: [] }, { baseRev: cur.rev, baseWid: wid })));
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}`);
    const [win, lose] = a.status === 200 ? ['a', b] : ['b', a];
    assert.equal(lose.body.state.device, win);
  }
  assert.ok(base.rev);
});

test('a document with a NUL character is a bad request, and nothing is stored', { skip: NO_PG }, async t => {
  const h = await startServer(t);
  const res = await h.put({ unit: 'kg', note: 'a\u0000b', workouts: [], routines: [] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /NUL character/);
  assert.equal((await h.req('GET', '/api/data/rev')).body.rev, 0);
});

// Anything that lands in memory is in every later save until it leaves, so a string Postgres
// refuses (U+0000; a lone surrogate) must be turned away before a route changes `db`: let in, it
// would fail every save on the instance, for everyone, until a restart.
test('text Postgres cannot store is refused at the door, and saving keeps working', { skip: NO_PG }, async t => {
  const h = await startServer(t);
  const sub = await h.req('POST', '/api/push/subscribe', {
    body: { subscription: { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: 'p', auth: 'a\u0000' } } } });
  assert.equal(sub.status, 400);
  const note = await h.req('POST', '/api/admin/invites/new', { uid: ADMIN, body: { note: 'half \ud800 a pair' } });
  assert.equal(note.status, 400);
  // An escaped backslash before "u0000" is ordinary text.
  const ok = await h.req('POST', '/api/admin/invites/new', { uid: ADMIN, body: { note: 'C:\\u0000 \ud83d\ude00' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await h.pg.query('SELECT note FROM invites')).rows, [{ note: 'C:\\u0000 \ud83d\ude00' }]);
});

test('health reports the database', { skip: NO_PG }, async t => {
  const h = await startServer(t);
  const res = await fetch(`${h.api}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, users: 2, writable: true, database: 'ok' });
});

test('deleting a profile removes every row it owns, and still removes its uploads and Coach credential', { skip: NO_PG }, async t => {
  const created = new Date().toISOString();
  const h = await startServer(t, {
    subs: [{ userId: ONE, endpoint: 'https://push.example.com/one', keys: { p256dh: 'p', auth: 'a' }, created },
      { userId: ADMIN, endpoint: 'https://push.example.com/admin', keys: { p256dh: 'p', auth: 'a' }, created }],
    deviceLinks: [{ h: 'd'.repeat(64), userId: ONE, exp: Date.now() + 600000, created: Date.now() }]
  });
  await h.put({ unit: 'kg', workouts: [], routines: [] });
  fs.mkdirSync(path.join(h.dataDir, 'uploads', ONE), { recursive: true });
  fs.writeFileSync(path.join(h.dataDir, 'uploads', ONE, 'photo'), 'x');
  fs.writeFileSync(path.join(h.dataDir, `coach-auth-${ONE}.json`), '{}');

  const res = await h.req('POST', '/api/admin/user/delete', { uid: ADMIN, body: { id: ONE } });
  assert.equal(res.status, 200);
  const count = async table => (await h.pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'users' ? 'id' : table === 'user_state' ? 'uid' : 'user_id'} = $1`, [ONE])).rows[0].n;
  for (const table of ['users', 'credentials', 'push_subscriptions', 'device_links', 'user_state']) {
    assert.equal(await count(table), 0, table);
  }
  assert.deepEqual((await h.pg.query('SELECT user_id FROM push_subscriptions')).rows, [{ user_id: ADMIN }], 'the admin keeps theirs');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'uploads', ONE)), false);
  assert.equal(fs.existsSync(path.join(h.dataDir, `coach-auth-${ONE}.json`)), false);
  assert.equal((await h.req('GET', '/api/data')).status, 401, 'their session is over');
});

test('a second server on the same database refuses to start', { skip: NO_PG }, async t => {
  const h = await startServer(t);
  const second = spawnServer(t, { DATABASE_URL: h.pg.url });
  assert.equal(await second.exited, 1);
  assert.match(second.log, /another kuch-api owns this database/);
});

// A port nothing listens on, for now.
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('a database that never answers is retried for DB_WAIT_MS, then stops the server, saying so', async t => {
  const port = await freePort();
  const started = Date.now();
  const h = spawnServer(t, { DATABASE_URL: `postgres://kuch:x@127.0.0.1:${port}/kuch`, DB_WAIT_MS: '1500' });
  assert.equal(await h.exited, 1);
  assert.ok(Date.now() - started >= 1500, 'it waited the time it was given');
  assert.ok((h.log.match(/database not reachable yet/g) || []).length >= 2, `every retry is logged:\n${h.log}`);
  assert.match(h.log, /kuch-api cannot start: cannot reach the database/);
  assert.doesNotMatch(h.log, /kuch-api on :/);
});

// A database that comes up while the server waits (a container started alongside it): the server
// starts once it answers. It "comes up" as a proxy to the real one opening on the port the server
// was given; a URL on that other port needs its password, which pgpass does not cover.
const noPassword = PG_URL && !new URL(PG_URL).password && 'DATABASE_URL_TEST has no password, and pgpass does not cover the proxy port';
test('a database that comes up during the wait is used: the server starts and serves', { skip: NO_PG || noPassword }, async t => {
  const pg = await freshSchema(t);
  const port = await freePort();
  const url = new URL(pg.url);
  const target = { host: url.hostname, port: +url.port || 5432 };
  url.hostname = '127.0.0.1';
  url.port = String(port);
  const h = spawnServer(t, { DATABASE_URL: url.toString(), DB_WAIT_MS: '30000' });
  while (!/database not reachable yet/.test(h.log) && h.child.exitCode === null) await new Promise(r => setTimeout(r, 50));

  const sockets = new Set();
  const proxy = net.createServer(client => {
    const up = net.connect(target);
    for (const s of [client, up]) { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); }
    client.pipe(up).pipe(client);
  });
  await new Promise(r => proxy.listen(port, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); proxy.close(); });

  const api = `http://127.0.0.1:${await boundPort(h.child, () => h.log)}`;
  const health = await fetch(`${api}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).database, 'ok');
  assert.match(h.log, /database: applied migrations 001_init/);
});
