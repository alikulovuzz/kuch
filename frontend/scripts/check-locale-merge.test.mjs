/* check-locale-merge.mjs, run the way the sync runbook and CI run it.
 *
 * Same shape as check-locales.test.mjs: the script is a program judged by its exit code and its
 * report, so it is executed, from a copy of the real file dropped into a throwaway tree laid out
 * the way it expects (scripts/ beside src/locales/). The tree is a git repo here, because the
 * script reads the packs out of history: every case is a real merge, built from a base commit, a
 * fork branch, an upstream branch and a merge commit whose packs are whatever the case says the
 * conflict resolution produced. */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'check-locale-merge.mjs')

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// One commit's packs: { fr: dict | 'raw source' }. A pack left out of the object is absent at that
// commit. A string is written as-is, so a case can control the exact bytes (CRLF, template literals).
const writePacks = (dir, packs) => {
  const locales = join(dir, 'src', 'locales')
  rmSync(locales, { recursive: true, force: true })
  mkdirSync(locales, { recursive: true })
  for (const [lang, pack] of Object.entries(packs))
    writeFileSync(join(locales, `${lang}.js`), typeof pack === 'string' ? pack : `export default ${JSON.stringify(pack, null, 2)}\n`)
}

const commit = (dir, packs, msg) => {
  writePacks(dir, packs)
  git(dir, 'add', '-A', 'src/locales')
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg)
}

// base → fork (main) and base → upstream, then a merge of upstream into the fork whose packs are
// `merged`: `-s ours` keeps git from resolving anything, so the case alone decides the result.
const run = ({ base, fork, upstream, merged, after }, args = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'check-locale-merge-'))
  try {
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'core.autocrlf', 'false')
    mkdirSync(join(dir, 'scripts'))
    copyFileSync(script, join(dir, 'scripts', 'check-locale-merge.mjs'))
    commit(dir, base, 'base')
    git(dir, 'checkout', '-q', '-b', 'upstream')
    commit(dir, upstream, 'upstream')
    git(dir, 'checkout', '-q', 'main')
    commit(dir, fork, 'fork')
    if (merged) {
      git(dir, 'merge', '-q', '-s', 'ours', '--no-commit', 'upstream')
      commit(dir, merged, 'merge upstream')
    }
    if (after) commit(dir, after, 'after the merge')
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-locale-merge.mjs'), ...args], { encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const base = { fr: { Save: 'Sauvegarder', Delete: 'Supprimer' } }

describe('check-locale-merge.mjs', { timeout: 30_000 }, () => {
  it('fails a fork retranslation the merge reverted to upstream, naming language, key and both values', () => {
    const r = run({
      base,
      fork: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } },
      upstream: { fr: { Save: 'Sauvegarder', Delete: 'Supprimer', New: 'Nouveau' } },
      merged: { fr: { Save: 'Sauvegarder', Delete: 'Supprimer', New: 'Nouveau' } },
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('fr')
    expect(r.out).toContain('"Save"')
    expect(r.out).toContain('"Enregistrer"')
    expect(r.out).toContain('"Sauvegarder"')
    expect(r.out).not.toContain('"New"')
  })

  it('passes a fork retranslation the merge kept', () => {
    const r = run({
      base,
      fork: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } },
      upstream: { fr: { Save: 'Sauvegarder', Delete: 'Supprimer', New: 'Nouveau' } },
      merged: { fr: { Save: 'Enregistrer', Delete: 'Supprimer', New: 'Nouveau' } },
    })
    expect(r.out).not.toContain('"Save"')
    expect(r.code).toBe(0)
  })

  it('fails a key the fork deleted that the merge brought back', () => {
    const r = run({
      base,
      fork: { fr: { Save: 'Sauvegarder' } },
      upstream: { fr: { Save: 'Sauvegarder', Delete: 'Effacer' } },
      merged: { fr: { Save: 'Sauvegarder', Delete: 'Effacer' } },
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('"Delete"')
  })

  it('is silent about an upstream-only change and a new upstream key', () => {
    const r = run({
      base,
      fork: base,
      upstream: { fr: { Save: 'Enregistrer', Delete: 'Supprimer', New: 'Nouveau' } },
      merged: { fr: { Save: 'Enregistrer', Delete: 'Supprimer', New: 'Nouveau' } },
    })
    expect(r.out).not.toMatch(/"(Save|New)"/)
    expect(r.code).toBe(0)
  })

  it('is silent when both sides made the same change', () => {
    const same = { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } }
    const r = run({ base, fork: same, upstream: same, merged: same })
    expect(r.out).not.toContain('"Save"')
    expect(r.code).toBe(0)
  })

  it('lists a hand-resolved value as information only', () => {
    const r = run({
      base,
      fork: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } },
      upstream: { fr: { Save: 'Sauver', Delete: 'Supprimer' } },
      merged: { fr: { Save: 'Enregistrer les modifications', Delete: 'Supprimer' } },
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('"Save"')
    expect(r.out).toContain('"Enregistrer les modifications"')
  })

  it('refuses a commit that is not a two-parent merge', () => {
    const r = run({ base, fork: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } }, upstream: base })
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/merge/i)
  })

  it('refuses a commit that does not exist', () => {
    const r = run({ base, fork: base, upstream: base, merged: base }, ['no-such-commit'])
    expect(r.code).toBe(2)
  })

  it('checks the merge commit it is given, not only HEAD', () => {
    const r = run({
      base,
      fork: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } },
      upstream: { fr: { Save: 'Sauver', Delete: 'Supprimer' } },
      merged: { fr: { Save: 'Sauver', Delete: 'Supprimer' } },
      after: { fr: { Save: 'Sauver', Delete: 'Effacer' } },
    }, ['HEAD^'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('"Save"')
  })

  it('handles a pack only upstream added', () => {
    const r = run({
      base,
      fork: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' } },
      upstream: { ...base, pl: { Save: 'Zapisz', Delete: 'Usuń' } },
      merged: { fr: { Save: 'Enregistrer', Delete: 'Supprimer' }, pl: { Save: 'Zapisz', Delete: 'Usuń' } },
    })
    expect(r.out).not.toContain('Zapisz')
    expect(r.code).toBe(0)
  })

  it('resolves a pack that imports another pack from the same commit', () => {
    // pt-BR.js spreads pt.js, so a revert in pt reaches pt-BR's strings too.
    const ptBr = "import pt from './pt.js'\nexport default { ...pt, Delete: 'Apagar' }\n"
    const r = run({
      base: { pt: { Save: 'Guardar' }, 'pt-BR': ptBr },
      fork: { pt: { Save: 'Salvar' }, 'pt-BR': ptBr },
      upstream: { pt: { Save: 'Guardar' }, 'pt-BR': ptBr },
      merged: { pt: { Save: 'Guardar' }, 'pt-BR': ptBr },
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain('"Salvar"')
  })

  it('reports no false revert when one side committed the pack with CRLF line endings', () => {
    // The whole file differs byte for byte, the multi-line template literal included; the strings
    // it defines do not, so nothing may be reported.
    const pack = eol => ["export default {", "  'Save': 'Enregistrer',", "  'Tip': `Ligne une", "ligne deux`,", "}", ""].join(eol)
    const r = run({
      base: { fr: pack('\n') },
      fork: { fr: pack('\r\n') },
      upstream: { fr: pack('\n') },
      merged: { fr: pack('\n') },
    })
    expect(r.out).not.toContain('"Tip"')
    expect(r.code).toBe(0)
  })
})
