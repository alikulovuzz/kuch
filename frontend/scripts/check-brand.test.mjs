/* scripts/check-brand.mjs (the repo-level brand check), run the way CI runs it.
 *
 * The check is a program, and what CI gets from it is an exit code and a list of findings, so it
 * is executed rather than imported. It reads the file set from `git ls-files` in the repository it
 * is run from, so each fixture is a throwaway git repo: files written, the tracked ones staged
 * (the index is all `git ls-files` reads, no commit needed), the allowlist dropped at
 * scripts/brand-allowlist.json. The script itself runs from where it ships, so the file under
 * test is the file CI runs, byte for byte. The fixture allowlist is never staged, so the terms
 * it spells out are not hits of their own. */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const script = join(repoRoot, 'scripts', 'check-brand.mjs')

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

const put = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

// tracked: staged files; allow: the allowlist entries; untracked: files on disk git doesn't know.
const run = ({ tracked = {}, allow = [], untracked = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'check-brand-'))
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'core.autocrlf', 'false')
    put(dir, tracked)
    if (Object.keys(tracked).length) git(dir, 'add', '--', ...Object.keys(tracked))
    put(dir, untracked)
    put(dir, { 'scripts/brand-allowlist.json': JSON.stringify(allow, null, 2) })
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const reason = 'a reason'

describe('check-brand.mjs', () => {
  it('passes a tree without a brand term', () => {
    const r = run({ tracked: { 'README.md': '# Kuch\n\nA gym tracker.\n', 'src/a.js': 'export const x = 1\n' } })
    expect(r.out).toContain('no unexpected')
    expect(r.code).toBe(0)
  })

  it('fails a new hit, naming the path, the line and the term', () => {
    const r = run({ tracked: { 'docs/guide.md': '# Guide\n\nKuch is great.\nWelcome to openGym.\n' } })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/docs\/guide\.md:4\s+opengym\s+"Welcome to openGym\."/)
  })

  it('reports every term, whatever its case', () => {
    const r = run({ tracked: { 'a.txt': ['OPENGYM', 'Open Gym', 'duarteSANTOS', 'duartesantos8', 'Duarte-Santos.CH', 'CH.DuarteSantos'].join('\n') + '\n' } })
    expect(r.code).toBe(1)
    for (const [line, term] of [[1, 'opengym'], [2, 'open gym'], [3, 'duartesantos'], [4, 'DuarteSantos8'], [5, 'duarte-santos.ch'], [6, 'ch.duartesantos']])
      expect(r.out).toMatch(new RegExp(`a\\.txt:${line}\\s+${term.replace(/\./g, '\\.')}\\s`))
  })

  it('lets a path-only entry cover every hit in the files its glob matches', () => {
    const r = run({
      tracked: { 'CHANGELOG.md': 'openGym 1.0\n\nby DuarteSantos8\n', 'docs/old/history.md': 'open gym, once\n' },
      allow: [{ path: 'CHANGELOG.md', reason }, { path: 'docs/**/*.md', reason }]
    })
    expect(r.out).toContain('no unexpected')
    expect(r.code).toBe(0)
  })

  it('lets a path-plus-regex entry cover the hits its regex matches', () => {
    const r = run({
      tracked: { 'src/mobile.js': "const FILE = 'opengym-state.json'\nconst OTHER = 'opengym-state.json'\n" },
      allow: [{ path: 'src/**', match: "'opengym-state\\.json'", reason }]
    })
    expect(r.code).toBe(0)
  })

  it('does not let a regex entry cover a different hit in the same file', () => {
    const r = run({
      tracked: { 'src/mobile.js': "const FILE = 'opengym-state.json'\nconst TITLE = 'openGym'\n" },
      allow: [{ path: 'src/**', match: "'opengym-state\\.json'", reason }]
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/src\/mobile\.js:2\s+opengym/)
    expect(r.out).not.toContain('src/mobile.js:1')
  })

  // A kept key on the line must not hide a user-visible leak beside it.
  it('covers only the text a regex matches, not the rest of its line', () => {
    const r = run({
      tracked: { 'src/mobile.js': "save('opengym-state.json') // openGym keeps it\n" },
      allow: [{ path: 'src/**', match: "'opengym-state\\.json'", reason }]
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/src\/mobile\.js:1\s+opengym\s+".*openGym keeps it/)
  })

  it('fails an entry that matched nothing in the whole run', () => {
    const r = run({
      tracked: { 'NOTICE.md': 'openGym, by its author\n', 'src/a.js': "const A = 'opengym-a'\n" },
      allow: [
        { path: 'NOTICE.md', reason },
        { path: 'gone/**', reason: 'a file that was deleted' },
        { path: 'src/**', match: 'opengym-b', reason: 'a key that was renamed' }
      ]
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/stale.*gone\/\*\*/)
    expect(r.out).toMatch(/stale.*opengym-b/)
    expect(r.out).toMatch(/src\/a\.js:1\s+opengym/)
  })

  it('ignores a file git does not track', () => {
    const r = run({ tracked: { 'README.md': '# Kuch\n' }, untracked: { 'notes.md': 'openGym todo\n', 'data/state-u1.json': '{"x":"opengym"}' } })
    expect(r.out).toContain('no unexpected')
    expect(r.code).toBe(0)
  })

  it('gives the same result for CRLF and LF', () => {
    const text = ["const A = 'opengym-a'", 'say("openGym")', ''].join('\n')
    const allow = [{ path: 'src/**', match: "^const A = 'opengym-a'$", reason }]
    const lf = run({ tracked: { 'src/a.js': text }, allow })
    const crlf = run({ tracked: { 'src/a.js': text.replace(/\n/g, '\r\n') }, allow })
    expect(lf.code).toBe(1)
    expect(lf.out).toMatch(/src\/a\.js:2\s+opengym\s+"say\("openGym"\)"/)
    expect(lf.out).not.toContain('src/a.js:1')
    expect(crlf).toEqual(lf)
  })

  // Agents never open the exercise media. The check skips them by path, whatever the extension,
  // and skips binary files by extension. The notice beside the media is text and is scanned.
  it('skips the exercise media and binary files, and still scans the media notice', () => {
    const r = run({
      tracked: {
        'catalogue/media/still/0001.webp': 'openGym',
        'catalogue/media/clip/0001.mp4': 'openGym',
        'catalogue/media/still/odd.txt': 'openGym',
        'assets/logo.png': 'openGym',
        'catalogue/media/NOTICE.md': '# Media\n\nLicensed to openGym.\n'
      }
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/catalogue\/media\/NOTICE\.md:3\s+opengym/)
    expect(r.out).not.toMatch(/still|clip|logo\.png/)
  })

  it('refuses an entry without a reason', () => {
    const r = run({ tracked: { 'NOTICE.md': 'openGym\n' }, allow: [{ path: 'NOTICE.md' }] })
    expect(r.code).toBe(2)
    expect(r.out).toContain('reason')
  })

  // The repository's own files and allowlist, so the suite carries the same check CI does.
  it('passes this repository', () => {
    const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' })
    expect(r.stdout + r.stderr).toContain('no unexpected')
    expect(r.status).toBe(0)
  }, 60_000)
})
