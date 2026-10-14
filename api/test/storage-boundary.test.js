/* The storage boundary (docs/adr/0001-postgres-write-through-db.md, store/index.js): accounts and
   training documents are read and written only through the store, and every store call is
   awaited. Upstream openGym still writes db.json and state-<uid>.json directly and synchronously,
   so a merged upstream change can add a storage call that conflicts with nothing: on Postgres it
   then reads or writes files nobody else looks at, or answers 200 before its write committed.
   Neither fails on the file backend. This test reads every API module as text and fails, naming
   file, line and rule, when one does (test/storage-boundary.mjs).

   Two rules:
   - direct-storage-access: a module outside the store names db.json / db.json.bak, or builds a
     state-<uid>.json name ('state-' + uid, `state-${uid}`, a 'state-' prefix, state-….json).
     Comments do not count. secret, vapid.json, coach.json, coach/, coach-auth-*, audit.log and
     uploads/ stay files under ADR 0001 and are not looked at.
   - unawaited-store-call: a call to a store method (store.loadDb, store.saveDb, …) or a thin
     wrapper (WRAPPERS in the scanner) that is not directly preceded by `await`, `return` or the
     `=>` of an arrow function whose expression body it is.

   A deliberate exception is a comment on the same line:
     // storage-boundary-allow <rule>: <why>
   A marker without a reason, or naming no rule, is itself a violation.

   Limits. The scanner is lexical, not a parser (the api's dependency budget has no room for one):
   - It only sees the store through the name `store` and the wrappers by their names. An alias
     (`const s = store`, `const { saveDb } = store`, `store['saveDb']`) is not seen.
   - "Awaited" means the token right before the call expression. `await (a ? store.saveDb(db) : x)`,
     `=> (store.readState(u))`, `Promise.all([store.readState(a), …])` and
     `const p = store.saveDb(db); await p;` are reported although they wait; write them as a
     plain `await` (or mark them). `await saveDb().then(…)` passes, since the chain is awaited.
   - Regular-expression literals are told from division by the token before the `/`; a `/` after
     `)` or `]` is division. A regex there would be read as code up to the next `/`.
   - A training-document name built some other way (from parts kept in variables) is not seen.
   - Only .js/.mjs under api/ count; the store itself, the tests and the JSON-to-Postgres migration
     script (which reads the files on purpose) are out of scope, and so is the MCP server, which
     reads storage directly by design. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './storage-boundary.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_OF_SCOPE = new Set(['store', 'test', 'node_modules', path.join('scripts', 'migrate-json-to-pg.mjs')]);

function modules(dir = API) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const abs = path.join(dir, e.name);
    if (OUT_OF_SCOPE.has(path.relative(API, abs))) return [];
    if (e.isDirectory()) return modules(abs);
    return /\.m?js$/.test(e.name) ? [abs] : [];
  });
}

const rules = src => scan(src).map(v => [v.line, v.rule]);

test('every API module outside the store keeps to the storage boundary', () => {
  const files = modules().map(f => path.relative(API, f).split(path.sep).join('/'));
  // The modules that call the store today, so a broken walk cannot pass by scanning nothing.
  for (const f of ['server.js', 'media.js', 'coach/jobs.js', 'coach/cohort.js', 'coach/cadence.js']) assert.ok(files.includes(f), `${f} is not scanned`);
  assert.ok(!files.some(f => f.startsWith('store/') || f.startsWith('test/')), 'the store and the tests are out of scope');
  const found = files.flatMap(f => scan(fs.readFileSync(path.join(API, f), 'utf8')).map(v => `${f}:${v.line}  ${v.rule}  "${v.excerpt}"`));
  assert.deepEqual(found, [], `storage boundary broken:\n${found.join('\n')}`);
});

test('direct storage access: the account database or a training-document name in code', () => {
  assert.deepEqual(rules(`const x = 1;\nconst f = path.join(DATA, 'db.json');\n`), [[2, 'direct-storage-access']]);
  assert.deepEqual(rules(`fs.copyFileSync(dbFile, "db.json.bak");`), [[1, 'direct-storage-access']]);
  assert.deepEqual(rules('\n\nconst f = path.join(DATA, `state-${uid}.json`);'), [[3, 'direct-storage-access']]);
  assert.deepEqual(rules(`const f = path.join(DATA, 'state-' + uid + '.json');`), [[1, 'direct-storage-access']]);
  assert.deepEqual(rules(`const uids = fs.readdirSync(DATA).filter(f => f.startsWith('state-'));`), [[1, 'direct-storage-access']]);
  assert.deepEqual(rules(`const m = /^state-(.+)\\.json$/.exec(name);`), [[1, 'direct-storage-access']]);
});

test('the files that stay files under ADR 0001 are not storage access', () => {
  assert.deepEqual(rules([
    `const secretFile = path.join(DATA, 'secret');`,
    `const vapid = path.join(DATA, 'vapid.json'), coach = path.join(DATA, 'coach.json');`,
    "const auth = path.join(DATA, 'coach', `coach-auth-${uid}`);",
    `const log = path.join(DATA, 'audit.log'), up = path.join(DATA, 'uploads/');`,
    `res.end('a state-changing request needs an Origin');`
  ].join('\n')), []);
});

test('unawaited store call: a bare statement, a wrapper, a fire-and-forget chain', () => {
  assert.deepEqual(rules(`db.users.push(u);\nstore.saveDb(db);\nsend(res, 200);`), [[2, 'unawaited-store-call']]);
  assert.deepEqual(rules(`function f() {\n  user.name = n;\n  saveDb();\n}`), [[3, 'unawaited-store-call']]);
  assert.deepEqual(rules(`store.readState(uid).then(S => send(res, 200, S));`), [[1, 'unawaited-store-call']]);
  assert.deepEqual(rules(`saveDb().then(() => log('saved'));`), [[1, 'unawaited-store-call']]);
  assert.deepEqual(rules(`const S = jobs.readState(user.id);`), [[1, 'unawaited-store-call']]);
  assert.deepEqual(rules(`for (const uid of listUserIds()) count++;`), [[1, 'unawaited-store-call']]);
  assert.deepEqual(rules(`const ok = store.casWriteState(uid, 1, null, doc);\nconst h = store.health();`), [[1, 'unawaited-store-call'], [2, 'unawaited-store-call']]);
  assert.deepEqual(rules(`void store.deleteState(uid);`), [[1, 'unawaited-store-call']]);
});

test('awaited, returned or an arrow expression body is fine', () => {
  assert.deepEqual(rules([
    `db = await store.loadDb();`,
    `await saveDb();`,
    `if (proof === 'passkey') await saveDb();`,
    `const S = (await store.readStateCached(user.id))?.lang;`,
    `try { landed = await store.casWriteState(user.id, rev, wid, body.state); } catch {}`,
    `for (const uid of await listUserIds()) {}`,
    `const S = await jobs.readState(user.id);`,
    `await stateLock(u.id, () => store.deleteState(u.id));`,
    `export const listUserIds = () => store.listStateUids();`,
    `export const readState = uid => store.readState(uid);`,
    `function saveDb() { return store.saveDb(db); }`,
    `async function readState(uid) { return null; }`,
    `const media = { readState(uid) { return null; } };`,
    `const cur = await store\n  .readStateRev(user.id);`,
    `await saveDb().then(() => log('saved'));`,
    `const MEDIA = createMediaStore({ readState: store.readState });`
  ].join('\n')), []);
});

test('the same names inside comments, strings and regular expressions are not code', () => {
  assert.deepEqual(rules([
    `// db.json and state-<uid>.json are the store's: store.saveDb(db) persists them`,
    `/* saveDb(); store.readState(uid); path.join(DATA, \`state-\${uid}.json\`) */`,
    `/**`,
    ` * readState(uid) returns the document; db.json.bak is the last save.`,
    ` */`,
    `const help = 'call store.saveDb(db) and saveDb() only with await';`,
    `const url = /https?:\\/\\/[^/]+\\/saveDb\\(/;`,
    'const msg = `saved: ${await store.readStateRev(uid)}`;'
  ].join('\n')), []);
  // And code after them is still code.
  assert.deepEqual(rules([
    `const u = 'http://x/y'; store.saveDb(db);`,
    `const r = /a\\/b/g; saveDb();`,
    'const t = `${n} // not a comment`; saveDb();',
    `x = a / b; saveDb(); // ok`
  ].join('\n')), [[1, 'unawaited-store-call'], [2, 'unawaited-store-call'], [3, 'unawaited-store-call'], [4, 'unawaited-store-call']]);
});

