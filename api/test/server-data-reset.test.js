/* "Reset everything" stamps the profile with `resetAt` (and `resetIds`, the names it wiped). The
   stamp only moves forward on the server: a write without it, or with an older one — a client from
   before it, a backup restored over the profile — keeps the stored one, so the devices that saw
   the reset do not take the restored copy for one from before it and wipe it again. Real
   server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { dataHome } from './backend.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const UID = 'u_reset_1';

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = () => ({ Cookie: `gymsid=${mintSession(UID)}`, 'Content-Type': 'application/json' });

async function startServer(t) {
  const home = await dataHome({ t, prefix: 'gym-reset-', secret: SECRET, db: {
    users: [{ id: UID, name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  } });
  const dataDir = home.dir;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', ...home.env, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { log: '', home, dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  home.own(child);
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  return h;
}

test('PUT /api/data keeps the reset stamp when a write lacks it or carries an older one', async t => {
  const h = await startServer(t);
  const put = async body => {
    const r = await fetch(`${h.api}/api/data`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const onDisk = () => h.home.readState(UID);
  const ids = { workouts: ['w-old'] };

  // the reset
  let r = await put({ state: { _ts: 100, workouts: [], routines: [], resetAt: 5000, resetIds: ids } });
  assert.equal(r.status, 200);
  assert.equal((await onDisk()).resetAt, 5000);

  // a backup restored over it, with no stamp: its workouts land, the stamp stays
  r = await put({ state: { _ts: 50, workouts: [{ id: 'w-old', d: '2026-01-01' }], routines: [] } });
  assert.equal(r.status, 200);
  assert.deepEqual((await onDisk()).workouts.map(w => w.id), ['w-old']);
  assert.equal((await onDisk()).resetAt, 5000);
  assert.deepEqual((await onDisk()).resetIds, ids);

  // an older stamp does not take it back either
  r = await put({ state: { _ts: 60, workouts: [], routines: [], resetAt: 10, resetIds: { workouts: ['x'] } }, baseRev: 2 });
  assert.equal(r.status, 200);
  assert.equal((await onDisk()).resetAt, 5000);
  assert.deepEqual((await onDisk()).resetIds, ids);

  // a later reset moves it forward
  r = await put({ state: { _ts: 70, workouts: [], routines: [], resetAt: 9000, resetIds: { workouts: ['w-new'] } } });
  assert.equal(r.status, 200);
  assert.equal((await onDisk()).resetAt, 9000);
  assert.deepEqual((await onDisk()).resetIds, { workouts: ['w-new'] });
});

test('PUT /api/data: a profile never reset gets no stamp', async t => {
  const h = await startServer(t);
  const r = await fetch(`${h.api}/api/data`, { method: 'PUT', headers: headers(), body: JSON.stringify({ state: { _ts: 1, workouts: [], routines: [] } }) });
  assert.equal(r.status, 200);
  const doc = await h.home.readState(UID);
  assert.equal('resetAt' in doc, false);
  assert.equal('resetIds' in doc, false);
});
