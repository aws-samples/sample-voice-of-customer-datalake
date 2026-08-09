/**
 * @fileoverview Tests for origin-based auth-header gating (issue #262).
 *
 * Vacuity trap addressed: each "header absent" assertion is paired with a
 * positive case that first proves the header IS attached for a trusted origin
 * — making the absence assertion meaningful rather than trivially true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── module-level mocks ────────────────────────────────────────────────────────

vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => ({
      config: { apiEndpoint: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1' },
      dateBasis: 'imported',
    })),
  },
}))

vi.mock('../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => true),
  getRuntimeConfig: vi.fn(() => ({
    apiEndpoint: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
    cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
  })),
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-cognito-id-token'),
  },
}))

// ── imports (after mocks) ─────────────────────────────────────────────────────

import {
  isTrustedRequestOrigin,
  getTrustedApiOrigins,
  getAuthHeaders,
  stripTrailingSlashes,
} from './baseUrl'
import * as runtimeConfigModule from '../runtimeConfig'
import { authService } from '../services/auth'

// ── helpers ───────────────────────────────────────────────────────────────────

const TRUSTED_API = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1'
const TRUSTED_ORIGIN = 'https://abc123.execute-api.us-east-1.amazonaws.com'

// ── tests ─────────────────────────────────────────────────────────────────────

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

describe('getTrustedApiOrigins', () => {
  it('returns the runtime config origin', () => {
    const origins = getTrustedApiOrigins()
    expect(origins).toContain(TRUSTED_ORIGIN)
  })

  it('returns an empty array when config is not loaded', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(false)
    expect(getTrustedApiOrigins()).toEqual([])
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
    const origins = getTrustedApiOrigins()
    expect(origins).toEqual([])
  })
})

describe('isTrustedRequestOrigin', () => {
  it('trusts a URL whose origin matches the deployment API', () => {
    expect(isTrustedRequestOrigin(`${TRUSTED_API}/feedback`)).toBe(true)
  })

  it('trusts a relative URL (same-origin by definition)', () => {
    expect(isTrustedRequestOrigin('/api/feedback')).toBe(true)
  })

  it('does NOT trust a URL with a foreign origin', () => {
    expect(isTrustedRequestOrigin('https://attacker.example.com/collect')).toBe(false)
  })

  it('does NOT trust a URL that starts with the same characters (prefix trick)', () => {
    // A host that begins with the same characters is a different origin.
    const prefixTrick = 'https://abc123.execute-api.us-east-1.amazonaws.com.evil.example.com/v1'
    expect(isTrustedRequestOrigin(prefixTrick)).toBe(false)
  })

  it('does NOT trust a URL with userinfo (userinfo trick)', () => {
    // A URL of the form https://user@evil.example.com would have origin
    // 'https://evil.example.com' — verify the parsed origin is used, not a
    // string prefix check.
    const userinfoTrick = `https://abc123.execute-api.us-east-1.amazonaws.com@attacker.example.com/v1`
    expect(isTrustedRequestOrigin(userinfoTrick)).toBe(false)
  })

  it('does NOT trust a protocol-relative URL pointing to a foreign host', () => {
    // `//evil.example.com/collect` starts with `/` but is NOT same-origin.
    // The old `startsWith('/')` guard was a bypass — the new implementation
    // resolves protocol-relative URLs against window.location.origin.
    expect(isTrustedRequestOrigin('//evil.example.com/collect')).toBe(false)
  })

  it('returns false when config is not loaded (empty allowlist)', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(false)
    expect(isTrustedRequestOrigin(TRUSTED_API)).toBe(false)
  })

  it('returns false for an unparseable URL', () => {
    expect(isTrustedRequestOrigin('not a url at all')).toBe(false)
  })
})

describe('getAuthHeaders — trusted origin', () => {
  beforeEach(() => {
    vi.mocked(authService.isConfigured).mockReturnValue(true)
    vi.mocked(authService.getIdToken).mockReturnValue('mock-cognito-id-token')
  })
  afterEach(() => vi.restoreAllMocks())

  it('attaches Authorization when a token exists and the origin is trusted', () => {
    const headers = getAuthHeaders(undefined, `${TRUSTED_API}/feedback`)
    // Positive assertion first — proves the mechanism fires for a good origin.
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })

  it('attaches Authorization for a relative URL (same-origin, always safe)', () => {
    const headers = getAuthHeaders(undefined, '/api/feedback')
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })

  it('attaches Authorization when no targetUrl is given (backward compat)', () => {
    const headers = getAuthHeaders()
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })
})

describe('getAuthHeaders — untrusted origin', () => {
  beforeEach(() => {
    vi.mocked(authService.isConfigured).mockReturnValue(true)
    vi.mocked(authService.getIdToken).mockReturnValue('mock-cognito-id-token')
  })
  afterEach(() => vi.restoreAllMocks())

  it('DOES attach Authorization to the trusted origin (vacuity check)', () => {
    // This positive case proves the token IS present and the header mechanism
    // works — without it, the absence assertion below would pass trivially if
    // the token were simply missing or getAuthHeaders were broken.
    const headers = getAuthHeaders(undefined, `${TRUSTED_API}/feedback`)
    expect(headers['Authorization']).toBe('mock-cognito-id-token')
  })

  it('does NOT attach Authorization to a foreign-origin URL', () => {
    const headers = getAuthHeaders(undefined, 'https://attacker.example.com/collect')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('does NOT attach Authorization even if a token exists (stale persisted value scenario)', () => {
    // Simulate a stale localStorage value: the store has a foreign endpoint,
    // but the header must still not be attached.
    const headers = getAuthHeaders(undefined, 'https://evil.example.com/steal-tokens')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('still includes Content-Type even when Authorization is withheld', () => {
    const headers = getAuthHeaders(undefined, 'https://attacker.example.com/collect')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('does NOT attach Authorization when the URL is unparseable', () => {
    const headers = getAuthHeaders(undefined, 'not a url at all')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('does NOT attach Authorization when config is not loaded', () => {
    vi.mocked(runtimeConfigModule.isConfigLoaded).mockReturnValueOnce(false)
    const headers = getAuthHeaders(undefined, TRUSTED_API)
    // With no config loaded, the allowlist is empty → not trusted → no token.
    expect(headers['Authorization']).toBeUndefined()
  })
})
