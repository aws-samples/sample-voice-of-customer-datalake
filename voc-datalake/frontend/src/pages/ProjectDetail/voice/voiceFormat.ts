/**
 * @fileoverview How a voice session's numbers read: a cost in US cents as dollars (a minute costs about two cents,
 * so three decimals), a clock as `m:ss`, the UI's language as the two-letter code the model is told, and whether the
 * model speaks it (`@stream/voice/protocol` VOICE_LANGUAGES), with the names of those it does.
 *
 * @module pages/ProjectDetail/voice/voiceFormat
 */
import { VOICE_LANGUAGES } from '@stream/voice/protocol'
import { languageName } from '../../../utils/languageName'

const CENTS_PER_DOLLAR = 100
const SECONDS_PER_MINUTE = 60

export function formatCents(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 3 })
    .format(cents / CENTS_PER_DOLLAR)
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(whole / SECONDS_PER_MINUTE))}:${String(whole % SECONDS_PER_MINUTE).padStart(2, '0')}`
}

/** `de-CH` → `de`: what the relay's prompt names as the language to fall back on. */
export function voiceLanguage(uiLanguage: string): string {
  return (uiLanguage.split('-')[0] ?? '').toLowerCase() || 'en'
}

/** Whether the model speaks the UI's language; if not, the names of those it does, in the UI's language. */
export function languageSupport(uiLanguage: string, supported: readonly string[]): { supported: boolean; names: string } {
  const offered: readonly string[] = supported.length > 0 ? supported : VOICE_LANGUAGES
  const code = voiceLanguage(uiLanguage)
  const names = new Intl.ListFormat(uiLanguage, { type: 'conjunction' }).format(offered.map((one) => languageName(one, uiLanguage)))
  return { supported: offered.includes(code), names }
}
