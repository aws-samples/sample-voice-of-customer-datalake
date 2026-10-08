/**
 * @fileoverview Tests for origin-based auth-header gating (issue #262).
 *
 * Vacuity trap addressed: each "header absent" assertion is paired with a
 * positive case that first proves the header IS attached for a trusted origin
 * — making the absence assertion meaningful rather than trivially true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── module-level mocks ────────────────────────────────────────────────────────

const TRUSTED_API = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1'

vi.mock('../store/configStore', () => import('@test/api-mocks').then(m =>
  m.configStoreMock('https://abc123.execute-api.us-east-1.amazonaws.com/v1', { dateBasis: 'imported' })))
vi.mock('../runtimeConfig', () => import('@test/api-mocks').then(m =>
  m.runtimeConfigMock('https://abc123.execute-api.us-east-1.amazonaws.com/v1')))
vi.mock('../services/auth', () => import('@test/api-mocks').then(m => m.authServiceMock('mock-cognito-id-token')))

// ── imports (after mocks) ─────────────────────────────────────────────────────

import { getAuthHeaders, parseCustomDaysInput, stripTrailingSlashes } from './baseUrl'
import { buildTrustedApiOrigins, isTrustedOrigin } from '../lib/trustedOrigins'
import * as runtimeConfigModule from '../runtimeConfig'
import { authService } from '../services/auth'
import { FOREIGN_HOST_SPELLINGS, useAppOrigin } from '@test/location'

// ── helpers ───────────────────────────────────────────────────────────────────

const TRUSTED_ORIGIN = 'https://abc123.execute-api.us-east-1.amazonaws.com'

// ── tests ─────────────────────────────────────────────────────────────────────

describe('parseCustomDaysInput', () => {
  it('accepts 0 (all time) through 9999, trimmed', () => {
    expect(parseCustomDaysInput('0')).toBe(0)
    expect(parseCustomDaysInput(' 30 ')).toBe(30)
    expect(parseCustomDaysInput('9999')).toBe(9999)
  })

  it('rejects anything that is not a whole number in range', () => {
    for (const input of ['', '10000', '-1', '1.5', '7d', '1e3']) {
      expect(parseCustomDaysInput(input)).toBeNull()
    }
  })
})

describe('stripTrailingSlashes', () => {
  it('removes a single trailing slash', () => {
    expect(stripTrailingSlashes('https://api.example.com/')).toBe('https://api.example.com')
  })

  it('removes multiple trailing slashes', () => {
    expect(stripTrailingSlashes('https://api.example.com///')).toBe('https://api.example.com')
  })

  it('leaves a URL without trailing slash unchanged', () => {
    expect(stripTrailingSlashes('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
})

describe('buildTrustedApiOrigins', () => {
  it('returns the runtime config origin', () => {
    const origins = buildTrustedApiOrigins()
    expect(origins).toContain(TRUSTED_ORIGIN)
  })

  it('returns an empty array when config is not loaded', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(false)
    expect(buildTrustedApiOrigins()).toStrictEqual([])
  })

  it('returns no origin derived from an unparseable runtime config endpoint', () => {
    vi.mocked(runtimeConfigModule.getRuntimeConfig).mockReturnValueOnce({
      apiEndpoint: 'not-a-url',
      cognito: { userPoolId: '', clientId: '', region: 'us-east-1', identityPoolId: '' },
    })
    // Config is "loaded" but the endpoint is unparseable.
    // buildTrustedApiOrigins never adds localhost entries — that logic lives
    // only in isTrustedAbsoluteUrl.  When the endpoint is unparseable the
    // array must be exactly empty.
    const origins = buildTrustedApiOrigins()
    expect(origins).toStrictEqual([])
  })
})

describe('isTrustedOrigin', () => {
  useAppOrigin()

  it('trusts a URL whose origin matches the deployment API', () => {
    expect(isTrustedOrigin(`${TRUSTED_API}/feedback`)).toBe(true)
  })

  it('trusts a relative URL (same-origin by definition)', () => {
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
  })

  it('does NOT trust a URL with a foreign origin', () => {
    expect(isTrustedOrigin('https://attacker.example.com/collect')).toBe(false)
  })

  it('does NOT trust a URL that starts with the same characters (prefix trick)', () => {
    // A host that begins with the same characters is a different origin.
    const prefixTrick = 'https://abc123.execute-api.us-east-1.amazonaws.com.evil.example.com/v1'
    expect(isTrustedOrigin(prefixTrick)).toBe(false)
  })

  it('does NOT trust a URL with userinfo (userinfo trick)', () => {
    // A URL of the form https://user@evil.example.com would have origin
    // 'https://evil.example.com' — verify the parsed origin is used, not a
    // string prefix check.
    const userinfoTrick = `https://abc123.execute-api.us-east-1.amazonaws.com@attacker.example.com/v1`
    expect(isTrustedOrigin(userinfoTrick)).toBe(false)
  })

  it('trusts a path-relative URL, so the foreign-host negatives below cannot pass vacuously', () => {
    expect(isTrustedOrigin('/api/feedback')).toBe(true)
  })

  // A `startsWith('/')` classifier was a bypass — the implementation resolves
  // the URL against window.location.origin and classifies the result.
  it.each(FOREIGN_HOST_SPELLINGS)('does NOT trust %s, which starts with / but resolves to a foreign host', (url) => {
    expect(isTrustedOrigin(url)).toBe(false)
  })

  it('returns false when config is not loaded (empty allowlist)', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(false)
    expect(isTrustedOrigin(TRUSTED_API)).toBe(false)
  })

  it('returns false for a URL with no host (fail closed)', () => {
    expect(isTrustedOrigin('http://')).toBe(false)
  })
})

/** App origin pinned and a configured auth service holding an id token. */
function useSignedInAuth(): void {
  useAppOrigin()

  beforeEach(() => {
    vi.mocked(authService.isConfigured).mockReturnValue(true)
    vi.mocked(authService.getIdToken).mockReturnValue('mock-cognito-id-token')
  })
  afterEach(() => vi.restoreAllMocks())
}

