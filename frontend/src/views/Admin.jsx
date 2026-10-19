import { useEffect, useRef, useState } from 'react'
import { useNavigate, useBlocker } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { adminApi as api } from '../lib/admin-api.js'
import { auditCat, auditLine } from '../lib/audit.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import AdminCoach from './AdminCoach.jsx'
import AdminSecurity from './AdminSecurity.jsx'
import AdminAccess from './AdminAccess.jsx'
import '../admin.css'
import { useAdminLanguage, languages } from '../lib/admin-language.js'
import { appBase } from '../lib/app-base.js'
import { MOBILE } from '../lib/mobile.js'
import { adminError } from '../lib/admin-errors.js'

// Admin-only operator dashboard (owner passkey + admin flag; guarded again server-side).
//
// One page of cards, each opening with a sentence that says what it is for. An operator who
// looks at this twice a year should not have to remember what "synced 3d ago" or an invite
// code means.


// The one time the reset code is visible. Locked, so a tap beside the sheet cannot lose it
// before it has been copied or written down.
function ResetCodeSheet({ name, email, code, expires, close }) {
  const { t, date } = useAdminLanguage()
  const [copyStatus, setCopyStatus] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const toast = useUI(s => s.toast)
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyStatus('Copied'); toast(t('Copied')) }
    catch { setCopyStatus('Copy failed. Select and copy the text.') }
  }
  return <>
    <h3>{t('Reset code for {0}', name)}</h3>
    <div className="adm-lead">{t('Give this code to {0}. In password sign-in, choose the administrator reset-code option and enter the name or email, code, and new password. The code works once, until {1}, and will not be shown again.', name, date(expires))} {email}</div>
    <button className="adm-code" style={{ fontSize: 22, width: '100%', padding: '14px 0' }} onClick={copy} aria-label={t("copy code")}>{code}</button>
    {copyStatus && <p role="status">{t(copyStatus)}</p>}
    <input className="field" aria-label={t("Reset code")} readOnly value={code} onFocus={e => e.target.select()} />
    <label><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> {t("I have saved this one-time code.")}</label>
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={!acknowledged} onClick={close}>{t("Done")}</Button>
  </>
}

