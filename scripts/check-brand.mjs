#!/usr/bin/env node
// The brand check: every upstream brand term in the repository is either allowlisted with a
// reason, or a leak. Kuch is a fork of openGym, and each upstream release brings new strings,
// docs and identifiers that say openGym. Phase 1 renamed the user-visible ones and kept a short,
// deliberate list (attribution, history, internal keys that must never change). This tells that
// list apart from a new leak, on every PR.
//
//   node scripts/check-brand.mjs      (from anywhere in the repository)
//
// Exit 0: every hit is covered by scripts/brand-allowlist.json. Exit 1 otherwise: an uncovered
// hit, an allowlist entry that covered nothing (a dead entry would quietly allow the next leak),
// or a check that could not run (no git, an invalid allowlist).
//
// What is searched: the files git tracks (`git ls-files`), so build output, node_modules and local
// data never count. The exercise media (catalogue/media/still, catalogue/media/clip) and binary
// files are skipped by path and never opened. Line endings are normalised to LF first, so a CRLF
// checkout reads the same as Linux CI.
//
// The allowlist is a JSON array of { path, match?, reason }:
//   path    a glob over repo-relative paths (`*`, `**`, `?`, `{a,b}`)
//   match   optional JavaScript regex, case-sensitive. Without it the entry covers every hit in
//           the files its glob matches; with it, only a hit that lies inside one of the regex's
//           matches on that hit's line. So a kept key never covers a leak beside it.
//   reason  required: why these hits stay.
//
// One pass per file: the terms are one regex, and an entry's regex runs only on the lines that
// already have a hit.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TERMS = ['opengym', 'open gym', 'duartesantos', 'DuarteSantos8', 'duarte-santos.ch', 'ch.duartesantos']
// Longest first, so DuarteSantos8 is reported as itself rather than as duartesantos.
const termRe = new RegExp([...TERMS].sort((a, b) => b.length - a.length).map(t => t.replace(/[.]/g, '\\.')).join('|'), 'gi')
const termOf = new Map(TERMS.map(t => [t.toLowerCase(), t]))

const SKIP_DIRS = ['catalogue/media/still/', 'catalogue/media/clip/']
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|avif|mp4|mov|webm|mkv|mp3|wav|ogg|m4a|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|jar|aar|apk|aab|keystore|jks|p12|so|dylib|dll|exe|class|wasm|db|sqlite)$/i

const fail = msg => { console.error(msg); process.exit(1) }

const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 << 20 }) } catch (e) { fail(`git ${args.join(' ')} failed: ${e.message}`) }
}
const root = git('rev-parse', '--show-toplevel').trim()
const allowPath = 'scripts/brand-allowlist.json'

// `*` stays inside one path segment, `**/` spans any number of them (including none).
const globRe = glob => {
  let re = '', depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') { re += '(?:'; depth++ }
    else if (c === '}' && depth) { re += ')'; depth-- }
    else if (c === ',' && depth) re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

let entries
try { entries = JSON.parse(readFileSync(join(root, allowPath), 'utf8')) } catch (e) { fail(`${allowPath}: ${e.message}`) }
if (!Array.isArray(entries)) fail(`${allowPath}: expected a JSON array of { path, match?, reason }`)
const problems = []
const allow = entries.map((e, i) => {
  const at = `${allowPath} #${i + 1}`
  if (!e || typeof e !== 'object') return problems.push(`${at}: not an object`)
  const extra = Object.keys(e).filter(k => !['path', 'match', 'reason'].includes(k))
  if (extra.length) problems.push(`${at}: unknown field ${extra.join(', ')}`)
  if (typeof e.path !== 'string' || !e.path) problems.push(`${at}: needs a "path" glob`)
  if (typeof e.reason !== 'string' || !e.reason.trim()) problems.push(`${at}: needs a "reason" (why these hits stay)`)
  let match = null
  if (e.match !== undefined) {
    try { match = new RegExp(e.match, 'g') } catch (err) { problems.push(`${at}: "match" is not a regex: ${err.message}`) }
  }
  return { at, entry: e, path: typeof e.path === 'string' ? globRe(e.path) : /$^/, match, used: 0 }
})
if (problems.length) fail(problems.join('\n'))

// Where each match of a regex entry starts and ends on one line.
const spans = (re, line) => {
  const out = []
  re.lastIndex = 0
  for (let m; (m = re.exec(line));) {
    out.push([m.index, m.index + m[0].length])
    if (!m[0].length) re.lastIndex++
  }
  return out
}

const excerpt = (line, start, end) => {
  const text = line.trim()
  if (text.length <= 120) return text
  const lead = line.length - line.trimStart().length
  const from = Math.max(0, start - lead - 50), to = Math.min(text.length, end - lead + 50)
  return (from ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '')
}

const findings = []
let hits = 0, hitFiles = 0
for (const file of git('ls-files', '-z').split('\0')) {
  if (!file || BINARY.test(file) || SKIP_DIRS.some(d => file.startsWith(d))) continue
  let text
  try { text = readFileSync(join(root, file), 'utf8') } catch { continue }   // deleted, or a submodule
  termRe.lastIndex = 0
  if (!termRe.test(text)) continue
  text = text.replace(/\r\n/g, '\n')
  hitFiles++
  const candidates = allow.filter(a => a.path.test(file))
  let lineNo = 1, lineStart = 0, scanned = 0, lineCache = null
  termRe.lastIndex = 0
  for (let m; (m = termRe.exec(text));) {
    hits++
    // Advance the line counter to this hit, never re-reading text already counted.
    for (let nl; (nl = text.indexOf('\n', scanned)) !== -1 && nl < m.index;) { lineNo++; lineStart = scanned = nl + 1 }
    if (!lineCache || lineCache.start !== lineStart) {
      const end = text.indexOf('\n', lineStart)
      lineCache = { start: lineStart, line: text.slice(lineStart, end === -1 ? undefined : end), spans: new Map() }
    }
    const { line } = lineCache
    const hitStart = m.index - lineStart, hitEnd = hitStart + m[0].length
    let covered = false
    for (const a of candidates) {
      if (a.match) {
        if (!lineCache.spans.has(a)) lineCache.spans.set(a, spans(a.match, line))
        if (!lineCache.spans.get(a).some(([from, to]) => from <= hitStart && hitEnd <= to)) continue
      }
      a.used++
      covered = true
    }
    if (!covered) findings.push(`${file}:${lineNo}  ${termOf.get(m[0].toLowerCase())}  "${excerpt(line, hitStart, hitEnd)}"`)
  }
}

const stale = allow.filter(a => !a.used)
for (const f of findings) console.log(f)
for (const a of stale) console.log(`${a.at}  stale  ${JSON.stringify({ path: a.entry.path, match: a.entry.match })} covered nothing`)

if (findings.length || stale.length) {
  console.error(
    `\n${findings.length} unexpected brand hit(s), ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'}.` +
    `\nRename a hit to Kuch, or add it to ${allowPath} with the reason it stays. Delete a stale entry.`)
  process.exit(1)
}
console.log(`${hits} brand hits in ${hitFiles} files, all allowlisted by ${allow.length} entries: no unexpected hits.`)
