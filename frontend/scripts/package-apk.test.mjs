/* package-apk.mjs: the last step of a release build. It must ship only a Gradle-signed APK, under
 * the version package.json carries, with a checksum `sha256sum -c` accepts. */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageApk } from './package-apk.mjs'

const RELEASE = 'android/app/build/outputs/apk/release'

const tree = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'package-apk-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}
const withTree = (files, fn) => {
  const dir = tree({ 'package.json': JSON.stringify({ version: '1.5.0' }), ...files })
  try { return fn(dir, join(dir, 'out')) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('packageApk', () => {
  it('copies the signed APK as kuch-<version>.apk with a sha256sum-style checksum beside it', () => {
    withTree({ [`${RELEASE}/app-release.apk`]: 'signed apk bytes' }, (dir, out) => {
      const { apk, sha256 } = packageApk(dir, out)
      expect(apk).toBe(join(out, 'kuch-1.5.0.apk'))
      expect(readFileSync(apk, 'utf8')).toBe('signed apk bytes')
      const hash = createHash('sha256').update('signed apk bytes').digest('hex')
      expect(sha256).toBe(hash)
      expect(readFileSync(apk + '.sha256', 'utf8')).toBe(`${hash}  kuch-1.5.0.apk\n`)
    })
  })

  it('refuses an unsigned build instead of shipping it', () => {
    withTree({ [`${RELEASE}/app-release-unsigned.apk`]: 'x' }, (dir, out) => {
      expect(() => packageApk(dir, out)).toThrow(/unsigned.*RELEASE_STORE_FILE/s)
    })
  })

  it('says to build first when there is no release APK at all', () => {
    withTree({}, (dir, out) => {
      expect(() => packageApk(dir, out)).toThrow(/assembleRelease/)
    })
  })
})