function UserDetail({ id, onChanged, close }) {
  const account = useStore(s => s.user?.id)
  const { t, date, relative: rel, duration, number } = useAdminLanguage(account)
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const load = () => { setError(''); return api('/api/admin/user?id=' + encodeURIComponent(id)).then(setD).catch(e => setError(adminError(e))) }
  useEffect(() => { load() }, [id])
  if (!d) return <div className="muted small" role="status">{error ? t(error) : t('Loading…')}{error && <button className="btn" onClick={load}>{t('Try again')}</button>}</div>
  const u = d.user
  // The document comes straight off the user's state file. PUT /api/data drops null and
  // shapeless entries now, but a file written before it did still answers with them, and this
  // sheet renders outside the route's ErrorBoundary: one throw here blanked the whole app and
  // left exactly this account un-disableable. setsDone/workoutVolume walk entries and sets, so
  // an entry that lacks either has nothing to show and is skipped rather than drawn.
  const workouts = (d.workouts || []).filter(w => w && Array.isArray(w.entries) && w.entries.every(e => e && Array.isArray(e.sets)))
  // Their whole record as the admin API already returns it — the export the delete sheet offers.
  const exportUser = () => {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `kuch-${u.name.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}-${u.id}.json`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const doDelete = () => {
    if (busy) return
    setBusy(true)
    return api('/api/admin/user/delete', { method: 'POST', body: JSON.stringify({ id: u.id }) })
      .then(() => { toast(t('Account deleted')); onChanged(); close() })
      .catch(e => setError(adminError(e))).finally(() => setBusy(false))
  }
  const setDisabled = disabled => {
    if (busy) return
    setBusy(true)
    return api('/api/admin/user/disable', { method: 'POST', body: JSON.stringify({ id: u.id, disabled }) })
      .then(() => { toast(t(disabled ? 'User disabled' : 'User enabled')); onChanged(); close() })
      .catch(e => setError(adminError(e))).finally(() => setBusy(false))
  }
  // Password sign-in (#118): the server only sends `password` when the instance offers it. The
  // code comes back once, is shown once, and is never stored anywhere but as a hash.
  const pwInstance = typeof u.password === 'boolean'
  const resetPassword = () => confirmSheet({
    title: t('Reset {0}’s password?', u.name),
    cancelText: t('Cancel'),
    message: t("You get a one-time code to hand them. Their current password stops working now and they are signed out everywhere; their passkeys keep working. They set a new password with the code under “Sign in with password”. It is shown once and is valid for 24 hours."),
    confirmText: t("Create reset code"),
    danger: true,
    onConfirm: () => { if (busy) return; setBusy(true); return api('/api/admin/user/password-reset', { method: 'POST', body: JSON.stringify({ id: u.id }) })
      .then(r => { onChanged(); close(); openSheet(done => <ResetCodeSheet name={r.name} email={u.email} code={r.code} expires={r.expires} close={done} />, { locked: true }) })
      .catch(() => { setError('The reset result is unknown. Check the account before deliberately issuing another code; a new code replaces the previous one.'); onChanged() }).finally(() => setBusy(false)) },
  })
  return <>
    <h3 className="capitalize">{u.name}</h3>
    {error && <p role="alert">{t(error)}</p>}
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
      {u.admin && <span className="adm-pill acc">{t("admin")}</span>}
      {u.disabled && <span className="adm-pill bad">{t("disabled")}</span>}
      {u.invitedBy && <span className="adm-pill">{t("invite")} {u.invitedBy}</span>}
      {u.password && <span className="adm-pill">{t("password")}</span>}
      {/* The sign-in e-mail (password instances only): shown to admins and nobody else. */}
      {u.email && <span className="adm-pill" title={t("sign-in e-mail")}>{u.email}</span>}
      {u.resetUntil && <span className="adm-pill acc">{t("reset code until")} {date(u.resetUntil)}</span>}
      <span className="adm-pill">{t("joined")} {date(u.created)}</span>
    </div>
    <div className="tiles" style={{ textAlign: 'start' }}>
      <div className="tile"><div className="l">{t('Workouts')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{number(workouts.length)}</div></div>
      <div className="tile"><div className="l">{t("Weigh-ins")}</div><div className="v" style={{ fontSize: '1.1rem' }}>{number(d.bodyweight.length)}</div></div>
      <div className="tile"><div className="l">{t("Measurements")}</div><div className="v" style={{ fontSize: '1.1rem' }}>{number((d.measurements || []).length)}</div></div>
      <div className="tile"><div className="l">{t("Routines")}</div><div className="v" style={{ fontSize: '1.1rem' }}>{number(d.routines.length)}</div></div>
      <div className="tile"><div className="l">{t("Last sync")}</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>
    {!u.admin && <>
      <button disabled={busy} className={'btn ' + (u.disabled ? 'primary' : 'danger')} style={{ margin: '12px 0 4px' }}
        onClick={() => u.disabled ? setDisabled(false)
          : confirmSheet({ title: t('Disable {0}?', u.name), message: t("They are signed out everywhere and can no longer sync or log in until re-enabled. Their data stays."), confirmText: t("Disable"), cancelText: t('Cancel'), danger: true, onConfirm: () => setDisabled(true) })}>
        {t(u.disabled ? 'Enable account' : 'Disable account')}</button>
      <div className="adm-hint">{t(u.disabled ? 'Enabling lets them sign in and sync again.' : 'Disabling signs them out everywhere and blocks sign-in. Nothing is deleted.')}</div>
      {/* The one destructive action in the app (issue #107), so it asks twice and offers the
          export first — that history is theirs. The second step names the account again, because
          the first sheet can be dismissed by anyone who was not reading. */}
      <button disabled={busy} className="btn danger" style={{ margin: '14px 0 4px' }}
        onClick={() => confirmSheet({
          title: t('Delete {0}?', u.name),
          cancelText: t('Cancel'),
          message: t("Everything goes: their workouts, weigh-ins, routines, passkeys and notifications. This cannot be undone, and the invite code they joined with stays used. Download their data first if they might want it."),
          confirmText: t("Continue"),
          danger: true,
          onConfirm: () => confirmSheet({
            title: t('Delete {0} for good?', u.name),
            cancelText: t('Cancel'),
            message: t("Last chance. There’s no undo and no backup of this on the server."),
            confirmText: t("Delete account"),
            danger: true,
            onConfirm: doDelete,
          }),
        })}>{t("Delete account")}</button>
      <button className="btn" style={{ marginBottom: 4 }} onClick={exportUser}>{t("Download their data")}</button>
      <div className="adm-hint">{t("Deleting removes the account and every trace of its training history from this server.")}</div>
      {pwInstance && <>
        <button className="btn" disabled={busy} style={{ margin: '14px 0 4px' }} onClick={resetPassword}>{t("Reset password")}</button>
        <div className="adm-hint">{t(u.password
          ? 'For a forgotten password: a one-time code lets them choose a new one. Their current password stops working at once.'
          : 'No password yet. A one-time code lets them set one. That’s the way back in after losing their only passkey.')}</div>
      </>}
    </>}
    <h4 className="sec">{t("Workout history")}</h4>
    {workouts.length ? <div className="list" style={{ gap: 0 }}>
      {workouts.slice(0, 60).map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div><div className="small" style={{ fontWeight: 600 }}>{w.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{date(w.d)} · {duration((w.end || w.start) - w.start)} · {number(setsDone(w))} {t("sets")}{w.prs?.length ? ' · ' + number(w.prs.length) + ' PR' : ''}</div></div>
        <span className="small muted">{number(w.vol ?? workoutVolume(w))} {d.unit}</span>
      </div>)}
    </div> : <div className="adm-empty">{t("No workouts logged.")}</div>}
  </>
}

function InvitesCard({ invites, reload, inviteOnly, error }) {
  const { t } = useAdminLanguage()
  const toast = useUI(s => s.toast)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  const [copyValue, setCopyValue] = useState('')
  const [message, setMessage] = useState('')
  const gen = async () => {
    if (busy) return
    setBusy(true); setMessage('')
    try { const { invite } = await api('/api/admin/invites/new', { method: 'POST', body: '{}' }); await copy(invite.code); await reload() }
    catch (e) { setMessage(adminError(e)) }
    finally { setBusy(false) }
  }
  const revoke = code => confirmSheet({
    title: t('Revoke code {0}?', code), message: t("Anyone who has it can no longer use it. People who already signed up with it are not affected."), cancelText: t('Cancel'),
    confirmText: t("Revoke"), danger: true,
    onConfirm: async () => {
      if (busy) return
      setBusy(true)
      try { await api('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) }); toast(t('Code revoked')); await reload() }
      catch (e) { setMessage(adminError(e)) }
      finally { setBusy(false) }
    }
  })
  const copy = async code => {
    setCopyValue(code)
    try { await navigator.clipboard.writeText(code); setMessage('Copied') }
    catch { setMessage('Copy failed. Select and copy the text.') }
  }
  const open = (invites || []).filter(i => !i.usedBy && filter !== 'used')
  const used = (invites || []).filter(i => i.usedBy && filter !== 'unused')
  return <div className="card">
    <div className="row between"><h2 style={{ margin: 0 }}>{t("Invite codes")}</h2>
      <Button variant="primary" size="sm" disabled={busy} onClick={gen} icon="plus">{t("New code")}</Button></div>
    <select className="adm-select" aria-label={t("Invite status")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{t("All")}</option><option value="unused">{t("Unused")}</option><option value="used">{t("Already used")}</option></select>
    {error && <p role="alert">{t(error)} <button className="btn" onClick={reload}>{t("Try again")}</button></p>}
    {!invites && !error && <p role="status">{t("Loading…")}</p>}
    {message && <p role="status">{t(message)}</p>}
    {copyValue && <input className="field" aria-label={t("Invite code")} readOnly value={copyValue} onFocus={e => e.target.select()} />}
    <div className="adm-lead">
      {t(inviteOnly
        ? 'Sign-up is invite-only: someone needs one of these codes to create a profile. Each code works once.'
        : 'Sign-up is open, so codes are optional here. They only record who invited whom.')}
    </div>
    {open.length ? <>
      <div className="adm-group-t">{t("Unused · tap to copy")}</div>
      {open.map(i => <div key={i.code} className="row between" style={{ padding: '6px 0', borderBottom: 'var(--hair) solid var(--sep)' }}>
        <button className="adm-code" onClick={() => copy(i.code)} aria-label={'copy ' + i.code}>{i.code}</button>
        <div className="row" style={{ gap: 4 }}>
          <button className="iconbtn adm-iconbtn" onClick={() => copy(i.code)} aria-label={t("copy")}><Icon name="copy" /></button>
          <button disabled={busy} className="iconbtn adm-iconbtn" style={{ color: 'var(--red)' }} onClick={() => revoke(i.code)} aria-label={t("revoke")}><Icon name="trash" /></button>
        </div>
      </div>)}
    </> : null}
    {used.length ? <>
      <div className="adm-group-t" style={{ marginTop: open.length ? 12 : 0 }}>{t("Already used")}</div>
      {used.map(i => <div key={i.code} className="row between dim" style={{ padding: '6px 0', fontSize: '.82rem' }}>
        <span style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', letterSpacing: '.06em' }}>{i.code}</span><span>→ {i.usedByName || 'used'}</span>
      </div>)}
    </> : null}
    {invites && !open.length && !used.length && <div className="adm-empty">{t(invites.length ? "No matching invite codes." : "No invite codes yet.")}</div>}
  </div>
}

// Who signed in, who tried and failed, what an admin changed. A card rather than its own route:
// the dashboard is deliberately one page of cards, and the 95 % use of this is a glance at the
// last twenty events. Paging follows Library.jsx's house style — "Show more", not page numbers.
function AuditCard({ tick }) {
  const { t, date, number } = useAdminLanguage()
  const toast = useUI(s => s.toast)
  const [meta, setMeta] = useState(null)      // last response minus the rows: total, retention, …
  const [rows, setRows] = useState([])
  const [cat, setCat] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const request = useRef(0)

  const load = async (c, before) => {
    const version = ++request.current
    setLoading(true); setError('')
    try {
      const r = await api('/api/admin/audit?limit=50&cat=' + c + (before ? '&before=' + before : ''))
      if (version !== request.current) return
      setMeta(r); setRows(x => before ? x.concat(r.events || []) : r.events || [])
    } catch (e) { if (version === request.current) setError(adminError(e)) }
    finally { if (version === request.current) setLoading(false) }
  }
  const pick = c => { setCat(c); setRows([]); setMeta(null); load(c) }
  // Reloads on mount and whenever the header's ↻ bumps the tick. Deliberately not on the 15s
  // poll that drives "training now": this is history, not presence.
  useEffect(() => { load(cat) }, [tick])

  const clear = () => confirmSheet({
    title: t("Clear the activity log?"),
    message: t("Every recorded event is deleted. The clear itself is logged, so the gap stays visible."),
    confirmText: t("Clear"), cancelText: t('Cancel'), danger: true,
    onConfirm: () => api('/api/admin/audit/clear', { method: 'POST', body: '{}' })
      .then(() => { toast(t('Activity log cleared')); pick(cat) }).catch(e => toast(t(adminError(e))))
  })

  if (meta && !meta.enabled) return null      // AUDIT_LOG=0 — the card isn't there at all

  return <div className="card">
    {error && <p role="alert">{t(error)} <button className="btn" onClick={() => load(cat)}>{t('Try again')}</button></p>}
    {loading && <p role="status">{t('Loading…')}</p>}
    <div className="row between"><h2 style={{ margin: 0 }}>{t("Activity log")}</h2>
      <button className="iconbtn adm-iconbtn" style={{ color: 'var(--red)' }} onClick={clear} aria-label={t("clear log")}><Icon name="trash" /></button></div>
    <div className="adm-lead">{t("Who signed in, what failed, and what an admin changed.")} {meta && <>{t('{0} events', number(meta.total))} · {meta.retention?.days ? t('Kept for {0} days', number(meta.retention.days)) : t('No time limit')} {meta.ip_mode === 'off' && t('Without IP addresses')}</>}
    </div>
    <div className="chips" style={{ marginBottom: 10 }}>
      {[['', 'All'], ['auth', 'Sign-ins'], ['admin', 'Admin'], ['fail', 'Failed']].map(([v, l]) =>
        <button key={v} className={'chip' + (cat === v ? ' on' : '')} onClick={() => pick(v)}>{t(l)}</button>)}
    </div>
    {rows.map(e => {
      const line = auditLine(e, t)
      return <div key={e.id} className="row between" style={{ padding: '8px 2px', borderBottom: 'var(--hair) solid var(--sep)' }}>
        <div className="grow">
          <div className="small" style={{ fontWeight: 600 }}>{line.title}
            {/* a red pill, not a red row: twenty fumbled Face IDs in a row shouldn't read as an incident */}
            {!e.ok && <span className="adm-pill bad" style={{ marginInlineStart: 6 }}>{t("failed")}</span>}
            {auditCat(e.ev) === 'admin' && <span className="adm-pill acc" style={{ marginInlineStart: 6 }}>{t("admin")}</span>}</div>
          {line.sub && <div className="dim" style={{ fontSize: '.72rem' }}>{line.sub}</div>}
        </div>
        <span className="small muted" style={{ flex: 'none', marginInlineStart: 8 }}>{date(e.ts)}</span>
      </div>
    })}
    {meta && !rows.length && <div className="adm-empty">{t("Nothing logged yet.")}</div>}
    {meta?.nextBefore && <div style={{ marginTop: 10 }}>
      <Button size="sm" disabled={loading} onClick={() => load(cat, meta.nextBefore)}>{t("Show more")}</Button></div>}
  </div>
}

export default function Admin() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const { locale, setLocale, t, date, relative: rel, duration, number } = useAdminLanguage(user?.id)
  const openSheet = useUI(s => s.openSheet)
  const [users, setUsers] = useState(null)
  const [usersErr, setUsersErr] = useState(null)   // why the last load failed, until one succeeds
  const [accessDenied, setAccessDenied] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [invites, setInvites] = useState(null)
  const [invitesErr, setInvitesErr] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  const [tick, setTick] = useState(0)          // the ↻ button; the activity log listens to it
  const [section, setSection] = useState(new URLSearchParams(location.hash.split('?')[1] || '').get('section') === 'security' ? 'Security' : 'Overview')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [copyStatus, setCopyStatus] = useState('')
  const [dirtyCoach, setDirtyCoach] = useState(false)
  const [dirtySecurity, setDirtySecurity] = useState(false)
  const [pendingLeave, setPendingLeave] = useState(null)
  const [formVersion, setFormVersion] = useState(0)
  const dirty = dirtyCoach || dirtySecurity
  const blocker = useBlocker(dirty)
  const leaveDialog = useRef(null)
  const showLeave = !!pendingLeave || blocker.state === 'blocked'
  useEffect(() => {
    if (showLeave) leaveDialog.current?.showModal?.()
    else leaveDialog.current?.close?.()
  }, [showLeave])
  const stay = () => { setPendingLeave(null); if (blocker.state === 'blocked') blocker.reset() }
  const discard = () => {
    const next = pendingLeave
    setPendingLeave(null); setDirtyCoach(false); setDirtySecurity(false); setFormVersion(v => v + 1)
    if (blocker.state === 'blocked') blocker.proceed()
    else next?.()
  }
  useEffect(() => {
    const denied = () => {
      setUsers(null); setInvites(null); setAccessDenied(true)
      useUI.setState?.({ sheets: [] })
    }
    window.addEventListener('kuch-admin-access-lost', denied)
    return () => window.removeEventListener('kuch-admin-access-lost', denied)
  }, [])
  const leave = action => { if (dirty) setPendingLeave(() => action); else action() }
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  const server = useStore(s => s.sync?.server)
  const adminLink = (MOBILE ? server || '' : location.origin + appBase()).replace(/\/+$/, '') + '/#/admin'
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(adminLink); setCopyStatus('Copied') }
    catch { setCopyStatus('Copy failed. Select and copy the text.') }
  }

  // A failed load, or an answer without a list, used to leave the page on "Loading…" for good —
  // with a toast every 15 seconds from the poll, or with nothing at all when the answer was
  // someone else's page. It says so where the list would be instead, and the poll (or ↻) keeps
  // trying; a list that did load stays up, marked as the last one that came through.
  const loadUsers = () => api('/api/admin/users')
    .then(d => {
      if (!Array.isArray(d?.users)) throw new Error('The server answered without a list of users.')
      setUsers(d.users); setInviteOnly(!!d.invite_only); setUsersErr(null); setLastUpdated(Date.now())
    })
    .catch(e => { if (e.status === 401 || e.status === 403) { setUsers(null); setInvites(null); setAccessDenied(true) }; setUsersErr(adminError(e)) })
  const loadInvites = () => api('/api/admin/invites').then(d => {
    if (!Array.isArray(d.invites)) throw new Error('Could not load invite codes.')
    setInvites(d.invites); setInvitesErr('')
  }).catch(e => setInvitesErr(adminError(e)))
  // poll every 15s so the "training now" section stays live without a manual refresh
  useEffect(() => { if (!user?.admin) return; loadUsers(); loadInvites(); const iv = setInterval(loadUsers, 15000); return () => clearInterval(iv) }, [])
  if (!user?.admin) return null
  if (accessDenied) return <AdminAccess />

  const openUser = id => openSheet(close => <UserDetail id={id} onChanged={loadUsers} close={close} />)
  const liveUsers = (users || []).filter(u => u.live)
  const activeCount = (users || []).filter(u => u.lastSync && Date.now() - u.lastSync < 7 * 86400000).length
  const disabledCount = (users || []).filter(u => u.disabled).length

  const filteredUsers = (users || []).filter(u =>
    (u.name + ' ' + u.id).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
    (status === 'all' || (status === 'disabled' ? u.disabled : !u.disabled)))
  return <div className="adm-workspace" lang={locale} dir="ltr">
    <nav className="adm-nav" aria-label={t("Admin sections")}>
      {['Overview', 'Users', 'Invites', 'AI Coach', 'Activity'].map(name => <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => leave(() => setSection(name))}>{t(name)}</button>)}
      <button onClick={() => nav('/home')}>{t('Back to workouts')}</button>
    </nav>
    <main className="adm-main">
    {new URLSearchParams(location.hash.split('?')[1] || '').get('authError') && <p role="alert">{t(adminError(new URLSearchParams(location.hash.split('?')[1] || '').get('authError')))}</p>}
    <div className="hdr">
      <div className="adm-title"><h1 style={{ margin: 0 }}>{t(section)}</h1>
        {['Overview', 'Users'].includes(section) && <div className="sub">{users ? t('{0} users · {1} active this week', number(users.length), number(activeCount)) : t(usersErr ? 'Could not load' : 'Loading…')}</div>}</div>
      <button className="btn adm-security-link" onClick={() => leave(() => setSection(section === 'Security' ? 'Overview' : 'Security'))}>{t(section === 'Security' ? 'Back to admin' : 'My account → Security')}</button>
      <button className="btn adm-copy-link" onClick={copyLink}>{t('Copy admin link')}</button>
      <select className="adm-select" aria-label={t("Admin language")} value={locale} onChange={e => setLocale(e.target.value)}>
        {Object.entries(languages).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <button className="iconbtn adm-refresh" onClick={() => { loadUsers(); loadInvites(); setTick(n => n + 1) }} aria-label={t("refresh")}>↻</button>
    </div>
    {showLeave && <dialog ref={leaveDialog} className="card adm-leave" role="alertdialog" aria-label={t('Unsaved changes')} onCancel={e => { e.preventDefault(); stay() }}>
      <p>{t('Discard unsaved changes?')}</p>
      <button className="btn" autoFocus onClick={stay}>{t('Stay')}</button>
      <button className="btn danger" onClick={discard}>{t('Discard changes')}</button>
    </dialog>}
    {copyStatus && <div role="status"><p>{t(copyStatus)}</p><input className="field" aria-label={t("Admin link")} readOnly value={adminLink} onFocus={e => e.target.select()} /></div>}
    {lastUpdated && ['Overview', 'Users'].includes(section) && <p className="adm-hint">{t('Last updated')}: {new Date(lastUpdated).toLocaleString(locale)}</p>}
    {section === 'Overview' && <div className="adm-intro">{t("Manage accounts, invitations, Coach and activity. Account details include available workout history and summaries; downloads are not complete backups.")}</div>}

    {usersErr && <div className="card" role="alert" style={{ borderColor: 'var(--red)' }}>
      <div className="row between"><h2 style={{ margin: 0 }}>{t(users ? 'The last update failed' : 'Could not load the users')}</h2>
        <Button size="sm" icon="reset" onClick={loadUsers}>{t("Try again")}</Button></div>
      <div className="adm-lead" style={{ marginBottom: 0 }}>
        {t(usersErr)} {t(users ? 'The list below is the last one that loaded.' : 'It tries again every 15 seconds.')}
      </div>
    </div>}

    {section === 'Overview' && <div className="tiles" style={{ marginBottom: 12 }}>
      <button className="tile" onClick={() => setSection('Users')}><div className="l">{t("Users")}</div><div className="v">{users ? number(users.length) : '–'}</div></button>
      <button className="tile" onClick={() => setSection('Activity')}><div className="l">{t("Training now")}</div><div className="v" style={{ color: liveUsers.length ? 'var(--acc)' : undefined }}>{users ? number(liveUsers.length) : '–'}</div></button>
      <button className="tile" onClick={() => setSection('Users')}><div className="l">{t("Active 7 days")}</div><div className="v">{users ? number(activeCount) : '–'}</div></button>
      <button className="tile" onClick={() => { setStatus('disabled'); setSection('Users') }}><div className="l">{t("Disabled")}</div><div className="v">{users ? number(disabledCount) : '–'}</div></button>
    </div>}

    <div className={section === 'Overview' ? 'adm-overview' : undefined}>
    {['Overview', 'Activity'].includes(section) && <div className="card adm-live" style={{ borderColor: 'var(--acc)' }}>
      <h2 className="row" style={{ margin: '0 0 2px', gap: 6 }}><Icon name="dot" style={{ fontSize: 10, color: 'var(--green)' }} />{t("Training now")}</h2>
      <div className="adm-lead">{t("Sessions running at this moment. Tap a name for details.")}</div>
      {!liveUsers.length && <p>{t(users ? 'No sessions running now.' : usersErr ? 'Could not load the users' : 'Loading…')}</p>}
      {liveUsers.map(u => <button key={u.id} className="row between adm-live-user" style={{ padding: '8px 2px', borderBottom: 'var(--hair) solid var(--sep)' }} onClick={() => openUser(u.id)}>
        <div><div className="small" style={{ fontWeight: 600 }}>{u.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{u.live.name} {t("· exercise")} {number(u.live.exIdx)} {t("of")} {number(u.live.exTotal)} · {number(u.live.setsDone)}/{number(u.live.setsTotal)} {t("sets")}</div></div>
        <span className="adm-pill acc">{duration(Date.now() - u.live.startedAt)}</span>
      </button>)}
    </div>}

    {/* The Coach setup. Renders nothing at all unless the instance offers the Coach, so an admin
        page on a box that never enabled it is byte-for-byte the page it was before. */}
    <div hidden={section !== 'AI Coach'}><AdminCoach key={formVersion} tick={tick} onDirty={setDirtyCoach} /></div>
    {section === 'Security' && <AdminSecurity key={formVersion} tick={tick} onDirty={setDirtySecurity} />}

    {section === 'Invites' && <InvitesCard invites={invites} error={invitesErr} reload={loadInvites} inviteOnly={inviteOnly} />}

    {['Overview', 'Users'].includes(section) && <div className="card">
      <h2 style={{ margin: 0 }}>{t("Users")}</h2>
      <div className="adm-actions">
        <input className="field" aria-label={t("Search users")} placeholder={t("Search users")} value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label={t("Account status")} className="adm-select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">{t("All accounts")}</option><option value="active">{t("Enabled")}</option><option value="disabled">{t("Disabled")}</option>
        </select>
      </div>
      <div className="adm-lead">{t("Everyone with a profile on this instance. Tap one to see their activity, to disable the account (nothing is deleted) or to delete it with all their data for good.")}</div>
      <div className="list">
        {(section === 'Overview' ? filteredUsers.slice(0, 5) : filteredUsers).map(u => <button key={u.id} className="item" onClick={() => openUser(u.id)}>
          <div className="grow"><div className="tt">{u.live && <Icon name="dot" style={{ fontSize: 9, color: 'var(--green)', display: 'inline-block', marginInlineEnd: 5 }} />}{u.name} {u.admin && <span className="adm-pill acc" style={{ marginInlineStart: 4 }}>{t("admin")}</span>}{u.disabled && <span className="adm-pill bad" style={{ marginInlineStart: 4 }}>{t("disabled")}</span>}</div>
            <div className="ss">{u.live ? t('Training now') + ' · ' + u.live.name : t('{0} workouts · last sync {1}', number(u.workouts), rel(u.lastSync))}{u.lastWorkout && ' · ' + t('Last workout') + ' ' + date(u.lastWorkout)}</div>
            {u.email && <div className="ss" title={t("sign-in e-mail")}>{u.email}</div>}</div>
          {u.hasPush && <Icon name="bell" title={t("push notifications on")} style={{ fontSize: 15, color: 'var(--label-3)' }} />}<Icon name="chevronRight" className="chev" />
        </button>)}
        {users && !users.length && <div className="adm-empty">{t("No users yet.")}</div>}
        {!!users?.length && !filteredUsers.length && <div className="adm-empty">{t("No matching users")}</div>}
      </div>
      {section === 'Overview' && <button className="btn" onClick={() => setSection('Users')}>{t('View all users')}</button>}
    </div>}

    {section === 'Overview' && <section className="card">
      <h2>{t('Invites')}</h2>
      <p>{t('Unused')}: {invites ? number(invites.filter(i => !i.usedBy).length) : '–'}</p>
      <button className="btn" onClick={() => setSection('Invites')}>{t('Manage invites')}</button>
      <h2>{t('AI Coach')}</h2>
      <button className="btn" onClick={() => setSection('AI Coach')}>{t('Configure Coach')}</button>
      <h2>{t('Activity')}</h2>
      <button className="btn" onClick={() => setSection('Activity')}>{t('View activity')}</button>
    </section>}

    {section === 'Activity' && <div style={{ marginTop: 14 }}><AuditCard tick={tick} /></div>}
    </div>
    </main>
  </div>
}
