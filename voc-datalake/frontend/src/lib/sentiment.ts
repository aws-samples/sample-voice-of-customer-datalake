/**
 * @fileoverview Shared sentiment color utilities.
 *
 * Two families, on purpose:
 * - `sentimentHexColor` returns literal hex for PRINT/PDF renderers
 *   (`*PDFContent.tsx`). Those render into a separate print window that does
 *   not carry the app stylesheet, so CSS variables would not resolve there,
 *   and paper output stays light regardless of the on-screen theme.
 * - `sentimentCssVar` is for on-screen UI: it resolves through the theme
 *   tokens in `src/index.css`, so it flips with Kiro dark/light.
 *
 * @module lib/sentiment
 */

/**
 * Lookup with a neutral fallback. A `Map` (not an object literal) so an
 * inherited key such as a label of "constructor" can never resolve.
 */
function lookup(map: ReadonlyMap<string, string>, label: string | undefined, fallback: string): string {
  return map.get(label ?? '') ?? fallback
}

const NEUTRAL_HEX = '#5e5966'

/** Print/PDF only — see the module note. Do not use for on-screen UI. */
const HEX_COLORS: ReadonlyMap<string, string> = new Map([
  ['positive', '#007038'],
  ['negative', '#bd1c3a'],
  ['neutral', NEUTRAL_HEX],
  ['mixed', '#6b5900'],
])

/** Returns hex color string for a sentiment label. Print/PDF renderers only. */
export function sentimentHexColor(label: string | undefined): string {
  return lookup(HEX_COLORS, label, NEUTRAL_HEX)
}

const NEUTRAL_CSS_VAR = 'var(--sentiment-neutral)'

const CSS_VARS: ReadonlyMap<string, string> = new Map([
  ['positive', 'var(--sentiment-positive)'],
  ['negative', 'var(--sentiment-negative)'],
  ['neutral', NEUTRAL_CSS_VAR],
  ['mixed', 'var(--sentiment-mixed)'],
])

/**
 * Returns a theme-aware CSS colour (`var(--sentiment-*)`) for a sentiment
 * label, for inline styles and SVG/Recharts props in on-screen UI.
 */
export function sentimentCssVar(label: string | undefined): string {
  return lookup(CSS_VARS, label, NEUTRAL_CSS_VAR)
}

/** Returns lowercase sentiment label from a numeric score (-1 to 1 scale). */
export function sentimentLabelFromScore(score: number): 'positive' | 'negative' | 'neutral' {
  if (score > 0) return 'positive'
  if (score < -0.3) return 'negative'
  return 'neutral'
}
