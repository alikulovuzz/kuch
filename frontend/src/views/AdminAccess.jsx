import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useAdminLanguage, languages } from '../lib/admin-language.js'

export default function AdminAccess() {
  const user = useStore(s => s.user)
  const signOut = useStore(s => s.signOut)
  const nav = useNavigate()
  const { locale, setLocale, t } = useAdminLanguage(user?.id)
  const [error, setError] = useState('')
  const switchAccount = async () => {
    try {
      const result = await signOut()
      if (result?.owed && !result.stashed) setError('Sync your pending workout changes before switching accounts.')
    } catch (e) { setError(e.message) }
  }
  return <section className="narrow" lang={locale}>
    <select aria-label={t('Admin language')} value={locale} onChange={e => setLocale(e.target.value)}>
      {Object.entries(languages).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
    </select>
    <h1>{t('Administrator access required')}</h1>
    <button className="btn" onClick={() => nav('/home')}>{t('Home')}</button>
    <button className="btn" onClick={switchAccount}>{t(user ? 'Switch account' : 'Sign in')}</button>
    {error && <p role="alert">{t(error)}</p>}
  </section>
}
