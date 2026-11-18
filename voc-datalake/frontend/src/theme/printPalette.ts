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
 * The widget forms' default theme (pages/FeedbackForms/model/formsV2.ts
 * DEFAULT_THEME) takes its colours from here; the print files inline the same
 * Kiro Light hexes (the values in the design doc's Colour tables) instead of
 * each file inventing its own blues and purples (E2E F6/F12).
 * `printPalette.test.ts` pins every value below, and every hex a print file uses,
 * to the `[data-theme="kiro-light"]` block of index.css, so they cannot drift.
 *
 * @module theme/printPalette
 */

export const KIRO_LIGHT_HEX = {
  /** `--accent`: primary buttons, active indicators. White text on it: 4.64:1. */
  accent: '#8e48ff',
  /** `--text-strong`: headings and values. */
  textStrong: '#19161d',
  /** `--bg` / `--card`: page and card background. */
  bg: '#ffffff',
} as const

