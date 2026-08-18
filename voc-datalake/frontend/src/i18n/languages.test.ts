/**
 * @fileoverview Tests for the side-effect-free language module.
 *
 * changeLanguage's guard is the boundary validation for the
 * localStorage('voc-language')-persisted value, so its rejection path is
 * regression-tested here (the UserProfileModal tests mock this module).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import i18n from 'i18next'
import type { TFunction } from 'i18next'
import { changeLanguage, isSupportedLanguage, languageNames, supportedLanguages } from './languages'

const dummyT = ((key: string) => key) as TFunction

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isSupportedLanguage', () => {
  it.each([...supportedLanguages])('returns true for shipped locale %s', (lang) => {
    expect(isSupportedLanguage(lang)).toBe(true)
  })

  it.each(['xx', '', 'EN', 'en-US', 'de-AT', 'zz-ZZ'])(
    'returns false for unsupported or non-canonical code %j',
    (lang) => {
      expect(isSupportedLanguage(lang)).toBe(false)
    },
  )
})

describe('languageNames', () => {
  it('provides a non-empty native name for every shipped locale', () => {
    for (const lang of supportedLanguages) {
      expect(languageNames[lang]).toBeTruthy()
    }
  })
})

describe('changeLanguage', () => {
  it('delegates to i18next for a supported language', async () => {
    const spy = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(dummyT)

    await changeLanguage('de')

    expect(spy).toHaveBeenCalledWith('de')
  })

  it('resolves without touching i18next for an unsupported code', async () => {
    const spy = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(dummyT)

    await changeLanguage('xx')

    expect(spy).not.toHaveBeenCalled()
  })

  it('ignores a regional variant not in the shipped list (resolves without switching)', async () => {
    const spy = vi.spyOn(i18n, 'changeLanguage').mockResolvedValue(dummyT)

    await changeLanguage('en-US')

    expect(spy).not.toHaveBeenCalled()
  })

  it('propagates i18next rejection to the caller', async () => {
    vi.spyOn(i18n, 'changeLanguage').mockRejectedValue(new Error('backend down'))

    await expect(changeLanguage('fr')).rejects.toThrow('backend down')
  })
})
