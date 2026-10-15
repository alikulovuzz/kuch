# Syncing an upstream release into Kuch

Kuch is a fork of openGym. Upstream's fixes and features reach Kuch by merging upstream's
**release tags** into a `sync/vX.Y.Z` branch, which then lands on `main` through a reviewed pull
request. A merge can quietly undo fork work: a new storage call that bypasses the store, a
returning openGym string, a reverted translation, a deleted upstream file coming back. This page
walks through a sync from start to PR. Three checks catch most of that on their own, and the
rest is the short list of greps in [step 7](#7-the-greps-the-checks-cannot-replace).

Everything here happens on `github.com/alikulovuzz/kuch`. Upstream (`DuarteSantos8/openGym`) is
only ever **read**: never push to it, and never open an issue or pull request there.

The commands are bash. On the Windows dev PC run them in Git Bash, from the repository root
unless a step says otherwise.

## 1. Add upstream as a fetch-only remote

Once per clone:

```bash
git remote add --no-tags upstream https://github.com/DuarteSantos8/openGym.git
git remote set-url --push upstream no-push
git config --replace-all remote.upstream.fetch '+refs/tags/v*:refs/upstream-tags/v*'
```

- `set-url --push ... no-push`: the remote has no push URL, so any `git push upstream` fails
  with `'no-push' does not appear to be a git repository`.
- The fetch refspec fetches upstream's release tags and nothing else. Upstream's branches are not
  fetched at all, so upstream `main` cannot be merged by mistake.
- The tags land in `refs/upstream-tags/`, not `refs/tags/`. Kuch tags its own releases `vX.Y.Z`
  too, so upstream's would collide with them, and `git push --tags` would copy upstream's tags into
  the fork.

Check it:

```bash
git remote -v | grep upstream
# upstream  https://github.com/DuarteSantos8/openGym.git (fetch)
# upstream  no-push (push)
```

## 2. Branch `sync/vX.Y.Z` and merge the release tag

Fetch upstream's tags and pick the release to merge (newest first):

```bash
git fetch upstream
git for-each-ref --sort=-v:refname --format='%(refname:lstrip=2)' refs/upstream-tags | head -5
```

The version must be greater than the last one synced. If the tag is already in `main`'s history,
`git merge-base --is-ancestor upstream-tags/vX.Y.Z origin/main && echo "already in main"` says
so. Merge upstream's releases one at a time, oldest first. Each one gets its own branch and PR.

```bash
V=v1.4.2                                   # the upstream tag
git fetch origin
git switch -c sync/$V origin/main
git merge --no-ff --no-commit -m "Merge upstream $V into sync/$V" upstream-tags/$V
```

Always merge the **tag** `upstream-tags/$V`, never an upstream branch, so Kuch only takes code
upstream has released. The branch name has to start with `sync/`: CI runs the locale merge check
only on `sync/*` branches. `main` is not touched until the PR merges.

`--no-commit` stops the merge before it commits, even when there is no conflict, so steps 3 and 4
land in the merge commit itself. Go through step 3 either way: the dangerous changes are the ones
that merge without a conflict.

## 3. Resolve the conflicts

`git status --short` lists the conflicted files (`UU`, `AA`, and `DU`/`UD` for modify/delete).
Three rules decide almost every conflict.

### Keep the fork's deletions

The fork deleted upstream's mirror, Pages, funding and GitLab/Gitea CI. An upstream change to one
of those files is a modify/delete conflict, and a new upstream file under one of those paths
merges in without any conflict at all. One command removes both (`-f` because the merge has already
staged the new files):

```bash
git rm -r -q -f --ignore-unmatch -- .gitea .gitlab .gitlab-ci.yml .github/FUNDING.yml \
  .github/workflows/mirror.yml .github/workflows/pages.yml renovate.json scripts/ci
git ls-files -- .gitea .gitlab .gitlab-ci.yml .github/FUNDING.yml \
  .github/workflows/mirror.yml .github/workflows/pages.yml renovate.json scripts/ci
# (no output)
```

The rest of the fork's CI is Kuch's own. In `.github/workflows/test.yml` and
`.github/workflows/docker-publish.yml` keep the fork's side: the brand check step, the `sync/*`
locale merge step, the PostgreSQL services and the `kuch-*` image names. Take upstream's changes
to the steps they share, such as a new test command.

### Keep the five never-change names

These internal names are stored on users' devices and servers. Renaming one orphans that data,
so they stay `opengym*` even where everything around them says Kuch:

| Name | What it is |
|---|---|
| `opengym-coach-v1` | the Coach config key (`api/coach/config.js`) |
| `opengym-link:` | the device-link token prefix (`api/device-link.js`) |
| `opengym-reset:` | the password-reset token prefix (`api/password.js`) |
| `opengym_plan` | the format marker of a plan bundle, as the Coach returns it (`api/coach/core/validate.js`) |
| `opengym-backup.json` | the data file inside a media backup zip (`frontend/src/lib/backup-media.js`) |

The other kept `opengym-*` names (on-device storage keys, file names, ids) are in
`scripts/brand-allowlist.json`, each with the reason it stays. Treat them the same way.

A conflict hunk where one side says `opengym-...` and the other `kuch-...` is usually a
**user-visible** name, and the fork's `kuch-...` side wins. A hunk that touches one of the five
names above keeps the name exactly as it is. Count them before you commit (`now` may be higher
than `main` when upstream added uses; it must never be lower without a reason):

```bash
for n in opengym-coach-v1 opengym-link: opengym-reset: opengym_plan opengym-backup.json; do
  printf '%-20s main %3s  now %3s\n' "$n" "$(git grep -F -o "$n" origin/main | wc -l)" "$(git grep -F -o "$n" | wc -l)"
done
```

### Keep every storage call going through the store

Kuch reads and writes accounts and training documents only through the async store (file or
PostgreSQL, [ADR 0001](adr/0001-postgres-write-through-db.md)). Upstream still reads and writes
`db.json` and `state-<uid>.json` directly and synchronously. In a conflict in `api/`, keep the
fork's side of every storage call and port upstream's logic onto it:

- a database write is `await saveDb()` (or `await store.saveDb(db)`), never a direct file write
- a training document is read with `await store.readState(uid)` (or `readStateStrict`,
  `readStateCached`) and written with `await store.casWriteState(...)`
- every store call is awaited or returned, so no route answers 200 before its write committed

The storage-boundary test in step 6 fails on what slips through, naming file, line and rule.

When every conflict is resolved, stage the files (`git add <file>`) but do not commit yet.

## 4. Rebuild the generated coach assets with LF line endings

`api/coach/core/prompts.js` and `api/coach/core/library-data.js` are generated from
`api/coach/prompts/*.md` and the exercise catalogue. `prompts.js` embeds the `.md` files as
JSON strings, so a Windows checkout (`core.autocrlf=true`) bakes a `\r` escape into every line
of it. Put the prompt sources back as LF first, then rebuild:

```bash
rm api/coach/prompts/*.md
git -c core.autocrlf=false checkout -- api/coach/prompts
node scripts/build-coach-assets.mjs
node scripts/build-coach-assets.mjs --check
! grep -qF '\r' api/coach/core/prompts.js && echo "prompts.js is LF"
git add api/coach/core
```

`--check` must print `in sync` for both files, and the last line must print `prompts.js is LF`.
On Linux the `rm` and `checkout` change nothing, and the steps are the same. (On a CRLF checkout,
`--check` reports both generated files as out of date even when they are not, because it compares
them byte for byte. The rebuild above leaves them LF.)

Then finish the merge:

```bash
git commit --no-edit
```

## 5. Run the brand check and the locale merge check

**Brand check.** From anywhere in the repository:

```bash
node scripts/check-brand.mjs
```

It searches every tracked file for the upstream brand terms and fails on any hit that
`scripts/brand-allowlist.json` does not cover, printing `path:line  term  "excerpt"`. It also
fails on an allowlist entry that no longer matches anything. For each hit:

- rename it to Kuch when a user can see it (UI text, locale strings, docs, website), or
- add an entry to `scripts/brand-allowlist.json` with the reason it stays: attribution, history,
  or an internal key such as a new `opengym-*` storage key. Make the entry as narrow as the
  existing ones: a path glob plus a `match` regex for the kept name, never `**` without a `match`.
- A stale entry means upstream removed what it allowed. Delete the entry.

**Locale merge check.** From `frontend/`, with the merge commit still at `HEAD`:

```bash
cd frontend
node scripts/check-locale-merge.mjs
cd ..
```

It compares every locale pack at the merge base, the fork side (`HEAD^1`), the upstream side
(`HEAD^2`) and the merge. It fails, grouped by language with the key, the fork's value and the
merged value, where the fork had changed or deleted upstream's text and the merge went back to
upstream's. Lines marked as hand-resolved are information only: glance over them.

Restore each failing key to the fork's value it shows, then fold the fix **into the merge
commit**, because CI runs this check on the merge commit itself:

```bash
git add frontend/src/locales
git commit --amend --no-edit
```

Once you have commits on top of the merge, `HEAD` is no longer the merge commit. Then run the check
the way CI does, over every merge commit on the branch:

```bash
cd frontend
for c in $(git rev-list --first-parent --merges --max-parents=2 origin/main..HEAD); do
  node scripts/check-locale-merge.mjs "$c"
done
cd ..
```

Other fixes (brand renames, a storage call ported onto the store) can be separate commits on the
branch. Name them `Sync $V: ...` so the review can tell them from the merge.

## 6. Run every suite

These are the same commands as the `test`, `api` and `mcp` jobs of `.github/workflows/test.yml`.
Its `api-image` and `compose` jobs (building and booting the Docker images) run on the PR in CI.
The PostgreSQL runs need a throwaway
database. This one matches CI's, on port 55432 so it does not clash with a Postgres you already run:

```bash
docker run -d --rm --name kuch-test-pg -p 55432:5432 \
  -e POSTGRES_USER=kuch -e POSTGRES_PASSWORD=kuch -e POSTGRES_DB=kuch_test postgres:17
until docker exec kuch-test-pg pg_isready -U kuch -d kuch_test >/dev/null 2>&1; do sleep 1; done
export DATABASE_URL_TEST=postgres://kuch:kuch@localhost:55432/kuch_test
```

**API, on the files and on PostgreSQL.** Both runs include the storage-boundary test
(`api/test/storage-boundary.test.js`):

```bash
cd api
npm ci --omit=optional
npm test
npm run test:pg
cd ..
```

Without `DATABASE_URL_TEST`, `npm run test:pg` prints that it skipped and exits 0. A sync is not
verified until it has really run, here or in CI.

**Frontend, the locale checks and the build:**

```bash
cd frontend
npm ci
npm test
npm run build
node scripts/check-locales.mjs
node scripts/check-source-strings.mjs
npm run test:fatigue-probe
cd ..
```

`check-source-strings` reports and does not fail yet. Compare its count with `main`'s, and
translate what the sync added.

**MCP server:**

```bash
cd mcp
npm ci
npm test
npm run check:node-loadable
cd ..
```

**Generated files and the Coach core:**

```bash
node scripts/build-coach-assets.mjs --check
npm ci
node scripts/build-api-docs.mjs --check
node api/scripts/check-core-loadable.mjs
```

If upstream changed `api/openapi.yaml`, `build-api-docs.mjs --check` fails until you regenerate
`website/api.html` with `node scripts/build-api-docs.mjs` and commit it.

On a Windows checkout both `--check` commands compare byte for byte and fail on any file git
checked out with CRLF. There, regenerate instead and let git compare, since git ignores the line
endings. No output means in sync (the coach assets only after step 4's LF rebuild):

```bash
node scripts/build-coach-assets.mjs
node scripts/build-api-docs.mjs
git diff --stat -- api/coach/core website/api.html
```

Stop the database afterwards with `docker stop kuch-test-pg`.

On Windows a few tests fail on `main` too (in the api suite, and `api-base`, `check-mobile-bundle`
and `package-apk` in the frontend suite). A sync must not add any: compare with a run on `main`
on the same machine. CI on Linux is the reference.

## 7. The greps the checks cannot replace

The checks are lexical and only see what they were built to see. These greps compare the merge
commit `M` with its parents (`$M^1` the fork, `$M^2` upstream) and their merge base `B`. Set both
first. This works with or without commits on top of the merge:

```bash
M=$(git rev-list --first-parent --merges -1 HEAD)
B=$(git merge-base $M^1 $M^2)
```

**Routes upstream added in this release.** Routes are declared in `api/server.js`,
`api/coach/routes.js` and any module upstream adds. For each one, read its handler and confirm
every account or training-document read and write goes through the store and is awaited:

```bash
git diff -U0 $B $M^2 -- api ':!api/test/' ':!api/openapi.yaml' | grep -E "^\+.*'(GET|POST|PUT|PATCH|DELETE) /api/"
```

**New file access in the API.** Upstream's new direct file reads and writes. Anything that touches
the accounts or a training document belongs in the store. `secret`, `vapid.json`, `coach.json`,
`coach/`, `audit.log` and `uploads/` stay files:

```bash
git diff -U0 $B $M^2 -- api | grep -E '^\+.*(readFileSync|writeFileSync|atomicWrite|renameSync|unlinkSync|fs\.promises|DATA_DIR)'
```

**Store aliases.** The storage-boundary test sees the store only by the name `store` and its
wrappers by name, so a store call through an alias would slip past the "awaited" rule. This lists
every alias in the API (the store's own directory and the tests excepted):

```bash
git grep -nE '=\s*store\b|\{[^}]*\}\s*=\s*store|store\[' -- 'api/*.js' 'api/*.mjs' ':!api/store/' ':!api/test/'
```

**Upstream retranslations the merge dropped.** The locale merge check stays silent when both sides
changed a string and the merge kept the fork's line, losing upstream's new translation (the v1.4.1
case). This prints every locale line upstream added or changed in this release that the merge
result does not contain:

```bash
for f in $(git diff --name-only $B $M^2 -- frontend/src/locales); do
  git diff -U0 $B $M^2 -- "$f" | grep '^+[^+]' | cut -c2- | grep -vxFf <(git show $M:"$f") | sed "s|^|$f: |"
done
```

Most lines it prints are expected: upstream's text with openGym in it, which the fork rebranded.
Look for the others. Where upstream rewrote a string the fork had only rebranded, take upstream's
new wording and keep Kuch in it.

**Deleted files that came back.** This must print nothing:

```bash
git diff --name-status --diff-filter=A $M^1 $M -- .gitea .gitlab .gitlab-ci.yml .github/FUNDING.yml \
  .github/workflows/mirror.yml .github/workflows/pages.yml renovate.json scripts/ci
```

## 8. Open the pull request

Push the branch to the fork and open the PR there. In a fork clone `gh` can default to upstream,
so name the repository every time:

```bash
git push -u origin sync/$V
gh pr create --repo alikulovuzz/kuch --base main --head sync/$V \
  --title "Sync upstream $V" --body-file sync-pr.md
```

The description states the upstream tag and pastes each check's result, so a reviewer can approve
without re-running everything. Write `sync-pr.md` outside the repository, or delete it before
committing anything else, and fill in this template:

````markdown
Merges upstream release **vX.Y.Z** (tag commit `<git rev-parse upstream-tags/vX.Y.Z^{}>`),
merge commit `<sha>`.

## Conflicts and fork fixes

- <file>: <how it was resolved>
- Fork deletions removed again: <paths, or "none came back">
- Never-change names: <the counts from step 3, or "unchanged">

## Checks

| Check | Result |
|---|---|
| `node scripts/check-brand.mjs` | <the summary line> |
| `node scripts/check-locale-merge.mjs` | <exit code, and any info lines> |
| `node scripts/build-coach-assets.mjs --check` | <both files in sync> |
| api `npm test` | <pass/fail counts> |
| api `npm run test:pg` | <pass/fail counts> |
| frontend `npm test` | <pass/fail counts> |
| frontend `npm run build` | <ok> |
| `node scripts/check-locales.mjs` | <result> |
| `node scripts/check-source-strings.mjs` | <count, against main's> |
| `npm run test:fatigue-probe` | <result> |
| mcp `npm test` + `check:node-loadable` | <result> |
| `node scripts/build-api-docs.mjs --check` | <result> |
| `node api/scripts/check-core-loadable.mjs` | <result> |

## Step 7 greps

- New routes: <each route, and how its storage goes through the store>
- New file access: <none / what and why it stays a file>
- Store aliases: <none>
- Upstream retranslations kept: <what was ported>
- Deleted files that came back: <none>
````

Paste real output, trimmed to the summary lines. A failure that is already on `main` gets a note
saying so. CI runs the same suites again on the PR, plus the locale merge check over every merge
commit on the branch.

After the PR merges, delete the branch. The next sync starts again at step 2.
