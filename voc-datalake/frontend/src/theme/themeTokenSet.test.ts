/**
 * Every colour theme is a complete palette (docs/kiro-design-system.md → Themes).
 *
 * A component paints with semantic tokens only, so a theme block that forgot one
 * (`--control-border`, a `--chart-*` step, `--nav-active-*`) would silently fall back
 * to the Kiro value under it and mix two palettes on one screen. Each block declares
 * exactly the token set of the Kiro block of the same mode; a theme may add its own
 * tokens only when listed below (Quick's ink and link tokens, used by its component look).
 */
import { describe, expect, it } from 'vitest'
import {
  THEMES, colorThemeOf, kiroThemeOf, modeOf, paletteCss, themeBlockBody, themeHex, themeTokenNames, withoutComments,
} from '@test/themeTokens'
import { COLOR_THEME_IDS, type ColorThemeId } from './themeCatalog'

/** Tokens a theme declares on top of the Kiro set, for its own component recipes. */
const EXTRA_TOKENS: Partial<Record<ColorThemeId, readonly string[]>> = {
  quick: ['focus', 'ink', 'ink-hover', 'link', 'on-ink'],
}

const NON_KIRO = THEMES.filter((theme) => colorThemeOf(theme) !== 'kiro')

describe('the theme list', () => {
  it('covers every colour theme in both modes', () => {
    expect(THEMES).toHaveLength(COLOR_THEME_IDS.length * 2)
    expect(NON_KIRO).toHaveLength(THEMES.length - 2)
  })
})

describe.each(THEMES)('%s', (theme) => {
  const mode = modeOf(theme)
  const reference = themeTokenNames(kiroThemeOf(mode))

  it(`declares exactly the ${kiroThemeOf(mode)} token set (plus its listed extras)`, () => {
    const extras = EXTRA_TOKENS[colorThemeOf(theme)] ?? []
    expect(themeTokenNames(theme)).toStrictEqual([...reference, ...extras].sort((a, b) => a.localeCompare(b)))
  })

  it('declares no token twice', () => {
    const names = themeTokenNames(theme)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toStrictEqual([])
  })

  it(`sets color-scheme: ${mode}`, () => {
    expect(themeBlockBody(theme)).toMatch(new RegExp(`color-scheme:\\s*${mode}\\s*;`))
  })

  it('draws the select chevron in its own --muted (a data URI cannot read the variable)', () => {
    const stroke = /--select-chevron:[^;]*stroke='%23([0-9a-f]{6})'/.exec(themeBlockBody(theme))?.[1]
    expect(`#${stroke ?? ''}`).toBe(themeHex(theme, 'muted'))
  })

  it('never uses `none` as a shadow (it is invalid inside the .card shadow list)', () => {
    expect(themeBlockBody(theme)).not.toMatch(/--shadow-[a-z]+:\s*none/)
  })
})

describe('the cascade', () => {
  // theme-palettes.css is imported at the top of index.css, so its blocks come BEFORE
  // index.css's `:root, [data-theme="kiro-dark"]` fallback; a bare attribute selector
  // would tie on specificity and lose to that later `:root`.
  it.each(NON_KIRO)('%s is keyed `:root[data-theme=…]`, above the Kiro `:root` fallback', (theme) => {
    expect(paletteCss).toContain(`:root[data-theme="${theme}"] {`)
  })

  it('theme-palettes.css declares no Kiro block of its own', () => {
    expect(withoutComments(paletteCss)).not.toMatch(/data-theme="kiro-/)
  })
})
