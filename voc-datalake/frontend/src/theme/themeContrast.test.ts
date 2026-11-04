/**
 * Text and boundary contrast of every theme (WCAG 1.4.3 / 1.4.11), beyond the status
 * tones, chart ramp, control borders and focus ring their own suites pin:
 *  - body, strong and muted text on every surface it is placed on;
 *  - `--accent-text` (links, selected labels) also on its own `--accent-subtle` tint
 *    over the card and over a hovered row; the selected nav label on its fill;
 *  - text on a solid `--accent` button, at rest and hovered.
 * High contrast goes beyond AA: text ≥ 7:1 (AAA), focus ring, control edges and chart
 * steps ≥ 4.5:1. Quick's own tokens (ink buttons, links, focus) are checked too.
 * The ratios come from the hexes in index.css / styles/theme-palettes.css, so retuning
 * a token below its floor fails here; the fix is the palette, never the floor.
 */
import { describe, expect, it } from 'vitest'
import {
  THEMES, colorThemeOf, contrastRatio, mixHex, themeHex, themeRgbaOver, themesOf, type Theme,
} from '@test/themeTokens'

const AA_TEXT = 4.5
const AAA_TEXT = 7
const NON_TEXT = 3
const HIGH_CONTRAST_NON_TEXT = 4.5
/** `--color-info-subtle` in index.css's Tailwind bridge: `--info` 12 % into what is under it. */
const INFO_TINT = 0.12

/** Every surface text or a control is placed on: page, panels, cards, dialogs, a hovered row. */
const SURFACES = ['bg', 'bg-accent', 'bg-elevated', 'bg-hover', 'card', 'panel'] as const

function textFloor(theme: Theme): number {
  return colorThemeOf(theme) === 'highcontrast' ? AAA_TEXT : AA_TEXT
}

/** `surface: ratio` pairs of `fg` below `min`, as readable strings. */
function below(theme: Theme, fg: string, backgrounds: Record<string, string>, min: number): string[] {
  const hex = themeHex(theme, fg)
  return Object.entries(backgrounds)
    .map(([surface, bg]) => ({ surface, ratio: contrastRatio(hex, bg) }))
    .filter(({ ratio }) => ratio < min)
    .map(({ surface, ratio }) => `--${fg} on ${surface}: ${ratio.toFixed(2)}`)
}

function surfaces(theme: Theme, names: readonly string[] = SURFACES): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, themeHex(theme, name)]))
}

/** The surfaces plus `--accent-subtle` laid over the card and over a hovered row. */
function accentTinted(theme: Theme): Record<string, string> {
  return {
    ...surfaces(theme),
    'accent-subtle on card': themeRgbaOver(theme, 'accent-subtle', themeHex(theme, 'card')),
    'accent-subtle on bg-hover': themeRgbaOver(theme, 'accent-subtle', themeHex(theme, 'bg-hover')),
  }
}

describe.each(THEMES)('text in %s', (theme) => {
  const min = textFloor(theme)

  it.each(['text', 'text-strong', 'muted'])(`--%s reaches the text floor on every surface`, (fg) => {
    expect(below(theme, fg, surfaces(theme), min)).toStrictEqual([])
  })

  it('--muted-strong reaches the text floor on every surface, a hovered row included', () => {
    expect(below(theme, 'muted-strong', surfaces(theme), min)).toStrictEqual([])
  })

  it('--accent-text reaches the text floor on every surface and on its own tint', () => {
    expect(below(theme, 'accent-text', accentTinted(theme), min)).toStrictEqual([])
  })

  it('the selected nav label reaches the text floor on its fill', () => {
    expect(below(theme, 'nav-active-text', { 'nav-active-bg': themeHex(theme, 'nav-active-bg') }, min)).toStrictEqual([])
  })

  it('--accent-fg reaches the text floor on a solid --accent fill, at rest and hovered', () => {
    const fills = { accent: themeHex(theme, 'accent'), 'accent-hover': themeHex(theme, 'accent-hover') }
    expect(below(theme, 'accent-fg', fills, min)).toStrictEqual([])
  })
})

describe.each(themesOf('highcontrast'))('high contrast %s goes beyond AA', (theme) => {
  it.each(['ring', 'control-border', 'control-border-hover', 'accent'])(
    `--%s reaches ${HIGH_CONTRAST_NON_TEXT}:1 on every surface`,
    (fg) => {
      expect(below(theme, fg, surfaces(theme), HIGH_CONTRAST_NON_TEXT)).toStrictEqual([])
    },
  )

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(`--chart-%i reaches ${HIGH_CONTRAST_NON_TEXT}:1 on --card`, (step) => {
    expect(below(theme, `chart-${step}`, surfaces(theme, ['card']), HIGH_CONTRAST_NON_TEXT)).toStrictEqual([])
  })

  it.each(['ok', 'warn', 'danger', 'info', 'aim'])(`--%s reaches ${AAA_TEXT}:1 on every surface and on its own tint`, (tone) => {
    expect(below(theme, tone, toneTinted(theme, tone), AAA_TEXT)).toStrictEqual([])
  })
})

/** The surfaces plus a tone's badge tint over the card and a hovered row (info's is the bridge's 12 % mix). */
function toneTinted(theme: Theme, tone: string): Record<string, string> {
  const over = (bg: string): string => (tone === 'info'
    ? mixHex(themeHex(theme, 'info'), themeHex(theme, bg), INFO_TINT)
    : themeRgbaOver(theme, `${tone}-subtle`, themeHex(theme, bg)))
  return { ...surfaces(theme), [`${tone} tint on card`]: over('card'), [`${tone} tint on bg-hover`]: over('bg-hover') }
}

describe.each(themesOf('quick'))('Quick tokens in %s', (theme) => {
  it.each(['ink', 'ink-hover'])('--on-ink reaches 4.5:1 on a --%s button', (fill) => {
    expect(below(theme, 'on-ink', { [fill]: themeHex(theme, fill) }, AA_TEXT)).toStrictEqual([])
  })

  it(`the --ink button edge reaches ${NON_TEXT}:1 on every surface`, () => {
    expect(below(theme, 'ink', surfaces(theme), NON_TEXT)).toStrictEqual([])
  })

  it('--link reaches 4.5:1 on every surface and on the accent tint', () => {
    expect(below(theme, 'link', accentTinted(theme), AA_TEXT)).toStrictEqual([])
  })

  it(`--focus reaches ${NON_TEXT}:1 on every surface, and --ring is --focus`, () => {
    expect(below(theme, 'focus', surfaces(theme), NON_TEXT)).toStrictEqual([])
    expect(themeHex(theme, 'ring')).toBe(themeHex(theme, 'focus'))
  })
})
