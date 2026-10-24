/**
 * @fileoverview Sentiment badge component.
 *
 * Displays sentiment label with colour by MEANING (design-system tones, not a
 * data-series hue): positive → `ok`, negative → `danger`, mixed → `warn`,
 * neutral → `muted`. Sentiment is a status, so it keeps the semantic tones the
 * way KiroCrew colours every good/bad value (`bg-ok-subtle text-ok`, …) instead
 * of joining the categorical data ramp (`--chart-*`).
 *
 * @module components/SentimentBadge
 */

import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { signedAverage } from '../SentimentWords/sentimentWords'

interface SentimentBadgeProps {
  sentiment: string
  /** The text shown (e.g. a sentence about the sentiment); the translated label ("Negatywny") when absent. It never changes the tone. */
  label?: string
  score?: number
  size?: 'sm' | 'md'
}

type SentimentType = 'positive' | 'negative' | 'neutral' | 'mixed'

const SENTIMENT_COLORS: Record<SentimentType, string> = {
  positive: 'bg-ok-subtle text-ok',
  negative: 'bg-danger-subtle text-danger',
  neutral: 'bg-bg-hover text-muted',
  mixed: 'bg-warn-subtle text-warn',
}

function isSentimentType(value: string): value is SentimentType {
  return value === 'positive' || value === 'negative' || value === 'neutral' || value === 'mixed'
}

function getSentimentColor(sentiment: string): string {
  if (isSentimentType(sentiment)) {
    return SENTIMENT_COLORS[sentiment]
  }
  return SENTIMENT_COLORS.neutral
}

export default function SentimentBadge({ sentiment, label, score, size = 'sm' }: Readonly<SentimentBadgeProps>) {
  const { t, i18n } = useTranslation()
  // Never the raw stored value ("negative") on screen: an unknown label reads as neutral, like its tone.
  const text = label ?? t(`dashboard:sentiment.${isSentimentType(sentiment) ? sentiment : 'neutral'}`)
  return (
    <span className={clsx(
      'inline-flex items-center rounded-full font-medium',
      getSentimentColor(sentiment),
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
    )}>
      {text}
      {score !== undefined && (
        // Same tone as the label, no opacity fade: opacity-70 on the 12px
        // score dropped it below WCAG AA contrast on the subtle fills.
        // Signed, with the locale's decimal mark ("−0,78").
        <span className="ml-1 font-mono">({signedAverage(Number(score), i18n.language)})</span>
      )}
    </span>
  )
}
