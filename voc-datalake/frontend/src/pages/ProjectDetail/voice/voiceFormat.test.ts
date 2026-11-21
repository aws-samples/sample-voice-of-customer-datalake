import { describe, expect, it } from 'vitest'
import { formatCents, formatClock, languageSupport, voiceLanguage } from './voiceFormat'

describe('voiceFormat', () => {
  it('reads cents as dollars to three decimals and a clock as m:ss', () => {
    expect([formatCents(2.25, 'en'), formatCents(150, 'en')]).toStrictEqual(['$0.023', '$1.50'])
    expect([formatClock(0), formatClock(65.9), formatClock(-3), formatClock(900)]).toStrictEqual(['0:00', '1:05', '0:00', '15:00'])
  })

  it('takes the language part of a locale, English when there is none', () => {
    expect([voiceLanguage('de-CH'), voiceLanguage('PT'), voiceLanguage('')]).toStrictEqual(['de', 'pt', 'en'])
  })

  it('says whether the model speaks the UI language, with the model\'s own list when the server sent none', () => {
    expect(languageSupport('ja', ['en', 'de']).supported).toBe(false)
    expect(languageSupport('en', [])).toStrictEqual({ supported: true, names: 'English, German, Spanish, French, and Portuguese' })
  })
})
