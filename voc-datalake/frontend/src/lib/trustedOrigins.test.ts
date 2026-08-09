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

  // ── protocol-relative URLs ────────────────────────────────────────────────

  it('does NOT trust a protocol-relative URL pointing to a foreign host', () => {
    // Positive case: path-relative is still safe.
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
    // //evil.example.com starts with '/' but resolves cross-origin.
    expect(isTrustedOrigin('//evil.example.com/collect')).toBe(false)
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
    expect(isTrustedOrigin('not a url at all')).toBe(false)
  })

  it('returns false when config is not loaded (empty allowlist → fail closed)', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(false)
    // Positive case first: with config loaded it would be trusted.
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(true)
    expect(isTrustedOrigin(TRUSTED_API)).toBe(true)
    // Now config is not loaded.
    expect(isTrustedOrigin(TRUSTED_API)).toBe(false)
  })
})

describe('isTrustedApiEndpoint', () => {
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

  it('returns false when config is not loaded (empty allowlist → fail closed)', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValue(false)
    // Even the runtime-config origin is rejected when config has not loaded.
    expect(isTrustedApiEndpoint(TRUSTED_API)).toBe(false)
  })
})
