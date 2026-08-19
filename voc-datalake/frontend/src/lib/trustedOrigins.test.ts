/**
 * @fileoverview Tests for the shared trusted-origin allowlist module (issue #262).
 *
 * `lib/trustedOrigins.ts` is the single authoritative security module: all
 * origin-based auth-header gating flows through the functions exported here.
 *
 * Vacuity trap addressed: every "not trusted" assertion is paired with a
 * positive case that first confirms the mechanism fires for a valid input —
 * making the absence assertion meaningful rather than trivially true.
 *
 * Critical hostname-comparison edge cases covered:
 *   - http://localhost:8000    → trusted in dev (any port)
 *   - http://localhost.evil.example.com → NOT trusted in dev (subdomain attack)
 *   - http://127.0.0.1:9000   → trusted in dev (any port)
 *   - ''                      → always safe (the "not configured" sentinel)
 *   - 'not-a-url'             → always rejected (fail closed)
 *   - any origin when config not loaded → rejected (fail closed)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── module-level mocks ────────────────────────────────────────────────────────

vi.mock('../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => true),
  getRuntimeConfig: vi.fn(() => ({
    apiEndpoint: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
    cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
  })),
}))

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { buildTrustedApiOrigins, isTrustedOrigin, isTrustedApiEndpoint } from './trustedOrigins'
import * as runtimeConfigModule from '../runtimeConfig'
import { APP_ORIGIN, setLocationOrigin, useAppOrigin } from '@test/location'

// ── helpers ───────────────────────────────────────────────────────────────────

const TRUSTED_API = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1'
const TRUSTED_ORIGIN = 'https://abc123.execute-api.us-east-1.amazonaws.com'

// ── tests ─────────────────────────────────────────────────────────────────────

describe('buildTrustedApiOrigins', () => {
  beforeEach(() => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(true)
    vi.mocked(runtimeConfigModule.getRuntimeConfig).mockReturnValue({
      apiEndpoint: TRUSTED_API,
      cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('returns the runtime-config origin when config is loaded', () => {
    const origins = buildTrustedApiOrigins()
    expect(origins).toContain(TRUSTED_ORIGIN)
  })

  it('returns an empty array when config is not loaded', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(false)
    expect(buildTrustedApiOrigins()).toEqual([])
  })

  it('returns an empty array when the runtime config endpoint is unparseable', () => {
    vi.mocked(runtimeConfigModule.getRuntimeConfig).mockReturnValue({
      apiEndpoint: 'not-a-url',
      cognito: { userPoolId: '', clientId: '', region: 'us-east-1', identityPoolId: '' },
    })
    // buildTrustedApiOrigins never adds localhost entries — that logic lives
    // only in isTrustedAbsoluteUrl.  When the endpoint is unparseable the
    // array must be exactly empty.
    expect(buildTrustedApiOrigins()).toEqual([])
  })

  it('does NOT add localhost entries to the returned array in dev builds', () => {
    vi.stubEnv('DEV', true)
    // buildTrustedApiOrigins only returns origins from the runtime config;
    // localhost trust is a separate hostname check inside isTrustedAbsoluteUrl.
    const origins = buildTrustedApiOrigins()
    expect(origins).toContain(TRUSTED_ORIGIN)
    expect(origins.some(o => o.includes('localhost'))).toBe(false)
  })
})

describe('isTrustedOrigin', () => {
  useAppOrigin()

  beforeEach(() => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(true)
    vi.mocked(runtimeConfigModule.getRuntimeConfig).mockReturnValue({
      apiEndpoint: TRUSTED_API,
      cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // ── path-relative URLs (always same-origin) ───────────────────────────────

  it('trusts a path-relative URL (same-origin by definition)', () => {
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
  })

  // ── trusted absolute URLs ─────────────────────────────────────────────────

  it('trusts an absolute URL whose origin matches the deployment API', () => {
    expect(isTrustedOrigin(`${TRUSTED_API}/feedback`)).toBe(true)
  })

  // ── foreign origins ───────────────────────────────────────────────────────

  it('does NOT trust a URL with a foreign origin', () => {
    // Positive case first — proves the mechanism fires for a good URL.
    expect(isTrustedOrigin(`${TRUSTED_API}/feedback`)).toBe(true)
    // Negative case.
    expect(isTrustedOrigin('https://attacker.example.com/collect')).toBe(false)
  })

  it('does NOT trust a prefix-trick URL', () => {
    const prefixTrick = `${TRUSTED_ORIGIN}.evil.example.com/v1/collect`
    expect(isTrustedOrigin(prefixTrick)).toBe(false)
  })

  // ── inputs that look same-origin but resolve elsewhere ────────────────────
  //
  // Every case below satisfies `startsWith('/')`, so each one would be trusted
  // by a prefix-based classifier. They are rejected because classification is
  // done on the origin the URL *resolves* to — the origin `fetch` will use.

  it('does NOT trust a protocol-relative URL pointing to a foreign host', () => {
    // Positive case: path-relative is still safe.
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
    // //evil.example.com starts with '/' but resolves cross-origin.
    expect(isTrustedOrigin('//evil.example.com/collect')).toBe(false)
  })

  it('does NOT trust a backslash-separator URL pointing to a foreign host', () => {
    // Positive case: a genuinely path-relative URL is still trusted, so the
    // negative assertions below cannot pass just because everything is refused.
    expect(isTrustedOrigin('/api/feedback')).toBe(true)

    // The WHATWG URL parser normalises `\` to `/` for http(s) schemes, so each
    // of these resolves to https://evil.example.com even though none of them
    // starts with '//'.
    expect(isTrustedOrigin('/\\evil.example.com/collect')).toBe(false)
    expect(isTrustedOrigin('/\\/evil.example.com')).toBe(false)
    expect(isTrustedOrigin('/\\\\evil.example.com/collect')).toBe(false)
  })

  it('does NOT trust mixed slash/backslash separator forms', () => {
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
    expect(isTrustedOrigin('//\\evil.example.com/collect')).toBe(false)
    expect(isTrustedOrigin('\\\\evil.example.com/collect')).toBe(false)
    expect(isTrustedOrigin('\\/evil.example.com/collect')).toBe(false)
  })

  it('resolves every separator form to the origin fetch would use', () => {
    // Documents *why* the cases above must be false: this is the classification
    // the implementation performs, and it matches what fetch does.
    // Every spelling asserted false above appears here, so the two lists cannot
    // drift: a case rejected up there without a resolution shown down here
    // would be rejected for an unexamined reason.
    for (const spelling of [
      '//evil.example.com/collect',
      '/\\evil.example.com/collect',
      '/\\/evil.example.com',
      '/\\\\evil.example.com/collect',
      '//\\evil.example.com/collect',
      '\\\\evil.example.com/collect',
      '\\/evil.example.com/collect',
    ]) {
      expect(new URL(spelling, APP_ORIGIN).origin).toBe('http://evil.example.com')
    }
    // …whereas a genuinely path-relative URL resolves to the current origin.
    expect(new URL('/api/feedback', APP_ORIGIN).origin).toBe(APP_ORIGIN)
  })

  // ── localhost in dev builds ───────────────────────────────────────────────

  it('trusts http://localhost on any port in dev builds', () => {
    vi.stubEnv('DEV', true)
    expect(isTrustedOrigin('http://localhost:8000/api')).toBe(true)
    expect(isTrustedOrigin('http://localhost:3001/api')).toBe(true)
    expect(isTrustedOrigin('http://localhost:5173/api')).toBe(true)
  })

  it('trusts http://127.0.0.1 on any port in dev builds', () => {
    vi.stubEnv('DEV', true)
    expect(isTrustedOrigin('http://127.0.0.1:9000/api')).toBe(true)
    expect(isTrustedOrigin('http://127.0.0.1:5000/api')).toBe(true)
  })

  it('does NOT trust a subdomain that starts with "localhost" in dev builds', () => {
    vi.stubEnv('DEV', true)
    // Positive case: real localhost is trusted.
    expect(isTrustedOrigin('http://localhost:8000/api')).toBe(true)
    // localhost.evil.example.com has hostname 'localhost.evil.example.com' —
    // NOT 'localhost' — so it must be rejected.
    expect(isTrustedOrigin('http://localhost.evil.example.com/steal')).toBe(false)
  })

  it('does NOT trust localhost URLs in production builds', () => {
    vi.stubEnv('DEV', false)
    // Positive case: the deployment API is still trusted in prod.
    expect(isTrustedOrigin(TRUSTED_API)).toBe(true)
    // Localhost is only in the dev allowlist; production must reject it.
    expect(isTrustedOrigin('http://localhost:8000/api')).toBe(false)
    expect(isTrustedOrigin('http://127.0.0.1:9000/api')).toBe(false)
  })

  // ── error cases ───────────────────────────────────────────────────────────

  it('returns false for an unparseable URL (fail closed)', () => {
    // 'http://' has no host, so it cannot be resolved even with a base.
    expect(isTrustedOrigin('http://')).toBe(false)
  })

  it('returns false for an opaque-origin scheme (fail closed)', () => {
    // Positive case so the assertions below are not vacuous.
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
    // These parse but have origin 'null', which is in no allowlist.
    expect(isTrustedOrigin('data:text/html,steal')).toBe(false)
    expect(isTrustedOrigin('javascript:alert(1)')).toBe(false)
  })

  it('trusts a scheme-less garbage string because it resolves same-origin', () => {
    // 'not a url at all' has no scheme and no authority, so the URL parser
    // resolves it as a path against the current origin — which is exactly
    // where fetch would send it. Same-origin, therefore safe: the token can
    // only reach our own origin.
    expect(new URL('not a url at all', APP_ORIGIN).origin).toBe(APP_ORIGIN)
    expect(isTrustedOrigin('not a url at all')).toBe(true)
  })

  it('refuses a relative URL when the document origin is unavailable', () => {
    // No usable base → nothing can be classified as same-origin, so relative
    // inputs fail closed rather than resolving against `undefined`.
    Object.defineProperty(window, 'location', {
      value: {},
      writable: true,
      configurable: true,
    })
    expect(isTrustedOrigin('/api/feedback')).toBe(false)
    // An absolute URL in the allowlist needs no base and is still trusted.
    expect(isTrustedOrigin(TRUSTED_API)).toBe(true)
  })

  it('refuses everything when the document origin is opaque ("null")', () => {
    // A sandboxed iframe without allow-same-origin, and a document loaded from
    // a `data:` URL, both report `location.origin === 'null'` — the STRING
    // 'null', not the value. That is a different branch from the case above:
    // `getCurrentOrigin()` sees a non-empty string and returns it, so the
    // same-origin comparison `parsed.origin === currentOrigin` is reachable in
    // principle, and 'null' === 'null' would trust anything.
    //
    // It fails closed instead, because of *where* it fails: the WHATWG URL
    // constructor parses the base first and throws TypeError if the base is
    // itself unparseable — which 'null' is. So the throw happens before the
    // comparison, for absolute inputs as much as relative ones, and the
    // `catch` returns false. Verified against Node's URL implementation:
    // `new URL(x, 'null')` throws for every x, including absolute URLs.
    //
    // This is currently a property of the URL parser rather than of an
    // explicit guard, which is exactly why it is pinned here: an "optimisation"
    // that reordered the same-origin comparison ahead of the parse, or that
    // resolved only relative-looking inputs against the base, would turn an
    // opaque document into one that trusts every origin.
    setLocationOrigin('null')

    expect(isTrustedOrigin('/api/feedback')).toBe(false)
    expect(isTrustedOrigin(TRUSTED_API)).toBe(false)
    expect(isTrustedOrigin('https://attacker.example.com/collect')).toBe(false)
    // Including a request URL whose own origin is also the string 'null', which
    // is the pairing that a naive equality check would wave through.
    expect(isTrustedOrigin('data:text/html,steal')).toBe(false)
  })

  it('trusts the allowlist again once the origin is a real one (vacuity check)', () => {
    // Guards the test above: it must fail closed because the origin is opaque,
    // not because these suites refuse everything regardless.
    setLocationOrigin(APP_ORIGIN)
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
    expect(isTrustedOrigin(TRUSTED_API)).toBe(true)
  })

  it('trusts the runtime-config origin while config IS loaded (vacuity check)', () => {
    // Positive case, with its own explicit mock state: config loaded → trusted.
    // Named for what it asserts — it previously carried the *next* test's name
    // ("returns false when config is not loaded"), which described the opposite
    // of its single `toBe(true)` assertion and so read as a passing test for a
    // property it never checked.
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(true)
    expect(isTrustedOrigin(TRUSTED_API)).toBe(true)
  })

  it('returns false for the runtime-config origin while config is not loaded', () => {
    // Negative case, also with explicit mock state rather than relying on how
    // many times isTrustedOrigin happens to call isConfigLoaded.
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(false)
    expect(isTrustedOrigin(TRUSTED_API)).toBe(false)
  })
})

describe('isTrustedApiEndpoint', () => {
  useAppOrigin()

  beforeEach(() => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(true)
    vi.mocked(runtimeConfigModule.getRuntimeConfig).mockReturnValue({
      apiEndpoint: TRUSTED_API,
      cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // ── sentinel value ────────────────────────────────────────────────────────

  it('returns true for empty string (the "not configured" sentinel)', () => {
    // Empty string → falls back to relative /api path in getBaseUrl() → same-origin.
    expect(isTrustedApiEndpoint('')).toBe(true)
  })

  // ── trusted origin ────────────────────────────────────────────────────────

  it('returns true for the deployment runtime-config origin (positive case)', () => {
    expect(isTrustedApiEndpoint(TRUSTED_API)).toBe(true)
  })

  // ── untrusted origins ─────────────────────────────────────────────────────

  it('returns false for a foreign origin', () => {
    // Positive case to prove the mechanism fires.
    expect(isTrustedApiEndpoint(TRUSTED_API)).toBe(true)
    // Negative case.
    expect(isTrustedApiEndpoint('https://attacker.example.com/collect')).toBe(false)
  })

  // ── localhost in dev builds ───────────────────────────────────────────────

  it('returns true for http://localhost:8000 in dev builds (any port)', () => {
    vi.stubEnv('DEV', true)
    expect(isTrustedApiEndpoint('http://localhost:8000')).toBe(true)
  })

  it('returns true for any http://localhost port in dev builds', () => {
    vi.stubEnv('DEV', true)
    expect(isTrustedApiEndpoint('http://localhost:3001')).toBe(true)
    expect(isTrustedApiEndpoint('http://localhost:5173')).toBe(true)
    expect(isTrustedApiEndpoint('http://localhost:8080')).toBe(true)
  })

  it('returns true for http://127.0.0.1 on any port in dev builds', () => {
    vi.stubEnv('DEV', true)
    expect(isTrustedApiEndpoint('http://127.0.0.1:9000')).toBe(true)
    expect(isTrustedApiEndpoint('http://127.0.0.1:5000')).toBe(true)
  })

  it('does NOT trust http://localhost.evil.example.com in dev builds (subdomain attack)', () => {
    vi.stubEnv('DEV', true)
    // Positive case: real localhost is trusted.
    expect(isTrustedApiEndpoint('http://localhost:8000')).toBe(true)
    // Subdomain that starts with 'localhost' — the hostname is
    // 'localhost.evil.example.com', not 'localhost' — must be rejected.
    expect(isTrustedApiEndpoint('http://localhost.evil.example.com')).toBe(false)
  })

  it('does NOT trust localhost URLs in production builds', () => {
    vi.stubEnv('DEV', false)
    // Positive case: deployment origin is still trusted in prod.
    expect(isTrustedApiEndpoint(TRUSTED_API)).toBe(true)
    // Localhost is only in the dev allowlist.
    expect(isTrustedApiEndpoint('http://localhost:8000')).toBe(false)
    expect(isTrustedApiEndpoint('http://127.0.0.1:9000')).toBe(false)
  })

  // ── error cases ───────────────────────────────────────────────────────────

  it('returns false for an unparseable value (fail closed)', () => {
    expect(isTrustedApiEndpoint('not-a-url')).toBe(false)
  })

  it('returns false for a path-relative endpoint', () => {
    // Pins the deliberate asymmetry with isTrustedOrigin, which trusts '/api'
    // because it resolves same-origin. A *stored endpoint* is a deployment
    // config value, so only the '' sentinel expresses "same origin"; every
    // other relative spelling fails closed by design, not by accident.
    expect(isTrustedApiEndpoint('')).toBe(true)
    expect(isTrustedOrigin('/api')).toBe(true)
    expect(isTrustedApiEndpoint('/api')).toBe(false)
    expect(isTrustedApiEndpoint('api/v1')).toBe(false)
  })

  it('returns false for separator-trick endpoints', () => {
    // Positive case so the negatives are meaningful.
    expect(isTrustedApiEndpoint(TRUSTED_API)).toBe(true)
    // Parsed with no base, so these are not absolute URLs at all → rejected.
    expect(isTrustedApiEndpoint('//evil.example.com')).toBe(false)
    expect(isTrustedApiEndpoint('/\\evil.example.com')).toBe(false)
  })

  it('returns false when config is not loaded (empty allowlist → fail closed)', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(false)
    // Even the runtime-config origin is rejected when config has not loaded.
    expect(isTrustedApiEndpoint(TRUSTED_API)).toBe(false)
  })
})