test('an exemption marker with a reason allows its line; one without a reason is a violation', () => {
  assert.deepEqual(rules(`['secret', 'db.json'].forEach(lock); // storage-boundary-allow direct-storage-access: chmod only`), []);
  assert.deepEqual(rules(`saveDb(); /* storage-boundary-allow unawaited-store-call — fire and forget on shutdown */`), []);
  // Only for the rule it names, and only on its own line.
  assert.deepEqual(rules(`saveDb(); // storage-boundary-allow direct-storage-access: chmod only`), [[1, 'unawaited-store-call']]);
  assert.deepEqual(rules(`// storage-boundary-allow unawaited-store-call: the next line\nsaveDb();`), [[2, 'unawaited-store-call']]);
  // No reason: the marker is reported, and allows nothing.
  assert.deepEqual(rules(`\nsaveDb(); // storage-boundary-allow unawaited-store-call`), [[2, 'unawaited-store-call'], [2, 'exemption-without-reason']]);
  assert.deepEqual(rules(`saveDb(); // storage-boundary-allow unawaited-store-call: `), [[1, 'unawaited-store-call'], [1, 'exemption-without-reason']]);
  // A marker that names no rule is not an exemption either.
  assert.deepEqual(rules(`saveDb(); // storage-boundary-allow: it is fine`), [[1, 'unawaited-store-call'], [1, 'exemption-without-reason']]);
});

test('a violation names its line and carries the source line', () => {
  assert.deepEqual(scan(`const a = 1;\n    store.saveDb(db);   \n`), [{ line: 2, rule: 'unawaited-store-call', excerpt: 'store.saveDb(db);' }]);
});
