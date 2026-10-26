/**
 * @fileoverview Sentiment in plain words: "Mostly negative · 78 % negative"
 * instead of a bare −0.78. One scale for every average on the analytics pages
 * (−1 … +1, the scale the processor stores); the share is the dominant side's
 * share of the reviews when the counts are known.
 *
 * Keys live in the `dashboard` namespace (`dashboard:sentimentWords.*`), which
 * every page loads, so any `t` resolves them.
 *
 * @module components/SentimentWords/sentimentWords
 */
import { Frown, Meh, Smile, type LucideIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { Tone } from '../../theme/tones'

export type SentimentTone = 'positive' | 'negative' | 'neutral'

/** How a sentiment tone is drawn on a metric tile: its face icon and its status colour. */
export const SENTIMENT_TONE_DISPLAY: Readonly<Record<SentimentTone, { readonly Icon: LucideIcon; readonly color: Extract<Tone, 'ok' | 'muted' | 'danger'> }>> = {
  positive: { Icon: Smile, color: 'ok' },
  neutral: { Icon: Meh, color: 'muted' },
  negative: { Icon: Frown, color: 'danger' },
}

export type SentimentWordKey = 'mostlyPositive' | 'leaningPositive' | 'balanced' | 'leaningNegative' | 'mostlyNegative'

/** |average| under this is "Balanced"; at or over STRONG it is "Mostly …". */
const BALANCED_BELOW = 0.15
const STRONG_FROM = 0.5

/** The words for an average on the −1 … +1 scale. */
export function sentimentWordKey(average: number): SentimentWordKey {
  if (!Number.isFinite(average) || Math.abs(average) < BALANCED_BELOW) return 'balanced'
  if (average > 0) return average >= STRONG_FROM ? 'mostlyPositive' : 'leaningPositive'
  return average <= -STRONG_FROM ? 'mostlyNegative' : 'leaningNegative'
}

/** The tone an average reads as: the colour and icon follow THIS, never the raw sign alone. */
export function sentimentTone(average: number): SentimentTone {
  const key = sentimentWordKey(average)
  if (key === 'balanced') return 'neutral'
  return key.endsWith('Positive') ? 'positive' : 'negative'
}

/** Review counts (or percentages) by sentiment label; absent labels count 0. */
export type SentimentCounts = Readonly<Partial<Record<string, number>>>

/** Whole-percent share of `label` among every counted review; undefined when nothing is counted. */
export function sentimentShare(counts: SentimentCounts, label: 'positive' | 'negative'): number | undefined {
  const total = Object.values(counts).reduce<number>((sum, n) => sum + (typeof n === 'number' && n > 0 ? n : 0), 0)
  if (total <= 0) return undefined
  return Math.round(((counts[label] ?? 0) / total) * 100)
}

/** The −1 … +1 average implied by percentages alone (positive share minus negative share). */
export function netFromCounts(counts: SentimentCounts): number {
  const positive = sentimentShare(counts, 'positive') ?? 0
  const negative = sentimentShare(counts, 'negative') ?? 0
  return (positive - negative) / 100
}

/** "Mostly negative" — the words alone. */
export function sentimentWords(t: TFunction, average: number): string {
  return t(`dashboard:sentimentWords.${sentimentWordKey(average)}`)
}

/** "78 % negative": the share of the side the words lean to (positive for a balanced window); undefined when nothing is counted. */
export function sentimentShareText(t: TFunction, average: number, counts: SentimentCounts): string | undefined {
  const side = sentimentTone(average) === 'negative' ? 'negative' : 'positive'
  const pct = sentimentShare(counts, side)
  // `ratio` is formatted by the locale's Intl percent ("78%", de "78 %"): one spelling per language.
  return pct === undefined ? undefined : t(`dashboard:sentimentWords.share.${side}`, { pct, ratio: pct / 100 })
}

/** "Mostly negative · 78 % negative" when `counts` are known, else the words alone. */
export function describeSentiment(t: TFunction, average: number, counts?: SentimentCounts): string {
  const words = sentimentWords(t, average)
  const share = counts === undefined ? undefined : sentimentShareText(t, average, counts)
  return share === undefined ? words : t('dashboard:sentimentWords.withShare', { words, share })
}

/** Below this |average| the two-decimal figure reads 0.00, so it carries no sign. */
const ROUNDS_TO_ZERO = 0.005

/** The number kept as the secondary figure: "−0.78" / "+0.42" (a real minus sign); `locale` sets the decimal mark ("−0,78"). */
export function signedAverage(average: number, locale = 'en'): string {
  if (!Number.isFinite(average)) return signedAverage(0, locale)
  const fixed = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(average))
  if (Math.abs(average) < ROUNDS_TO_ZERO) return fixed
  return average > 0 ? `+${fixed}` : `\u2212${fixed}`
}

const SENTIMENT_LABEL_KEYS = new Set(['positive', 'negative', 'neutral', 'mixed'])

/**
 * ONE review's sentiment in words: "Negative · 90 %" (the label, then how strongly the review
 * reads that way: |score| as a percent), instead of "negative (-0.90)". The label alone when
 * there is no score.
 */
export function reviewSentimentText(t: TFunction, label: string, score: number | undefined): string {
  const word = t(`dashboard:sentiment.${SENTIMENT_LABEL_KEYS.has(label) ? label : 'neutral'}`)
  if (score === undefined || !Number.isFinite(score)) return word
  const pct = Math.min(100, Math.round(Math.abs(score) * 100))
  return t('dashboard:sentimentWords.review', { word, pct, ratio: pct / 100 })
}
