/**
 * The `.tooltip` recipe (components/Tooltip, docs/kiro-design-system.md › Tooltips): inverted in both modes,
 * `--card` text on a `--text-strong` fill, and that pair clears the text floor in every theme (WCAG 1.4.3;
 * High contrast 7:1). It enters with the shared fade token, which the global reduced-motion rule collapses,
 * and it sets no `display`, so a closed popover (or `[hidden]`) stays hidden.
 */
import { describe, expect, it } from 'vitest'
import { THEMES, colorThemeOf, contrastRatio, indexCss, ruleBody, themeHex } from '@test/themeTokens'

const AA_TEXT = 4.5
const AAA_TEXT = 7

const recipe = ruleBody(indexCss, '.tooltip')

describe('.tooltip', () => {
  it('is the inverted bubble: card text on the strong-text fill, 0.75rem (it scales with the text size), at most 16rem wide', () => {
    expect(recipe).toMatch(/@apply [^;]*\bbg-text-strong\b[^;]*\btext-card\b/)
    expect(recipe).toMatch(/\btext-\[0\.75rem\][^;]*\bmax-w-64\b/)
  })

  it('fades in with the shared token (reduced motion is handled globally) and never sets display', () => {
    expect(recipe).toMatch(/\banimate-fade-in\b/)
    expect(recipe).not.toMatch(/\bdisplay\s*:|@apply[^;]*\b(block|inline-block|flex|inline-flex|grid)\b/)
    expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, ::before, ::after \{\s*animation-duration: 0\.01ms !important/)
  })

  it('overrides the popover defaults so it is placed beside its trigger', () => {
    expect(recipe).toMatch(/position: fixed;\s*inset: auto;\s*left: 0;\s*top: 0;/)
    expect(recipe).toMatch(/margin: 0;\s*border: 0;/)
  })

  it.each(THEMES)('reads at the text floor in %s', (theme) => {
    const floor = colorThemeOf(theme) === 'highcontrast' ? AAA_TEXT : AA_TEXT
    expect(contrastRatio(themeHex(theme, 'card'), themeHex(theme, 'text-strong'))).toBeGreaterThanOrEqual(floor)
  })
})
