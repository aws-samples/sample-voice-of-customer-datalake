/**
 * @fileoverview Kiro Light hex values for surfaces that cannot read CSS variables.
 *
 * App UI styles with semantic tokens (`bg-accent`, `text-muted`, ...) and never
 * with literals (docs/kiro-design-system.md, rule 1). Two surfaces cannot:
 *
 * - PDF / print exports, rendered off-screen with inline styles into a document
 *   that does not carry the app's stylesheet, and always printed light;
 * - the embeddable feedback-form widget's default theme, which is DATA stored on
 *   the form and rendered on the customer's own page.
 *
 * Both take their colours from here, so they stay on the Kiro Light palette
 * (the values in the design doc's Colour tables) instead of each file inventing
 * its own blues and purples (E2E F6/F12). `printPalette.test.ts` pins every value
 * to the `[data-theme="kiro-light"]` block of index.css, so they cannot drift.
 *
 * @module theme/printPalette
 */

export const KIRO_LIGHT_HEX = {
  /** `--accent`: primary buttons, active indicators. White text on it: 4.64:1. */
  accent: '#8e48ff',
  /** `--accent-text`: accent-coloured text and bars on white (6.58:1). */
  accentText: '#723acc',
  /** `--aim` (Kiro Light): AI / secondary highlight (6.47:1 on white). */
  aim: '#7337d6',
  /** `--text-strong`: headings and values. */
  textStrong: '#19161d',
  /** `--text`: body text. */
  text: '#4a464f',
  /** `--muted`: secondary text and meta. */
  muted: '#5e5966',
  /** `--bg` / `--card`: page and card background. */
  bg: '#ffffff',
  /** `--bg-accent`: subtle sections, table headers, callouts. */
  bgAccent: '#f5f5f5',
  /** `--border`: default 1px border. */
  border: '#e4e4e7',
  /** Semantic tones' Kiro Light foregrounds, each ≥ 5.99:1 with white. */
  ok: '#007038',
  warn: '#6b5900',
  danger: '#bd1c3a',
  info: '#285092',
} as const

