import { useAdminLanguage } from '../lib/admin-language.js'
import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { useStore } from '../store/useStore.js'
import { adminApi as api } from '../lib/admin-api.js'
import Icon from '../components/Icon.jsx'
import { Button, Switch, TextArea, TextField } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import { adminError } from '../lib/admin-errors.js'

/* The operator's side of the Coach, laid out as a guided setup: one master switch, numbered
   steps that each say what they are for, and everything an owner rarely needs folded away
   under "Advanced" and "Activity". Its language is independent of the workout surface.

   What it never shows: anybody's intake answers, payloads or proposals. An admin can enable
   the feature and see that jobs ran; they cannot read what their users asked it.

   This is the ONLY place the Coach can be switched off for everyone. Users can decline the
   consent screen for themselves, but they cannot disable the feature — that is an operator
   decision, so it lives with the operator. */

// Extra static headers for the endpoint, one `Name: value` per line — e.g. a gateway's
// routing/session header (opencode Go's `x-opencode-session`). Parsed client-side so a
// typo reads as a message on the card, not a 400 the admin has to decode. Empty clears.
export const headersToText = h => h && typeof h === 'object'
  ? Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n')
  : ''
export function parseHeadersText(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return { headers: null }
  const out = {}
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i < 1) return { error: `not a Name: value line: ${line.slice(0, 40)}` }
    const name = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (!name || !value) return { error: `not a Name: value line: ${line.slice(0, 40)}` }
    out[name] = value
  }
  return { headers: out }
}

// Which chips go under which heading. Runtime-backed providers are the ones that need the
// bigger `coach` image; the fixture exists so the whole loop can be walked without any account.
const RUNTIME_IDS = ['claude', 'codex']
const TESTING_IDS = ['fixture']

