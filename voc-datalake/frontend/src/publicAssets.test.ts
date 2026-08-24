/**
 * Published-asset inventory guard (PR #374).
 *
 * Vite copies `public/` verbatim into `dist/`, which `VocApiStack`'s
 * BucketDeployment syncs to the website bucket and CloudFront serves. So every
 * entry here is publicly reachable on the internet whether or not a single line
 * of application code references it — being unused does not make a file in
 * `public/` private, it only makes it unnoticed.
 *
 * That is how two dead assets came to be served for a long time: a stale copy of
 * the embeddable feedback widget (which called routes retired by #277, so the
 * CDN published a widget that could only fail) and an `msw` service worker for a
 * package that is not installed. Neither was reachable from the app, and no gate
 * objected: linting cannot answer "is this published thing reachable?", and one
 * of the two shipped its own file-wide eslint-disable header anyway.
 *
 * This test exists to force that decision to be conscious. Adding a file to
 * `public/` fails here, and the fix is to answer two questions in the PR that
 * adds it: is it actually referenced, and is it meant to be world-readable? If
 * both are yes, add it below. If not, it does not belong in `public/` —
 * build-time assets belong in `src/` where the bundler can tree-shake them, and
 * anything needing authorization belongs behind the API.
 *
 * The inventory is read from git rather than from the working tree, because the
 * two are not the same question. What CI publishes is what is *tracked*; an
 * untracked file exists on one developer's disk and is never deployed. Reading
 * the filesystem would therefore fail on things that are deliberately ignored —
 * `frontend/.gitignore` names `public/config.json` on purpose (runtimeConfig.ts
 * fetches `/config.json`, and scripts/deploy.sh generates it into `dist/` at
 * deploy time, so a developer wanting `npm run dev` to serve a real config drops
 * it here) as well as `.DS_Store`. A guard that breaks `npm test` for a
 * documented workflow gets deleted rather than fixed, so it must not.
 *
 * The cost of that choice is a dependency on `git` and a real `.git` directory,
 * which a source archive or workshop zip does not have. That case cannot be
 * silently skipped — a guard that quietly passes when it cannot see the
 * inventory guards nothing — so it fails with a message naming the missing
 * checkout rather than with a bare `fatal: not a git repository` under a test
 * name about `public/`, and it fails ONCE: the inventory is resolved at module
 * scope, so an unzipped source tree reports one error rather than repeating the
 * same environmental fact under each assertion's name.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as path from 'path'

const FRONTEND_DIR = path.join(__dirname, '..')

/**
 * Every path tracked under `public/`, relative to `public/`. This is the set git
 * would deploy, so gitignored local-only files (see the note above) cannot make
 * it fail, and nested paths are included — recursion comes for free.
 *
 * `git ls-files` always emits forward slashes regardless of platform, so paths
 * are split on `/` rather than `path.sep`; using the platform separator would
 * silently stop collapsing `locales/en/common.json` to `locales` on Windows and
 * the inventory assertion would fail listing 121 files.
 *
 * `-z` is load-bearing, not stylistic. Without it `git ls-files` honours
 * `core.quotePath`, which defaults to true, so any path containing a non-ASCII
 * byte comes back C-quoted with octal escapes — `public/déad.js` is emitted as
 * `"public/d\303\251ad.js"`. Every step below then breaks silently: the script
 * regex is anchored with `$` and cannot match a name ending in a literal quote,
 * so a published script would pass the check that exists to catch it, and the
 * `^public/` strip is a no-op because the line starts with `"`. `-z` returns raw
 * NUL-separated bytes instead, which also survives a path containing a newline
 * (`split('\n')` would tear that one in half). `locales/` already spans eight
 * languages, so non-ASCII filenames here are ordinary rather than exotic.
 */
