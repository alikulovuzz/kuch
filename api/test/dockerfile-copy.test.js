/* The api image carries only the files named on api/Dockerfile's COPY line (plus coach/). A
   root-level module that server.js imports and that line forgets is invisible to every test run
   from the source tree and shows up only when the published image boots — as
   ERR_MODULE_NOT_FOUND, on every instance that pulled it. So the line is checked here, for
   server.js's own imports and for whatever those modules import from the api root in turn. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(API, f), 'utf8');

// Every `./name.js` a file imports, statically or dynamically — root-level only; coach/ is
// copied as a whole directory.
const rootImports = src => [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([^'"/]+\.js)['"]/g)].map(m => m[1]);

test('every root-level module server.js needs is on the Dockerfile COPY line', () => {
  const line = read('Dockerfile').split('\n').find(l => /^COPY\s+server\.js\b/.test(l));
  assert.ok(line, 'the COPY line that carries server.js');
  const copied = new Set(line.trim().split(/\s+/).slice(1, -1));

  const needed = new Set(['server.js']);
  const queue = ['server.js'];
  while (queue.length) {
    for (const dep of rootImports(read(queue.shift()))) {
      if (!needed.has(dep)) { needed.add(dep); queue.push(dep); }
    }
  }
  assert.ok(needed.has('media.js'), 'the walk finds the media store');
  const missing = [...needed].filter(f => !copied.has(f));
  assert.deepEqual(missing, [], `add ${missing.join(', ')} to the COPY line in api/Dockerfile`);
  for (const f of copied) assert.ok(fs.existsSync(path.join(API, f)), `${f} is copied but does not exist`);
});

// The same for directories: server.js importing `./store/index.js` needs a `COPY store ./store`.
test('every directory server.js imports from has its own COPY line', () => {
  const dirs = new Set([...read('server.js').matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([^'"/]+)\/[^'"]+['"]/g)].map(m => m[1]));
  assert.ok(dirs.has('store') && dirs.has('coach'), 'the walk finds store/ and coach/');
  const lines = read('Dockerfile').split('\n');
  const missing = [...dirs].filter(d => !lines.some(l => new RegExp(`^COPY\\s+${d}\\s+\\./${d}\\s*$`).test(l.trim())));
  assert.deepEqual(missing, [], `add COPY ${missing.join(', ')} to api/Dockerfile`);
});

// The cutover runs the migration inside the image (`docker compose run --rm api node
// scripts/migrate-json-to-pg.mjs`), so the script ships, and so does every api file it imports.
test('the JSON-to-Postgres migration script and what it imports are in the image', () => {
  const lines = read('Dockerfile').split('\n').map(l => l.trim());
  assert.ok(lines.some(l => /^COPY\s+scripts\/migrate-json-to-pg\.mjs\s+\.\/scripts\/$/.test(l)), 'add COPY scripts/migrate-json-to-pg.mjs ./scripts/ to api/Dockerfile');
  const copied = new Set(lines.find(l => /^COPY\s+server\.js\b/.test(l)).split(/\s+/).slice(1, -1));
  for (const [, file] of read('scripts/migrate-json-to-pg.mjs').matchAll(/from\s+['"]\.\.\/([^'"]+)['"]/g)) {
    const dir = file.includes('/') ? file.split('/')[0] : null;
    assert.ok(dir ? lines.includes(`COPY ${dir} ./${dir}`) : copied.has(file), `the script imports ${file}, which the image does not carry`);
  }
});

// Read from disk rather than imported, so the walks above cannot see it: without the SQL files the
// Postgres backend refuses to start on a fresh database, and only in the image.
test('the migrations the Postgres backend runs at startup are in the image', () => {
  assert.match(read('store/pg.js'), /'\.\.', 'migrations'/, 'store/pg.js still reads api/migrations');
  assert.ok(read('Dockerfile').split('\n').some(l => /^COPY\s+migrations\s+\.\/migrations\s*$/.test(l.trim())), 'add COPY migrations ./migrations to api/Dockerfile');
});
