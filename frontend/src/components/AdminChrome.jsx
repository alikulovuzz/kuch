import Icon from './Icon.jsx'

export function AdminMark({ className = '' }) {
  return <span className={'adm-mark ' + className} aria-hidden="true">K</span>
}

export function AdminAvatar({ name = '', className = '' }) {
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => [...part][0]).join('').toLocaleUpperCase()
  return <span className={'adm-avatar ' + className} aria-hidden="true">{initials || 'K'}</span>
}

export function AdminSectionIcon({ section }) {
  const names = { Overview: 'grid', Users: 'person', Invites: 'ticket', 'AI Coach': 'sparkles', Activity: 'pulse', Security: 'shield' }
  return <Icon name={names[section] || 'grid'} />
}

export function AuthFrame({ title, label, intro, locale, languageControl, homeLabel, onHome, children, footer }) {
  return <main className="adm-auth-shell" lang={locale}>
    <aside className="adm-auth-brand">
      <div className="adm-brand"><AdminMark /><strong>Kuch</strong></div>
      <div className="adm-auth-story"><span className="adm-eyebrow">{label}</span><p>{intro}</p></div>
      <div className="adm-auth-brand-line" aria-hidden="true" />
    </aside>
    <section className="adm-auth-pane">
      <header className="adm-auth-top">
        {onHome ? <button className="adm-auth-back" onClick={onHome}><Icon name="chevronLeft" />{homeLabel}</button> : <span className="adm-auth-wordmark">Kuch</span>}
        {languageControl}
      </header>
      <div className="adm-auth-body">
        <div className="adm-auth-heading"><AdminMark /><span className="adm-eyebrow">{label}</span><h1>{title}</h1></div>
        {children}
      </div>
      {footer && <footer className="adm-auth-footer">{footer}</footer>}
    </section>
  </main>
}
