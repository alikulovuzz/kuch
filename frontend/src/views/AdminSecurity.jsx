import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { passkeyAssertion, createPasskey } from '../lib/api.js'
import { adminApi as api } from '../lib/admin-api.js'
import { useAdminLanguage } from '../lib/admin-language.js'
import { acceptSession } from '../lib/remote.js'
import { MOBILE } from '../lib/mobile.js'
import { adminError } from '../lib/admin-errors.js'

export default function AdminSecurity({ tick = 0, onDirty = () => {} }) {
  const user = useStore(s => s.user)
  const signOut = useStore(s => s.signOut)
  const signOutAll = useStore(s => s.signOutAll)
  const { t } = useAdminLanguage(user?.id)
  const [status, setStatus] = useState(null)
  const [current, setCurrent] = useState('')
  const [email, setEmail] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [proofKind, setProofKind] = useState('password')
  const [confirm, setConfirm] = useState(null)
  const [keyNames, setKeyNames] = useState({})
  const [readyKey, setReadyKey] = useState(null)
  const inFlight = useRef(false)
  const remoteBase = useStore(s => s.sync?.server)
  const load = () => api('/api/account/security').then(setStatus).catch(e => setMessage(adminError(e)))
  useEffect(() => { load() }, [tick])
  useEffect(() => { onDirty(!!(current || email || next || readyKey || Object.keys(keyNames).length)) }, [current, email, next, readyKey, keyNames])
  const run = async fn => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setMessage('')
    try { await fn() } catch (e) { setMessage(adminError(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  const ownerProof = () => proofKind === 'passkey' ? passkeyAssertion() : Promise.resolve({ current })
  const mutate = (path, body = {}, method = 'POST') => run(async () => {
    const proof = await ownerProof()
    const result = await acceptSession(await api(path, { method, body: JSON.stringify({ ...body, ...proof }) }))
    if (result.url) { location.assign(result.url); return }
    setCurrent('')
    if (path === '/api/account/password') setNext('')
    if (path === '/api/account/email-verification') setEmail('')
    if (path === '/api/account/passkeys/rename') setKeyNames(names => { const rest = { ...names }; delete rest[body.id]; return rest })
    setConfirm(null); setMessage('Saved'); await load()
  })
  if (!status) return <section className="card"><p role="status">{t(message || 'Loading…')}</p><button className="btn" onClick={load}>{t('Try again')}</button></section>
  return <section className="card">
    <h2>{t('My account → Security')}</h2>
    {MOBILE && <p>{t('Manage Google and passkeys in your browser. Browser sign-in is separate from this paired app.')} <a href={(remoteBase || '').replace(/\/+$/, '') + '/#/admin?section=security'} target="_blank" rel="noopener noreferrer">{t('Open in browser')}</a></p>}
    <p>{t('Keep a backup sign-in method. Removing a method revokes other browser and mobile sessions.')}</p>
    <label>{t('Confirm your identity')}<select className="adm-select" value={proofKind} onChange={e => setProofKind(e.target.value)}>
      <option value="password">{t('Current password')}</option>{status.passkeys > 0 && <option value="passkey">{t('Passkey')}</option>}
    </select></label>
    {proofKind === 'password' && <label>{t('Current password')}<input className="input" name="current-password" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>}
    <h3>Google</h3><p>{t(status.google.linked ? 'Linked' : 'Not linked')}</p>
    {status.google.available && status.google.linked && <button className="btn" disabled={busy || MOBILE || !!(email || next || Object.keys(keyNames).length)} onClick={() => run(async () => { const r = await api('/api/account/google/proof', { method: 'POST', body: '{}' }); location.assign(r.url) })}>{t('Confirm with Google before making a change')}</button>}
    {!status.google.available && <p>{t('Google sign-in is unavailable on this server.')}</p>}
    <button className="btn" disabled={busy || MOBILE || !status.google.available || (!status.google.linked && !!(email || next || Object.keys(keyNames).length))} onClick={() => status.google.linked ? setConfirm('google') : mutate('/api/account/google/link', { returnTo: '/admin?section=security' })}>{t(status.google.linked ? 'Disconnect Google' : 'Connect Google')}</button>
    <h3>{t('Login email')}</h3>
    <p>{status.email || '—'} · {t(status.emailVerified ? 'Verified' : 'Not verified')}</p>
    {status.pendingEmail && <p>{t('Pending verification')}: {status.pendingEmail}</p>}
    {!status.mailAvailable && <p>{t('Outgoing mail is not configured. Contact the server operator or use another sign-in method.')}</p>}
    <label>{t('New login email')}<input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
    <button className="btn" disabled={busy || !status.mailAvailable || !status.password.available} onClick={() => mutate('/api/account/email-verification', { email: email || status.pendingEmail || status.email })}>{t('Send verification link')}</button>
    {(status.email || status.pendingEmail) && <button className="btn danger" disabled={busy} onClick={() => setConfirm('email')}>{t('Remove login email')}</button>}
    <h3>{t('Password')}</h3>
    <p>{t(status.password.set ? 'Password configured' : 'No password configured')}</p>
    <label>{t('New password')}<input className="input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
    <button className="btn" disabled={busy || !status.password.available || !next} onClick={() => mutate('/api/account/password', { next })}>{t('Save password')}</button>
    {status.password.set && <button className="btn" disabled={busy} onClick={() => setConfirm('password')}>{t('Remove password')}</button>}
    <h3>{t('Passkeys')}</h3>
    {(status.passkeyDetails || []).map((key, index) => <div key={key.id} className="adm-field">
      <label>{t('Passkey name')}<input className="input" value={keyNames[key.id] ?? key.name ?? t('Passkey {0}', index + 1)} maxLength={40} onChange={e => setKeyNames(names => ({ ...names, [key.id]: e.target.value }))} /></label>
      <button className="btn" disabled={busy || !(key.id in keyNames)} onClick={() => mutate('/api/account/passkeys/rename', { id: key.id, name: keyNames[key.id] })}>{t('Save')}</button>
      <button className="btn danger" disabled={busy} onClick={() => setConfirm({ keyId: key.id })}>{t('Remove passkey')}</button>
    </div>)}
    {readyKey ? <button className="btn" disabled={busy} onClick={() => run(async () => {
      try {
        const credential = await createPasskey(readyKey.options)
        await api('/api/account/passkeys/verify', { method: 'POST', body: JSON.stringify({ cid: readyKey.cid, credential }) })
        setReadyKey(null); setMessage('Saved'); await load()
      } catch (e) { if (e.status) setReadyKey(null); throw e }
    })}>{t('Create passkey')}</button> : <button className="btn" disabled={busy || MOBILE} onClick={() => run(async () => {
      const proof = await ownerProof()
      setReadyKey(await api('/api/account/passkeys/options', { method: 'POST', body: JSON.stringify(proof) }))
      setCurrent('')
    })}>{t('Add a passkey')}</button>}
    <p>{t('If all sign-in methods are lost, contact the server operator to recover this existing profile.')}</p>
    <button className="btn" disabled={busy} onClick={() => run(async () => { const result = await signOut(); if (result?.owed && !result.stashed) setMessage('Sync pending changes before signing out.') })}>{t('Sign out')}</button>
    <button className="btn" disabled={busy} onClick={() => setConfirm('sessions')}>{t('Sign out everywhere')}</button>
    {confirm && <div role="group" aria-label={t('Confirm removal')}>
      <p>{t('This revokes browser and paired mobile sessions. Continue?')}</p>
      <button className="btn danger" disabled={busy} onClick={() => confirm === 'sessions' ? run(async () => { const result = await signOutAll(); if (result?.owed && !result.stashed) setMessage('Sync pending changes before signing out.') }) : mutate(confirm.keyId ? '/api/account/passkeys?id=' + encodeURIComponent(confirm.keyId) : '/api/account/' + confirm, {}, 'DELETE')}>{t('Confirm')}</button>
      <button className="btn" onClick={() => setConfirm(null)}>{t('Cancel')}</button>
    </div>}
    {message && <p role="status">{t(message)}</p>}
  </section>
}
