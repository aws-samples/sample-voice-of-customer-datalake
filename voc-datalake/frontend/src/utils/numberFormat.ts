/**
 * @fileoverview Locale-aware numbers for the analytics pages: one spelling per
 * locale, from `Intl` ("92%" in English, "92 %" in German and French,
 * "17.066" in German) instead of hand-built `${n}%` / `toLocaleString()`
 * without a locale (which follows the BROWSER, not the app language).
 * @module utils/numberFormat
 */

/** A 0–100 percentage in the locale's percent spelling; non-finite values read as 0. */
export function formatPercent(pct: number, locale: string, maximumFractionDigits = 0): string {
  const value = Number.isFinite(pct) ? pct / 100 : 0
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits }).format(value)
}

/** A count with the locale's grouping ("17,066" / "17.066"); non-finite values read as 0. */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Number.isFinite(value) ? value : 0)
}

/** A number with exactly `digits` decimals and the locale's decimal mark ("1.70" / "1,70"); non-finite reads as 0. */
export function formatDecimal(value: number, locale: string, digits: number): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(Number.isFinite(value) ? value : 0)
}
