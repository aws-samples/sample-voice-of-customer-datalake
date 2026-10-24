/**
 * @fileoverview One brand's sentiment trend and its love / hate themes (GET /radar/brands/{brand}).
 * Every theme, quote, trend day and the totals line opens the reviews behind it (ReviewsModal).
 * @module pages/Radar/BrandSentiment
 */
import { BookOpen, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import TrendChart from './TrendChart'
import { sentimentWords, signedAverage } from '../../components/SentimentWords/sentimentWords'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { LucideIcon } from 'lucide-react'
import type { RadarReviewFilter } from '../../api/radarApi'
import type { RadarDetail, RadarTheme } from '../../api/radarSchema'

type OnRead = (filter: RadarReviewFilter) => void
/** Love = positive themes, hate = negative ones. */
type Polarity = 'positive' | 'negative'

/** A theme's reviews: its category, its subcategory ('' = none) and the column's sentiment. */
function themeFilter(theme: RadarTheme, sentiment: Polarity): RadarReviewFilter {
  return { category: theme.category, subcategory: theme.subcategory ?? '', sentiment }
}

function Theme({ theme, sentiment, onRead }: Readonly<{ theme: RadarTheme; sentiment: Polarity; onRead: OnRead }>) {
  const { t } = useTranslation('radar')
  const open = () => onRead(themeFilter(theme, sentiment))
  const name = useDisplayLabels().theme(theme.category, theme.subcategory)
  return (
    <li className="border-t border-border pt-2">
      <button type="button" onClick={open}
        className="w-full min-w-0 text-sm text-text flex items-center justify-between gap-2 text-left rounded-sm hover:bg-bg-hover">
        <span className="font-medium min-w-0 break-words">{name}</span>
        {/* `badge` keeps the count on one line; the name wraps beside it (never cut) at 390px. */}
        <span className="badge badge-muted shrink-0">{t('reviews.readTheme', { count: theme.count })}</span>
      </button>
      {theme.quotes.map((quote) => (
        <button key={quote} type="button" onClick={open}
          className="block w-full text-left text-xs text-muted mt-1 border-l-2 border-border pl-2 hover:text-text">
          {quote}<span className="sr-only"> {t('reviews.openTheme', { theme: name })}</span>
        </button>
      ))}
    </li>
  )
}

function ThemeColumn({ title, icon: Icon, sentiment, themes, onRead }: Readonly<{
  title: string; icon: LucideIcon; sentiment: Polarity; themes: readonly RadarTheme[]; onRead: OnRead
}>) {
  const { t } = useTranslation('radar')
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-text-strong flex items-center gap-2 mb-2">
        <Icon size={14} className={sentiment === 'positive' ? 'text-ok' : 'text-danger'} aria-hidden="true" />{title}
      </h3>
      {themes.length === 0 ? <p className="text-sm text-muted">{t('themes.empty')}</p> : (
        <ul className="space-y-3">
          {themes.map((theme) => (
            <Theme key={`${theme.category}/${theme.subcategory ?? ''}`} theme={theme} sentiment={sentiment} onRead={onRead} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Totals({ detail, onRead }: Readonly<{ detail: RadarDetail; onRead: OnRead }>) {
  const { t, i18n } = useTranslation('radar')
  if (detail.total === 0) return <p className="text-sm text-muted">{t('totals.noReviews')}</p>
  const average = detail.avg_sentiment ?? 0
  // The locale's decimal mark ("+0,08" in Polish), never a hard-coded "+0.08" (verify10).
  const sentiment = t('totals.sentimentWords', { words: sentimentWords(t, average), value: signedAverage(average, i18n.language) })
  return (
    <p className="text-sm text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{`${t('totals.reviews', { count: detail.total })} · ${sentiment}`}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRead({})}>
        <BookOpen size={14} aria-hidden="true" />{t('reviews.readAll')}
      </button>
    </p>
  )
}

export default function BrandSentiment({ detail, onRead }: Readonly<{ detail: RadarDetail; onRead: OnRead }>) {
  const { t } = useTranslation('radar')
  return (
    <>
      <Totals detail={detail} onRead={onRead} />
      <TrendChart trend={detail.trend} onDay={(day) => onRead({ day })} />
      <section className="card grid gap-6 md:grid-cols-2" aria-label={`${t('themes.love')} / ${t('themes.hate')}`}>
        <ThemeColumn title={t('themes.love')} icon={ThumbsUp} sentiment="positive" themes={detail.love} onRead={onRead} />
        <ThemeColumn title={t('themes.hate')} icon={ThumbsDown} sentiment="negative" themes={detail.hate} onRead={onRead} />
        {detail.sampled ? <p className="text-xs text-muted md:col-span-2">{t('themes.sampled')}</p> : null}
      </section>
    </>
  )
}
