// Tests for mcp/src/state.js on Postgres: KUCH_DATABASE_URL (or DATABASE_URL) set, the API on
// STORAGE_BACKEND=postgres. Each case gets its own schema built by the API's migrations
// (pg-helpers.mjs) and a fresh copy of state.js, which reads its env at module load.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PG_URL, NO_PG, freshSchema, withOptions } from './pg-helpers.mjs'

if (NO_PG) console.warn(`[state-pg.test] ${NO_PG}`)

const ENV = ['KUCH_DATABASE_URL', 'DATABASE_URL', 'KUCH_UID', 'OPENGYM_UID', 'KUCH_DATA', 'OPENGYM_DATA']

let mod = null
async function load(env) {
  vi.resetModules()
  for (const k of ENV) vi.stubEnv(k, env[k] ?? '')
  mod = await import('../src/state.js')
  return mod
}

afterEach(async () => {
  if (mod) await mod.close()
  mod = null
  vi.unstubAllEnvs()
})

// Whatever a test asserts, it must not be able to pass by reading a stale file next to it.
function markedDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pg-'))
  fs.writeFileSync(path.join(d, 'MIGRATED-TO-POSTGRES'), '')
  fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify({ users: [{ id: 'alex', name: 'Stale File' }] }))
  fs.writeFileSync(path.join(d, 'state-alex.json'), JSON.stringify({ unit: 'stale' }))
  return d
}

