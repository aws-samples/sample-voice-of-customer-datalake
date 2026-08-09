/**
 * Shared trusted-origin allowlist logic.
 *
 * Extracted here so that both `api/baseUrl.ts` and `store/configStore.ts` can
 * import the same implementation without creating a circular dependency (baseUrl
 * imports configStore for `getBaseUrl`, so configStore cannot import baseUrl).
 *
 * This module imports only from `runtimeConfig` — a true leaf with no
 * dependencies on either baseUrl or configStore.
 */
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'

/**
 * Build the allowlist of trusted API origins.
 *
 * The authoritative origin is always the one from the deployment's runtime
 * config (config.json). In development, any `localhost` or `127.0.0.1` hostname
 * is also trusted so developers can run the mock server on any port.
 *
 * Returns an empty array when the runtime config is not loaded yet — the
 * caller treats an empty allowlist as "no origin is trusted", which is the
 * safe outcome.
 */
export function buildTrustedApiOrigins(): string[] {
  if (!isConfigLoaded()) return []

  const cfg = getRuntimeConfig()
  const origins: string[] = []

  try {
    const url = new URL(cfg.apiEndpoint)
    origins.push(url.origin)
  } catch {
    // Unparseable runtime config endpoint: no trusted origin can be derived.
    // Fail closed — callers see an empty allowlist and withhold the token.
  }

  return origins
}

/**
 * Return true when `requestUrl` originates from a trusted host.
 *
 * Trusts:
 *   - Relative URLs (no host) — always same-origin requests.
 *   - Protocol-relative URLs — resolved against `window.location.origin` so
 *     `//evil.example.com/...` is treated as cross-origin, not same-origin.
 *   - Absolute URLs whose origin is in the runtime-config allowlist.
 *   - In dev builds: any URL whose hostname is `localhost` or `127.0.0.1`.
 *
 * Parsing failures are treated as unsafe (return false).
 */
export function isTrustedOrigin(requestUrl: string): boolean {
  // Protocol-relative and path-relative URLs: resolve against current origin so
  // //evil.example.com is not treated as a same-origin path.
  if (requestUrl.startsWith('/')) {
    // Path-relative (single slash) → same-origin, always safe.
    if (!requestUrl.startsWith('//')) return true

    // Protocol-relative (double slash) → resolve to determine real origin.
    try {
      const parsed = new URL(requestUrl, window.location.origin)
      return isTrustedAbsoluteUrl(parsed)
    } catch {
      return false
    }
  }

  try {
    const parsed = new URL(requestUrl)
    return isTrustedAbsoluteUrl(parsed)
  } catch {
    return false
  }
}

/** Check a fully-parsed URL against the trusted-origin allowlist. */
function isTrustedAbsoluteUrl(parsed: URL): boolean {
  // In dev builds, any localhost / loopback address is trusted regardless of port.
  if (import.meta.env.DEV) {
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return true
    }
  }

  const trustedOrigins = buildTrustedApiOrigins()
  return trustedOrigins.includes(parsed.origin)
}

/**
 * Return true when `endpoint` is safe to persist as the API endpoint.
 *
 * Empty string is always safe (it is the "not yet configured" sentinel that
 * falls back to the `/api` relative-URL path in `getBaseUrl()`).
 * Any non-empty value must resolve to a trusted host.
 * Unparseable values are treated as unsafe (fail closed).
 */
export function isTrustedApiEndpoint(endpoint: string): boolean {
  if (endpoint === '') return true
  try {
    const url = new URL(endpoint)
    // In dev, any localhost port is allowed.
    if (import.meta.env.DEV) {
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return true
      }
    }
    const origins = buildTrustedApiOrigins()
    // Empty allowlist (config not yet loaded) → fail closed.
    return origins.length > 0 && origins.includes(url.origin)
  } catch {
    return false
  }
}
