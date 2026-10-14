/* PUT /api/data's compare-and-write holds with two devices pushing at the same moment. It used to
   hold because the read and the write were synchronous with nothing awaited between them; the
   store is async now (store/index.js), so the route runs that section under a per-profile lock
   instead (keyed-lock.js). Without the lock both writes read the same revision, both pass the
   check, and both answer 200: the first device's write is silently lost.

   The state is made big (about 1.5 MB) so a read of it takes real time, which is what lets the
   second request's read land inside the first one's section when nothing serialises them. Real
   server.js in a child, file backend. */
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
const UID = 'u_cas_1';

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const headers = { Cookie: `gymsid=${mintSession(UID)}`, 'Content-Type': 'application/json' };

// About 1.5 MB of workouts, the size a few years of logging reaches.
const bigWorkouts = () => Array.from({ length: 6000 }, (_, i) => ({
  id: 'w' + i, d: '2026-01-01', name: 'Full body A', vol: i,
  ex: [{ id: '0001', sets: [{ w: 20, r: 10, done: true }, { w: 22.5, r: 8, done: true }] }]
}));

async function startServer(t) {
  const home = await dataHome({ t, prefix: 'gym-cas-', secret: SECRET, db: {
    users: [{ id: UID, name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }, states: { [UID]: { _rev: 1, _wid: 'seed', routines: [], workouts: bigWorkouts() } } });
  const dataDir = home.dir;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', ...home.env, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { api: '', log: '', home, dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  home.own(child);
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  return h;
}

const put = async (h, body) => {
  const r = await fetch(`${h.api}/api/data`, { method: 'PUT', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const onDisk = h => h.home.readState(UID);

test('two devices pushing over the same revision at once: one write lands, the other gets 409 with it', async t => {
  const h = await startServer(t);
  const workouts = bigWorkouts();
  for (let round = 0; round < 20; round++) {
    const { _rev: base, _wid: baseWid } = await onDisk(h);
    const [a, b] = await Promise.all([
      put(h, { state: { _ts: round * 2 + 1, device: 'a', routines: [], workouts }, baseRev: base, baseWid }),
      put(h, { state: { _ts: round * 2 + 2, device: 'b', routines: [], workouts }, baseRev: base, baseWid })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}: exactly one write may land`);
    const [won, lost] = a.status === 200 ? [a, b] : [b, a];
    assert.equal(won.body.rev, base + 1);
    assert.equal(lost.body.error, 'conflict');
    assert.equal(lost.body.rev, base + 1, 'the 409 reports the revision the other write made');
    assert.equal(lost.body.state._wid, won.body.wid, 'and carries the document it stored');
    const disk = await onDisk(h);
    assert.equal(disk._rev, base + 1);
    assert.equal(disk._wid, won.body.wid);
    assert.equal(disk.device, won === a ? 'a' : 'b');
  }
});

test('two overwrites without baseRev at once: each gets its own revision, none is reused', async t => {
  const h = await startServer(t);
  const workouts = bigWorkouts();
  const base = (await onDisk(h))._rev;
  const [a, b] = await Promise.all([
    put(h, { state: { _ts: 1, device: 'a', routines: [], workouts } }),
    put(h, { state: { _ts: 2, device: 'b', routines: [], workouts } })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual([a.body.rev, b.body.rev].sort(), [base + 1, base + 2]);
  const last = a.body.rev > b.body.rev ? a : b;
  const disk = await onDisk(h);
  assert.equal(disk._rev, base + 2);
  assert.equal(disk._wid, last.body.wid);
  assert.ok(disk._wids.includes((last === a ? b : a).body.wid), 'the later write descends from the earlier one');
});
