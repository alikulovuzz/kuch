import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, passwordLogin, passkeyLogin } from '../lib/api.js'
import { useAdminLanguage, languages } from '../lib/admin-language.js'
import { adminError } from '../lib/admin-errors.js'
import { MOBILE } from '../lib/mobile.js'
import { normalizeServerUrl } from '../lib/remote.js'
import { ConnectSheet } from './MobileOnboarding.jsx'

function AdminAdoptPrompt({ extras, finish }) {
  const { t } = useAdminLanguage()
  const hasWorkouts = !!(extras.workouts || extras.bodyweight || extras.customEx)
  return <section role="group" aria-label={t('Local workout data')}>
    <h3>{t(hasWorkouts ? 'Add this device’s workouts to your profile?' : 'Add this device’s plan to your profile?')}</h3>
    <p>{t('This browser has workout data from before sign-in. Add it to this profile, or keep the profile exactly as it is on the server.')}</p>
    <button className="btn" onClick={() => finish(true)}>{t('Add them')}</button>
    <button className="btn" onClick={() => finish(false)}>{t('Keep profile as is')}</button>
  </section>
}

function AdminConnectSheet({ close, initialUrl }) {
  const { t } = useAdminLanguage(null)
  return <ConnectSheet close={close} initialUrl={initialUrl} translate={t} />
}

