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
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const PUBLIC_DIR = path.join(__dirname, '../public')

/**
 * Every entry deliberately published to the CDN, with why it must be public.
 * Keep sorted; `readdirSync` output is compared against this exactly.
 */
const EXPECTED_PUBLIC_ENTRIES = [
  // Browser tab icon; requested by the browser itself, not by our code.
  'favicon.ico',
  // i18next fetches translation JSON at runtime over HTTP, so these cannot be
  // bundled. Contents are guarded separately by src/i18n/localeParity.test.ts.
  'locales',
  // Referenced by index.html.
  'vite.svg',
]

describe('frontend public/ inventory', () => {
  it('contains exactly the assets we intend to publish to the CDN', () => {
    const actual = fs.readdirSync(PUBLIC_DIR).sort()

    // Compared as a whole rather than per-entry so the failure message names
    // the unexpected file, which is the thing a reader needs to act on.
    expect(actual).toEqual(EXPECTED_PUBLIC_ENTRIES)
  })

  it('publishes no JavaScript, which would be served unbundled and unlinted', () => {
    // Both files this guard was written for were .js. Anything executable in
    // here bypasses the bundler (no tree-shaking, no content hash, no
    // type-checking) and, until #374, the lint ignores as well.
    const scripts = fs
      .readdirSync(PUBLIC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
      .map((entry) => entry.name)

    expect(scripts).toEqual([])
  })
})
