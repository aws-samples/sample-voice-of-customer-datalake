/**
 * @fileoverview Small display helpers shared by the Radar page sections.
 * @module pages/Radar/radarFormat
 */
import { formatPercent } from '../../utils/numberFormat'

/**
 * The windows the page offers, in days: the header's own presets (7, 30, 90 days)
 * plus a year, the longest the Radar API reads (`MAX_DAYS` 365 in radar_handler.py).
 */
export const RADAR_WINDOWS = [7, 30, 90, 365] as const
export const DEFAULT_RADAR_WINDOW: (typeof RADAR_WINDOWS)[number] = 90

/** Administration → Sources → Radar: the brands tracked, how Radar works, the scan settings. */
export const RADAR_SETUP_PATH = '/admin?tab=sources&section=radar'

/** A 0-1 share as a whole percentage in the locale ("62%", de "62 %"); empty when unknown. */
export function percent(share: number | null, locale = 'en'): string {
  return share === null ? '' : formatPercent(Math.round(share * 100), locale)
}

/** A URL's host for a citation chip, or the URL itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return url
  }
}

/** The host with its path ("example-air.example/changelog/2026-06"): what to call a page that has no title of its own. */
function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname.replace(/^www\./u, '')}${trimTrailingSlashes(parsed.pathname)}`
  } catch {
    return url
  }
}

/**
 * A citation's link text, said once: the page title when it names the page, else the host with
 * its path. Never "example-air.example (example-air.example)": a title that is only the host (with or without
 * `www.`) is no title, and the host is not repeated after a title that already holds it.
 */
export function citationLabel(url: string, title: string): string {
  const host = hostOf(url).toLowerCase()
  const named = title.trim().replace(/^www\./iu, '')
  if (named === '' || named.toLowerCase() === host) return hostAndPath(url)
  return named.toLowerCase().includes(host) ? named : `${named} · ${hostOf(url)}`
}

/** One citation of a release: where it links and what it is called. */
interface Citation {
  readonly url: string
  readonly title: string
}

/** `path` without its trailing slashes (a loop, not a `/\/+$/` regex: linear on any input). */
function trimTrailingSlashes(path: string): string {
  const slashes = Array.from(path).reverse().findIndex((ch) => ch !== '/')
  if (slashes === -1) return ''
  return path.slice(0, path.length - slashes)
}

/** The address a citation is the same page as: no scheme, no `www.`, no trailing slash, case-folded host. */
function citationKey(url: string): string {
  try {
    const parsed = new URL(url)
    const path = trimTrailingSlashes(parsed.pathname)
    return `${parsed.hostname.replace(/^www\./u, '').toLowerCase()}${path}${parsed.search}`
  } catch {
    return url
  }
}

/** `url` over https when it was given over http (every citation host serves https). */
function preferHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}

/**
 * A release's citations, ONE per page: the same article cited over http and https,
 * with and without `www.` or a trailing slash, is listed once, linked over https,
 * under the first title it came with (else its host).
 */
export function uniqueCitations(urls: readonly string[], titles: readonly string[]): Citation[] {
  const seen = new Map<string, Citation>()
  urls.forEach((url, index) => {
    const key = citationKey(url)
    if (seen.has(key)) return
    const link = preferHttps(url)
    seen.set(key, { url: link, title: titles.at(index) ?? hostOf(link) })
  })
  return [...seen.values()]
}
