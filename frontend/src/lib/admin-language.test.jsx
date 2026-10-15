// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useAdminLanguage } from './admin-language.js'
vi.mock('../store/useStore.js', () => ({ useStore: selector => selector({ user: { id: 'admin' } }) }))
let root
afterEach(() => { act(() => root?.unmount()); localStorage.clear() })
function Language({ account }) {
  const { locale, setLocale, t } = useAdminLanguage(account)
  return <><output>{locale}:{t('Users')}</output><button onClick={() => setLocale('ru')}>Russian</button></>
}
it('keeps sign-in and account choices separate without changing the workout language', async () => {
  localStorage.setItem('workout-language', 'uz-Cyrl')
  const host = document.createElement('div'); root = createRoot(host)
  await act(async () => root.render(<Language account={null} />))
  await act(async () => host.querySelector('button').click())
  expect(host.textContent).toContain('ru:Пользователи')
  await act(async () => root.render(<Language account="first-admin" />))
  expect(host.textContent).not.toContain('ru:')
  await act(async () => host.querySelector('button').click())
  await act(async () => root.render(<Language account="second-admin" />))
  expect(host.textContent).not.toContain('ru:')
  await act(async () => root.render(<Language account="first-admin" />))
  expect(host.textContent).toContain('ru:Пользователи')
  expect(localStorage.getItem('workout-language')).toBe('uz-Cyrl')
})
