// Loaded only by the integration-test child. Production endpoints remain fixed to Google.
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
const realNow = Date.now;
Date.now = () => {
  try { return realNow() + Number(fs.readFileSync(path.join(process.env.DATA_DIR, 'clock-offset.txt'), 'utf8')); }
  catch { return realNow(); }
};
nodemailer.createTransport = () => ({ sendMail: async mail => {
  fs.appendFileSync(path.join(process.env.DATA_DIR, 'test-mail.jsonl'), JSON.stringify(mail) + '\n');
  return { accepted: [mail.to] };
} });
const { privateKey, publicKey } = await generateKeyPair('RS256');
const rogueKey = (await generateKeyPair('RS256')).privateKey;
const publicJwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(options.body);
    const claims = JSON.parse(Buffer.from(params.get('code'), 'base64url').toString());
    const token = await new SignJWT({ nonce: claims.nonce, auth_time: claims.auth_time ?? Math.floor(Date.now() / 1000) }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .setSubject(claims.sub || 'google-person').setIssuer(claims.issuer || 'https://accounts.google.com')
      .setAudience(claims.aud || 'fixture-client').setIssuedAt().setExpirationTime(claims.exp || '5m').sign(claims.badSignature ? rogueKey : privateKey);
    return Response.json({ id_token: token });
  }
  return originalFetch(url, options);
};
