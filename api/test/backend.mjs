/* Which storage backend the suite runs on, and a test's data on it.

   `npm test` runs every file on the file backend; `npm run test:pg` runs the same files again with
   TEST_STORAGE_BACKEND=postgres (test/run-pg.mjs), where every data home is also a throwaway schema
   of the database DATABASE_URL_TEST names (pg-helpers.mjs). So a test seeds, reads and edits its
   accounts and training documents through its home, never through db.json or state-*.json, and the
   same assertions hold on both. What stays a file on both backends (secret, audit.log, uploads/,
   the Coach's credentials) is read from `home.dir` as before.

   The few tests about the files themselves (a corrupt db.json, the stat cache) are file-only:
   `{ skip: fileOnly('why') }`. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after } from 'node:test';
import pg from 'pg';
import { createPgStore, readAccounts, types, STATE_COLUMNS } from '../store/pg.js';
import { PG_URL, withSchema } from './pg-helpers.mjs';

export const BACKEND = process.env.TEST_STORAGE_BACKEND === 'postgres' ? 'postgres' : 'file';
export const ON_PG = BACKEND === 'postgres';

// A connection that reads like the store's (types), beside it: no lock, no snapshot.
const newClient = url => new pg.Client({ connectionString: url, types });

// A `skip` for a test about what only the file backend has.
export const fileOnly = why => (ON_PG ? `file backend only: ${why}` : false);

/* A data directory, plus a schema on Postgres, holding `db` (as db.json would) and `states`
   ({ uid: document }), and removed when the test ends — `t`'s end, or the file's without one.

   → {
       dir                    DATA_DIR
       env                    what a spawned server.js needs to use it: DATA_DIR, STORAGE_BACKEND,
                              and DATABASE_URL on Postgres
       writeDb(db)            stores the accounts; before the server starts, and before writeState
       readDb()               every account, as db.json holds them
       dbText()               the stored accounts as text, for "never stored" checks
       readState(uid)         the profile's document, or null when it has none
       writeState(uid, doc)   replaces it whatever is there, as a restore or a hand edit would
       own(child)             a server.js spawned on it, killed before the home is removed
     }
   Everything is async. On Postgres a document needs its profile, so writeState adds a bare users
   row for a uid that has none (the file backend has no such constraint). And a running server's
   cached reads (the reminder tick, the push routes) notice a rewrite there by its `_rev`/`_wid`
   only, so a test that rewrites a document under a server gives it a new `_rev`, as every real
   write has. */
export async function dataHome({ t, prefix = 'gym-', secret, db, states = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const children = [];
  const cleanup = [() => {
    try { fs.chmodSync(dir, 0o700); } catch { /* a test that took write access away */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }];
  // Each server is gone before its directory is: on Windows a process still closing a file it was
  // writing makes the removal fail with ENOTEMPTY.
  (t ? t.after.bind(t) : after)(async () => {
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null
      : new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); })));
    for (const step of cleanup.reverse()) await step();
  });
  const own = child => { children.push(child); return child; };
  if (secret != null) fs.writeFileSync(path.join(dir, 'secret'), secret, { mode: 0o600 });

  if (!ON_PG) {
    const file = name => path.join(dir, name);
    if (db) fs.writeFileSync(file('db.json'), JSON.stringify(db));
    const home = {
      dir,
      env: { DATA_DIR: dir, STORAGE_BACKEND: 'file' },
      own,
      async writeDb(next) { fs.writeFileSync(file('db.json'), JSON.stringify(next)); },
      async readDb() { return JSON.parse(fs.readFileSync(file('db.json'), 'utf8')); },
      async dbText() { return fs.readFileSync(file('db.json'), 'utf8'); },
      async readState(uid) {
        try { return JSON.parse(fs.readFileSync(file(`state-${uid}.json`), 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      },
      async writeState(uid, doc) { fs.writeFileSync(file(`state-${uid}.json`), JSON.stringify(doc)); }
    };
    for (const [uid, doc] of Object.entries(states)) await home.writeState(uid, doc);
    return home;
  }

  if (!PG_URL) throw new Error('TEST_STORAGE_BACKEND=postgres needs DATABASE_URL_TEST');
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const url = withSchema(PG_URL, schema);
  const admin = newClient(PG_URL);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  cleanup.push(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  });

  // Migrated and seeded by the store itself, which then lets go of the schema for the server.
  async function writeDb(next) {
    const seed = createPgStore({ url, waitMs: 0 });
    try {
      await seed.loadDb();
      if (next) await seed.saveDb(next);
    } finally { await seed.close(); }
  }
  await writeDb(db);

  const side = newClient(url);
  await side.connect();
  cleanup.push(() => side.end().catch(() => {}));
  const home = {
    dir,
    env: { DATA_DIR: dir, STORAGE_BACKEND: 'postgres', DATABASE_URL: url },
    own,
    schema,
    writeDb,
    query:(sql, params) => side.query(sql, params),
    readDb: () => readAccounts(side),
    async dbText() { return JSON.stringify(await readAccounts(side)); },
    async readState(uid) {
      const { rows } = await side.query('SELECT doc FROM user_state WHERE uid = $1', [uid]);
      return rows.length ? rows[0].doc : null;
    },
    async writeState(uid, doc) {
      await side.query(`INSERT INTO users (id, pos) SELECT $1, coalesce(max(pos) + 1, 0) FROM users
        ON CONFLICT (id) DO NOTHING`, [uid]);
      await side.query(`INSERT INTO user_state (uid, rev, wid, wids, doc) SELECT $1, ${STATE_COLUMNS} FROM (SELECT $2::jsonb AS d) s
        ON CONFLICT (uid) DO UPDATE SET (rev, wid, wids, doc, updated_at) = (EXCLUDED.rev, EXCLUDED.wid, EXCLUDED.wids, EXCLUDED.doc, now())`,
        [uid, JSON.stringify(doc)]);
    }
  };
  for (const [uid, doc] of Object.entries(states)) await home.writeState(uid, doc);
  return home;
}
