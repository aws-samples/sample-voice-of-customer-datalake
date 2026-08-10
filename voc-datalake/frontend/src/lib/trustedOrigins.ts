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
 * config (config.json). `localhost` / `127.0.0.1` are NOT in the returned
 * array — localhost trust is enforced inside {@link isTrustedAbsoluteUrl} via
 * a hostname comparison, not via the origins array. Reading this array and
 * looking for a localhost entry will never find one.
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
 * Return true when `requestUrl` resolves to a trusted host.
 *
 * A "same-origin reference" is decided by *resolution*, never by the shape of
 * the string: `requestUrl` is resolved against `window.location.origin` using
 * the same WHATWG URL parser `fetch` uses, and the resulting origin is what
 * gets classified. Classifying on string prefixes is unsound, because several
 * unrelated spellings look path-relative yet resolve to a foreign host:
 *
 *   `//evil.example.com/x`   → protocol-relative
 *   `/\evil.example.com/x`   → backslash is a path separator for http(s)
 *   `/\/evil.example.com`    → mixed separators
 *
 * All three resolve to `https://evil.example.com`, so resolving first closes
 * the whole class instead of one spelling at a time.
 *
 * Trusts:
 *   - URLs that resolve to `window.location.origin` — true same-origin, which
 *     is where genuinely path-relative inputs such as `/api/...` land.
 *   - URLs whose resolved origin is in the runtime-config allowlist.
 *   - In dev builds: any URL whose hostname is `localhost` or `127.0.0.1`.
 *
 * Parsing failures are treated as unsafe (return false).
 */
export function isTrustedOrigin(requestUrl: string): boolean {
  const currentOrigin = getCurrentOrigin()

  try {
    // With no usable base, only a fully absolute URL can be classified; a
    // relative one throws here and is refused, which is the safe outcome.
    const parsed =
      currentOrigin === null ? new URL(requestUrl) : new URL(requestUrl, currentOrigin)

    // Genuine same-origin (where path-relative inputs resolve) is always safe.
    if (currentOrigin !== null && parsed.origin === currentOrigin) return true

    return isTrustedAbsoluteUrl(parsed)
  } catch {
    return false
  }
}

/**
 * Read the document's own origin, or `null` when it is unavailable.
 *
 * Resolution needs a base URL, and `window.location` is not guaranteed to
 * supply one: a non-browser host (SSR, a worker) has no `window` at all. `null`
 * makes that case explicit so the caller can restrict itself to absolute URLs
 * instead of resolving against `undefined`.
 */
function getCurrentOrigin(): string | null {
  const origin: unknown = globalThis.window?.location?.origin
  return typeof origin === 'string' && origin !== '' ? origin : null
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
 * Empty string is always safe: it is the "not yet configured" sentinel that
 * `getBaseUrl()` maps to the same-origin `/api` path.
 * Any non-empty value must be an absolute URL resolving to a trusted host.
 *
 * Note the deliberate asymmetry with {@link isTrustedOrigin}: this function
 * parses `endpoint` with no base, so `''` is the *only* accepted same-origin
 * spelling. Other relative forms (`'/api'`, `'api/v1'`) fail closed even
 * though `isTrustedOrigin('/api')` is `true`, because a stored endpoint is a
 * deployment configuration value rather than a request URL and there is no
 * reason for it to be relative. Pinned by test:
 * "returns false for a path-relative endpoint".
 *
 * The base-less parse is the *only* intended difference from
 * {@link isTrustedOrigin}: the classification itself is delegated to
 * {@link isTrustedAbsoluteUrl}, so what "trusted" means is decided in exactly
 * one place. Re-implementing the localhost/allowlist rules here would let the
 * two decisions drift — the same defect that motivated extracting this module.
 *
 * Unparseable values are treated as unsafe (fail closed).
 */
export function isTrustedApiEndpoint(endpoint: string): boolean {
  if (endpoint === '') return true
  try {
    // Parsed with no base: relative forms throw and fail closed by design.
    return isTrustedAbsoluteUrl(new URL(endpoint))
  } catch {
    return false
  }
}
