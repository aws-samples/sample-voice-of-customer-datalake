/**
 * @fileoverview Display labels for sentiment slugs, shared by the wizard's
 * filter buttons and its context summary.
 *
 * Lives in its own module for two reasons: exporting a non-component from a
 * .tsx file trips `react-refresh/only-export-components`, and the buttons and
 * the summary previously disagreed — one translated, the other printed the raw
 * slug — which is exactly what a single source prevents.
 *
 * @module components/DataSourceWizard/sentimentLabels
 */

import { useTranslation } from 'react-i18next'
import { SENTIMENTS, type Sentiment } from '../../constants/filters'

/**
 * Keyed by the literal `Sentiment` union, so adding a sentiment without a
 * label is a typecheck failure rather than a slug rendered to the user.
 *
 * The four calls are written out instead of mapping over `SENTIMENTS` with
 * `` t(`common:sentiment.${s}`) `` because `scripts/i18n-check.mjs` cannot see
 * keys inside a template literal — a dynamic key works at runtime but leaves
 * these four reported as unreferenced, which is the blind spot that let them
 * sit translated-but-unused in the first place.
 */
export function useSentimentLabels(): Record<Sentiment, string> {
  const { t } = useTranslation('common')
  return {
    positive: t('common:sentiment.positive'),
    negative: t('common:sentiment.negative'),
    neutral: t('common:sentiment.neutral'),
    mixed: t('common:sentiment.mixed'),
  }
}

const KNOWN_SENTIMENTS: ReadonlySet<string> = new Set(SENTIMENTS)

/** Narrows a persisted slug to a Sentiment by checking it at runtime. */
function isSentiment(value: string): value is Sentiment {
  return KNOWN_SENTIMENTS.has(value)
}

/** Translate stored sentiment slugs for display, preserving their order. */
export function toSentimentLabels(
  sentiments: ReadonlyArray<string>,
  labels: Record<Sentiment, string>,
): string[] {
  // Slugs come from persisted config, so an unknown value is possible; show it
  // verbatim rather than dropping the filter silently from the summary.
  return sentiments.map(s => (isSentiment(s) ? labels[s] : s))
}
