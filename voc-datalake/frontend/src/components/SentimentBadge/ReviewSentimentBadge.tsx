/**
 * @fileoverview One review's sentiment badge in words: "Negative · 90 %" (`reviewSentimentText`),
 * never the raw label and score ("negative (-0.90)").
 * @module components/SentimentBadge/ReviewSentimentBadge
 */
import { useTranslation } from 'react-i18next'
import SentimentBadge from './SentimentBadge'
import { reviewSentimentText } from '../SentimentWords/sentimentWords'

interface ReviewSentimentBadgeProps {
  readonly sentiment: string
  readonly score?: number
  readonly size?: 'sm' | 'md'
}

export default function ReviewSentimentBadge({ sentiment, score, size }: Readonly<ReviewSentimentBadgeProps>) {
  const { t } = useTranslation()
  return <SentimentBadge sentiment={sentiment} label={reviewSentimentText(t, sentiment, score)} size={size} />
}
