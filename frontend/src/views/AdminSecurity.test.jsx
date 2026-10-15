// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AdminSecurity from './AdminSecurity.jsx'
vi.mock('../store/useStore.js', () => ({ useStore: fn => fn({ user: { id: 'admin' } }) }))
let root
afterEach(() => { act(() => root?.unmount()); vi.unstubAllGlobals() })
it('explains unavailable recovery and keeps password input on a failed security change', async () => {
  vi.stubGlobal('fetch', async (_, init) => Response.json(init.method === 'POST' ? { error: 'mail failed', code: 'mail-failed' } : {
    google: { available: false, linked: false }, password: { available: true, set: true }, mailAvailable: false, passkeys: 0, email: null,
  }, { status: init.method === 'POST' ? 503 : 200 }))
  const host = document.createElement('div'); root = createRoot(host)
  await act(async () => { root.render(<AdminSecurity />) })
  expect(host.textContent).toContain('Outgoing mail is not configured')
  expect(host.querySelector('input[name="current-password"]')).toBeTruthy()
  const current = host.querySelector('input[name="current-password"]')
  const next = host.querySelector('input[autocomplete="new-password"]')
  await act(async () => {
    for (const [input, value] of [[current, 'current fixture password'], [next, 'new fixture password']]) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Save password').click())
  expect(current.value).toBe('current fixture password')
  expect(next.value).toBe('new fixture password')
  expect(host.querySelector('[role="status"]').textContent).toBeTruthy()
})