describe('getAuthHeaders — trusted origin', () => {
  useSignedInAuth()

  it('attaches Authorization when a token exists and the origin is trusted', () => {
    const headers = getAuthHeaders(`${TRUSTED_API}/feedback`)
    // Positive assertion first — proves the mechanism fires for a good origin.
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })

  it('attaches Authorization for a relative URL (same-origin, always safe)', () => {
    const headers = getAuthHeaders('/api/feedback')
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })

  /*
   * No "omitting targetUrl does not compile" test here, replacing the old
   * "backward compat" case that pinned the permissive default. A type-level
   * assertion in a test file enforces nothing: the test globs are excluded from
   * every typecheck gate and vitest transpiles without type-checking. The
   * requirement is enforced at runtime instead — see the "empty" / "missing
   * entirely" cases in the untrusted-origin block below.
   */
})

describe('getAuthHeaders — untrusted origin', () => {
  useSignedInAuth()

  it('DOES attach Authorization to the trusted origin (vacuity check)', () => {
    // This positive case proves the token IS present and the header mechanism
    // works — without it, the absence assertion below would pass trivially if
    // the token were simply missing or getAuthHeaders were broken.
    const headers = getAuthHeaders(`${TRUSTED_API}/feedback`)
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })

  it('does NOT attach Authorization to a foreign-origin URL', () => {
    const headers = getAuthHeaders('https://attacker.example.com/collect')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('does NOT attach Authorization even if a token exists (stale persisted value scenario)', () => {
    // Simulate a stale localStorage value: the store has a foreign endpoint,
    // but the header must still not be attached.
    const headers = getAuthHeaders('https://evil.example.com/steal-tokens')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('still includes Content-Type even when Authorization is withheld', () => {
    const headers = getAuthHeaders('https://attacker.example.com/collect')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('does NOT attach Authorization when the URL has no host (fail closed)', () => {
    const headers = getAuthHeaders('http://')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('does NOT attach Authorization to a backslash-separator foreign URL', () => {
    const headers = getAuthHeaders('/\\evil.example.com/collect')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('does NOT attach Authorization when config is not loaded', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(false)
    const headers = getAuthHeaders(TRUSTED_API)
    // With no config loaded, the allowlist is empty → not trusted → no token.
    expect(headers['Authorization']).toBeUndefined()
  })

  /*
   * The next two pin the argument precondition. Both values resolve SAME-ORIGIN
   * if handed to the URL parser (`''` to the current origin, a missing argument
   * via the string `'undefined'`), so without the check they are trusted and the
   * header is attached — which is how the permissive default could return with
   * nothing failing: `targetUrl?: string` plus `isTrustedOrigin(targetUrl ?? '')`
   * compiled and passed all 161 tests here before the precondition existed.
   */
  it('does NOT attach Authorization when the target URL is empty', () => {
    // Vacuity guard: the same call with a real trusted URL does attach it.
    expect(getAuthHeaders(TRUSTED_API)['Authorization']).toBe('mock-cognito-id-token')
    expect(getAuthHeaders('')['Authorization']).toBeUndefined()
  })

  it('does NOT attach Authorization when the target URL is missing entirely', () => {
    // An off-contract call that the signature forbids but that is reachable at
    // runtime (an untyped caller). Method parameters are bivariant, so the
    // holder admits the optional signature without a type assertion.
    const untyped: { getAuthHeaders(targetUrl?: string): Record<string, string> } = { getAuthHeaders }
    expect(untyped.getAuthHeaders()['Authorization']).toBeUndefined()
  })
})