export default function AdminCoach({ tick = 0, onDirty = () => {}, onStatus = () => {} }) {
  const { locale, t, number, relative: rel } = useAdminLanguage()
  const seconds = ms => new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'short' }).format(Math.round(ms / 1000))
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const [saved, setD] = useState(null)
  const [draft, setDraft] = useState({})
  const [capsDraft, setCapsDraft] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [headersDraft, setHeadersDraft] = useState(null)
  const [credentialDirty, setCredentialDirty] = useState(false)
  const d = saved ? { ...saved, ...draft, caps: capsDraft || saved.caps } : null
  const [busy, setBusy] = useState(false)
  // The models the endpoint serves, fetched on demand. Seeded from the status call when the
  // stored key already let it list them.
  const [models, setModels] = useState(null)
  // The last "Test the Coach" outcome, shown inline where the button is rather than only as a
  // toast that is gone before anyone has read the provider's reason.
  const [testResult, setTestResult] = useState(null)

  // Every change on this card ends in load(), so load() also re-reads /api/config. The app reads
  // that once per boot, and the Plan tab's Coach card hangs off it: without the re-read, an admin
  // who has just switched the Coach on and connected it finds no Coach anywhere until a reload,
  // which reads as a setup that failed (Discord #install-help, 2026-09-19).
  const load = () => api('/api/admin/coach').then(r => { setD(r); onStatus(r); setLoadError(''); setModels(r.knownModels || null); useStore.getState().refreshConfig() }).catch(e => { setLoadError(adminError(e)); toast(t(adminError(e))) })
  useEffect(() => { load() }, [tick])
  useEffect(() => { onDirty(!!Object.keys(draft).length || !!capsDraft || headersDraft !== null || credentialDirty) }, [draft, capsDraft, headersDraft, credentialDirty])

  const save = async body => {
    if (busy) return
    const validNumber = (value, min, max) => String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max
    if ((body.caps && (!validNumber(body.caps.perProfileDaily, 0, 200) || !validNumber(body.caps.instanceDaily, 0, 5000))) ||
      ('maxMessageLen' in body && !validNumber(body.maxMessageLen, 200, 4000)) ||
      ('maxOutputTokens' in body && !validNumber(body.maxOutputTokens, 1024, 65536))) {
      setLoadError('Enter a whole number within the field limits. Zero means Unlimited only for daily usage limits.'); return
    }
    if (body === draft && headersDraft !== null) {
      const parsed = parseHeadersText(headersDraft)
      if (parsed.error) { setLoadError('Use one Name: value header per line.'); return }
      body = { ...body, headers: parsed.headers }
    }
    setBusy(true)
    try {
      await api('/api/admin/coach/config', { method: 'POST', body: JSON.stringify(body) })
      if (body.caps) setCapsDraft(null)
      else setDraft(current => Object.fromEntries(Object.entries(current).filter(([key, value]) => !(key in body) || body[key] !== value)))
      if ('headers' in body) setHeadersDraft(null)
      setTestResult(r => r ? { ...r, outdated: true } : null)
      await load()
    }
    catch (e) { toast(t(adminError(e))) }
    setBusy(false)
  }
  const patch = body => {
    if (body.caps) setCapsDraft(body.caps)
    else setDraft(current => ({ ...current, ...body }))
    setTestResult(r => r ? { ...r, outdated: true } : null)
  }
  const loadModels = async () => {
    setBusy(true)
    try {
      const r = await api('/api/admin/coach/models', { method: 'POST', body: '{}' })
      if (r.ok) { setModels(r.models); toast(t('{0} models', number(r.models.length))) } else toast(t(adminError(r.error || 'Could not list models')))
    } catch (e) { toast(t(adminError(e))) }
    setBusy(false)
  }
  const test = async () => {
    setBusy(true); setTestResult({ pending: true })
    try {
      // The server gives the provider up to 90 s for this round-trip (api/coach/jobs.js testRun),
      // longer than api()'s default for a request; a slow local model must still get its answer.
      const r = await api('/api/admin/coach/test', { method: 'POST', body: '{}', timeout: 150000 })
      setTestResult(r)
      toast(t(r.ok ? 'Coach test passed ✅' : 'Test failed'))
      await load()
    } catch (e) { setTestResult({ ok: false, error: adminError(e) }); toast(t(adminError(e))) }
    setBusy(false)
  }
  // Keep incomplete drafts visible; save validates them before converting to numbers.
  const capBlur = key => e => {
    const value = e.target.value === '' ? '' : Number(e.target.value)
    if (value !== d.caps[key]) patch({ caps: { ...d.caps, [key]: value } })
  }
  const disconnect = async () => {
    setBusy(true)
    try { await api('/api/admin/coach/disconnect', { method: 'POST', body: JSON.stringify({ provider: d.provider }) }); toast(t("Credential removed")); setTestResult(r => r ? { ...r, outdated: true } : null); await load() }
    catch (e) { toast(t(adminError(e))) }
    setBusy(false)
  }
  const openCredential = (Component, props) => {
    let handle
    const draftChanged = changed => { setCredentialDirty(changed); handle?.lock(changed) }
    handle = openSheet(close => <Component {...props} onDraft={draftChanged}
      close={() => { setCredentialDirty(false); close() }}
      onDone={() => { setCredentialDirty(false); setTestResult(r => r ? { ...r, outdated: true } : null); load() }} />)
  }

  if (!d) return <div className="card"><div className="muted small" role="status">{t(loadError || 'Loading Coach status…')}</div>{loadError && <button className="btn" onClick={load}>{t("Try again")}</button>}</div>

  if (d.disabledByEnv) return <div className="card">
    <h2 style={{ margin: '0 0 6px' }}>{t("AI Coach")}</h2>
    <div className="adm-lead">{t("Force-disabled by")} <code>{t("COACH_DISABLED")}</code> {t("in the server's environment. Remove that variable and restart to configure the Coach here.")}</div>
  </div>

  const meta = d.providers.find(p => p.id === d.provider) || {}
  const providerPending = draft.provider !== undefined && draft.provider !== saved.provider
  const authState = providerPending ? 'none' : d.auth?.state
  const authed = authState === 'connected' || authState === 'not-required' || authState === 'optional'
  const needsEndpoint = !!meta.baseUrl
  const hasEndpoint = !needsEndpoint || !!d.baseUrl
  const live = d.enabled && d.runtime.ok && authed && hasEndpoint

  const status = !d.enabled ? t("Off. Users won’t see the Coach anywhere in the app.")
    : live ? <>{t("On ·")} {meta.label}{d.model ? ' · ' + d.model : ''}</>
      : !hasEndpoint ? t("On, but no endpoint yet. Finish step 2.")
        : !authed ? t("On, but no credential yet. Finish the Credential step.")
          : !d.runtime.ok ? t("On, but the provider can’t be reached. See the Test step.")
            : t("On")

  // Chips, grouped.
  const groups = [
    { title: t("Paste an API key"), hint: t("Plain HTTPS to the provider. Works on the default api image, nothing extra to install."), items: d.providers.filter(p => p.http) },
    { title: t("Runs a local AI runtime"), hint: t("Needs the bigger api image built with --target coach."), items: d.providers.filter(p => RUNTIME_IDS.includes(p.id)) },
    { title: t("Testing"), hint: t("A built-in fake that answers instantly, so the whole loop can be tried without an account."), items: d.providers.filter(p => TESTING_IDS.includes(p.id)) }
  ]

  const hasCredentialStep = !!(meta.setupToken || meta.apiKey)
  // The model this provider was explicitly GIVEN — as opposed to `d.model`, which falls back to
  // the provider's own default. Both halves of the Model step (the dropdown and the free-text
  // box) read this one value, so they cannot disagree about what is configured.
  const chosenModel = draft.model ?? d.models?.[d.provider] ?? ''
  const step1Done = !!d.provider
  const step2Done = hasEndpoint
  const step3Done = authed
  const step4Done = !!d.model
  const step5Done = !!testResult?.ok || !!d.lastSuccess
  // Step numbers only count the steps this provider actually shows — and like any wizard,
  // only the first unfinished step stands open; everything done folds to its summary line.
  const flags = [step1Done, ...(needsEndpoint ? [step2Done] : []), ...(hasCredentialStep ? [step3Done] : []), step4Done, step5Done]
  const doneCount = flags.filter(Boolean).length
  const firstTodo = flags.indexOf(false)
  let n = 1
  let idx = 0
  const num = () => n++
  const stepAt = () => { const i = idx++; return { open: i === (firstTodo === -1 ? -1 : firstTodo), key: i + ':' + (i === firstTodo) } }

  // Off = a quiet, optional feature: one clean pitch and one button, no half-dimmed controls.
  if (!d.enabled) return <div className="card">
    <div className="adm-hero">
      <div className="adm-hero-av"><Icon name="sparkles" /></div>
      <h2>{t("AI Coach")}</h2>
      <p>{t("An optional coach that designs training plans and reviews what people actually log. Off right now, so nobody sees it anywhere in the app.")}</p>
      <div className="adm-hero-feats">
        <div><Icon name="key" /><span><b>{t("Bring any AI.")}</b> {t("An API key from Anthropic, OpenAI or Gemini, or a free local model via Ollama.")}</span></div>
        <div><Icon name="shield" /><span><b>{t("Private by design.")}</b> {t("A strict allowlist decides what leaves; every change needs the user's yes and can be undone.")}</span></div>
        <div><Icon name="person" /><span><b>{t("Each user decides.")}</b> {t("Turning it on only makes the Coach available; every person consents for themselves.")}</span></div>
      </div>
      {saved.enabled
        ? <><Button variant="primary" disabled={busy} onClick={() => save(draft)}>{t("Save changes")}</Button>
          <Button disabled={busy} onClick={() => setDraft({})}>{t("Discard changes")}</Button></>
        : <Button variant="primary" icon="sparkles" disabled={busy} onClick={() => patch({ enabled: true })}>{t("Set up the Coach")}</Button>}
    </div>
  </div>

  return <div className="adm-coach">
    {loadError && <p role="alert">{t(loadError)} <button onClick={load}>{t("Try again")}</button></p>}
    {providerPending && <p role="status">{t('Save the provider selection before editing credentials or listing models.')}</p>}
    <div className="adm-coach-heading">
      <h2>{t('Setup')}</h2><label><span>{t('AI Coach')}</span>
      <Switch checked={!!d.enabled} disabled={busy} onChange={v => patch({ enabled: v })} />
      </label>
    </div>
    <div className="adm-coach-layout"><section className="card adm-coach-setup">
    <div className="adm-coach-progress"><span>{t('{0} of {1} steps done. Finish the open step and the next one unfolds.', number(doneCount), number(flags.length))}</span>{!live && <div className="adm-progress" aria-hidden="true"><i style={{ width: Math.round(doneCount / flags.length * 100) + '%' }} /></div>}</div>
    <div className="adm-lead">
      {live ? t("Users find the Coach under Plan → Coach. This switch is the only place it can be turned off for everyone.")
        : t('{0} of {1} steps done. Finish the open step and the next one unfolds.', number(doneCount), number(flags.length))}
    </div>

    {d.enabled && <>
      {/* ---------- provider ---------- */}
      <Step n={num()} title={t("Provider")} hint={meta.label || t('Which AI answers the Coach')} done={step1Done} {...stepAt()}>
        <div className="adm-hint">{t("Pick who answers. A key or token you save stays with its provider, so you can switch back and forth without pasting it again.")}</div>
        {groups.map(g => !!g.items.length && <div key={g.title} className="adm-group">
          <div className="adm-group-t">{g.title}</div>
          <div className="adm-chips">
            {g.items.map(p => <button key={p.id} className={'chip' + (p.id === d.provider ? ' on' : '')} disabled={busy}
              onClick={() => { setTestResult(null); patch({ provider: p.id }) }}>
              {p.label}{p.connected && <span className="adm-chip-key">{t("key saved")}</span>}
            </button>)}
          </div>
          <div className="adm-hint" style={{ margin: '6px 0 0' }}>{g.hint}</div>
        </div>)}
      </Step>

      {/* ---------- endpoint (compatible only) ---------- */}
      {needsEndpoint && <Step n={num()} title={t("Endpoint")} hint={d.baseUrl || t('Where the model runs')} done={step2Done} {...stepAt()}>
        <div className="adm-hint">{t("The address of any server that speaks OpenAI's chat API:")} <b>{t("Ollama")}</b>, <b>{t("LM Studio")}</b>, <b>{t("vLLM")}</b>, <b>{t("OpenRouter")}</b>{t(", or a gateway of your own. The base as your provider documents it, with or without its version (")}<code>{t("/v1")}</code>, <code>{t("/v4")}</code>{t("), and no key in the URL.")}</div>
        <div className="adm-field">
          <label>{t("Base URL")}</label>
          <TextField value={d.baseUrl || ''} placeholder={t("http://ollama:11434  or  https://openrouter.ai/api")} inputMode="url" autoCapitalize="none" autoCorrect="off" onChange={e => patch({ baseUrl: e.target.value })}
            onBlur={e => e.target.value !== (d.baseUrl || '') && patch({ baseUrl: e.target.value })} />
        </div>
        <div className="adm-hint" style={{ margin: 0 }}>{t("The host is written to the job log, so you can always see where requests went.")}</div>
        <div className="adm-field">
          <label>{t("Extra headers (optional)")}</label>
          <TextArea value={headersDraft ?? headersToText(d.headers)} onChange={e => setHeadersDraft(e.target.value)} placeholder={'x-opencode-session: 550e8400-…'} autoCapitalize="none" autoCorrect="off" rows={2}
            onBlur={e => {
              const cur = headersToText(d.headers)
              if (e.target.value === cur) return
              const p = parseHeadersText(e.target.value)
              if (p.error) { toast(t('Use one Name: value header per line.')); e.target.value = cur; return }
              patch({ headers: p.headers })
            }} />
        </div>
        <div className="adm-hint" style={{ margin: 0 }}>{t("One")} <code>{t("Name: value")}</code> {t("per line, sent with every request to this endpoint. For gateways that demand routing headers. Never")} <code>{t("Authorization")}</code> {t("or")} <code>{t("Content-Type")}</code> {t("— those are refused.")}</div>
      </Step>}

      {/* ---------- credential ---------- */}
      {hasCredentialStep && <Step n={num()} title={t("Credential")} hint={credentialHint({ ...d.auth, state: authState }, meta, t)} done={step3Done} {...stepAt()}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <CredentialPill auth={{ ...d.auth, state: authState }} />
        </div>
        {authState === 'connected' ? <>
          <div className="adm-hint">{d.auth.account ? t('Connected as {0}', d.auth.account) : t('Connected')} {t("via")} {t(credentialLabel(d.auth.type))}{d.auth.connectedAt ? ' · ' + t('added {0}', rel(d.auth.connectedAt)) : ''}{t(". The key is stored encrypted and is never shown again.")}</div>
          <div className="adm-actions">
            {meta.apiKey && <Button size="sm" variant="tinted" icon="lock" disabled={busy || providerPending}
              onClick={() => openCredential(ApiKeySheet, { label: meta.label, placeholder: meta.keyPlaceholder, optional: meta.keyOptional })}>{t("Replace key")}</Button>}
            {/* The key is encrypted at rest and never shown again, so this is the one action on the
                card that cannot be walked back. Every other irreversible action in the app asks first;
                until 2026-09-22 this one did not. */}
            <Button size="sm" danger disabled={busy || providerPending} onClick={() => confirmSheet({
              title: t("Remove this credential?"),
              message: t("The Coach stops working for everyone on this instance until a new key is added. The stored key cannot be recovered."),
              confirmText: t("Remove"), cancelText: t('Cancel'), danger: true, onConfirm: disconnect,
            })}>{t("Remove")}</Button>
          </div>
        </> : <>
          {authState === 'unreadable' && <div className="adm-hint" style={{ color: 'var(--red)' }}>{t("The stored credential can't be decrypted. This usually means")} <code>{t("./data")}</code> {t("was restored without its")} <code>{t("secret")}</code> {t("file. Add the key again to fix it.")} </div>}
          {authState === 'optional' && <div className="adm-hint">{t("This endpoint works without a key. Add one only if your server asks for it (OpenRouter does; a model on your own network usually does not).")}</div>}
          {authState === 'none' && <div className="adm-hint">{meta.setupToken
            ? t("Paste either a Claude Code setup token (your subscription) or an Anthropic API key (pay per use).")
            : t("Paste an API key from the provider's console. It is stored encrypted on this server and sent to the provider only while a job runs.")}</div>}
          <div className="adm-actions">
            {meta.setupToken && <Button size="sm" variant="primary" icon="key" disabled={busy || providerPending}
              onClick={() => openCredential(SetupTokenSheet, { label: meta.label })}>{t("Add Claude Code token")}</Button>}
            {meta.apiKey && <Button size="sm" variant={meta.setupToken ? undefined : 'primary'} icon="lock" disabled={busy || providerPending}
              onClick={() => openCredential(ApiKeySheet, { label: meta.label, placeholder: meta.keyPlaceholder, optional: meta.keyOptional })}>
              {meta.keyOptional ? t("Add API key (optional)") : t("Add API key")}</Button>}
          </div>
        </>}
      </Step>}

      {/* ---------- model ---------- */}
      <Step n={num()} title={t("Model")} hint={d.model || (meta.defaultModel ? t('Default: {0}', meta.defaultModel) : t("not chosen yet"))} done={step4Done} {...stepAt()}>
        <div className="adm-hint">{meta.http
          ? t("Which model the provider should use. \"List models\" asks the provider for its current list, so nothing here goes stale.")
          : t("Optional. Leave it empty to use the runtime's own default.")}</div>
        <div className="adm-field">
          <label>{t("Model")}</label>
          {models && models.length
            ? <select className="adm-select" value={chosenModel} disabled={busy} onChange={e => patch({ model: e.target.value })}>
              <option value="">{meta.defaultModel ? t('Default ({0})', meta.defaultModel) : t("Pick a model…")}</option>
              {chosenModel && !models.includes(chosenModel) && <option value={chosenModel}>{chosenModel} {t("(not in the list)")}</option>}
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            : <TextField value={chosenModel} onChange={e => patch({ model: e.target.value })} placeholder={meta.defaultModel ? t('Default: {0}', meta.defaultModel) : needsEndpoint ? t("e.g. qwen2.5:3b, or press \"List models\"") : t("(runtime default)")}
              onBlur={e => e.target.value !== chosenModel && patch({ model: e.target.value })} />}
        </div>
        {meta.http && <div className="adm-actions">
          <Button size="sm" variant="tinted" icon="reset" disabled={busy || providerPending} onClick={loadModels}>{models ? t("Refresh list") : t("List models")}</Button>
          {models && models.length ? <span className="dim small" style={{ alignSelf: 'center' }}>{number(models.length)} {t("served by the provider")}</span> : null}
        </div>}
      </Step>

      {/* ---------- test ---------- */}
      <Step n={num()} title={t("Test")} hint={step5Done ? t("passed") : t("one real round trip, no user data")} done={step5Done} {...stepAt()} forceOpen={!!testResult}>
        <div className="adm-hint">{t("Sends one tiny question to the provider and checks the answer. No training data is involved. Do this after every change above.")}</div>
        <div className="adm-actions">
          <Button size="sm" variant="primary" icon="check" disabled={busy || !authed || !hasEndpoint || !!Object.keys(draft).length || headersDraft !== null} onClick={test}>{t("Test the Coach")}</Button>
          {!!Object.keys(draft).length && <p>{t("Save changes before testing. The test uses saved settings.")}</p>}
        </div>
        {(!authed || !hasEndpoint) && <div className="adm-hint" style={{ margin: '6px 0 0' }}>
          {!hasEndpoint ? t("Finish the Endpoint step first.") : t("Finish the Credential step first.")}
        </div>}
        {testResult && <div className={'adm-result ' + (testResult.pending ? '' : testResult.ok ? 'ok' : 'bad')}>
          {testResult.outdated && <b>{t("Outdated result — test the saved settings again.")}</b>}
          {testResult.pending ? t("Asking the provider…")
            : testResult.ok ? <><b>{t("Passed")}</b>{testResult.version ? t('Provider: {0}', testResult.version) : t("The provider answered as expected.")}</>
              : <><b>{t("Failed")}</b>{testResult.error || t('No answer from the provider.')}</>}
        </div>}
        <div className="adm-kv" style={{ marginTop: 10 }}>
          <span className="k">{t("Runtime")}</span>
          <span className="v">{d.runtime.ok ? <span className="adm-pill ok">{t("ready")}</span> : <span className="adm-pill bad">{t("missing")}</span>}{d.runtime.version ? <div className="dim small">{d.runtime.version}</div> : null}{!d.runtime.ok && d.runtime.error ? <div className="small" style={{ color: 'var(--red)' }}>{d.runtime.error}</div> : null}</span>
        </div>
      </Step>

    </>}
    </section>
    <aside className="adm-coach-side"><section className="card">
      <h2>{t('Status')}</h2><div className="adm-status"><span role="status" aria-label={t('Status')} className={'adm-pill ' + (live ? 'ok' : 'warn')}>{t(live ? 'ready' : 'not ready')}</span></div>
      <p className="adm-lead">{status}</p>
      <div className="adm-kv"><span className="k">{t('Provider')}</span><span className="v">{meta.label}</span></div>
      <div className="adm-kv"><span className="k">{t('Model')}</span><span className="v adm-mono">{d.model || '–'}</span></div>
      <div className="adm-kv"><span className="k">{t('Credential')}</span><span className="v"><CredentialPill auth={d.auth} /></span></div>
    </section><section className="card">
    {d.enabled && <>
      {/* ---------- advanced ---------- */}
      <details className="adm-fold">
        <summary>{t("Advanced")} <Icon name="chevronRight" className="chev" /></summary>
        <div className="adm-fold-b">
          <div className="adm-group-t">{t("Limits")}</div>
          <div className="adm-hint">{t("How many Coach runs are allowed per day. Every run is one request on the provider account above. 0 means no limit.")}</div>
          <div className="adm-kv"><span className="k">{t("Per user, per day")}</span>
            <span className="v"><input className="num" type="number" min="0" max="200" value={d.caps.perProfileDaily} disabled={busy} onChange={capBlur('perProfileDaily')}
              onBlur={capBlur('perProfileDaily')} /></span></div>
          <div className="adm-kv"><span className="k">{t("Whole instance, per day")}</span>
            <span className="v"><input className="num" type="number" min="0" max="5000" value={d.caps.instanceDaily} disabled={busy} onChange={capBlur('instanceDaily')}
              onBlur={capBlur('instanceDaily')} /></span></div>
          <div className="adm-hint" style={{ marginTop: 10 }}>{t("How long a chat message, refinement or review note can be. The chat composer and the server both enforce this.")}</div>
          <div className="adm-kv"><span className="k">{t("Max message length")}</span>
            <span className="v"><input className="num" type="number" min="200" max="4000" value={d.maxMessageLen ?? ''} disabled={busy} onChange={e => patch({ maxMessageLen: e.target.value === '' ? '' : Number(e.target.value) })}
              onBlur={e => e.target.value !== '' && +e.target.value !== d.maxMessageLen && patch({ maxMessageLen: +e.target.value })} /></span></div>
          <div className="adm-hint" style={{ marginTop: 10 }}>{t("The ceiling on a single provider answer. Reasoning models — DeepSeek-style endpoints, or a \"thinking\" Gemini/OpenAI model — count their hidden reasoning against it, so a plan can fail with \"the answer was cut off at the output limit\" even though the plan itself is short. Raise it if that happens; keep it within the model's own output limit.")}</div>
          <div className="adm-kv"><span className="k">{t("Max output tokens")}</span>
            <span className="v"><input className="num" type="number" min="1024" max="65536" value={d.maxOutputTokens ?? ''} disabled={busy} onChange={e => patch({ maxOutputTokens: e.target.value === '' ? '' : Number(e.target.value) })}
              onBlur={e => e.target.value !== '' && +e.target.value !== d.maxOutputTokens && patch({ maxOutputTokens: +e.target.value })} /></span></div>

          <div className="adm-group-t" style={{ marginTop: 14 }}>{t("Compare with others")}</div>
          <div className="row between" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="adm-hint" style={{ margin: 0 }}>
              <b>{t("Let people compare with each other.")}</b> {t("Anonymous medians (estimated 1RM, sessions per week) across profiles that opt in; at least three must share before anyone sees a number. Each person switches themselves on in the Coach chat, and sees nothing unless they do.")} </div>
            <Switch checked={!!d.community} disabled={busy} onChange={v => patch({ community: v })} />
          </div>

          <div className="adm-group-t" style={{ marginTop: 14 }}>{t("Whose account pays")}</div>
          <div className="adm-hint">{d.authMode === 'profile'
            ? t("Each profile signs in with their own account.")
            : d.auth?.type === 'apikey' || meta.http
              ? t("One API key for the whole instance: every profile may use the Coach with it, and the daily limits above are what bound the spend.")
              : d.boundUid
                ? t("One personal account, already in use by one profile. Every other profile is refused, so nobody spends somebody else's subscription.")
                : t("One personal account. The first profile to use it becomes the only one allowed to; every other profile is then refused. Paste an API key instead if the whole instance should have the Coach.")}</div>

          <div className="adm-group-t" style={{ marginTop: 14 }}>{t("Isolation")}</div>
          <div className="adm-hint">{d.unprivileged && !d.unprivileged.ok
            ? <span style={{ color: 'var(--red)' }}>{t("Jobs are blocked:")} {d.unprivileged.why}{t(". Nothing runs until this is fixed.")}</span>
            : d.unprivileged?.dropped
              ? t("Jobs run as a separate unprivileged user that cannot read your data directory or secrets.")
              : d.unprivileged?.why?.includes('no child process')
                ? t("Not needed for this provider. It makes an HTTPS request and starts no program on this server.")
                : t("Jobs run with the server's own user on this host (no separate user to drop to).")}</div>
        </div>
      </details>

      {/* ---------- activity ---------- */}
      <details className="adm-fold">
        <summary>{t("Activity")} <Icon name="chevronRight" className="chev" /></summary>
        <div className="adm-fold-b">
          <div className="tiles" style={{ textAlign: 'start', marginBottom: 10 }}>
            <div className="tile"><div className="l">{t("Jobs today")}</div><div className="v" style={{ fontSize: '1.1rem' }}>{number(d.jobsToday)}</div></div>
            <div className="tile"><div className="l">{t("Last success")}</div><div className="v" style={{ fontSize: '.85rem' }}>{rel(d.lastSuccess?.at)}</div></div>
          </div>
          {d.lastError && <>
            <div className="adm-group-t">{t("Last failure")}</div>
            <div className="adm-result bad" style={{ marginTop: 0, marginBottom: 10 }}>
              <b>{t(failureTitle(d.lastError.errorClass))}</b>
              {d.lastError.detail ? <span className="small">{d.lastError.detail}</span> : null}
              <div className="dim" style={{ fontSize: '.72rem', marginTop: 4 }}>{rel(d.lastError.at)}</div>
            </div>
          </>}
          <div className="adm-group-t">{t("Recent jobs")}</div>
          {d.recent?.length ? <div className="adm-log">
            {d.recent.slice(0, 10).map((e, i) => <div key={i} className="adm-log-row">
              <span>{e.kind === 'create' ? t("Plan") : t("Review")}{e.trigger === 'scheduled' ? t(" · scheduled") : ''} · <span style={{ color: e.outcome === 'failed' ? 'var(--red)' : e.outcome === 'ready' ? 'var(--acc)' : 'var(--label-2)' }}>{t(e.outcome)}</span>{e.ms ? ' · ' + seconds(e.ms) : ''}</span>
              <span className="when">{rel(e.at)}</span>
            </div>)}
          </div> : <div className="adm-empty">{t("No jobs yet.")}</div>}
          <div className="adm-hint" style={{ margin: '8px 0 0' }}>{t("Counts and outcomes only. What people asked the Coach, and what it answered, is never shown here.")}</div>
        </div>
      </details>
    </>}
    </section></aside></div>
    <div className="adm-actions">
      <span className="adm-save-note">{t(Object.keys(draft).length || capsDraft || headersDraft !== null ? 'Unsaved changes' : 'No unsaved changes')}</span>
      <Button variant="tinted" disabled={busy || (!Object.keys(draft).length && !capsDraft && headersDraft === null)} onClick={() => { setDraft({}); setCapsDraft(null); setHeadersDraft(null) }}>{t('Discard changes')}</Button>
      <Button variant="primary" disabled={busy || (!Object.keys(draft).length && headersDraft === null)} onClick={() => save(draft)}>{t("Save changes")}</Button>
      {capsDraft && <Button variant="tinted" disabled={busy} onClick={() => save({ caps: capsDraft })}>{t("Save usage limits")}</Button>}
    </div>
  </div>
}

