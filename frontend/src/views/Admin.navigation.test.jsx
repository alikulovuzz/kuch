// @vitest-environment happy-dom
import React, { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../store/useStore.js', () => ({ useStore: fn => fn({ user: { id: 'admin', admin: true } }) }))
vi.mock('../store/useUI.js', () => ({ useUI: fn => fn({ toast: vi.fn(), openSheet: vi.fn() }) }))
vi.mock('../lib/api.js', () => ({ api: path => Promise.resolve(path.includes('users') ? { users: [] } : { invites: [] }) }))
vi.mock('./AdminSecurity.jsx', () => ({ default: () => null }))
vi.mock('./AdminCoach.jsx', () => ({ default: function Draft({ onDirty }) {
  const [value, setValue] = useState('')
  useEffect(() => { onDirty(!!value) }, [value])
  return <input aria-label="Fixture draft" value={value} onChange={e => setValue(e.target.value)} />
} }))
let root, host, router
afterEach(() => { act(() => root?.unmount()); router?.dispose(); host?.remove(); localStorage.clear() })
it('guards browser Back, retains the draft on Stay, and leaves only after Discard', async () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  router = createMemoryRouter([{ path: '/admin', element: <Admin /> }, { path: '/home', element: <h1>Home</h1> }], { initialEntries: ['/home', '/admin'], initialIndex: 1 })
  await act(async () => root.render(<RouterProvider router={router} />))
  await act(async () => [...host.querySelectorAll('nav button')].find(b => b.textContent === 'AI Coach').click())
  const input = host.querySelector('[aria-label="Fixture draft"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'unsaved endpoint')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => router.navigate(-1))
  expect(host.querySelector('[role="alertdialog"]')).toBeTruthy()
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Stay').click())
  expect(router.state.location.pathname).toBe('/admin')
  expect(input.value).toBe('unsaved endpoint')
  await act(async () => router.navigate(-1))
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Discard changes').click())
  expect(router.state.location.pathname).toBe('/home')
})
