import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataHome } from './backend.mjs';
import { boundPort } from './helpers.mjs';
import { hashPassword } from '../password.js';
import fs from 'node:fs';
import path from 'node:path';

async function start(t, configured = false, options = {}) {
  const secret = crypto.randomBytes(32).toString('hex');
  const home = await dataHome({ t, prefix: 'admin-auth-', secret });
  await home.writeDb({ users: [{ id: 'admin', name: 'Admin', admin: true, pw: { h: await hashPassword('a strong fixture password') }, ...options.admin }, ...(options.users || [])], creds: [], subs: [], invites: [] });
  const child = home.own(spawn(process.execPath, ['--import', './test/google-provider-fixture.mjs', 'server.js'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...home.env, PORT: '0', SMTP_HOST: 'fixture.invalid', MAIL_FROM: 'kuch@example.test', PASSWORD_LOGIN: '1', ORIGIN: 'http://localhost:8080', PUBLIC_BASE_URL: 'http://localhost:8080/gym/', GOOGLE_CLIENT_ID: configured ? 'fixture-client' : '', GOOGLE_CLIENT_SECRET: configured ? 'fixture-secret' : '' },
  }));
  let log = ''; child.stdout.on('data', x => log += x); child.stderr.on('data', x => log += x);
  const base = 'http://127.0.0.1:' + await boundPort(child, () => log);
  const payload = `admin:${Date.now() + 86400000}:0`;
  const cookie = 'gymsid=' + payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return { base, cookie, home, clock: offset => fs.writeFileSync(path.join(home.dir, 'clock-offset.txt'), String(offset)), mail: () => {
    const file = path.join(home.dir, 'test-mail.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  } };
}

test('security status requires a session and describes unavailable Google without exposing secrets', async t => {
  const { base, cookie } = await start(t);
  assert.equal((await fetch(base + '/api/account/security')).status, 401);
  const response = await fetch(base + '/api/account/security', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(status.google, { available: false, linked: false });
  assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('email verification is single-use and keeps the login email unchanged until verified', async t => {
  const { base, cookie, mail } = await start(t);
  const request = await fetch(base + '/api/account/email-verification', { method: 'POST', headers: { Cookie: cookie },
    body: JSON.stringify({ email: 'owner@example.test', current: 'a strong fixture password' }) });
  assert.equal(request.status, 200);
  const before = await (await fetch(base + '/api/account/security', { headers: { Cookie: cookie } })).json();
  assert.equal(before.email, null);
  const link = new URL(mail()[0].text.match(/http\S+/)[0]);
  const token = new URLSearchParams(link.hash.split('?')[1]).get('token');
  assert.ok(token);
  const verify = () => fetch(base + '/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) });
  assert.equal((await verify()).status, 200);
  assert.equal((await verify()).status, 400);
  const after = await (await fetch(base + '/api/account/security', { headers: { Cookie: cookie } })).json();
  assert.equal(after.email, 'owner@example.test');
  assert.equal(after.emailVerified, true);
  const recover = email => fetch(base + '/api/auth/email/recover', { method: 'POST', body: JSON.stringify({ email }) });
  const known = await recover('owner@example.test');
  const unknown = await recover('nobody@example.test');
  assert.equal(known.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
  const resetLink = new URL(mail().at(-1).text.match(/http\S+/)[0]);
  const resetToken = new URLSearchParams(resetLink.hash.split('?')[1]).get('token');
  const reset = () => fetch(base + '/api/auth/email/reset', { method: 'POST', body: JSON.stringify({ token: resetToken, password: 'a different strong password' }) });
  assert.equal((await reset()).status, 200);
  assert.equal((await reset()).status, 400);
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 401);
  const login = await fetch(base + '/api/login/password', { method: 'POST', body: JSON.stringify({ identifier: 'owner@example.test', password: 'a different strong password' }) });
  assert.equal(login.status, 200);
});

test('linking requires fresh ownership proof and allows later Google access to the same profile', async t => {
  const { base, cookie } = await start(t, true);
  const begin = async body => fetch(base + '/api/account/google/link', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await begin({})).status, 403);
  const linkedStart = await begin({ current: 'a strong fixture password', returnTo: '/admin' });
  assert.equal(linkedStart.status, 200);
  async function callback(started, activeCookie = cookie) {
    const target = new URL((await started.json()).url);
    const code = Buffer.from(JSON.stringify({ nonce: target.searchParams.get('nonce') })).toString('base64url');
    return fetch(base + '/api/auth/google/callback?state=' + target.searchParams.get('state') + '&code=' + code,
      { redirect: 'manual', headers: { Cookie: activeCookie + '; ' + started.headers.getSetCookie()[0].split(';')[0] } });
  }
  const linked = await callback(linkedStart);
  assert.equal(linked.status, 303);
  assert.equal(linked.headers.get('location'), 'http://localhost:8080/gym/#/admin');
  const security = await fetch(base + '/api/account/security', { headers: { Cookie: cookie } });
  assert.equal((await security.json()).google.linked, true);
  const loginStart = await fetch(base + '/api/auth/google/start', { method: 'POST', body: '{}' });
  const loggedIn = await callback(loginStart);
  const session = loggedIn.headers.getSetCookie().find(x => x.startsWith('gymsid='));
  assert.ok(session);
  const me = await fetch(base + '/api/me', { headers: { Cookie: session.split(';')[0] } });
  assert.equal((await me.json()).user.id, 'admin');
  // A Google-linked account may remove its password; the change revokes existing sessions.
  const removed = await fetch(base + '/api/account/password', { method: 'DELETE', headers: { Cookie: cookie }, body: JSON.stringify({ current: 'a strong fixture password' }) });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: session.split(';')[0] } })).status, 401);
  const retained = removed.headers.getSetCookie().find(x => x.startsWith('gymsid='));
  assert.ok(retained);
  const last = await fetch(base + '/api/account/google', { method: 'DELETE', headers: { Cookie: retained.split(';')[0] }, body: '{}' });
  assert.notEqual(last.status, 200);
  const retainedCookie = retained.split(';')[0];
  const proofStart = await fetch(base + '/api/account/google/proof', { method: 'POST', headers: { Cookie: retainedCookie }, body: '{}' });
  const proofCallback = await callback(proofStart, retainedCookie);
  const proofCookie = proofCallback.headers.getSetCookie().find(x => x.startsWith('kuch_proof='));
  assert.ok(proofCookie);
  const restored = await fetch(base + '/api/account/password', { method: 'POST', headers: { Cookie: retainedCookie + '; ' + proofCookie.split(';')[0] }, body: JSON.stringify({ next: 'a strong fixture password' }) });
  assert.equal(restored.status, 200);
  const activeCookie = restored.headers.getSetCookie().find(x => x.startsWith('gymsid=')).split(';')[0];
  const disconnected = await fetch(base + '/api/account/google', { method: 'DELETE', headers: { Cookie: activeCookie }, body: JSON.stringify({ current: 'a strong fixture password' }) });
  assert.equal(disconnected.status, 200);
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: session.split(';')[0] } })).status, 401);
});

