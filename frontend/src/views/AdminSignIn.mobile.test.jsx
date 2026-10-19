// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AdminSignIn from './AdminSignIn.jsx'

const state = vi.hoisted(() => ({ config: { password_login: true, google_login: true }, sync: { server: 'https://example.test/gym' } }))
const openSheet = vi.hoisted(() => vi.fn())
vi.mock('../lib/mobile.js', async importOriginal => ({ ...(await importOriginal()), MOBILE: true }))
vi.mock('../store/useStore.js', () => ({ useStore: fn => fn(state) }))
vi.mock('../store/useUI.js', () => ({ useUI: fn => fn({ openSheet }) }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ search: '?section=security&token=fixture-secret' }) }))

let root
afterEach(() => { act(() => root?.unmount()); localStorage.clear(); openSheet.mockClear() })

it('uses browser sign-in and pairing on native mobile, preserving the server prefix and destination', () => {
  const host = document.createElement('div'); root = createRoot(host)
  act(() => root.render(<AdminSignIn />))
  const link = host.querySelector('a[href]')
  expect(link.getAttribute('href')).toBe('https://example.test/gym/#/admin?section=security')
  expect(host.textContent).toContain('Pair this app with a code')
  expect(host.textContent).not.toContain('Sign in with a passkey')
  expect(host.textContent).not.toContain('Google sign-in is unavailable')
  act(() => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Pair this app')).click())
  expect(openSheet).toHaveBeenCalledTimes(1)
})
