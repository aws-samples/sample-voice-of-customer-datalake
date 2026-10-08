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

interface SentimentBadgeProps {
  sentiment: string
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

export default function SentimentBadge({ sentiment, score, size = 'sm' }: Readonly<SentimentBadgeProps>) {
  return (
    <span className={clsx(
      'inline-flex items-center rounded-full font-medium',
      getSentimentColor(sentiment),
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
    )}>
      {sentiment}
      {score !== undefined && (
        // Same tone as the label, no opacity fade: opacity-70 on the 12px
        // score dropped it below WCAG AA contrast on the subtle fills.
        <span className="ml-1 font-mono">({Number(score).toFixed(2)})</span>
      )}
    </span>
  )
}
