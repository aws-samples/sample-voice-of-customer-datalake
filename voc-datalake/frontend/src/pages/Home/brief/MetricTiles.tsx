/**
 * @fileoverview Three deterministic tiles (reviews, sentiment, urgent) for the last 7 days,
 * with arrows against the 7 days before. Read from `/metrics/summary`, which applies the
 * caller's category and source access, so a tile never counts what the reader cannot see;
 * a restricted reader is told so by the scope notice under the heading.
 * @module pages/Home/brief/MetricTiles
 */
import { useSummaryQuery } from '../../../hooks/useSummaryQuery'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, MessageSquare } from 'lucide-react'
import { SENTIMENT_TONE_DISPLAY, sentimentTone, sentimentWords, signedAverage } from '../../../components/SentimentWords/sentimentWords'
import MetricCard from '../../../components/MetricCard/MetricCard'
import ScopeNotice from '../../../components/ScopeNotice/ScopeNotice'
import { useConfigStore } from '../../../store/configStore'
import { tiles } from './briefCards'

const WINDOW_DAYS = 7

function trendOf(change: number | undefined): 'up' | 'down' | 'neutral' {
  if (change === undefined || change === 0) return 'neutral'
  return change > 0 ? 'up' : 'down'
}

/** The week's sentiment in words, the average kept as the secondary figure; the icon follows the words. */
function SentimentTile({ average, change }: Readonly<{ average: number; change: number | undefined }>) {
  const { t, i18n } = useTranslation('briefing')
  const { Icon, color } = SENTIMENT_TONE_DISPLAY[sentimentTone(average)]
  return (
    <MetricCard title={t('tiles.sentiment')} value={sentimentWords(t, average)} detail={signedAverage(average, i18n.language)}
      change={change} trend={trendOf(change)} icon={<Icon size={18} aria-hidden="true" />} color={color} />
  )
}

export default function MetricTiles() {
  const { t } = useTranslation('briefing')
  const endpoint = useConfigStore((s) => s.config.apiEndpoint)
  // The same `['summary', {days}]` entries Layout and the Dashboard read, so the tiles never refetch them.
  const week = useSummaryQuery({ days: WINDOW_DAYS }, endpoint)
  const fortnight = useSummaryQuery({ days: WINDOW_DAYS * 2 }, endpoint)
  if (week.data === undefined || fortnight.data === undefined) return null
  const numbers = tiles(week.data, fortnight.data)
  return (
    <section aria-labelledby="brief-tiles-title" className="space-y-2">
      <h2 id="brief-tiles-title" className="text-sm font-medium text-muted">{t('tiles.title')}</h2>
      <ScopeNotice />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
        <MetricCard title={t('tiles.reviews')} value={numbers.reviews.current} change={numbers.reviews.change}
          trend={trendOf(numbers.reviews.change)} icon={<MessageSquare size={18} aria-hidden="true" />} color="accent" />
        <SentimentTile average={numbers.sentiment.current} change={numbers.sentiment.change} />
        <MetricCard title={t('tiles.urgent')} value={numbers.urgent.current} change={numbers.urgent.change}
          trend={trendOf(numbers.urgent.change)}
          icon={<AlertTriangle size={18} aria-hidden="true" />} color="danger" />
      </div>
    </section>
  )
}