/* ---------------------------------- pieces ---------------------------------- */

function Step({ n, title, hint, done, open, forceOpen, children }) {
  const { t } = useAdminLanguage()
  // `key` remounts the <details> when the wizard advances, so the next step unfolds itself.
  return <details className={'adm-step ' + (done ? 'done' : 'todo')} open={open || forceOpen}>
    <summary>
      <span className="adm-num">{done ? <Icon name="check" /> : n}</span>
      <span className="adm-step-t"><b>{title}</b><span>{hint}</span></span>
      <Icon name="chevronRight" className="chev" />
    </summary>
    <div className="adm-step-b">{children}</div>
  </details>
}

function CredentialPill({ auth }) {
  const { t } = useAdminLanguage()
  const s = auth?.state
  if (s === 'connected') return <span className="adm-pill ok">{t("connected")}{auth.account ? ' · ' + auth.account : ''}</span>
  if (s === 'not-required') return <span className="adm-pill">{t("not needed")}</span>
  if (s === 'optional') return <span className="adm-pill">{t("optional, none saved")}</span>
  if (s === 'unreadable') return <span className="adm-pill bad">{t("can't be read")}</span>
  return <span className="adm-pill warn">{t("needed")}</span>
}

const credentialHint = (auth, meta, t) => {
  const s = auth?.state
  if (s === 'connected') return auth.account ? t('Connected as {0}', auth.account) : t('Connected')
  if (s === 'not-required') return t('Not needed')
  if (s === 'optional') return t('Optional for this endpoint')
  if (s === 'unreadable') return t('Stored key cannot be read. Add it again.')
  return t(meta.setupToken ? 'Token or API key needed' : 'API key needed')
}

