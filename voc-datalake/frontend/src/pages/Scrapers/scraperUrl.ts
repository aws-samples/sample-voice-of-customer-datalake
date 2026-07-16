/**
 * Split from ScraperCard so the component file only exports components
 * (react-refresh/only-export-components — mixed exports disable Fast
 * Refresh for the module).
 */

/**
 * base_url as runtime data actually delivers it (absent on the mock
 * server and possibly on older configs, despite the declared type),
 * normalized to a trimmed string — '' meaning "not configured". Single
 * owner of that check so the label and the Run-button gate can't drift.
 */
export function normalizedBaseUrl(baseUrl: string | undefined): string {
  return typeof baseUrl === 'string' ? baseUrl.trim() : ''
}

/**
 * Display label for a scraper's target site. Never throws: a render-time
 * TypeError here took down the whole /scrapers route (issue #167).
 * Unparseable-but-present values fall back to the raw string so the user
 * can still see what is configured.
 */
export function scraperDomainLabel(baseUrl: string | undefined, notConfigured: string): string {
  const raw = normalizedBaseUrl(baseUrl)
  if (raw === '') return notConfigured
  try {
    // mailto:/file: URLs parse successfully with an EMPTY hostname —
    // fall back to the raw value rather than rendering an empty label.
    const host = new URL(raw).hostname
    return host !== '' ? host : raw
  } catch {
    return raw
  }
}
