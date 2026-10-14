/* npm run test:pg — the whole API suite again, on the Postgres backend (test/backend.mjs), against
   the database DATABASE_URL_TEST names. Arguments replace the default file list.

   Without DATABASE_URL_TEST there is nothing to run against: said plainly and skipped, except on
   CI, where a missing test database is a broken job rather than a pass. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL_TEST) {
  console.log('DATABASE_URL_TEST is not set: the Postgres run of the API suite is skipped.');
  process.exit(process.env.CI ? 1 : 0);
}
const files = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', ...(files.length ? files : ['test/*.test.js'])], {
  cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  stdio: 'inherit',
  env: { ...process.env, TEST_STORAGE_BACKEND: 'postgres' }
});
process.exit(r.status ?? 1);
