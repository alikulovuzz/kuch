/* The schema migrations of the Postgres backend: api/migrations/NNN_name.sql, applied in name
   order, each one in its own transaction together with its row in schema_migrations, so a
   migration is either wholly applied and recorded or not at all. A failure throws, naming the
   file: the API does not start on a schema it does not know.

   Run by store/pg.js at startup, on the connection that holds the single-instance lock, so two
   processes never migrate the same schema at once. */
import fs from 'node:fs';
import path from 'node:path';

export async function migrate(client, dir) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
  const files = fs.readdirSync(dir).filter(f => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`database migration ${file} failed: ${e.message}`);
    }
    applied.push(version);
  }
  return applied;
}
