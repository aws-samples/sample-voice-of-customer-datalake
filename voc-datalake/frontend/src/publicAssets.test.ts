/**
 * Published-asset inventory guard (PR #374).
 *
 * Vite copies `public/` verbatim into `dist/`, which `VocApiStack`'s
 * BucketDeployment syncs to the website bucket and CloudFront serves. Every entry
 * here is therefore reachable on the internet whether or not a single line of
 * application code references it — being unused does not make a file in `public/`
 * private, it only makes it unnoticed. That is how two dead assets came to be
 * served for a long time: a stale copy of the embeddable feedback widget (calling
 * routes retired by #277, so the CDN published a widget that could only fail) and
 * an `msw` service worker for a package that is not installed. No gate objected —
 * linting cannot answer "is this published thing reachable?", and one of the two
 * shipped its own file-wide eslint-disable header anyway.
 *
 * Adding a file to `public/` fails here, and the fix is to answer two questions in
 * the PR that adds it: is it referenced, and is it meant to be world-readable? If
 * both are yes, allowlist it below. If not, it belongs in `src/` where the bundler
 * can tree-shake it, or behind the API if it needs authorization.
 *
 * ## Why git, not the filesystem
 *
 * What a CLEAN CHECKOUT publishes is the reviewable question: CI and any release
 * build start from a clone, so what can reach `dist/` there is what is tracked.
 * Reading the filesystem would instead fail on files ignored on purpose —
 * `frontend/.gitignore` names `public/config.json` (runtimeConfig.ts fetches
 * `/config.json`, and deploy.sh generates it into `dist/` at deploy time, so a
 * developer wanting `npm run dev` to serve a real config drops it here) and
 * `.DS_Store` — and a guard that breaks `npm test` for a documented workflow gets
 * deleted rather than fixed.
 *
 * The residual gap, stated because it is real rather than theoretical: the
 * recommended deploy path `frontend/scripts/deploy.sh` runs `npm run build` (line 97)
 * and `aws s3 sync dist/ … --delete` (line 158) against the developer's LOCAL tree,
 * so an untracked `public/anything.js` DOES reach the CDN when a human deploys from a
 * dirty checkout. This guard cannot see that, and the trade is deliberate — it is the
 * same choice that keeps the gitignored `config.json` workflow working.
 *
 * The other cost is needing `git` and a real `.git`, which a source archive or
 * workshop zip lacks. Skipping silently is not an option (a guard that passes when it
 * cannot see the inventory guards nothing), so it fails naming the missing checkout,
 * once — see TRACKED_PUBLIC_PATHS.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import * as path from 'path'
import { at } from '@test/defined'

const FRONTEND_DIR = path.join(__dirname, '..')

/** Ordering only has to be stable so a failure message reads the same twice; an
 *  explicit comparator because the default sorts by UTF-16 code unit. */
const byName = (a: string, b: string) => a.localeCompare(b)

/** Whether `candidate` is an executable regular file. */
function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * The absolute path of `git`, found on PATH the way the shell would (first
 * executable match wins, `PATHEXT` suffixes on Windows).
 *
 * `git` still comes from PATH like every other git call in this repo (deploy.sh,
 * the hooks, CI) — a hard-coded absolute path would break on any machine whose git
 * is elsewhere. Resolving it here, once, means the child is spawned by absolute
 * path, so a later change to PATH (or a `git` dropped into the working directory)
 * cannot swap the binary between the lookup and the spawn.
 */
