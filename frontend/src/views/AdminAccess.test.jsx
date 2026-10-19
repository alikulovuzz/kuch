// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AdminAccess from './AdminAccess.jsx'
const state = vi.hoisted(() => ({ user: { id: 'ordinary', admin: false }, signOut: vi.fn(), config: {} }))
vi.mock('../store/useStore.js', () => ({ useStore: fn => fn(state) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
let root
afterEach(() => { act(() => root?.unmount()); localStorage.clear() })
it('explains lack of administrator access without exposing admin data', () => {
  const host = document.createElement('div'); root = createRoot(host)
  act(() => root.render(<AdminAccess />))
  expect(host.textContent).toContain('Administrator access required')
  expect(host.textContent).toContain('Switch account')
  expect(host.textContent).not.toContain('Invite codes')
})
