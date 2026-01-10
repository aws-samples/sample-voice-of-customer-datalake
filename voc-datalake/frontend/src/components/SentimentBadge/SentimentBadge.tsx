/**
 * @fileoverview Sentiment badge component.
 *
 * Displays sentiment label with color coding:
 * - positive: green
 * - negative: red
 * - neutral: gray
 * - mixed: yellow
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
  positive: 'bg-green-100 text-green-800',
  negative: 'bg-red-100 text-red-800',
  neutral: 'bg-gray-100 text-gray-800',
  mixed: 'bg-yellow-100 text-yellow-800',
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
        <span className="ml-1 opacity-70">({Number(score).toFixed(2)})</span>
      )}
    </span>
  )
}