function resolveGit(): string {
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir))
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `git${suffix}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  throw new Error('public/ inventory requires git; no executable "git" was found on PATH')
}

function gitLsPublic(): string {
  const git = resolveGit()
  try {
    // The argv is a fixed literal, so nothing is interpolated from a filename.
    return execFileSync(git, ['ls-files', '-z', '--', 'public'], {
      cwd: FRONTEND_DIR,
      encoding: 'utf8',
      // Keep git's stderr out of the test output. `execFileSync` already appends the
      // child's stderr to the thrown error's `message`, which the catch interpolates.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // Unhandled, this is a bare `fatal: not a git repository` under a test named for
    // the inventory — pointing the reader at `public/` when the problem is the missing
    // `.git`, which `git archive` and `npm pack` both drop by construction.
    throw new Error(
      `public/ inventory requires a git checkout; "git ls-files" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/**
 * Every path tracked under `public/`, relative to `public/` — nested included, so
 * recursion comes for free.
 *
 * `git ls-files` always emits forward slashes, so paths split on `/` rather than
 * `path.sep`: the platform separator would stop collapsing `locales/en/common.json`
 * to `locales` on Windows and the inventory assertion would fail listing 121 files.
 *
 * `-z` is load-bearing, not stylistic. Without it `git ls-files` honours
 * `core.quotePath` (default true), so any path with a non-ASCII byte comes back
 * C-quoted with octal escapes — `public/déad.js` as `"public/d\303\251ad.js"` — and
 * everything downstream then breaks silently: the script regex is `$`-anchored and
 * cannot match a name ending in a literal quote, so a published script would pass
 * the check that exists to catch it, and the `^public/` strip is a no-op because the
 * line starts with `"`. `-z` returns raw NUL-separated bytes, which also survives a
 * path containing a newline (`split('\n')` would tear that one in half). `locales/`
 * spans eight languages, so non-ASCII names here are ordinary rather than exotic.
 */
function trackedPublicPaths(): string[] {
  const paths = gitLsPublic()
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^public\//, ''))

  // An empty result is not a clean bill of health, and it needs nothing to be wrong
  // with git: run from inside a DIFFERENT repository — a copied tree, a vendored
  // checkout, a parent repo that swallowed this one — and `git ls-files -- public`
  // exits 0 with no output because `public` is not in that index. Measured on that
  // fixture: three of the five assertions below then pass vacuously, and the two that
  // fail blame `public/` contents (`expected [] to deeply equal [ 'favicon.ico',
  // 'locales' ]`) for what is an environmental problem. Failing here gives one report
  // that names the cause, as the catch above does for a missing `.git`.
  if (paths.length === 0) {
    throw new Error(
      'public/ inventory came back empty: "git ls-files -- public" found nothing tracked. '
      + `Is ${FRONTEND_DIR} inside a different git repository than this one (a copied or `
      + 'vendored tree), or has public/ been deleted? Empty is a failure rather than a '
      + 'pass because the assertions below would otherwise either check nothing or '
      + 'report a missing favicon for an environmental cause.',
    )
  }

  return paths
}

/**
 * Resolved once at module scope, which matters only in the failure case: three `it`s
 * calling this reported the same environmental error under three test names. One
 * fact, one report — the one-defect-one-failure rule the assertions follow.
 */
const TRACKED_PUBLIC_PATHS = trackedPublicPaths()

/** First path segments that are directories rather than top-level files. */
const TRACKED_DIRECTORIES = [
  ...new Set(
    TRACKED_PUBLIC_PATHS.filter((p) => p.includes('/')).map((p) => at(p.split('/'), 0)),
  ),
]

/**
 * For each allowlisted DIRECTORY, the file extensions its contents may have.
 *
 * Two facts make this necessary, neither visible from the assertions. The inventory
 * check compares only first path segments, so once a directory is allowlisted every
 * file at any depth inside it is invisible to it — `locales/en/dump.csv` collapses
 * to `locales` and passes. And the sibling `localeParity.test.ts` cannot see such a
 * file either: it enumerates the `.json` namespaces it expects rather than auditing
 * what is present.
 *
 * Extensions match EXACTLY and lowercase, the opposite of the case-insensitive script
 * regex below, because the two have inverted jobs: a FORBIDDEN list must match
 * broadly or something slips past, an ALLOWED list narrowly or something slips in.
 * `locales/en/COMMON.JSON` is a distinct S3 key i18next never requests — dead weight.
 *
 * `Partial` is load-bearing. A total `Record<string, readonly string[]>` tells the
 * compiler every key is present, which makes the `=== undefined` guards below look
 * like dead code to tsc and to ESLint (`sonarjs/different-types-comparison` reports
 * them); deleting one on that advice turns a reported defect into `TypeError: Cannot
 * read properties of undefined`.
 */
