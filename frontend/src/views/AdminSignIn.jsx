import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api, passwordLogin, passkeyLogin } from '../lib/api.js'
import { useAdminLanguage, languages } from '../lib/admin-language.js'
import { askAddDeviceData } from '../sheets.jsx'
import { adminError } from '../lib/admin-errors.js'
import { MOBILE } from '../lib/mobile.js'

export default function AdminSignIn() {
  const config = useStore(s => s.config)
  const setUser = useStore(s => s.setUser)
  const adoptProfile = useStore(s => s.adoptProfile)
  const nav = useNavigate()
  const { locale, setLocale, t } = useAdminLanguage(null)
  const query = new URLSearchParams(location.hash.split('?')[1] || '')
  const [mode, setMode] = useState(query.get('action') || 'login')
  const [token] = useState(query.get('token') || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(adminError(query.get('authError') || ''))
  const run = async fn => {
    if (busy) return
    setBusy(true); setMessage('')
    try { await fn() } catch (e) { setMessage(adminError(e)) }
    finally { setBusy(false) }
  }
  const signedIn = async user => { setUser(user, { adopt: true }); await adoptProfile(askAddDeviceData); if (query.has('action') || query.has('authError')) nav('/admin', { replace: true }) }
  const submit = e => {
    e.preventDefault()
    run(async () => {
      if (mode === 'login') await signedIn(await passwordLogin(email, password))
      else if (mode === 'verify') { await api('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) }); setMessage('Email verified. Sign in to continue.'); setMode('login'); nav('/admin', { replace: true }) }
      else if (mode === 'reset') { await api('/api/auth/email/reset', { method: 'POST', body: JSON.stringify({ token, password }) }); setPassword(''); setMessage('Password changed. Sign in again.'); setMode('login'); nav('/admin', { replace: true }) }
      else { await api('/api/auth/email/recover', { method: 'POST', body: JSON.stringify({ email }) }); setMessage('If this address is eligible, a recovery link has been sent. Check your mail or try another sign-in method.') }
    })
  }
  return <main className="narrow" lang={locale}>
    <select aria-label={t('Admin language')} className="adm-select" value={locale} onChange={e => setLocale(e.target.value)}>
      {Object.entries(languages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <h1>{t('Admin workspace')}</h1>
    <form onSubmit={submit}>
      {['login', 'recover'].includes(mode) && <label>{t('Login email')}<input className="input" name="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>}
      {['login', 'reset'].includes(mode) && <label>{t(mode === 'reset' ? 'New password' : 'Password')}<input className="input" name="password" type={show ? 'text' : 'password'} autoComplete={mode === 'reset' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required />
        <button type="button" className="btn" onClick={() => setShow(!show)}>{t(show ? 'Hide password' : 'Show password')}</button></label>}
      <button type="submit" className="btn primary" disabled={busy || (mode === 'login' && !config?.password_login)}>{t(mode === 'login' ? 'Sign in' : mode === 'verify' ? 'Verify email' : mode === 'reset' ? 'Reset password' : 'Send recovery link')}</button>
    </form>
    {mode === 'login' && <>
      {!config?.password_login && <p>{t('Password sign-in is unavailable on this server.')}</p>}
      <button className="btn" disabled={busy || MOBILE || !config?.google_login} onClick={() => run(async () => { const r = await api('/api/auth/google/start', { method: 'POST', body: JSON.stringify({ returnTo: location.hash.slice(1) || '/admin' }) }); location.assign(r.url) })}>{t('Sign in with Google')}</button>
      {!config?.google_login && <p>{t('Google sign-in is unavailable on this server.')}</p>}
      <button className="btn" disabled={busy} onClick={() => run(async () => signedIn(await passkeyLogin()))}>{t('Sign in with a passkey')}</button>
      <button className="btn" onClick={() => setMode('recover')}>{t('Forgot password?')}</button>
    </>}
    {mode !== 'login' && <button className="btn" onClick={() => setMode('login')}>{t('Sign in')}</button>}
    <button className="btn" onClick={() => nav('/home')}>{t('Home')}</button>
    {message && <p role="status">{t(message)}</p>}
  </main>
}
