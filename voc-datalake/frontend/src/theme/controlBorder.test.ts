/**
 * Form-control boundaries (design audit D-13, WCAG 1.4.11 Non-text Contrast).
 *
 * The edge of an input, select, textarea, checkbox or radio is what tells a
 * sighted user "this is a field". On production it was `--border`: 1.28:1 on the
 * card in dark and 1.27:1 in light (797 hits on 36 screens), and no existing Kiro
 * token reached 3:1 (`--border-hover` 2.43 / 2.56:1). `--control-border` (and its
 * hover step) is that boundary, and every shared control recipe draws with it.
 *
 * The ratios are computed here from the hexes in index.css, so retuning a token
 * below 3:1 on any surface a control can sit on fails this suite.
 */
import { describe, expect, it } from 'vitest'
import { appTsxLines, isCommentLine, stringLiterals } from '@test/appSources'
import { THEMES, contrastRatio as contrast, indexCss as css, themeHex as token } from '@test/themeTokens'

const MIN_NON_TEXT_CONTRAST = 3

/** Every surface a control is placed on: the page, panels, cards, dialogs and a hovered row. */
const SURFACES = ['bg', 'bg-accent', 'bg-elevated', 'bg-hover', 'card', 'panel', 'panel-strong'] as const

/** The body of the first rule whose selector list starts with `selector`. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no rule for ${selector}`)
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
}

describe('the contrast arithmetic (positive control)', () => {
  it('reproduces the audit: --border on the dark card is 1.28:1, on the light card 1.27:1', () => {
    expect(contrast(token('kiro-dark', 'border'), token('kiro-dark', 'card')).toFixed(2)).toBe('1.28')
    expect(contrast(token('kiro-light', 'border'), token('kiro-light', 'card')).toFixed(2)).toBe('1.27')
    expect(contrast('#000000', '#ffffff')).toBe(21)
  })
})

describe.each(THEMES)('--control-border in %s', (theme) => {
  it.each(['control-border', 'control-border-hover'])('--%s reaches 3:1 against every surface', (name) => {
    const ratios = Object.fromEntries(SURFACES.map((surface) => [
      surface, Number(contrast(token(theme, name), token(theme, surface)).toFixed(2)),
    ]))
    const below = Object.entries(ratios).filter(([, ratio]) => ratio < MIN_NON_TEXT_CONTRAST)
    expect(below, JSON.stringify(ratios)).toStrictEqual([])
  })

  it('the hover step is at least as strong as the resting border', () => {
    const resting = contrast(token(theme, 'control-border'), token(theme, 'bg-elevated'))
    const hovered = contrast(token(theme, 'control-border-hover'), token(theme, 'bg-elevated'))
    expect(hovered).toBeGreaterThanOrEqual(resting)
  })

  it('a checked box or radio (filled with --accent) still reaches 3:1 against every surface', () => {
    const below = SURFACES.filter((surface) => contrast(token(theme, 'accent'), token(theme, surface)) < MIN_NON_TEXT_CONTRAST)
    expect(below).toStrictEqual([])
  })
})

describe('the shared recipes draw their boundary with the token', () => {
  it.each(['.input', '.select'])('%s uses border-control-border at rest and on hover, never --border', (selector) => {
    const body = ruleBody(selector)
    expect(body).toContain('border-control-border')
    expect(body).toContain('hover:border-control-border-hover')
    expect(body).not.toMatch(/\bborder-border\b|hover:border-border-strong/)
  })

  it('every checkbox and radio is drawn with --control-border (the UA box ignores CSS borders)', () => {
    const body = ruleBody('input[type="checkbox"], input[type="radio"]')
    expect(body).toContain('appearance: none')
    expect(body).toContain('border: 1px solid var(--control-border)')
  })

  it('the Tailwind bridge exposes the tokens as utilities', () => {
    expect(css).toContain('--color-control-border: var(--control-border);')
    expect(css).toContain('--color-control-border-hover: var(--control-border-hover);')
  })
})

describe('no control paints the weak border back on', () => {
  /** A utility that would override the recipe's boundary with a sub-3:1 colour. */
  const WEAK_BORDER = /^(?:hover:|focus:)?border-(?:border|border-strong|border-hover|accent\/\d+|aim\/\d+|danger\/\d+)$/

  /** Class lists on lines that style a control: the `.input`/`.select` recipe or a checkbox/radio. */
  function controlClassLists(): Array<{ at: string; classes: string[] }> {
    const lines = appTsxLines()
    return lines.flatMap(({ at, line }, i) => {
      if (isCommentLine(line)) return []
      const isBox = /type="(?:checkbox|radio)"/.test(lines.slice(Math.max(0, i - 6), i + 1).map((l) => l.line).join('\n'))
      return stringLiterals(line).map((literal) => literal.split(/\s+/).filter(Boolean))
        .filter((classes) => classes.includes('input') || classes.includes('select') || (isBox && classes.includes('accent-accent')))
        .map((classes) => ({ at, classes }))
    })
  }

  it('finds the controls it guards (positive control)', () => {
    expect(controlClassLists().length).toBeGreaterThan(100)
  })

  it('no input/select/checkbox/radio class list carries a sub-3:1 border colour', () => {
    const offenders = controlClassLists()
      .filter(({ classes }) => classes.some((c) => WEAK_BORDER.test(c)))
      .map(({ at, classes }) => `${at}: ${classes.filter((c) => WEAK_BORDER.test(c)).join(' ')}`)
    expect(offenders).toStrictEqual([])
  })
})
