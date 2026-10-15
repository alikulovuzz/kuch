import crypto from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

// Google owns the endpoints; no caller-supplied issuer, keys or token URL is trusted.
export function googleAuth({ publicBase, clientId, clientSecret }) {
  let base;
  try {
    base = new URL(publicBase);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) base = null;
  } catch { base = null; }
  const available = !!(base && clientId && clientSecret);
  const callback = base ? new URL('api/auth/google/callback', base.href.replace(/\/?$/, '/')).href : '';
  const cookieName = base?.protocol === 'https:' ? '__Host-kuch_google' : 'kuch_google';
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${base?.protocol === 'https:' ? '; Secure' : ''}`;
  const pending = new Map();
  const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { [customFetch]: (...args) => fetch(...args) });
  const returnPath = value => typeof value === 'string' && /^\/admin(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(value) ? value : '/admin';
  function begin(returnTo, link = null) {
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    if (pending.size >= 1000) throw new Error('busy');
    const state = crypto.randomBytes(32).toString('base64url');
    const browser = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    pending.set(state, { browser, nonce, verifier, link, returnTo: returnPath(returnTo), started: Math.floor(Date.now() / 1000), expires: Date.now() + 300000 });
    const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    target.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'openid email',
      state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' });
    if (link?.proof) target.searchParams.set('max_age', '0');
    return { url: target.href, cookie: cookie(browser, 300) };
  }
  async function finish(req) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const state = query.get('state');
    const transaction = pending.get(state);
    const values = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(cookieName + '='));
    const browser = values.length === 1 ? values[0].slice(cookieName.length + 1) : null;
    if (!transaction || transaction.expires < Date.now() || !browser || browser !== transaction.browser) return null;
    pending.delete(state);
    const result = { returnTo: transaction.returnTo, link: transaction.link, cookie: cookie('', 0) };
    if (query.has('error')) return { ...result, error: 'google-cancelled' };
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({ code: query.get('code') || '', client_id: clientId, client_secret: clientSecret,
          redirect_uri: callback, grant_type: 'authorization_code', code_verifier: transaction.verifier }) });
      if (!response.ok) throw new Error('provider');
      const tokens = await response.json();
      const { payload } = await jwtVerify(tokens.id_token, keys, { algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId, requiredClaims: ['exp', 'iat', 'sub', 'nonce'], maxTokenAge: '10m' });
      if (payload.nonce !== transaction.nonce || typeof payload.sub !== 'string' || !payload.sub || (payload.azp && payload.azp !== clientId)) throw new Error('identity');
      if (transaction.link?.proof && (!Number.isFinite(payload.auth_time) || payload.auth_time < transaction.started - 5 || payload.auth_time > Date.now() / 1000 + 5)) throw new Error('stale-proof');
      return { ...result, subject: payload.sub };
    } catch { return { ...result, error: 'google-failed' }; }
  }
  const destination = (returnTo, error) => base.href.replace(/\/?$/, '/') + '#' + returnPath(returnTo) + (error ? (returnTo.includes('?') ? '&' : '?') + 'authError=' + encodeURIComponent(error) : '');
  return { available, begin, finish, destination };
}
