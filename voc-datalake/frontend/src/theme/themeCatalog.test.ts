import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COLOR_THEME_IDS, DEFAULT_COLOR_THEME, isColorThemeChoice, isColorThemeId, resolveColorTheme, themeAttribute,
  themeFavicon, WORKSPACE_THEME_CHOICE,
} from './themeCatalog'

describe('themeCatalog', () => {
  it('ships Kiro as the default and lists it first', () => {
    expect(DEFAULT_COLOR_THEME).toBe('kiro')
    expect(COLOR_THEME_IDS[0]).toBe(DEFAULT_COLOR_THEME)
  })

  it.each(COLOR_THEME_IDS)('accepts the shipped id %s as a theme and as a choice', (id) => {
    expect(isColorThemeId(id)).toBe(true)
    expect(isColorThemeChoice(id)).toBe(true)
  })

  it('accepts `workspace` only as a choice, never as a theme', () => {
    expect(isColorThemeChoice(WORKSPACE_THEME_CHOICE)).toBe(true)
    expect(isColorThemeId(WORKSPACE_THEME_CHOICE)).toBe(false)
  })

  it.each([['neon'], [''], ['KIRO'], ['constructor'], [null], [undefined], [1], [{}]])('refuses %j', (value) => {
    expect(isColorThemeId(value)).toBe(false)
    expect(isColorThemeChoice(value)).toBe(false)
  })

  it('resolves `workspace` to the workspace theme and a personal pick to itself', () => {
    expect(resolveColorTheme(WORKSPACE_THEME_CHOICE, 'dracula')).toBe('dracula')
    expect(resolveColorTheme('quick', 'dracula')).toBe('quick')
  })

  it('names the stylesheet block `<id>-<mode>`', () => {
    expect(themeAttribute('highcontrast', 'light')).toBe('highcontrast-light')
    expect(themeAttribute('kiro', 'dark')).toBe('kiro-dark')
  })

  it.each(COLOR_THEME_IDS)('ships the %s tab icon it points at, as an SVG', (id) => {
    const file = resolve(__dirname, '../../public', themeFavicon(id).slice(1))
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  })

  it('keeps Kiro on its ghost and every other theme under /favicons/', () => {
    expect(themeFavicon('kiro')).toBe('/kiro-ghost.svg')
    expect(themeFavicon('quick')).toBe('/favicons/quick.svg')
  })

  it('the dev mock accepts exactly the shipped theme ids (mock-appearance.js)', () => {
    const mock = readFileSync(resolve(__dirname, '../../mock-appearance.js'), 'utf8')
    const quoted = COLOR_THEME_IDS.map((id) => `'${id}'`).join(', ')
    expect(mock).toContain(`const THEME_IDS = [${quoted}];`)
  })
})