const NESTED_ALLOWED_EXTENSIONS: Partial<Record<string, readonly string[]>> = {
  // i18next-parser writes one JSON namespace per language and nothing else.
  locales: ['.json'],
}

/**
 * Every TRACKED entry deliberately published to the CDN, with why it must be public.
 * Not the whole published manifest: `config.json` is served too — `api-stack.ts` adds
 * it via `s3deploy.Source.data` and deploy.sh generates it at deploy time — but it is
 * gitignored and must stay untracked, so it is deliberately absent from a list built
 * from git.
 *
 * Kept sorted for reviewability, but the assertion does not rely on that — see there.
 */
const EXPECTED_PUBLIC_ENTRIES = [
  // Browser tab icon; requested by the browser itself (index.html:5 declares it, but
  // /favicon.ico would be requested regardless).
  'favicon.ico',
  // SVG favicon (Kiro ghost mark), declared first in index.html's icon links;
  // favicon.ico stays as the fallback for browsers without SVG icons.
  'kiro-ghost.svg',
  // i18next fetches translation JSON at runtime over HTTP, so these cannot be
  // bundled — src/i18n/loadPath.ts builds `/locales/{{lng}}/{{ns}}.json?v=…`.
  // Contents are guarded separately by src/i18n/localeParity.test.ts.
  'locales',
  // Pre-paint theme script — see PUBLISHED_SCRIPTS.
  'theme-init.js',
  // The external-assistant skill for the global MCP endpoint (todofeatures §6.3,
  // docs/mcp.md). Public BY DESIGN: it is handed to third-party assistants as a
  // stable link (`/voc-mcp-skill.md`), and the Connect page fetches it to fill in
  // this deployment's endpoint for the download. It holds no token and no
  // deployment detail — only the `{{VOC_MCP_ENDPOINT}}` placeholder.
  'voc-mcp-skill.md',
]

/**
 * The ONLY scripts allowed under `public/`, each with why it cannot be bundled.
 *
 * `theme-init.js` sets `data-theme`/`data-mode` on <html> before first paint so the
 * Kiro dark/light theme never flashes. It must run synchronously in <head>:
 *  - the CloudFront CSP is `script-src 'self'`, so it cannot be inline;
 *  - a Vite module script is deferred, so a bundled version runs after first paint.
 * The two reasons the ban exists are answered for it: it IS linted (`eslint .`
 * covers `public/`), and its storage key and attributes are pinned to
 * src/theme/themeStore.ts by src/theme/themeInit.test.ts.
 */
const PUBLISHED_SCRIPTS = ['theme-init.js']

