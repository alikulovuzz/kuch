import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dataHome } from './backend.mjs';
import { boundPort } from './helpers.mjs';
import crypto from 'node:crypto';

test('operator recovery restores the existing administrator without granting a new role', async t => {
  const home = await dataHome({ t, prefix: 'operator-recovery-', secret: 'b'.repeat(64) });
  const google = { issuer: 'https://accounts.google.com', subject: 'same-owner' };
  const credential = { id: 'preserved-key', userId: 'admin', publicKey: 'fixture', counter: 0 };
  await home.writeDb({ users: [{ id: 'admin', name: 'Owner', admin: true, google, email: 'owner@example.test', emailVerified: 'owner@example.test' }, { id: 'ordinary', name: 'Person' }], creds: [credential], subs: [], invites: [] });
  await home.writeState('admin', { workouts: [{ id: 'preserved-workout' }] });
  const run = uid => new Promise(resolve => {
    const child = home.own(spawn(process.execPath, ['scripts/recover-admin.mjs', uid], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...home.env, PASSWORD_LOGIN: '1', ADMIN_UIDS: '' }, stdio: ['pipe', 'pipe', 'pipe'] }));
    child.stdin.end('operator supplied strong password\n');
    child.on('exit', code => resolve(code));
  });
  assert.equal(await run('ordinary'), 1);
  assert.equal(await run('admin'), 0);
  const db = await home.readDb();
  assert.equal(db.users[0].sv, 1);
  assert.deepEqual(db.users[0].google, google);
  assert.equal(db.users[0].emailVerified, 'owner@example.test');
  assert.deepEqual(db.creds, [credential]);
  assert.deepEqual((await home.readState('admin')).workouts, [{ id: 'preserved-workout' }]);
  assert.equal(db.users[1].pw, undefined);
  const child = home.own(spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...home.env, PORT: '0', PASSWORD_LOGIN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  const base = 'http://127.0.0.1:' + await boundPort(child);
  const payload = `admin:${Date.now() + 60000}:0`;
  const oldToken = payload + '.' + crypto.createHmac('sha256', 'b'.repeat(64)).update(payload).digest('base64url');
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: 'gymsid=' + oldToken } })).status, 401);
  assert.equal((await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + oldToken } })).status, 401);
  const response = await fetch(base + '/api/login/password', { method: 'POST', body: JSON.stringify({ identifier: 'Owner', password: 'operator supplied strong password' }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).user, { id: 'admin', name: 'Owner', admin: true });
});
