#!/usr/bin/env node
// Catches translations an upstream sync merge silently reverted. check-locales cannot: after a
// conflict resolution that took upstream's side, every key is still there, translated, with its
// placeholders. That is how the v1.4.1 merge put 56 fr/pl/ru strings back to upstream's wording.
//
//   node scripts/check-locale-merge.mjs [<merge-commit>]     (default HEAD)
//
// The commit's first parent is the fork side (ours), its second the upstream side (theirs), and
// their merge base is where both started. Every locale pack is read at all four commits from git
// history, never from the working tree, and compared per key, with B/O/T/M its value at base,
// ours, theirs and the merge (a key that is not there is a value too):
//
//   fork change lost       O ≠ B, M = T and M ≠ O     fails
//   fork deletion undone   B present, O absent, M present     fails
//   hand-resolved          M is neither O nor T, and O ≠ T     information only
//
// Everything else is silent: upstream-only changes, new upstream keys (a missing translation is
// check-locales' job) and the same change made on both sides.
//
// Exit 0 when nothing failed, 1 when something did, 2 on a usage error: a bad argument, a commit
// that does not exist or does not have exactly two parents.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const USAGE = 'usage: node scripts/check-locale-merge.mjs [<merge-commit>]   (default HEAD)'

const usage = msg => {
  console.error(`${msg}\n${USAGE}`)
  process.exit(2)
}

const git = (args, input) => spawnSync('git', args, { cwd: here, input, maxBuffer: 1 << 30 })
const gitText = args => {
  const r = git(args)
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null
}

const args = process.argv.slice(2)
if (args.length > 1 || args[0]?.startsWith('-')) usage(args[0] === '-h' || args[0] === '--help' ? 'Checks one sync merge commit for reverted translations.' : `unexpected arguments: ${args.join(' ')}`)
const rev = args[0] ?? 'HEAD'

// The packs sit at ../src/locales from this script. As a path from the top of the repo, so that
// a checkout under a different (or Windows 8.3-shortened) absolute path still resolves.
const prefix = gitText(['rev-parse', '--show-prefix'])
if (prefix === null) usage(`not inside a git repository: ${here}`)
const localesPath = posix.normalize(`${prefix}../src/locales`)

