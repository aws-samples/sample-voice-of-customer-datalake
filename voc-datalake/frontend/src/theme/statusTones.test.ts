/**
 * Status tones (`--ok`, `--warn`, `--danger`, `--info`, `--aim`) and sentiment.
 *
 * - SOURCE: each tone keeps the hue of KiroCrew's Kiro theme
 *   (kirodotdev/kirocrew website/src/index.css `[data-theme="kiro-dark|light"]`);
 *   where KiroCrew's exact value misses AA, VoC moves lightness only. So a tone
 *   lifted from a different KiroCrew theme (dark `--ok` was once `#22c55e`, the
 *   generic `dark` theme's green) fails here.
 * - WCAG 1.4.3: each tone is ≥ 4.5:1 as text on every surface a badge or label
 *   sits on — the page, `--bg-accent`, the card, a hovered row, and its own
 *   `-subtle` tint over the card and over a hovered row.
 * - Sentiment is a status (KiroCrew colours good/bad with these tones), so the
 *   `--sentiment-*` tokens alias them in both themes and never the chart ramp.
 * See docs/kiro-design-system.md › Semantic tones and › Sentiment.
 */
import { describe, expect, it } from 'vitest'
import { THEMES, contrastRatio, hueDistance, hueOf, themeBlockBody, themeHex, themeRgbaOver, type Theme } from '@test/themeTokens'

const MIN_TEXT_CONTRAST = 4.5
const MAX_HUE_DRIFT_DEG = 6

/** KiroCrew's Kiro-theme value of each tone (the hue VoC must keep). */
const KIROCREW: Record<Theme, Record<string, string>> = {
  'kiro-dark': { ok: '#008543', warn: '#e0b94d', danger: '#f94359', info: '#6f9ae0', aim: '#c19aff' },
  'kiro-light': { ok: '#008543', warn: '#a38a00', danger: '#d92544', info: '#285092', aim: '#8041e6' },
}

/** Tones with a stored `-subtle` tint (info's is derived in the Tailwind bridge). */
const TINTED: ReadonlySet<string> = new Set(['ok', 'warn', 'danger', 'aim'])
const TONES = ['ok', 'warn', 'danger', 'info', 'aim'] as const

function surfaces(theme: Theme, tone: string): Record<string, string> {
  const card = themeHex(theme, 'card')
  const hover = themeHex(theme, 'bg-hover')
  const plain = { bg: themeHex(theme, 'bg'), 'bg-accent': themeHex(theme, 'bg-accent'), card, 'bg-hover': hover }
  if (!TINTED.has(tone)) return plain
  return {
    ...plain,
    [`${tone}-subtle on card`]: themeRgbaOver(theme, `${tone}-subtle`, card),
    [`${tone}-subtle on bg-hover`]: themeRgbaOver(theme, `${tone}-subtle`, hover),
  }
}

describe.each(THEMES)('status tones in %s', (theme) => {
  it.each(TONES)(`--%s keeps KiroCrew's Kiro hue`, (tone) => {
    const ours = themeHex(theme, tone)
    expect(hueDistance(hueOf(ours), hueOf(KIROCREW[theme][tone] ?? ours))).toBeLessThanOrEqual(MAX_HUE_DRIFT_DEG)
  })

  it.each(TONES)(`--%s is at least ${MIN_TEXT_CONTRAST}:1 as text on every surface it labels`, (tone) => {
    const fg = themeHex(theme, tone)
    const failing = Object.entries(surfaces(theme, tone))
      .map(([surface, bg]) => ({ surface, ratio: contrastRatio(fg, bg) }))
      .filter(({ ratio }) => ratio < MIN_TEXT_CONTRAST)
      .map(({ surface, ratio }) => `${surface}: ${ratio.toFixed(2)}`)
    expect(failing).toStrictEqual([])
  })

  it.each(TONES)(`--%s-fg is at least ${MIN_TEXT_CONTRAST}:1 on a solid --%s fill`, (tone) => {
    expect(contrastRatio(themeHex(theme, `${tone}-fg`), themeHex(theme, tone))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })
})

describe('the arithmetic (positive control)', () => {
  it("reproduces why KiroCrew's dark --ok was adjusted: #008543 is under 3:1 on its tint over a hovered row", () => {
    const tint = themeRgbaOver('kiro-dark', 'ok-subtle', themeHex('kiro-dark', 'bg-hover'))
    expect(contrastRatio('#008543', tint)).toBeLessThan(3)
  })
})

describe.each(THEMES)('sentiment in %s', (theme) => {
  const block = themeBlockBody(theme)

  it.each([
    ['positive', 'ok'],
    ['negative', 'danger'],
    ['mixed', 'warn'],
    ['neutral', 'muted'],
  ])('--sentiment-%s aliases the --%s status tone', (label, tone) => {
    expect(block).toMatch(new RegExp(`--sentiment-${label}:\\s*var\\(--${tone}\\)`))
  })

  it('never points sentiment at the chart ramp', () => {
    expect(block).not.toMatch(/--sentiment-[a-z]+:\s*var\(--chart-/)
  })
})
