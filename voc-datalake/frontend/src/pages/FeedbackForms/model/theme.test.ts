/**
 * The theme in the editor's model (7.04.00): read with every field (a stored theme's missing or unusable ones as
 * their defaults, as the server reads it), sent whole, and judged by validateForm with the server's rules: text under
 * 3:1 blocks only Publish and Update live form, the other pairs below their minimum are warnings.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from './formsV2'
import type { FormTheme } from './formsV2'
import { parseFormV2, toWireForm } from './formsV2Schema'
import { migrateV1Form } from './migrateV1'
import { blockingProblems, incompleteLanguages, publishBlockingProblems, validateForm } from './validateForm'
import { sampleForm } from '../test/draftHarness'

const withTheme = (theme: Partial<FormTheme>) => sampleForm({ theme: { ...DEFAULT_THEME, ...theme } })
const themeProblems = (theme: Partial<FormTheme>) => validateForm(withTheme(theme)).filter((problem) => problem.at.kind === 'theme')

describe('reading and writing the theme', () => {
  it('reads a theme stored before 7.04.00 with the defaults of its new fields', () => {
    const stored = { primary_color: '#123456', background_color: '#fafafa', text_color: '#111', border_radius: '0px' }
    expect(parseFormV2({ ...toWireForm(sampleForm()), theme: stored })?.theme).toStrictEqual({ ...DEFAULT_THEME, ...stored })
  })

  it('reads an unusable value as its default, and keeps an old form’s #rrggbbaa', () => {
    const theme = parseFormV2({ ...toWireForm(sampleForm()), theme: { primary_color: 'red', text_color: '#19161dcc', mode: 'sepia', dark: { text_color: '#eee', primary_color: '#bd8fff80' } } })?.theme
    expect(theme).toStrictEqual({ ...DEFAULT_THEME, text_color: '#19161dcc', dark: { ...DEFAULT_THEME.dark, text_color: '#eee' } })
  })

  it('migrates a v1 form’s theme with every field', () => {
    const { form } = migrateV1Form({ question: 'Why?', theme: { primary_color: '#0552c2' } }, 'en', () => 'x')
    expect(form.theme).toStrictEqual({ ...DEFAULT_THEME, primary_color: '#0552c2' })
  })

  it('sends every field of the theme', () => {
    const theme: FormTheme = { ...DEFAULT_THEME, mode: 'auto', font: 'serif', text_size: 'large', border_radius: '16px' }
    expect(toWireForm(withTheme(theme)).theme).toStrictEqual(theme)
  })
})

describe('the theme in validateForm', () => {
  it('passes the default theme and both VoC palettes', () => {
    expect([themeProblems({}), themeProblems({ mode: 'auto' })]).toStrictEqual([[], []])
  })

  it('makes text under 3:1 an error that blocks Publish only', () => {
    const problems = validateForm(withTheme({ text_color: '#9ca3af' }))
    const [unreadable] = publishBlockingProblems(problems)
    expect(unreadable).toMatchObject({ severity: 'error', code: 'themeUnreadable', blocks: 'publish', params: { ratio: 2.5 }, at: { kind: 'theme', id: 'light', field: 'text_color' } })
    expect(blockingProblems(problems)).toStrictEqual([])
  })

  it('warns for text from 3 to 4.5:1, a faint primary and a primary no label reads on', () => {
    expect(themeProblems({ text_color: '#808080' }).map((problem) => [problem.severity, problem.code, problem.params.ratio])).toStrictEqual([['warning', 'themeTextLow', 3.9]])
    expect(themeProblems({ primary_color: '#f5c518' }).map((problem) => problem.code)).toStrictEqual(['themePrimaryLow'])
    expect(themeProblems({ primary_color: '#777777' }).map((problem) => problem.code)).toStrictEqual(['themeLabelLow'])
  })

  it('only warns about a live form kept on its own unreadable theme, whatever its key order', () => {
    const grey = withTheme({ text_color: '#9ca3af' })
    const kept = validateForm(grey, { liveTheme: grey.theme })
    expect(kept.filter((problem) => problem.at.kind === 'theme').map((problem) => [problem.severity, problem.code, problem.params.ratio]))
      .toStrictEqual([['warning', 'themeUnreadableLive', 2.5]])
    expect(publishBlockingProblems(kept)).toStrictEqual([])
    // (its key order does not make it another theme)
    const { theme } = grey
    const reordered = { ...grey, theme: {
      text_size: theme.text_size, font: theme.font, dark: theme.dark, mode: theme.mode, border_radius: theme.border_radius,
      text_color: theme.text_color, background_color: theme.background_color, primary_color: theme.primary_color,
    } }
    expect(publishBlockingProblems(validateForm(reordered, { liveTheme: grey.theme }))).toStrictEqual([])
  })

  it('blocks a live form whose colours change to unreadable ones, from readable or unreadable ones', () => {
    const grey = withTheme({ text_color: '#9ca3af' })
    const changed = validateForm(withTheme({ text_color: '#b0b0b0' }), { liveTheme: grey.theme })
    expect(publishBlockingProblems(changed).map((problem) => problem.code)).toStrictEqual(['themeUnreadable'])
    const fromReadable = validateForm(grey, { liveTheme: DEFAULT_THEME })
    expect(publishBlockingProblems(fromReadable).map((problem) => problem.code)).toStrictEqual(['themeUnreadable'])
  })

  it('checks every palette that can be shown, and only those', () => {
    const dark = { ...DEFAULT_THEME.dark, text_color: '#333333' }
    expect(themeProblems({ mode: 'auto', dark }).map((problem) => problem.at.id)).toStrictEqual(['dark'])
    expect(themeProblems({ mode: 'light', dark })).toStrictEqual([])
  })
})

describe('incompleteLanguages', () => {
  it('lists each offered language with missing texts and how many', () => {
    const form = sampleForm({ languages: ['en', 'pl'] })
    expect(incompleteLanguages(validateForm(form))).toStrictEqual([{ language: 'pl', count: 2 }])
    expect(incompleteLanguages(validateForm(sampleForm()))).toStrictEqual([])
  })
})
