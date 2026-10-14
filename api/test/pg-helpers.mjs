/* A throwaway Postgres schema per test, in the database DATABASE_URL_TEST names. Tests that need
   one skip with a clear message when it is not set, so the suite still runs without Postgres.

   Each schema is its own instance as far as the API can tell: the store finds its tables through
   the connection's search_path, and its single-instance lock is per schema (store/pg.js). */
import crypto from 'node:crypto';
import pg from 'pg';

export const PG_URL = process.env.DATABASE_URL_TEST || '';
export const NO_PG = PG_URL ? false : 'DATABASE_URL_TEST is not set: the Postgres tests are skipped';

// `url` with the connection's search_path set to `schema`.
export function withSchema(url, schema) {
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

// → { url, schema, query(sql, params) }: a new empty schema, dropped when the test ends.
export async function freshSchema(t) {
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = withSchema(PG_URL, schema);
  const side = new pg.Client({ connectionString: url });
  await side.connect();
  t.after(async () => {
    await side.end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  });
  return { url, schema, query: (sql, params) => side.query(sql, params) };
}
