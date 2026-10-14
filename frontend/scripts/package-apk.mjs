#!/usr/bin/env node
/* Run after a signed `./gradlew assembleRelease`: put the release APK where a release is cut from.
 *
 * Copies android/app/build/outputs/apk/release/app-release.apk to dist-apk/kuch-<version>.apk (the
 * version from package.json, which build.gradle's versionName follows) and writes its checksum
 * beside it in `sha256sum` format, so `sha256sum -c kuch-<version>.apk.sha256` checks it.
 * Only the Gradle-signed APK is taken: `app-release-unsigned.apk` means the RELEASE_* signing
 * values were missing (docs/MOBILE.md), and that file can't be installed.
 *
 * Usage: node scripts/package-apk.mjs [out dir]   — default: dist-apk/ at the repo root. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE = 'android/app/build/outputs/apk/release'

export function packageApk(frontendDir, outDir) {
  const signed = join(frontendDir, RELEASE, 'app-release.apk')
  if (!existsSync(signed)) {
    if (existsSync(join(frontendDir, RELEASE, 'app-release-unsigned.apk')))
      throw new Error('the release build is unsigned: set RELEASE_STORE_FILE, RELEASE_STORE_PASSWORD, ' +
        'RELEASE_KEY_ALIAS and RELEASE_KEY_PASSWORD (docs/MOBILE.md) and run assembleRelease again')
    throw new Error(`no ${RELEASE}/app-release.apk: run \`./gradlew assembleRelease\` in android/ first`)
  }
  const { version } = JSON.parse(readFileSync(join(frontendDir, 'package.json'), 'utf8'))
  const name = `kuch-${version}.apk`
  const apk = join(outDir, name)
  mkdirSync(outDir, { recursive: true })
  copyFileSync(signed, apk)
  const sha256 = createHash('sha256').update(readFileSync(apk)).digest('hex')
  writeFileSync(apk + '.sha256', `${sha256}  ${name}\n`)
  return { apk, sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const frontend = join(dirname(fileURLToPath(import.meta.url)), '..')
  const out = resolve(process.argv[2] || join(frontend, '..', 'dist-apk'))
  try {
    const { apk, sha256 } = packageApk(frontend, out)
    console.log(`${apk}\nsha256 ${sha256}`)
  } catch (e) {
    console.error('✗ ' + e.message)
    process.exit(1)
  }
}