export default function AdminSignIn() {
  const config = useStore(s => s.config)
  const setUser = useStore(s => s.setUser)
  const adoptProfile = useStore(s => s.adoptProfile)
  const openSheet = useUI(s => s.openSheet)
  const remoteBase = useStore(s => s.sync?.server)
  const nav = useNavigate()
  const locationState = useLocation()
  const { locale, setLocale, t } = useAdminLanguage(null)
  const query = new URLSearchParams(locationState.search)
  const [mode, setMode] = useState(query.get('action') || 'login')
  const token = query.get('token') || ''
  useEffect(() => { setMode(query.get('action') || 'login') }, [locationState.search])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [serverInput, setServerInput] = useState(remoteBase || '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(adminError(query.get('authError') || ''))
  const run = async fn => {
    if (busy) return
    setBusy(true); setMessage('')
    try { await fn() } catch (e) { setMessage(adminError(e)) }
    finally { setBusy(false) }
  }
  const signedIn = async user => {
    setUser(user, { adopt: true })
    await adoptProfile(extras => new Promise(resolve => {
      openSheet(close => <AdminAdoptPrompt extras={extras} finish={answer => { close(); resolve(answer) }} />, { locked: true })
    }))
    if (query.has('action') || query.has('authError')) nav('/admin', { replace: true })
  }
  const submit = e => {
    e.preventDefault()
    run(async () => {
      if (mode === 'login') await signedIn(await passwordLogin(email, password))
      else if (mode === 'verify') { await api('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) }); setMessage('Email verified. Sign in to continue.'); setMode('login'); nav('/admin', { replace: true }) }
      else if (mode === 'reset') { await api('/api/auth/email/reset', { method: 'POST', body: JSON.stringify({ token, password }) }); setPassword(''); setMessage('Password changed. Sign in again.'); setMode('login'); nav('/admin', { replace: true }) }
      else { await api('/api/auth/email/recover', { method: 'POST', body: JSON.stringify({ email }) }); setMessage('If this address is eligible, a recovery link has been sent. Check your mail or try another sign-in method.') }
    })
  }
  const heading = mode === 'login' ? 'Sign in' : mode === 'verify' ? 'Verify email' : mode === 'reset' ? 'Reset password' : 'Forgot password?'
  const server = normalizeServerUrl(serverInput)
  const nativeDestination = '/#/admin' + (query.get('section') === 'security' ? '?section=security' : '')
  if (MOBILE) return <main className="narrow adm-auth" lang={locale}>
    <div className="adm-auth-top">
      <span>{t('Admin workspace')}</span>
      <select aria-label={t('Admin language')} className="adm-select" value={locale} onChange={e => setLocale(e.target.value)}>
        {Object.entries(languages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    <section className="adm-auth-card">
      <h1>{t('Connect your admin account')}</h1>
      <p className="adm-auth-note adm-auth-intro">{t('Sign in to your Kuch server in a browser. Then open Settings → Account → Pair the mobile app and enter the code here.')}</p>
      <div className="adm-auth-form">
        <div className="adm-auth-field"><label htmlFor="adm-auth-server">{t('Server address')}</label><input id="adm-auth-server" className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" value={serverInput} onChange={e => setServerInput(e.target.value)} placeholder="https://example.com" /></div>
        {server ? <a className="btn primary adm-auth-submit" href={server.replace(/\/+$/, '') + nativeDestination} target="_blank" rel="noopener noreferrer">{t('Open server sign-in in browser')}</a> : <p className="adm-auth-note">{t('Enter your server address to open sign-in.')}</p>}
        <button className="btn adm-auth-submit" onClick={() => openSheet(close => <AdminConnectSheet close={close} initialUrl={server || serverInput} />)}>{t('Pair this app with a code')}</button>
      </div>
    </section>
    <button className="adm-auth-text-button adm-auth-home" onClick={() => nav('/home')}>{t('Home')}</button>
  </main>
  return <main className="narrow adm-auth" lang={locale}>
    <div className="adm-auth-top">
      <span>{t('Admin workspace')}</span>
      <select aria-label={t('Admin language')} className="adm-select" value={locale} onChange={e => setLocale(e.target.value)}>
        {Object.entries(languages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
    <section className="adm-auth-card">
      <h1>{t(heading)}</h1>
      <form onSubmit={submit} className="adm-auth-form">
        {['login', 'recover'].includes(mode) && <div className="adm-auth-field"><label htmlFor="adm-auth-email">{t(mode === 'login' ? 'Name or login email' : 'Login email')}</label><input id="adm-auth-email" className="input" name="email" type={mode === 'recover' ? 'email' : 'text'} inputMode={mode === 'recover' ? 'email' : 'text'} autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></div>}
        {['login', 'reset'].includes(mode) && <div className="adm-auth-field">
          <div className="adm-auth-field-head"><label htmlFor="adm-auth-password">{t(mode === 'reset' ? 'New password' : 'Password')}</label><button type="button" className="adm-auth-visibility" onClick={() => setShow(!show)}>{t(show ? 'Hide password' : 'Show password')}</button></div>
          <input id="adm-auth-password" className="input" name="password" type={show ? 'text' : 'password'} autoComplete={mode === 'reset' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required />
        </div>}
        <button type="submit" className="btn primary adm-auth-submit" disabled={busy || (mode === 'login' && !config?.password_login)}>{t(mode === 'login' ? 'Sign in' : mode === 'verify' ? 'Verify email' : mode === 'reset' ? 'Reset password' : 'Send recovery link')}</button>
      </form>
      {mode === 'login' && <>
        {!config?.password_login && <p className="adm-auth-note">{t('Password sign-in is unavailable on this server.')}</p>}
        <div className="adm-auth-options">
          {config?.google_login && !MOBILE ? <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api('/api/auth/google/start', { method: 'POST', body: JSON.stringify({ returnTo: location.hash.slice(1) || '/admin' }) }); location.assign(r.url) })}>{t('Sign in with Google')}</button> : <p className="adm-auth-note">{t('Google sign-in is unavailable on this server.')}</p>}
          <button className="btn" disabled={busy} onClick={() => run(async () => signedIn(await passkeyLogin()))}>{t('Sign in with a passkey')}</button>
        </div>
        <button className="adm-auth-text-button" onClick={() => setMode('recover')}>{t('Forgot password?')}</button>
      </>}
      {mode !== 'login' && <button className="adm-auth-text-button" onClick={() => setMode('login')}>{t('Sign in')}</button>}
      {message && <p role="status" className="adm-auth-message">{t(message)}</p>}
    </section>
    <button className="adm-auth-text-button adm-auth-home" onClick={() => nav('/home')}>{t('Home')}</button>
  </main>
}
