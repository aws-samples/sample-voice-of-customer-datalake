import { describe, expect, it } from 'vitest'
import {
  COLOR_THEME_IDS, DEFAULT_COLOR_THEME, isColorThemeChoice, isColorThemeId, resolveColorTheme, themeAttribute,
  WORKSPACE_THEME_CHOICE,
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
})
