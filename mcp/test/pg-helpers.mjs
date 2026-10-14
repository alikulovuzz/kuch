/* A throwaway Postgres schema per test, in the database DATABASE_URL_TEST names, built by the
   API's own migrations so the reader is tested against the schema the API really writes. Tests
   that need one skip with a clear message when it is not set, as in the api suite
   (api/test/pg-helpers.mjs). */
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { migrate } from '../../api/store/migrate.js'

export const PG_URL = process.env.DATABASE_URL_TEST || ''
export const NO_PG = PG_URL ? false : 'DATABASE_URL_TEST is not set: the Postgres tests are skipped'

// `url` whose connections start with these settings (`-c name=value` each).
export function withOptions(url, settings) {
  const u = new URL(url)
  u.searchParams.set('options', Object.entries(settings).map(([k, v]) => `-c ${k}=${v}`).join(' '))
  return u.toString()
}

const MIGRATIONS = new URL('../../api/migrations/', import.meta.url)

// → { url, schema, query(sql, params), role(grants), drop() }: a new schema with the API's tables.
export async function freshSchema() {
  const schema = 't_' + crypto.randomBytes(6).toString('hex')
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA ${schema}`)
  const url = withOptions(PG_URL, { search_path: schema })
  const side = new pg.Client({ connectionString: url })
  await side.connect()
  await migrate(side, fileURLToPath(MIGRATIONS))
  const roles = []
  return {
    url,
    schema,
    query: (sql, params) => side.query(sql, params),
    // A NOLOGIN role holding `grants`; connect as it with withOptions(url, { role }).
    async role(grants) {
      const name = schema + '_r' + roles.length
      await admin.query(`CREATE ROLE ${name} NOLOGIN`)
      roles.push(name)
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`)
      for (const g of grants) await side.query(g.replaceAll('$ROLE', name))   // side: search_path is the schema
      await admin.query(`GRANT ${name} TO CURRENT_USER`)
      return name
    },
    async drop() {
      await side.end().catch(() => {})
      await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {})
      for (const r of roles) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
      await admin.end().catch(() => {})
    }
  }
}
