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
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as path from 'path'

const FRONTEND_DIR = path.join(__dirname, '..')

/**
 * Every path tracked under `public/`, relative to `public/`. This is the set git
 * would deploy, so gitignored local-only files (see the note above) cannot make
 * it fail, and nested paths are included — recursion comes for free.
 */
function trackedPublicPaths(): string[] {
  return execFileSync('git', ['ls-files', '--', 'public'], {
    cwd: FRONTEND_DIR,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => path.relative('public', line))
}

/**
 * Every entry deliberately published to the CDN, with why it must be public.
 * Keep sorted; the top-level tracked entries are compared against this exactly.
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
      ...new Set(trackedPublicPaths().map((p) => p.split(path.sep)[0])),
    ].sort()

    // Compared as a whole rather than per-entry so the failure message names
    // the unexpected file, which is the thing a reader needs to act on.
    expect(actual).toEqual(EXPECTED_PUBLIC_ENTRIES)
  })

  it('publishes no JavaScript anywhere in the tree, which would be served unbundled and unlinted', () => {
    // Both files this guard was written for were top-level .js, but the check
    // covers every tracked path under public/ — a script inside an allowlisted
    // directory (locales/ is machine-managed by i18next-parser, so it is the
    // subtree least likely to be read carefully) is copied to dist/ and served
    // just the same, while the assertion above sees only the directory name.
    // Anything executable here bypasses the bundler: no tree-shaking, no
    // content hash, no type-checking, and until #374 no linting either.
    const scripts = trackedPublicPaths()
      .filter((p) => /\.[cm]?[jt]sx?$/.test(p))
      .sort()

    expect(scripts).toEqual([])
  })
})