function trackedPublicPaths(): string[] {
  let stdout: string

  try {
    stdout = execFileSync('git', ['ls-files', '-z', '--', 'public'], {
      cwd: FRONTEND_DIR,
      encoding: 'utf8',
      // Keep git's stderr out of the test output rather than letting it print
      // above the assertion. `execFileSync` already appends the child's stderr
      // to the thrown error's `message`, which is what the catch below
      // interpolates — nothing here reads `error.stderr`.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // `execFileSync` throws rather than returning a status, and outside a git
    // checkout that surfaces as a bare `fatal: not a git repository` against a
    // test named for the inventory — pointing the reader at `public/` when the
    // problem is the missing `.git`. This repo ships as a source archive and a
    // workshop zip as often as it is cloned (`git archive` and `npm pack` both
    // drop `.git` by construction), so name the real cause.
    throw new Error(
      `public/ inventory requires a git checkout; "git ls-files" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }

  return stdout
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^public\//, ''))
}

/**
 * Resolved once for the whole file rather than per assertion, which matters only
 * in the failure case: each `it` calling `trackedPublicPaths()` meant an
 * unzipped source tree reported the same "requires a git checkout" error three
 * times under three test names, and the reader deciding whether the repo is
 * broken has not read this file. One environmental fact, one report — the same
 * one-defect-one-failure rule the assertions below follow, and the memoization
 * shape `api-stack.test.ts` already uses for its synthesized template.
 */
const TRACKED_PUBLIC_PATHS = trackedPublicPaths()

/**
 * For each allowlisted DIRECTORY, the file extensions its contents may have.
 *
 * Two facts make this necessary, neither visible from the assertions alone. The
 * inventory check compares only first path segments, so once a directory is
 * allowlisted every file at any depth inside it is invisible to it —
 * `locales/en/dump.csv` collapses to `locales` and passes. And the sibling
 * `localeParity.test.ts` cannot see such a file either, because it enumerates
 * the `.json` namespaces it expects rather than auditing what is present.
 *
 * Extensions match EXACTLY and lowercase — deliberately the opposite of the
 * case-insensitive script regex below (see its comment), because the two have
 * inverted jobs: a FORBIDDEN list must match broadly or something slips past, an
 * ALLOWED list must match narrowly or something slips in. `locales/en/COMMON.JSON`
 * is a distinct S3 key that i18next never requests, so it is dead CDN weight.
 *
 * Every allowlisted directory must appear here, asserted separately below. The
 * per-path check is scoped to directories the inventory already accepts, so that
 * one defect yields one failure — but the scoping means a directory that has just
 * been allowlisted, and so passes the inventory check, would otherwise be
 * unconstrained on everything except scripts. That is exactly the state
 * `locales/` was in before this file declared `['.json']` for it, so allowlisting
 * a subtree has to keep forcing the second decision: not just "may this directory
 * be published?" but "what may live in it?".
 */
const NESTED_ALLOWED_EXTENSIONS: Record<string, readonly string[]> = {
  // i18next-parser writes one JSON namespace per language and nothing else.
  locales: ['.json'],
}

/**
 * Every entry deliberately published to the CDN, with why it must be public.
 *
 * Kept sorted for reviewability, but the assertion sorts a copy before comparing
 * rather than relying on that: an unsorted literal made a correctly-allowlisted
 * new asset appear in the diff as both added and removed, so the one author who
 * did everything right got the least comprehensible message. Sorting at the
 * comparison makes the ordering unenforceable-but-irrelevant instead of a
 * documented rule with a confusing penalty.
 */
const EXPECTED_PUBLIC_ENTRIES = [
  // Browser tab icon; requested by the browser itself, not by our code
  // (index.html:5 declares it, but the browser would request /favicon.ico
  // regardless).
  'favicon.ico',
  // i18next fetches translation JSON at runtime over HTTP, so these cannot be
  // bundled — src/i18n/loadPath.ts builds `/locales/{{lng}}/{{ns}}.json?v=…`.
  // Contents are guarded separately by src/i18n/localeParity.test.ts.
  'locales',
]

describe('frontend public/ inventory', () => {
  it('contains exactly the assets we intend to publish to the CDN', () => {
    // First path segment only, so `locales/en/common.json` counts as `locales`
    // and the 120 translation files do not have to be listed individually.
    const actual = [
      ...new Set(TRACKED_PUBLIC_PATHS.map((p) => p.split('/')[0])),
    ].sort()

    // Compared as a whole rather than per-entry so the failure message names
    // the unexpected file, which is the thing a reader needs to act on. The
    // expected side is sorted too: comparing a sorted actual against the
    // literal order reported a legitimately-added entry as simultaneously
    // unexpected (+) and missing (-), which reads as a bug in the guard.
    expect(actual).toEqual([...EXPECTED_PUBLIC_ENTRIES].sort())
  })

  it('publishes no JavaScript anywhere in the tree, which would be served unbundled and unlinted', () => {
    // Both files this guard was written for were top-level .js, but the check
    // covers every tracked path under public/ — a script inside an allowlisted
    // directory (locales/ is machine-managed by i18next-parser, so it is the
    // subtree least likely to be read carefully) is copied to dist/ and served
    // just the same, while the assertion above sees only the directory name.
    // Anything executable here bypasses the bundler: no tree-shaking, no
    // content hash, no type-checking, and until #374 no linting either.
    //
    // Matched case-insensitively, which is load-bearing rather than defensive.
    // S3 keys and URL paths are case-sensitive, so `locales/en/DEAD.JS` is a
    // distinct object that Vite copies and CloudFront serves exactly like a
    // lowercase one — but a case-sensitive regex does not match it, so the
    // check that exists to name a published script would have stayed silent
    // while the file shipped. macOS makes this ordinary rather than contrived:
    // its filesystem treats `DEAD.JS` and `dead.js` as the same file, so the
    // case a contributor gets is whichever one git recorded on `git add`.
    const scripts = TRACKED_PUBLIC_PATHS.filter((p) =>
      /\.[cm]?[jt]sx?$/i.test(p),
    ).sort()

    expect(scripts).toEqual([])
  })

  it('declares the permitted file types for every allowlisted directory', () => {
    // Asserted over the CONSTANTS, not over the tracked paths, which is what
    // keeps it to one failure: it fires on the missing declaration itself rather
    // than once per file inside the undeclared directory.
    //
    // Without this, the scoping on the assertion below leaves a gap in the
    // intended workflow rather than in a mistake. Add `public/fonts/`, allowlist
    // `'fonts'`, and the inventory check goes green — at which point nothing
    // requires an extensions entry for `fonts/`, and a later `.csv` dropped in
    // there is invisible again. Requiring the declaration up front closes that
    // without re-reporting a directory the inventory check is already rejecting.
    const directories = [
      ...new Set(
        TRACKED_PUBLIC_PATHS.filter((p) => p.includes('/')).map(
          (p) => p.split('/')[0],
        ),
      ),
    ]

    const undeclared = directories
      .filter((dir) => EXPECTED_PUBLIC_ENTRIES.includes(dir))
      .filter((dir) => NESTED_ALLOWED_EXTENSIONS[dir] === undefined)
      .sort()

    expect(
      undeclared,
      'allowlisted directories with no NESTED_ALLOWED_EXTENSIONS entry — say which file types may be published from each',
    ).toEqual([])
  })

  it('publishes only the declared file types inside allowlisted directories', () => {
    // The inventory assertion sees `locales`, not `locales/en/dump.csv`, so
    // without this a non-script file nested in an allowlisted directory is
    // published with nothing objecting. See NESTED_ALLOWED_EXTENSIONS for why
    // the match is exact-lowercase rather than case-insensitive.
    //
    // Scoped to directories the inventory assertion already accepts, so one
    // defect produces one failure: a path under a NEW directory is reported
    // there, by the message that names the decision actually needing to be made
    // (justify the directory), not by this one (declare its extensions).
    const unexpected = TRACKED_PUBLIC_PATHS.filter((p) => p.includes('/'))
      .filter((p) => EXPECTED_PUBLIC_ENTRIES.includes(p.split('/')[0]))
      .filter((p) => {
        const allowed = NESTED_ALLOWED_EXTENSIONS[p.split('/')[0]]
        // A directory with NO declaration is reported once by the assertion
        // above, on the constant, rather than here once per file inside it — so
        // skip it, and let that message name the decision that has to be made.
        return allowed !== undefined && !allowed.some((ext) => p.endsWith(ext))
      })
      .sort()

    expect(unexpected).toEqual([])
  })
})
