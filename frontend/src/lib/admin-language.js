import { useSyncExternalStore } from 'react'
import { dictionaries, languages } from '../locales/admin/index.js'
import { useStore } from '../store/useStore.js'
export { languages }
const listeners = new Set()
const volatile = new Map()
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (!event.key || event.key.startsWith('kuch.admin.language.')) listeners.forEach(listener => listener())
})
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
const keyFor = account => 'kuch.admin.language.' + (account || 'signin')
function initialLanguage() {
  for (const lang of navigator.languages || [navigator.language]) {
    const lower = (lang || '').toLowerCase()
    if (lower.startsWith('uz')) return lower.includes('cyrl') ? 'uz-Cyrl' : 'uz-Latn'
    if (lower.startsWith('ru')) return 'ru'
    if (lower.startsWith('en')) return 'en'
  }
  return 'en'
}
function savedLanguage(account) {
  try { const saved = localStorage.getItem(keyFor(account)); if (languages[saved]) return saved } catch { return volatile.get(keyFor(account)) || initialLanguage() }
  return initialLanguage()
}
export function useAdminLanguage(account) {
  const signedIn = useStore(s => s.user?.id)
  if (account === undefined) account = signedIn
  const locale = useSyncExternalStore(subscribe, () => savedLanguage(account))
  const setLocale = value => {
    if (!languages[value]) return
    try { localStorage.setItem(keyFor(account), value) } catch { volatile.set(keyFor(account), value) }
    listeners.forEach(listener => listener())
  }
  const t = (key, ...args) => String(dictionaries[locale]?.[key] || dictionaries.en[key] || key).replace(/\{(\d+)\}/g, (match, i) => args[i] ?? match)
  const number = value => new Intl.NumberFormat(locale).format(value)
  const date = value => value ? new Date(value).toLocaleString(locale, { timeZoneName: 'short' }) : '—'
  const duration = ms => {
    const minutes = Math.max(0, Math.floor(ms / 60000))
    const unit = (n, unit) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(n)
    return minutes < 60 ? unit(minutes, 'minute') : unit(Math.floor(minutes / 60), 'hour') + ' ' + unit(minutes % 60, 'minute')
  }
  const relative = value => {
    if (!value) return t('Never')
    const seconds = (new Date(value).getTime() - Date.now()) / 1000
    const [unit, divisor] = Math.abs(seconds) < 60 ? ['second', 1] : Math.abs(seconds) < 3600 ? ['minute', 60] : Math.abs(seconds) < 86400 ? ['hour', 3600] : ['day', 86400]
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.trunc(seconds / divisor), unit)
  }
  return { locale, setLocale, t, number, date, relative, duration }
}
