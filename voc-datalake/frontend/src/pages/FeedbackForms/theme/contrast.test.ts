/**
 * The theme's contrast rules (audit §2.3; the same in lambda/shared/form_theme.py): the WCAG ratio, the button label,
 * the derived option edge, the four pairs with their levels, the palettes that can be shown, and the OKLCH-lightness
 * suggestions (the audit's worked examples).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, VOC_DARK_PALETTE, VOC_LIGHT_PALETTE } from '../model/formsV2'
import {
  contrastRatio, isEditorHex, optionEdge, pairSuggestions, palettePairs, readableOn, shownPalettes, suggestColours,
  unreadablePalettes,
} from './contrast'

const onWhite = (colour: string) => contrastRatio(colour, '#ffffff')

describe('contrastRatio', () => {
  it.each([
    ['#19161d', '#ffffff', 17.89], ['#ffffff', '#8e48ff', 4.64], ['#f2f1f4', '#19161d', 15.9], ['#bd8fff', '#19161d', 7.27],
    ['#9ca3af', '#fff', 2.54], ['#000', '#000', 1],
  ])('%s on %s is %s:1', (foreground, background, ratio) => {
    expect(contrastRatio(foreground, background)).toBeCloseTo(ratio, 2)
  })

  it('judges an old translucent colour as the widget draws it, its alpha dropped (the shared vector)', () => {
    // (the same vector in feedbackWidget.theme.test.ts and lambda/shared/test/test_form_theme.py)
    expect(contrastRatio('#19161d80', '#ffffff00')).toBeCloseTo(17.89, 2)
    expect(contrastRatio('#ffffff80', '#ffffff')).toBeCloseTo(1, 2)
  })

  it('judges nothing that is not hex', () => {
    expect(contrastRatio('red', '#ffffff')).toBeNull()
    expect(optionEdge('#000000', 'white')).toBeNull()
  })
})

describe('the hex field', () => {
  it.each(['#8e48ff', '#FFF', ' #abc '])('accepts %s', (value) => { expect(isEditorHex(value)).toBe(true) })
  it.each(['8e48ff', '#8e48ff80', '#12', 'red', '#ggg'])('refuses %s', (value) => { expect(isEditorHex(value)).toBe(false) })
})

describe('readableOn and the option edge', () => {
  it.each([['#8e48ff', '#ffffff'], ['#bd8fff', '#19161d'], ['#f5c518', '#19161d'], ['#0552c2', '#ffffff'], ['nope', '#ffffff']])(
    'labels %s with %s', (fill, label) => { expect(readableOn(fill)).toBe(label) },
  )

  it('draws the edge at 55 % of the text, raised until 3:1, never past the text itself', () => {
    const edge = (text: string) => {
      const found = optionEdge(text, '#ffffff')
      return found === null ? null : [Math.round(found.alpha * 100), Math.round(found.ratio * 100)]
    }
    expect(edge('#19161d')).toStrictEqual([55, 398])
    expect(edge('#6f7681')).toStrictEqual([80, 316])
    expect(edge('#9ca3af')).toStrictEqual([100, 254])
  })
})

describe('the four pairs', () => {
  it('passes every pair of VoC light and VoC dark', () => {
    for (const palette of [VOC_LIGHT_PALETTE, VOC_DARK_PALETTE]) {
      expect(palettePairs(palette).map((pair) => [pair.id, pair.level])).toStrictEqual([['text', 'ok'], ['primary', 'ok'], ['label', 'ok'], ['edge', 'ok']])
    }
  })

  it('makes text under 3:1 an error, from 3 to 4.5 a warning', () => {
    const level = (text: string) => palettePairs({ ...VOC_LIGHT_PALETTE, text_color: text })[0]?.level
    expect([level('#9ca3af'), level('#949494'), level('#767676')]).toStrictEqual(['error', 'warn', 'ok'])
  })

  it('warns, never errs, for the primary, the label and the edge', () => {
    const pairs = palettePairs({ primary_color: '#f5c518', background_color: '#ffffff', text_color: '#9ca3af' })
    expect(pairs.map((pair) => pair.level)).toStrictEqual(['error', 'warn', 'ok', 'warn'])
    const grey = palettePairs({ ...VOC_LIGHT_PALETTE, primary_color: '#777777' })
    expect(grey.find((pair) => pair.id === 'label')?.level).toBe('warn')
  })

  it('checks every palette that can be shown', () => {
    expect((['light', 'dark', 'auto'] as const).map((mode) => shownPalettes({ mode }))).toStrictEqual([['light'], ['dark'], ['light', 'dark']])
    const darkUnreadable = { ...DEFAULT_THEME, mode: 'auto' as const, dark: { ...VOC_DARK_PALETTE, text_color: '#333333' } }
    expect(unreadablePalettes(darkUnreadable).map((found) => found.palette)).toStrictEqual(['dark'])
    expect(unreadablePalettes({ ...darkUnreadable, mode: 'light' })).toStrictEqual([])
  })
})

describe('suggestions in OKLCH lightness (the audit’s worked examples)', () => {
  it.each([
    ['#f5c518', 3, '#b39018', 3.04],
    ['#ff7a00', 3, '#e97319', 3.03],
    ['#9ca3af', 4.5, '#6f7681', 4.58],
    ['#ff7a00', 4.5, '#bb5a0e', 4.58],
  ])('%s on white at %s:1 is %s (%s:1)', (colour, minimum, suggested, ratio) => {
    const { darker, lighter } = suggestColours(colour, minimum, onWhite)
    expect(darker?.colour).toBe(suggested)
    expect(darker?.ratio).toBeCloseTo(ratio, 2)
    expect(lighter).toBeUndefined()
  })

  it('offers the lighter way too, on a dark background', () => {
    const { darker, lighter } = suggestColours('#8e48ff', 4.5, (candidate) => contrastRatio(candidate, '#19161d'))
    expect(darker).toBeUndefined()
    expect(lighter?.ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('suggests for a failing pair only: the text and the primary each by their own colour', () => {
    const palette = { primary_color: '#f5c518', background_color: '#ffffff', text_color: '#9ca3af' }
    expect(palettePairs(palette).map((pair) => pairSuggestions(pair, palette).map((s) => s.colour)))
      .toStrictEqual([['#6f7681'], ['#b39018'], [], []])
  })

  it('moves a primary no label reads on until white or #19161d does', () => {
    const grey = { ...VOC_LIGHT_PALETTE, primary_color: '#777777' }
    const label = palettePairs(grey).find((pair) => pair.id === 'label')
    const fixes = label === undefined ? [] : pairSuggestions(label, grey)
    expect(fixes).toHaveLength(2)
    expect(fixes.every((fix) => (contrastRatio(readableOn(fix.colour), fix.colour) ?? 0) >= 4.5)).toBe(true)
  })
})