test('Google sign-in binds state to this browser and rejects unknown identities without creating a profile', async t => {
  const { base } = await start(t, true);
  const started = await fetch(base + '/api/auth/google/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo: '/admin' }) });
  assert.equal(started.status, 200);
  const target = new URL((await started.json()).url);
  assert.equal(target.searchParams.get('redirect_uri'), 'http://localhost:8080/gym/api/auth/google/callback');
  const code = Buffer.from(JSON.stringify({ nonce: target.searchParams.get('nonce') })).toString('base64url');
  const callback = base + '/api/auth/google/callback?state=' + target.searchParams.get('state') + '&code=' + code;
  const noCookie = await fetch(callback, { redirect: 'manual' });
  assert.equal(noCookie.status, 303);
  assert.match(noCookie.headers.get('location'), /authError=google-state$/);
  const result = await fetch(callback, { redirect: 'manual', headers: { Cookie: started.headers.getSetCookie()[0].split(';')[0] } });
  assert.equal(result.status, 303);
  assert.match(result.headers.get('location'), /\/gym\/#\/admin\?authError=google-unlinked$/);
  assert.equal((await fetch(base + '/api/me')).status, 401);
  const replay = await fetch(callback, { redirect: 'manual', headers: { Cookie: started.headers.getSetCookie()[0].split(';')[0] } });
  assert.equal(replay.status, 303);
  assert.match(replay.headers.get('location'), /authError=google-state$/);
});

test('Google callback rejects wrong audience, issuer, nonce, signature and expired tokens', async t => {
  const { base } = await start(t, true);
  for (const claims of [{ aud: 'attacker' }, { issuer: 'https://attacker.test' }, { nonce: 'wrong' }, { exp: 1 }, { badSignature: true }]) {
    const started = await fetch(base + '/api/auth/google/start', { method: 'POST', body: '{}' });
    const target = new URL((await started.json()).url);
    const code = Buffer.from(JSON.stringify({ nonce: target.searchParams.get('nonce'), ...claims })).toString('base64url');
    const result = await fetch(base + '/api/auth/google/callback?state=' + target.searchParams.get('state') + '&code=' + code,
      { redirect: 'manual', headers: { Cookie: started.headers.getSetCookie()[0].split(';')[0] } });
    assert.match(result.headers.get('location'), /authError=google-failed$/);
    assert.equal(result.headers.getSetCookie().some(x => x.startsWith('gymsid=')), false);
  }
});

test('Google identity conflicts and disabled profiles cannot sign in or merge', async t => {
  const h = await start(t, true, { users: [{ id: 'other', name: 'Other', disabled: true, google: { issuer: 'https://accounts.google.com', subject: 'occupied' } }] });
  for (const path of ['/api/account/google/link', '/api/auth/google/start']) {
    const started = await fetch(h.base + path, { method: 'POST', headers: { Cookie: h.cookie }, body: JSON.stringify({ current: 'a strong fixture password' }) });
    const target = new URL((await started.json()).url);
    const code = Buffer.from(JSON.stringify({ nonce: target.searchParams.get('nonce'), sub: 'occupied' })).toString('base64url');
    const result = await fetch(h.base + '/api/auth/google/callback?state=' + target.searchParams.get('state') + '&code=' + code, { redirect: 'manual', headers: { Cookie: h.cookie + '; ' + started.headers.getSetCookie()[0].split(';')[0] } });
    assert.match(result.headers.get('location'), path.includes('/link') ? /authError=google-conflict$/ : /authError=disabled$/);
    assert.equal(result.headers.getSetCookie().some(cookie => cookie.startsWith('gymsid=')), false);
  }
  const security = await fetch(h.base + '/api/account/security', { headers: { Cookie: h.cookie } });
  assert.equal((await security.json()).google.linked, false);
});

test('linking rejects a Google identity whose verified email belongs to another profile', async t => {
  const h = await start(t, true, { users: [{ id: 'other', name: 'Other', email: 'other@example.test', emailVerified: 'other@example.test' }] });
  const started = await fetch(h.base + '/api/account/google/link', { method: 'POST', headers: { Cookie: h.cookie }, body: JSON.stringify({ current: 'a strong fixture password' }) });
  assert.equal(started.status, 200);
  const target = new URL((await started.json()).url);
  const code = Buffer.from(JSON.stringify({ nonce: target.searchParams.get('nonce'), sub: 'fresh-google-person', email: 'OTHER@example.test', email_verified: true })).toString('base64url');
  const callback = await fetch(h.base + '/api/auth/google/callback?state=' + target.searchParams.get('state') + '&code=' + code,
    { redirect: 'manual', headers: { Cookie: h.cookie + '; ' + started.headers.getSetCookie()[0].split(';')[0] } });
  assert.match(callback.headers.get('location'), /authError=google-conflict$/);
  assert.equal(callback.headers.getSetCookie().some(value => value.startsWith('gymsid=')), false);
  const security = await (await fetch(h.base + '/api/account/security', { headers: { Cookie: h.cookie } })).json();
  assert.equal(security.google.linked, false);
});

test('Google confirmation requires a fresh provider authentication time', async t => {
  const h = await start(t, true, { admin: { google: { issuer: 'https://accounts.google.com', subject: 'known' } } });
  const started = await fetch(h.base + '/api/account/google/proof', { method: 'POST', headers: { Cookie: h.cookie }, body: '{}' });
  const target = new URL((await started.json()).url);
  assert.equal(target.searchParams.get('max_age'), '0');
  const code = Buffer.from(JSON.stringify({ nonce: target.searchParams.get('nonce'), sub: 'known', auth_time: 1 })).toString('base64url');
  const result = await fetch(h.base + '/api/auth/google/callback?state=' + target.searchParams.get('state') + '&code=' + code, { redirect: 'manual', headers: { Cookie: h.cookie + '; ' + started.headers.getSetCookie()[0].split(';')[0] } });
  assert.match(result.headers.get('location'), /authError=google-failed$/);
  assert.equal(result.headers.getSetCookie().some(cookie => cookie.startsWith('kuch_proof=')), false);
});

const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const mailToken = mail => new URLSearchParams(new URL(mail.text.match(/http\S+/)[0]).hash.split('?')[1]).get('token');

test('verification resends supersede old links, preserve the legacy address, and expire after 24 hours', async t => {
  const h = await start(t, false, { admin: { email: 'legacy@example.test' } });
  const request = email => fetch(h.base + '/api/account/email-verification', { method: 'POST', headers: { Cookie: h.cookie }, body: JSON.stringify({ email, current: 'a strong fixture password' }) });
  const verify = token => fetch(h.base + '/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) });
  assert.equal((await request('first@example.test')).status, 200);
  const old = mailToken(h.mail()[0]);
  assert.equal((await request('second@example.test')).status, 429);
  h.clock(61000);
  assert.equal((await request('second@example.test')).status, 200);
  assert.equal((await verify(old)).status, 400);
  assert.equal((await h.home.readDb()).users[0].email, 'legacy@example.test');
  h.clock(86400000 + 62000);
  assert.equal((await verify(mailToken(h.mail()[1]))).status, 400);
  assert.equal((await h.home.readDb()).users[0].email, 'legacy@example.test');
});

test('concurrent email verification keeps addresses unique', async t => {
  const email = 'shared@example.test';
  const record = token => ({ hash: tokenHash(token), email, exp: Date.now() + 86400000, version: 0 });
  const h = await start(t, false, { admin: { emailVerification: record('first') }, users: [{ id: 'second', name: 'Second', emailVerification: record('second') }] });
  const responses = await Promise.all(['first', 'second'].map(token => fetch(h.base + '/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await h.home.readDb()).users.filter(u => u.email === email).length, 1);
});

test('legacy unverified email can still sign in but cannot recover a password', async t => {
  const h = await start(t, false, { admin: { email: 'legacy@example.test' } });
  const recovery = await fetch(h.base + '/api/auth/email/recover', { method: 'POST', body: JSON.stringify({ email: 'legacy@example.test' }) });
  assert.equal(recovery.status, 200);
  assert.equal(h.mail().length, 0);
  const login = await fetch(h.base + '/api/login/password', { method: 'POST', body: JSON.stringify({ identifier: 'legacy@example.test', password: 'a strong fixture password' }) });
  assert.equal(login.status, 200);
});

test('only one concurrent recovery redemption succeeds and expiry is enforced', async t => {
  const email = 'verified@example.test';
  const h = await start(t, false, { admin: { email, emailVerified: email, emailRecovery: { hash: tokenHash('reset'), email, version: 0, exp: Date.now() + 1800000 } } });
  const redeem = () => fetch(h.base + '/api/auth/email/reset', { method: 'POST', body: JSON.stringify({ token: 'reset', password: 'a new strong fixture password' }) });
  const responses = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal((await fetch(h.base + '/api/me', { headers: { Cookie: h.cookie } })).status, 401);
  const expired = await start(t, false, { admin: { email, emailVerified: email, emailRecovery: { hash: tokenHash('expired'), email, version: 0, exp: Date.now() - 1 } } });
  assert.equal((await fetch(expired.base + '/api/auth/email/reset', { method: 'POST', body: JSON.stringify({ token: 'expired', password: 'another strong fixture password' }) })).status, 400);
});

test('a deployment-disabled Google method does not permit removing the last password', async t => {
  const h = await start(t, false, { admin: { google: { issuer: 'https://accounts.google.com', subject: 'person' } } });
  const response = await fetch(h.base + '/api/account/password', { method: 'DELETE', headers: { Cookie: h.cookie }, body: JSON.stringify({ current: 'a strong fixture password' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'last-way-in');
});
