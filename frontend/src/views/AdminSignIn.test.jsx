// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AdminSignIn from './AdminSignIn.jsx'
const state = vi.hoisted(() => ({ config: { password_login: true }, setUser: vi.fn(), adoptProfile: vi.fn() }))
vi.mock('../store/useStore.js', () => ({ useStore: fn => fn(state) }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ search: '' }) }))
let root
afterEach(() => { act(() => root?.unmount()); localStorage.clear() })
it('offers password recovery without losing the entered email when language changes', () => {
  const host = document.createElement('div'); root = createRoot(host)
  act(() => root.render(<AdminSignIn />))
  const input = host.querySelector('input[name="email"]')
  expect(input).toBeTruthy()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'owner@example.test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const language = host.querySelector('select')
  act(() => { language.value = 'ru'; language.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(input.value).toBe('owner@example.test')
  expect(host.querySelector('button[type="submit"]').textContent).toBe('Войти')
})
