/* The Postgres backend of the storage interface (store/pg.js), against a real database: a fresh
   schema per test (pg-helpers.mjs). Skipped without DATABASE_URL_TEST. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../store/index.js';
import { createPgStore } from '../store/pg.js';
import { NO_PG, freshSchema } from './pg-helpers.mjs';

async function open(t, url) {
  const store = openStore({ backend: 'postgres', url });
  t.after(() => store.close());
  return store;
}

test('a new database is migrated and starts with no accounts', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  assert.deepEqual(await store.loadDb(), { users: [], creds: [], subs: [], invites: [], deviceLinks: [] });
  const applied = (await pg.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
  assert.deepEqual(applied, ['001_init']);
});

// Everything a db.json can hold, including what no column is for: fields the code never wrote,
// values of the wrong type, explicit nulls, a top-level key nobody knows. Arrays out of key order.
function richDb() {
  return {
    users: [
      { id: 'u_z', name: 'Zed', created: '2026-01-02T03:04:05.000Z', admin: true, sv: 3, lastPull: 1760000000123,
        lastReminder: '2026-10-01', lastNudge: '2026-10-02', pw: { h: 'scrypt$x', set: '2026-01-02T03:04:05.000Z' },
        pwReset: { h: 'r', exp: 1760000999000, by: 'u_a' }, email: 'zed@example.com', invitedBy: 'INV1' },
      { id: 'u_a', name: 'Ann', created: '2026-01-01T00:00:00.000Z', disabled: false, admin: null, sv: 1.5,
        lastPull: '17', favourite: { colour: 'teal' }, email: null }
    ],
    creds: [
      { id: 'cred-2', userId: 'u_a', publicKey: 'pk2', counter: 0, transports: [], created: '2026-01-01T00:00:00.000Z' },
      { id: 'cred-1', userId: 'u_z', publicKey: 'pk1', counter: 42, transports: ['internal', 'hybrid'],
        created: '2026-01-02T03:04:05.000Z', lastUsed: '2026-10-10T10:10:10.000Z', name: 'Phone' }
    ],
    subs: [
      { userId: 'u_z', endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' }, deviceId: 'd1', created: '2026-02-01T00:00:00.000Z' },
      { userId: 'u_z', endpoint: 'https://push.example/a', keys: { p256dh: 'p2', auth: 'a2' }, created: '2026-02-02T00:00:00.000Z' }
    ],
    invites: [
      { code: 'INV2', note: '', createdBy: 'u_z', created: '2026-03-01T00:00:00.000Z' },
      { code: 'INV1', note: 'for Zed', createdBy: 'u_gone', created: '2026-01-01T00:00:00.000Z', usedBy: 'u_z', usedAt: '2026-01-02T03:04:05.000Z', revoked: true }
    ],
    deviceLinks: [{ h: 'f'.repeat(64), userId: 'u_a', exp: 1760000600000, created: 1760000000000 }],
    settings: { theme: 'dark', n: [1, 2] },
    legacyFlag: null
  };
}

test('what saveDb stores, loadDb gives back exactly, in another process', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const a = await open(t, pg.url);
  const db = await a.loadDb();
  Object.assign(db, richDb());
  await a.saveDb(db);
  await a.close();

  const b = await open(t, pg.url);
  assert.deepEqual(await b.loadDb(), richDb());
});

test('a save writes only the rows that changed, and removes what is gone with what it owned', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  const db = await store.loadDb();
  Object.assign(db, richDb());
  await store.saveDb(db);
  // xmin is the transaction that last wrote a row: an untouched row keeps it.
  const versions = async () => Object.fromEntries((await pg.query('SELECT id, xmin::text AS x FROM users')).rows.map(r => [r.id, r.x]));
  const before = await versions();

  db.users.find(u => u.id === 'u_z').lastPull = 1760000999999;
  await store.saveDb(db);
  const after = await versions();
  assert.notEqual(after.u_z, before.u_z, 'the changed profile was written');
  assert.equal(after.u_a, before.u_a, 'the other was left alone');

  await store.saveDb(db);
  assert.deepEqual(await versions(), after, 'a save with nothing changed writes nothing');

  // An admin delete: the profile and its rows leave memory (server.js), the save follows.
  db.users = db.users.filter(u => u.id !== 'u_a');
  db.creds = db.creds.filter(c => c.userId !== 'u_a');
  db.deviceLinks = db.deviceLinks.filter(l => l.userId !== 'u_a');
  delete db.settings;
  await store.saveDb(db);
  const fresh = await open(t, pg.url).then(async s => { await store.close(); return s.loadDb(); });
  assert.deepEqual(fresh.users.map(u => u.id), ['u_z']);
  assert.deepEqual(fresh.creds.map(c => c.id), ['cred-1']);
  assert.deepEqual(fresh.deviceLinks, []);
  assert.equal('settings' in fresh, false);
});

// The console lines a function printed with console.error.
async function errorsOf(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

test('a row the database refuses fails the save, names itself, and is retried by the next', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  const db = await store.loadDb();
  db.users.push({ id: 'u_1', name: 'One', email: 'same@example.com' });
  await store.saveDb(db);

  // Memory accepted what the unique index refuses (an app/database mismatch in normalizeEmail).
  db.users.push({ id: 'u_2', name: 'Two', email: 'same@example.com' });
  db.invites.push({ code: 'C1', note: 'rides along' });
  let failure;
  const logged = await errorsOf(() => store.saveDb(db).catch(e => { failure = e; }));
  assert.ok(failure, 'the save was refused');
  assert.equal(failure.code, '23505');
  assert.ok(logged.some(l => l.includes('users') && l.includes('u_2')), `the log names the table and key: ${logged}`);

  // Nothing of that save landed, and while memory still holds the row every save fails the same way.
  await assert.rejects(store.saveDb(db), { code: '23505' });
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM invites')).rows[0].n, 0);

  db.users[1].email = 'two@example.com';
  await store.saveDb(db);
  assert.deepEqual((await pg.query('SELECT code FROM invites')).rows, [{ code: 'C1' }], 'the retry carried the rest of the change');
  assert.equal((await pg.query("SELECT email FROM users WHERE id = 'u_2'")).rows[0].email, 'two@example.com');
});

test('an address moving between two profiles in one save is not a conflict', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  const db = await store.loadDb();
  db.users.push({ id: 'u_new', name: 'New' }, { id: 'u_old', name: 'Old', email: 'moving@example.com' });
  await store.saveDb(db);
  // The profile listed first takes the address the one after it gives up, before either is saved.
  delete db.users[1].email;
  db.users[0].email = 'moving@example.com';
  await store.saveDb(db);
  assert.deepEqual((await pg.query('SELECT id, email FROM users ORDER BY pos')).rows,
    [{ id: 'u_new', email: 'moving@example.com' }, { id: 'u_old', email: null }]);
});

// A store with one profile, `u_1`, saved.
async function withProfile(t) {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  const db = await store.loadDb();
  db.users.push({ id: 'u_1', name: 'One' });
  await store.saveDb(db);
  return { pg, store, db };
}
const docAt = (rev, wid, more = {}) => ({ _rev: rev, _wid: wid, _wids: rev > 1 ? ['w' + (rev - 1)] : [], workouts: [], routines: [], ...more });

test('a profile without a document reads as none, and its first write creates it', { skip: NO_PG }, async t => {
  const { store } = await withProfile(t);
  assert.equal(await store.readStateStrict('u_1'), null);
  assert.equal(await store.readState('u_1'), null);
  assert.equal(await store.readStateRev('u_1'), null);

  assert.equal(await store.casWriteState('u_1', null, null, docAt(1, 'w1')), true);
  assert.deepEqual(await store.readStateStrict('u_1'), docAt(1, 'w1'));
  assert.deepEqual(await store.readStateRev('u_1'), { rev: 1, wid: 'w1' });
  assert.deepEqual(await store.listStateUids(), ['u_1']);
  // A second "first write" finds one there.
  assert.equal(await store.casWriteState('u_1', null, null, docAt(1, 'other')), false);
  assert.equal((await store.readState('u_1'))._wid, 'w1');
});

test('a write lands only over the revision and write id it was based on', { skip: NO_PG }, async t => {
  const { store } = await withProfile(t);
  await store.casWriteState('u_1', null, null, docAt(1, 'w1'));
  assert.equal(await store.casWriteState('u_1', 0, null, docAt(2, 'x')), false, 'an older revision');
  assert.equal(await store.casWriteState('u_1', 1, 'w0', docAt(2, 'x')), false, 'the same number, another document');
  assert.deepEqual(await store.readStateRev('u_1'), { rev: 1, wid: 'w1' });
  assert.equal(await store.casWriteState('u_1', 1, 'w1', docAt(2, 'w2', { lang: 'de' })), true);
  assert.deepEqual(await store.readStateStrict('u_1'), docAt(2, 'w2', { lang: 'de' }));

  // A document from before write ids: no _wid stored, and none expected.
  await store.casWriteState('u_1', 2, 'w2', { _rev: 3, workouts: [] });
  assert.deepEqual(await store.readStateRev('u_1'), { rev: 3, wid: null });
  assert.equal(await store.casWriteState('u_1', 3, null, docAt(4, 'w4')), true);
});

test('two devices writing over the same revision: exactly one lands', { skip: NO_PG }, async t => {
  const { store } = await withProfile(t);
  await store.casWriteState('u_1', null, null, docAt(1, 'w1'));
  for (let round = 1; round <= 10; round++) {
    const results = await Promise.all(['a', 'b'].map(d => store.casWriteState('u_1', round, 'w' + round, docAt(round + 1, 'w' + (round + 1), { by: d }))));
    assert.deepEqual(results.sort(), [false, true], `round ${round}`);
    assert.deepEqual(await store.readStateRev('u_1'), { rev: round + 1, wid: 'w' + (round + 1) });
  }
});

test('a document Postgres cannot hold is refused as invalid, and nothing is stored', { skip: NO_PG }, async t => {
  const { store } = await withProfile(t);
  for (const bad of ['nul \u0000 inside', 'lone \udc00 surrogate']) {
    await assert.rejects(store.casWriteState('u_1', null, null, docAt(1, 'w1', { note: bad })), { name: 'InvalidDocument' });
  }
  assert.equal(await store.readStateStrict('u_1'), null);
});

test('a cached read is reused while the revision stands, and follows every write, even one made by hand', { skip: NO_PG }, async t => {
  const { pg, store } = await withProfile(t);
  assert.equal(await store.readStateCached('u_1'), null);
  await store.casWriteState('u_1', null, null, docAt(1, 'w1'));

  const first = await store.readStateCached('u_1');
  assert.deepEqual(first, docAt(1, 'w1'));
  assert.equal(await store.readStateCached('u_1'), first, 'the same document, not fetched again');

  await store.casWriteState('u_1', 1, 'w1', docAt(2, 'w2'));
  assert.deepEqual(await store.readStateCached('u_1'), docAt(2, 'w2'), 'a write through the store');

  // An operator editing the row in psql: a new revision the store never wrote.
  await pg.query(`UPDATE user_state SET rev = 3, doc = doc || '{"_rev": 3, "lang": "fr"}' WHERE uid = 'u_1'`);
  assert.equal((await store.readStateCached('u_1')).lang, 'fr');

  await store.deleteState('u_1');
  assert.equal(await store.readStateCached('u_1'), null);
});

test('a second API process on the same database refuses to start; another schema is another instance', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const first = await open(t, pg.url);
  await first.loadDb();
  const second = await open(t, pg.url);
  await assert.rejects(second.loadDb(), /another kuch-api owns this database/);

  const other = await freshSchema(t);
  const elsewhere = await open(t, other.url);
  assert.deepEqual((await elsewhere.loadDb()).users, []);

  // Once the first is gone the lock is free, and the schema is already migrated.
  await first.close();
  const third = await open(t, pg.url);
  await third.loadDb();
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
});

test('a database that cannot be reached is waited for, then refused loudly', async t => {
  // A port nothing listens on: refused at once, every attempt.
  const net = await import('node:net');
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const store = createPgStore({ url: `postgres://kuch:x@127.0.0.1:${port}/kuch`, waitMs: 1200 });
  t.after(() => store.close());
  const started = Date.now();
  let err;
  const logged = await errorsOf(() => store.loadDb().catch(e => { err = e; }));
  assert.match(String(err?.message), /cannot reach the database/);
  assert.ok(Date.now() - started >= 1000, 'it kept trying for the time it was given');
  assert.ok(logged.filter(l => /not reachable yet/.test(l)).length >= 2, `each wait is logged: ${logged}`);
});

test('health says whether the database answers', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  await store.loadDb();
  assert.deepEqual(await store.health(), { ok: true });
  await store.close();
  assert.deepEqual(await store.health(), { ok: false });
});

test('saves land in the order they were called, each with what memory held at its turn', { skip: NO_PG }, async t => {
  const pg = await freshSchema(t);
  const store = await open(t, pg.url);
  const db = await store.loadDb();
  const saves = [];
  db.users.push({ id: 'keep', name: 'v0' });
  for (let i = 0; i < 40; i++) {
    db.users.push({ id: 'u' + i, name: 'P' + i });
    if (i % 3 === 2) db.users.splice(1, 1);       // a removal between two saves in flight
    db.users[0].name = 'v' + i;
    saves.push(store.saveDb(db));
    await new Promise(r => setImmediate(r));       // the earlier save is mid-transaction
  }
  await Promise.all(saves);
  const expected = structuredClone(db.users);
  await store.close();
  const again = await open(t, pg.url);
  assert.deepEqual((await again.loadDb()).users, expected);
});