describe('frontend public/ inventory', () => {
  it('contains exactly the assets we intend to publish to the CDN', () => {
    // First path segment only, so `locales/en/common.json` counts as `locales` and the
    // 120 translation files need not be listed individually.
    const actual = [
      ...new Set(TRACKED_PUBLIC_PATHS.map((p) => at(p.split('/'), 0))),
    ].sort(byName)

    // Compared whole rather than per-entry so the message names the unexpected file,
    // which is what a reader acts on. Both sides sorted: comparing a sorted actual
    // against the literal order reported a legitimately-added entry as simultaneously
    // unexpected (+) and missing (-), which reads as a bug in the guard.
    expect(actual).toStrictEqual([...EXPECTED_PUBLIC_ENTRIES].sort(byName))
  })

  it('publishes no JavaScript anywhere in the tree except the justified PUBLISHED_SCRIPTS', () => {
    // Every tracked path, not just the top level: a script inside an allowlisted
    // directory (locales/ is machine-managed, so it is the subtree least likely to be
    // read) is copied to dist/ and served just the same, while the assertion above sees
    // only the directory name. Anything executable here bypasses the bundler — no
    // tree-shaking, no content hash, no type-checking, and until #374 no linting.
    //
    // Case-insensitive because S3 keys and URL paths are not: `locales/en/DEAD.JS` is a
    // distinct object Vite copies and CloudFront serves like any other. On macOS that
    // case is ordinary rather than contrived — the filesystem treats `DEAD.JS` and
    // `dead.js` as one file, so a contributor gets whichever case git recorded.
    const scripts = TRACKED_PUBLIC_PATHS.filter((p) =>
      /\.[cm]?[jt]sx?$/i.test(p),
    ).sort(byName)

    // Exact-match allowlist (top-level path, same case): `locales/theme-init.js` or
    // `THEME-INIT.JS` would still fail.
    expect(scripts).toStrictEqual([...PUBLISHED_SCRIPTS].sort(byName))
  })

  it('declares the permitted file types for every allowlisted directory', () => {
    // Asserted at directory granularity, over the two constants' intersection, rather
    // than per tracked file: that keeps one defect to one message — the missing
    // declaration itself, not every file inside the undeclared directory.
    //
    // Without it the scoping below leaves a gap in the intended workflow rather than in
    // a mistake: add `public/fonts/`, allowlist `'fonts'`, and the inventory check goes
    // green with nothing requiring an extensions entry, so a later `.csv` dropped in
    // there is invisible — the state `locales/` was in before this file declared
    // `['.json']` for it.
    const undeclared = TRACKED_DIRECTORIES
      .filter((dir) => EXPECTED_PUBLIC_ENTRIES.includes(dir))
      .filter((dir) => NESTED_ALLOWED_EXTENSIONS[dir] === undefined)
      .sort(byName)

    expect(
      undeclared,
      'allowlisted directories with no NESTED_ALLOWED_EXTENSIONS entry — say which file types may be published from each',
    ).toStrictEqual([])
  })

  it('declares file types only for directories that still exist', () => {
    // The mirror of the assertion above, and the defect class #374 fixed by hand: two
    // `eslint.config.js` ignore entries for deleted files sat there inert, reading as
    // coverage. An entry for a directory that is gone does the same, and it also
    // catches the likelier slip of naming a FILE (`mockServiceWorker.js`) where a
    // directory is meant, which would constrain nothing.
    const stale = Object.keys(NESTED_ALLOWED_EXTENSIONS)
      .filter((dir) => !TRACKED_DIRECTORIES.includes(dir))
      .sort(byName)

    expect(
      stale,
      'NESTED_ALLOWED_EXTENSIONS keys that are not directories tracked under public/ — delete the entry, or fix the name',
    ).toStrictEqual([])
  })

  it('publishes only the declared file types inside allowlisted directories', () => {
    // The check the two constants exist for — see NESTED_ALLOWED_EXTENSIONS for why a
    // nested non-script file is otherwise published with nothing objecting.
    //
    // Scoped to directories the inventory assertion already accepts, so one defect
    // produces one failure: a path under a NEW directory is reported there, by the
    // message naming the decision that actually has to be made (justify the
    // directory), not by this one (declare its extensions).
    const unexpected = TRACKED_PUBLIC_PATHS.filter((p) => p.includes('/'))
      .filter((p) => EXPECTED_PUBLIC_ENTRIES.includes(at(p.split('/'), 0)))
      .filter((p) => {
        const allowed = NESTED_ALLOWED_EXTENSIONS[at(p.split('/'), 0)]
        // A directory with NO declaration is reported once above, on the constant.
        return allowed !== undefined && !allowed.some((ext) => p.endsWith(ext))
      })
      .sort(byName)

    expect(unexpected).toStrictEqual([])
  })
})