const merge = gitText(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
if (!merge) usage(`not a commit: ${rev}`)
const parents = gitText(['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1)
if (parents.length !== 2)
  usage(`${rev} has ${parents.length} parent${parents.length === 1 ? '' : 's'}; this check needs a merge commit with exactly two (fork first, upstream second).`)
const [ours, theirs] = parents
const base = gitText(['merge-base', ours, theirs])
if (!base) usage(`${ours.slice(0, 9)} and ${theirs.slice(0, 9)} have no merge base.`)

const commits = { base, ours, theirs, merged: merge }

// The pack files at each commit: { role: Map(file → blob) }. A pack missing at a commit is simply
// not listed, and counts as an empty pack below.
const listing = {}
for (const [role, sha] of Object.entries(commits)) {
  const out = gitText(['ls-tree', '--full-tree', sha, `${localesPath}/`]) ?? ''
  listing[role] = new Map(out.split('\n').filter(Boolean).flatMap(line => {
    const [meta, path] = line.split('\t')
    const [, type, blob] = meta.split(' ')
    return type === 'blob' && path.endsWith('.js') ? [[posix.basename(path), blob]] : []
  }))
}

// Every blob in one `git cat-file --batch` instead of one `git show` per pack and commit: the same
// bytes, and four commits times a dozen-odd packs is a lot of process starts on Windows.
const blobs = new Map()
const wanted = [...new Set(Object.values(listing).flatMap(m => [...m.values()]))]
if (wanted.length) {
  const r = git(['cat-file', '--batch'], wanted.join('\n') + '\n')
  if (r.status !== 0) { console.error(`git cat-file failed: ${r.stderr}`); process.exit(1) }
  let at = 0
  for (const sha of wanted) {
    const eol = r.stdout.indexOf(0x0a, at)
    const size = Number(r.stdout.toString('utf8', at, eol).split(' ')[2])
    blobs.set(sha, r.stdout.toString('utf8', eol + 1, eol + 1 + size))
    at = eol + 1 + size + 1
  }
}

// Each commit's packs are written out as a folder of their own and imported from there, the
// same ES-module default export check-locales loads. A folder rather than a string, because a
// pack may import a sibling (pt-BR.js spreads pt.js), and the sibling must come from the same
// commit. Line endings are normalised first, so a pack committed from a CRLF checkout on Windows
// never reads as a change. Comparing evaluated values already covers most of that (JS itself folds
// CRLF to LF inside a template literal); the normalisation keeps it true for whatever a pack holds.
const scratch = mkdtempSync(join(tmpdir(), 'check-locale-merge-'))
const packs = {}
const broken = []
try {
  writeFileSync(join(scratch, 'package.json'), '{ "type": "module" }\n')
  for (const [role, files] of Object.entries(listing)) {
    mkdirSync(join(scratch, role))
    for (const [file, blob] of files) writeFileSync(join(scratch, role, file), blobs.get(blob).replace(/\r\n/g, '\n'))
  }
  for (const [role, files] of Object.entries(listing)) {
    packs[role] = new Map()
    for (const file of files.keys()) {
      try {
        const { default: dict } = await import(pathToFileURL(join(scratch, role, file)).href)
        if (!dict || typeof dict !== 'object') throw new Error('no default-exported object')
        packs[role].set(file, dict)
      } catch (e) {
        broken.push(`${file} at ${role} (${commits[role].slice(0, 9)}): ${e.message}`)
      }
    }
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }

if (broken.length) {
  for (const b of broken) console.error(`cannot read ${b}`)
  process.exit(1)
}

// Absent is a value of its own, distinct from every string. Plural entries are objects, compared
// by content.
const enc = v => (v === undefined ? undefined : JSON.stringify(v))
const show = v => (v === undefined ? '(absent)' : JSON.stringify(v))

const files = [...new Set(Object.values(listing).flatMap(m => [...m.keys()]))].sort()
let lost = 0
let info = 0
const report = []
for (const file of files) {
  const [B, O, T, M] = ['base', 'ours', 'theirs', 'merged'].map(role => packs[role].get(file) ?? {})
  const keys = [...new Set([B, O, T, M].flatMap(d => Object.keys(d)))]
  const lines = []
  for (const k of keys) {
    const [b, o, t, m] = [B, O, T, M].map(d => (Object.hasOwn(d, k) ? d[k] : undefined))
    const [eb, eo, et, em] = [b, o, t, m].map(enc)
    let kind = null
    if (b !== undefined && o === undefined && m !== undefined) kind = 'fork deletion undone'
    else if (eo !== eb && em === et && em !== eo) kind = 'fork change lost'
    else if (em !== eo && em !== et && eo !== et) kind = 'hand-resolved (info)'
    if (!kind) continue
    if (kind.endsWith('(info)')) info++
    else lost++
    lines.push(`  ${kind}: ${JSON.stringify(k)}`, `      fork:     ${show(o)}`)
    if (kind.endsWith('(info)')) lines.push(`      upstream: ${show(t)}`)
    lines.push(`      merged:   ${show(m)}`)
  }
  if (lines.length) report.push(`\n${file.replace(/\.js$/, '')}`, ...lines)
}

const short = sha => sha.slice(0, 9)
console.log(`merge ${short(merge)}: fork ${short(ours)}, upstream ${short(theirs)}, base ${short(base)}; ${files.length} locale packs`)
if (report.length) console.log(report.join('\n'))

if (lost) {
  console.error(`\n${lost} fork translation${lost === 1 ? '' : 's'} lost in the merge${info ? `, ${info} hand-resolved` : ''}.`)
  console.error('Restore the fork value in the pack, or, if upstream\'s is now the better one, say so in the sync PR.')
  process.exit(1)
}

console.log(`\nNo fork translation lost${info ? `; ${info} hand-resolved value${info === 1 ? '' : 's'} listed above for review` : ''}.`)