const credentialLabel = type => ({
  'cli-token': 'Claude Code setup token', 'chatgpt-cli': 'ChatGPT CLI login', oauth: 'legacy token', apikey: 'API key'
}[type] || 'credential')

// The failure classes jobs.js emits, in words an operator can act on.
const failureTitle = cls => ({
  timeout: 'The provider took longer than the job budget (COACH_JOB_TIMEOUT_MS, default 5 minutes)',
  missing: 'The provider runtime or key is missing',
  auth: 'The provider rejected the credential',
  provider: 'The provider returned an error',
  unusable: 'The model answered, but not in a shape the app could use',
  restart: 'The server restarted while a job was running',
  nostate: 'The user\'s training data could not be read',
  off: 'The Coach was off when the job ran',
  toolarge: 'The user\'s training data made a request too large to send, so no provider was called',
  internal: 'Something went wrong on the server'
}[cls] || cls || 'Failed')

/* ------------------------------- setup token -------------------------------- */

function SetupTokenSheet({ close, onDone, onDraft = () => {}, label }) {
  const { t } = useAdminLanguage()
  const toast = useUI(s => s.toast)
  const [token, setToken] = useState('')
  // Which account this token belongs to. Optional, and stored as a plain label — it is what the
  // admin card and the user's Coach screen both show when they name whose account is spent.
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api('/api/admin/coach/connect', { method: 'POST', body: JSON.stringify({ type: 'cli-token', token: token.trim(), account: account.trim() }) })
      setToken('')
      toast(t(r.test?.ok ? 'Connected ✅' : 'Token saved'))
      close(); onDone()
    } catch (e) { toast(t(adminError(e))); setBusy(false) }
  }

  return <>
    <h3>{t("Connect")} {label}</h3>
    <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 12 }}>{t("On a trusted computer where you use Claude Code, run")} <code>{t("claude setup-token")}</code>{t(", complete its normal browser sign-in, then paste the token it prints here. This app never opens or handles Claude's authorization flow.")} </div>
    <TextField value={token} autoFocus type="password" placeholder={t("paste setup token")} onChange={e => { setToken(e.target.value); onDraft(!!(e.target.value || account)) }} />
    <div style={{ height: 8 }} />
    <TextField value={account} placeholder={t("whose account is this? (e.g. you@example.com)")} onChange={e => { setAccount(e.target.value); onDraft(!!(token || e.target.value)) }} />
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy || !token.trim()} onClick={save}>{t("Save token")}</Button>
    <Button disabled={busy} onClick={close}>{t(token || account ? 'Discard changes' : 'Cancel')}</Button>
    <div style={{ height: 8 }} />
  </>
}

function ApiKeySheet({ close, onDone, onDraft = () => {}, label, placeholder, optional }) {
  const { t } = useAdminLanguage()
  const toast = useUI(s => s.toast)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api('/api/admin/coach/connect', { method: 'POST', body: JSON.stringify({ type: 'apikey', token: key.trim() }) })
      toast(t(r.test?.ok ? 'Key saved ✅' : 'Key saved'))
      close(); onDone()
    } catch (e) { toast(t(adminError(e))); setBusy(false) }
  }
  return <>
    <h3>{label} {t("API key")}</h3>
    <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 12 }}>{t("Stored encrypted on this server and sent to the provider only while a job runs. It is never shown again and never leaves the server")}{optional ? t(". For an endpoint that takes no key, you can leave this empty and close the sheet.") : '.'}
    </div>
    <TextField value={key} autoFocus type="password" placeholder={placeholder || 'sk-…'} autoCapitalize="none" autoCorrect="off" onChange={e => { setKey(e.target.value); onDraft(!!e.target.value) }} />
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy || !key.trim()} onClick={save}>{t("Save key")}</Button>
    <Button disabled={busy} onClick={close}>{t(key ? 'Discard changes' : 'Cancel')}</Button>
    <div style={{ height: 8 }} />
  </>
}
