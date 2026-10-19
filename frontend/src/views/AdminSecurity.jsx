import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { passkeyAssertion, createPasskey } from '../lib/api.js'
import { adminApi as api } from '../lib/admin-api.js'
import { useAdminLanguage } from '../lib/admin-language.js'
import { acceptSession } from '../lib/remote.js'
import { MOBILE } from '../lib/mobile.js'
import { adminError } from '../lib/admin-errors.js'
import Icon from '../components/Icon.jsx'

export default function AdminSecurity({ tick = 0, onDirty = () => {}, onStatus = () => {} }) {
  const user = useStore(s => s.user)
  const signOut = useStore(s => s.signOut)
  const signOutAll = useStore(s => s.signOutAll)
  const { t, number } = useAdminLanguage(user?.id)
  const [status, setStatus] = useState(null)
  const [current, setCurrent] = useState('')
  const [email, setEmail] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [proofKind, setProofKind] = useState('password')
  const [confirm, setConfirm] = useState(null)
  const confirmDialog = useRef(null)
  const confirmReturn = useRef(null)
  const securityHeading = useRef(null)
  const openConfirm = value => { confirmReturn.current = document.activeElement; setConfirm(value) }
  const [keyNames, setKeyNames] = useState({})
  const [readyKey, setReadyKey] = useState(null)
  const hasDraft = !!(current || email || next || readyKey || Object.keys(keyNames).length)
  const otherDraft = !!(email || next || readyKey || Object.keys(keyNames).length)
  const inFlight = useRef(false)
  const remoteBase = useStore(s => s.sync?.server)
  const load = () => api('/api/account/security').then(result => { setStatus(result); onStatus(result) }).catch(e => setMessage(adminError(e)))
  useEffect(() => { load() }, [tick])
  useEffect(() => { onDirty(hasDraft) }, [hasDraft])
  useEffect(() => {
    if (confirm) confirmDialog.current?.showModal?.()
    else {
      confirmDialog.current?.close?.()
      if (confirmReturn.current) {
        const target = confirmReturn.current.isConnected ? confirmReturn.current : securityHeading.current
        target?.focus()
        confirmReturn.current = null
      }
    }
  }, [confirm])
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
    setMessage('Saved'); await load(); setConfirm(null)
  })
  if (!status) return <section className="card"><p role="status">{t(message || 'Loading…')}</p><button className="btn" onClick={load}>{t('Try again')}</button></section>
  return <div className="adm-security-layout">
    <p className="adm-security-note">{t('Keep a backup sign-in method. Removing a method revokes other browser and mobile sessions.')}
      {MOBILE && <> {t('Manage Google and passkeys in your browser. Browser sign-in is separate from this paired app.')} <a href={(remoteBase || '').replace(/\/+$/, '') + '/#/admin?section=security'} target="_blank" rel="noopener noreferrer">{t('Open in browser')}</a></>}
    </p>
    <section className="card adm-security-methods">
    <h2 ref={securityHeading} tabIndex={-1}>{t('Sign-in methods')}</h2>
    <section className="adm-method">
      <div className="adm-method-head"><Icon name="lock" /><div><h3>{t('Password')}</h3><p>{t(status.password.set ? 'Password configured' : 'No password configured')}</p></div><span className={'adm-pill ' + (status.password.set ? 'ok' : '')}>{t(status.password.set ? 'Configured' : 'Not configured')}</span></div>
      {status.password.set && <div className="adm-method-actions"><button className="btn danger" disabled={busy} onClick={() => openConfirm('password')}>{t('Remove password')}</button></div>}
      {!status.password.available && <p>{t('Password sign-in is unavailable on this server.')}</p>}
    </section>
    <section className="adm-method">
    <div className="adm-method-head"><Icon name="key" /><div><h3>{t('Passkeys')}</h3><p>{t('{0} passkeys', number(status.passkeys))}</p></div></div>
    {(status.passkeyDetails || []).map((key, index) => <div key={key.id} className="adm-field">
      <label>{t('Passkey name')}<input className="input" value={keyNames[key.id] ?? key.name ?? t('Passkey {0}', index + 1)} maxLength={40} onChange={e => setKeyNames(names => ({ ...names, [key.id]: e.target.value }))} /></label>
      <div className="adm-method-actions"><button className="btn" disabled={busy || !(key.id in keyNames)} onClick={() => mutate('/api/account/passkeys/rename', { id: key.id, name: keyNames[key.id] })}>{t('Save')}</button>
      <button className="btn danger" disabled={busy} onClick={() => openConfirm({ keyId: key.id })}>{t('Remove passkey')}</button></div>
    </div>)}
    <div className="adm-method-actions">
    {readyKey ? <button className="btn primary" disabled={busy} onClick={() => run(async () => {
      try {
        const credential = await createPasskey(readyKey.options)
        await api('/api/account/passkeys/verify', { method: 'POST', body: JSON.stringify({ cid: readyKey.cid, credential }) })
        setReadyKey(null); setMessage('Saved'); await load()
      } catch (e) { if (e.status) setReadyKey(null); throw e }
    })}>{t('Create passkey')}</button> : <button className="btn primary" disabled={busy || MOBILE} onClick={() => run(async () => {
      const proof = await ownerProof()
      setReadyKey(await api('/api/account/passkeys/options', { method: 'POST', body: JSON.stringify(proof) }))
      setCurrent('')
    })}><Icon name="plus" />{t('Add a passkey')}</button>}
    </div>
    </section>
    <section className="adm-method">
    <div className="adm-method-head"><Icon name="envelope" /><div><h3>{t('Login email')}</h3><p>{status.email || '–'}</p></div><span className={'adm-pill ' + (status.emailVerified ? 'ok' : 'warn')}>{t(status.emailVerified ? 'Verified' : 'Not verified')}</span></div>
    {status.pendingEmail && <p>{t('Pending verification')}: {status.pendingEmail}</p>}
    {!status.mailAvailable && <p className="adm-hint">{t('Outgoing mail is not configured. Contact the server operator or use another sign-in method.')}</p>}
    {status.mailAvailable && status.password.available && <><label>{t('New login email')}<input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <div className="adm-method-actions"><button className="btn" disabled={busy} onClick={() => mutate('/api/account/email-verification', { email: email || status.pendingEmail || status.email })}>{t('Send verification link')}</button></div></>}
    {(status.email || status.pendingEmail) && <div className="adm-method-actions"><button className="btn danger" disabled={busy} onClick={() => openConfirm('email')}>{t('Remove login email')}</button></div>}
    </section>
    <section className="adm-method">
    <div className="adm-method-head"><Icon name="globe" /><div><h3>Google</h3><p>{t(status.google.linked ? 'Linked' : 'Not linked')}</p></div></div>
    <div className="adm-method-actions">
    {status.google.available && status.google.linked && <button className="btn" disabled={busy || MOBILE || hasDraft} onClick={() => run(async () => { const r = await api('/api/account/google/proof', { method: 'POST', body: '{}' }); location.assign(r.url) })}>{t('Confirm with Google before making a change')}</button>}
    {status.google.available && <button className="btn" disabled={busy || MOBILE || (!status.google.linked && otherDraft)} onClick={() => status.google.linked ? openConfirm('google') : mutate('/api/account/google/link', { returnTo: '/admin?section=security' })}>{t(status.google.linked ? 'Disconnect Google' : 'Connect Google')}</button>}
    </div>
    {!status.google.available && <p className="adm-hint">{t('Google sign-in is unavailable on this server.')}</p>}
    </section>
    </section>
    <aside className="adm-security-side">
    <section className="card">
    <h2>{t('Confirm your identity')}</h2>
    <label>{t('Confirm your identity')}<select className="adm-select" value={proofKind} onChange={e => setProofKind(e.target.value)}>
      <option value="password">{t('Current password')}</option>{status.passkeys > 0 && <option value="passkey">{t('Passkey')}</option>}
    </select></label>
    {proofKind === 'password' && <label>{t('Current password')}<input className="input" name="current-password" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>}
    {status.password.available ? <><label>{t('New password')}<input className="input" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
      <button className="btn primary" disabled={busy || !next} onClick={() => mutate('/api/account/password', { next })}>{t('Save password')}</button></> : null}
    </section>
    <section className="card">
    <h2>{t('Sessions')}</h2>
    <div className="adm-session-actions">
    <button className="btn" disabled={busy} onClick={() => hasDraft ? openConfirm('signout') : run(async () => { const result = await signOut(); if (result?.owed && !result.stashed) setMessage('Sync pending changes before signing out.') })}>{t('Sign out')}</button>
    <button className="btn" disabled={busy} onClick={() => openConfirm('sessions')}>{t('Sign out everywhere')}</button>
    </div>
    <p className="adm-lead">{t('If all sign-in methods are lost, contact the server operator to recover this existing profile.')}</p>
    </section>
    </aside>
    {confirm && <dialog ref={confirmDialog} className="card adm-leave" role="alertdialog" aria-labelledby="adm-security-confirm-title" aria-describedby="adm-security-confirm-description" onCancel={event => { event.preventDefault(); setConfirm(null) }}>
      <h3 id="adm-security-confirm-title">{t(confirm === 'signout' ? 'Discard changes and sign out?' : 'Confirm removal')}</h3>
      <p id="adm-security-confirm-description">{t(hasDraft ? 'Your unsaved account changes will be discarded. Continue?' : 'This revokes browser and paired mobile sessions. Continue?')}</p>
      <button className="btn" autoFocus onClick={() => setConfirm(null)}>{t('Cancel')}</button>
      <button className="btn danger" disabled={busy} onClick={() => confirm === 'signout' ? run(async () => { const result = await signOut(); if (result?.owed && !result.stashed) setMessage('Sync pending changes before signing out.'); else setConfirm(null) }) : confirm === 'sessions' ? run(async () => { const result = await signOutAll(); if (result?.owed && !result.stashed) setMessage('Sync pending changes before signing out.'); else setConfirm(null) }) : mutate(confirm.keyId ? '/api/account/passkeys?id=' + encodeURIComponent(confirm.keyId) : '/api/account/' + confirm, {}, 'DELETE')}>{t('Confirm')}</button>
    </dialog>}
    {message && <p role="status" className="adm-security-feedback">{t(message)}</p>}
  </div>
}