describe.skipIf(NO_PG)('Postgres mode', () => {
  let db
  beforeEach(async () => { db = await freshSchema() })
  afterEach(async () => { await db.drop() })

  const addUser = (id, pos, name = id, created = '2026-01-01T00:00:00.000Z') =>
    db.query('INSERT INTO users (id, pos, name, created) VALUES ($1, $2, $3, $4)', [id, pos, name, created])
  const putState = (uid, rev, doc) =>
    db.query(`INSERT INTO user_state (uid, rev, doc) VALUES ($1, $2, $3)
              ON CONFLICT (uid) DO UPDATE SET rev = EXCLUDED.rev, doc = EXCLUDED.doc`, [uid, rev, doc])

  test('reads the profile from user_state and users, with the app defaults merged in', async () => {
    await addUser('alex', 0, 'Alex', '2026-01-02T03:04:05.000Z')
    await putState('alex', 3, { unit: 'lb', routines: [{ id: 'r1', name: 'R', ex: [] }] })
    const { getState, getUser } = await load({ KUCH_DATABASE_URL: db.url, KUCH_UID: 'alex', KUCH_DATA: markedDir() })
    const S = await getState()
    expect(S.unit).toBe('lb')
    expect(S.routines.length).toBe(1)
    expect(S.dayPlan).toEqual({})
    expect(await getUser()).toEqual({ id: 'alex', name: 'Alex', created: '2026-01-02T03:04:05.000Z' })
  })

  test('a profile with no user_state row is null, and its first sync shows up on the next call', async () => {
    await addUser('alex', 0)
    const { getState } = await load({ KUCH_DATABASE_URL: db.url, KUCH_UID: 'alex' })
    expect(await getState()).toBeNull()
    await putState('alex', 1, { unit: 'lb' })
    expect((await getState()).unit).toBe('lb')
  })

  test('freshness follows rev: a new rev is re-read, the same rev is served from memory', async () => {
    await addUser('alex', 0)
    await putState('alex', 1, { unit: 'kg' })
    const { getState } = await load({ KUCH_DATABASE_URL: db.url, KUCH_UID: 'alex' })
    expect((await getState()).unit).toBe('kg')
    await putState('alex', 2, { unit: 'lb' })
    expect((await getState()).unit).toBe('lb')
    // The API bumps rev on every write, so a doc that changes under the same rev is not one the
    // API wrote: proof the cache is keyed on rev rather than re-reading the doc every call.
    await db.query(`UPDATE user_state SET doc = '{"unit":"st"}' WHERE uid = 'alex'`)
    expect((await getState()).unit).toBe('lb')
  })

  test('a deleted profile reads as null, not as the last copy in memory', async () => {
    await addUser('alex', 0)
    await putState('alex', 1, { unit: 'lb' })
    const { getState } = await load({ KUCH_DATABASE_URL: db.url, KUCH_UID: 'alex' })
    expect((await getState()).unit).toBe('lb')
    await db.query(`DELETE FROM users WHERE id = 'alex'`)
    expect(await getState()).toBeNull()
  })

  test('DATABASE_URL works when KUCH_DATABASE_URL is unset, and KUCH_DATABASE_URL wins over it', async () => {
    await addUser('alex', 0)
    await putState('alex', 1, { unit: 'lb' })
    let s = await load({ DATABASE_URL: db.url, KUCH_UID: 'alex' })
    expect((await s.getState()).unit).toBe('lb')
    await mod.close()
    s = await load({ KUCH_DATABASE_URL: db.url, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', KUCH_UID: 'alex' })
    expect((await s.getState()).unit).toBe('lb')
  })

  describe('which profile, without KUCH_UID', () => {
    test('the only user_state row', async () => {
      await addUser('alex', 0); await addUser('sam', 1)
      await putState('sam', 1, { unit: 'lb' })
      const { getUser } = await load({ KUCH_DATABASE_URL: db.url })
      expect((await getUser()).id).toBe('sam')
    })

    test('no user_state row: the only user', async () => {
      await addUser('alex', 0)
      const { getUser, getState } = await load({ KUCH_DATABASE_URL: db.url })
      expect((await getUser()).id).toBe('alex')
      expect(await getState()).toBeNull()
    })

    test('no users at all says so', async () => {
      const { getState } = await load({ KUCH_DATABASE_URL: db.url })
      await expect(getState()).rejects.toThrow(/no Kuch users found in the database/)
    })

    for (const [label, synced] of [['several user_state rows', true], ['several users, none synced yet', false]]) {
      test(`${label}: a config message that names no uid`, async () => {
        const uids = ['alex', 'secret-partner-uid', 'third-account']
        for (const [i, u] of uids.entries()) { await addUser(u, i); if (synced) await putState(u, 1, {}) }
        const logs = []
        const spy = vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')))
        const { getState } = await load({ KUCH_DATABASE_URL: db.url })
        const err = await getState().then(() => null, e => e)
        spy.mockRestore()
        expect(err.code).toBe('EINVAL')
        expect(err.message).toMatch(/holds 3 profiles/)
        expect(err.message).toMatch(/set KUCH_UID/)
        for (const u of uids) expect(err.message).not.toContain(u)
        expect(err.message).not.toContain('/')
        for (const u of uids) expect(logs.join('\n')).toContain(u)
        // the operator's log names the profiles, never the connection string and its password
        expect(logs.join('\n')).not.toContain(PG_URL)
      })
    }
  })

  test('the read-only role the README documents is enough, and cannot see credentials', async () => {
    await addUser('alex', 0, 'Alex')
    await putState('alex', 4, { unit: 'lb' })
    await db.query(`INSERT INTO credentials (id, pos, user_id, public_key, counter) VALUES ('c1', 0, 'alex', 'k', 0)`)
    const role = await db.role([
      'GRANT SELECT ON user_state TO $ROLE',
      'GRANT SELECT (id, name, created) ON users TO $ROLE'
    ])
    const url = withOptions(PG_URL, { search_path: db.schema, role })
    const { getState, getUser } = await load({ KUCH_DATABASE_URL: url })   // uid resolved, too
    expect((await getState()).unit).toBe('lb')
    expect((await getUser()).name).toBe('Alex')
    const pg = (await import('pg')).default
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    try {
      await expect(c.query('SELECT * FROM credentials')).rejects.toThrow(/permission denied/)
      await expect(c.query('SELECT email FROM users')).rejects.toThrow(/permission denied/)
    } finally { await c.end() }
  })
})

test('an unreachable database is an EIO that names the failure, not the password', async () => {
  const { getState } = await load({ KUCH_DATABASE_URL: 'postgres://kuch:hunter2-secret@127.0.0.1:1/kuch', KUCH_UID: 'alex' })
  const err = await getState().then(() => null, e => e)
  expect(err).toBeTruthy()
  expect(err.code).toBe('EIO')
  expect(err.message).toMatch(/cannot read the Kuch database/)
  expect(err.message).not.toContain('hunter2-secret')
})
