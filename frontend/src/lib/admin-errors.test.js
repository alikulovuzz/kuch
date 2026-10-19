import { expect, it } from 'vitest'
import { adminError } from './admin-errors.js'
import { dictionaries } from '../locales/admin/index.js'

it('shows localized summaries for known admin workflow failures even when the request has a generic HTTP code', () => {
  const known = [
    'no such user', 'cannot disable an admin', 'you cannot delete your own account',
    'cannot delete the last admin', 'no such code', 'already used, cannot revoke',
  ]
  for (const error of known) {
    const summary = adminError({ code: 'http', data: { error }, message: error })
    expect(summary).not.toBe(error)
    for (const locale of ['ru', 'uz-Latn', 'uz-Cyrl']) expect(dictionaries[locale][summary]).toBeTruthy()
  }
})
