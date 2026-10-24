import { PieChart, Pie, ResponsiveContainer, Tooltip } from 'recharts'
import { useId } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SentimentData, SentimentFilter } from './types'
import { netFromCounts, sentimentShare, sentimentShareText, sentimentTone, sentimentWords } from '../../components/SentimentWords/sentimentWords'
import { sentimentCssVar } from '../../lib/sentiment'
import { formatPercent } from '../../utils/numberFormat'

const SENTIMENT_LABEL_KEYS = ['positive', 'negative', 'neutral', 'mixed'] as const

/** Recharts tooltip styling — theme tokens so it flips with light/dark. */
const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
}
const TOOLTIP_ITEM_STYLE = { color: 'var(--text)' }

/**
 * The half-donut is drawn in a 2:1 box with no chart margin, so Recharts'
 * max radius is half the box height and these percentages are of THAT:
 * the arc spans 95 % of the box height, the hole 62 %. The gauge therefore
 * scales with its width (the hole always holds the share number) instead of
 * being fixed px radii that the old in-hole words overflowed.
 */
const GAUGE_MARGIN = { top: 0, right: 0, bottom: 0, left: 0 }
const OUTER_RADIUS = '190%'
const INNER_RADIUS = '124%'

/** Localized sentiment name; unknown names render as-is. */
function sentimentLabel(t: TFunction<'categories'>, name: string): string {
  return SENTIMENT_LABEL_KEYS.some((k) => k === name) ? t(name) : name
}

/** "71%" / "71 %" (the locale's percent) of the side the words lean to; empty when nothing is counted. */
function gaugeShareNumber(net: number, percentages: Readonly<Partial<Record<string, number>>>, locale: string): string {
  const side = sentimentTone(net) === 'negative' ? 'negative' : 'positive'
  const pct = sentimentShare(percentages, side)
  return pct === undefined ? '' : formatPercent(pct, locale)
}

interface SentimentGaugeProps {
  readonly sentimentData: SentimentData[]
  readonly sentimentFilter: SentimentFilter
  readonly onSentimentFilterChange: (filter: SentimentFilter) => void
  /** Keyed by sentiment label; a label the breakdown did not report has no entry. */
  readonly percentages: Readonly<Partial<Record<string, number>>>
  /** Display label of the one category the breakdown is scoped to (title "Sentiment · <label>"); null/absent = every category. */
  readonly scopeLabel?: string | null
  /** The scoped breakdown is still loading: a skeleton, never the previous scope's value. */
  readonly isLoading?: boolean
}

/** First-paint size of the gauge (aspect 2, like its container); replaced by the measured size at once. */
const GAUGE_INITIAL_SIZE = { width: 240, height: 120 }

type GaugeDataProps = Readonly<Pick<SentimentGaugeProps, 'sentimentData' | 'percentages'>>

/** The half-donut arc and its tooltip (decorative: the summary carries the meaning). */
function SentimentGaugeChart({ sentimentData, percentages }: GaugeDataProps) {
  const { t, i18n } = useTranslation('categories')
  return (
    // A positive first-paint size (aspect 2): without it Recharts renders at -1 x -0.5 until its
    // ResizeObserver fires and logs "The width(-1) and height(-0.5) of chart should be greater than 0".
    <ResponsiveContainer width="100%" aspect={2} minWidth={0} initialDimension={GAUGE_INITIAL_SIZE}>
      <PieChart margin={GAUGE_MARGIN}>
        <Pie
          data={sentimentData.map(d => ({ ...d, fill: sentimentCssVar(d.name) }))}
          cx="50%"
          cy="100%"
          startAngle={180}
          endAngle={0}
          innerRadius={INNER_RADIUS}
          outerRadius={OUTER_RADIUS}
          paddingAngle={2}
          dataKey="value"
          stroke="var(--card)"
        />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          formatter={(value, name) => {
            const nameStr = String(name)
            const pct = formatPercent(percentages[nameStr] ?? 0, i18n.language, 1)
            return [`${value} (${pct})`, sentimentLabel(t, nameStr)]
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

/**
 * Gauge with a summary BELOW it (industry default for gauges/donuts): the hole
 * holds only the short share number in `text-strong`; the words and the
 * "71 % negative" line sit under the arc in text tokens (≥ 4.5:1 in both
 * themes) and may wrap, so no locale or text size can push them over the arc.
 * The sentiment colour is only on the small dot, never on the text.
 */
function GaugeSummary({ net, sentimentData, percentages }: GaugeDataProps & Readonly<{ net: number }>) {
  const { t, i18n } = useTranslation('categories')
  const words = sentimentWords(t, net)
  const shareText = sentimentShareText(t, net, percentages) ?? ''
  const tone = sentimentTone(net)
  return (
    <div
      role="img"
      aria-label={t('gaugeLabel', { words, share: shareText })}
      data-testid="sentiment-gauge"
      className="flex flex-col items-center"
    >
      {/* The gauge box is its own size container: the hole number is sized
          in `cqi` (capped at 1.25rem), so whatever the card width or text
          size it stays inside the hole and never touches the arc. The same
          share is always readable at full text size in the line below. */}
      <div className="@container relative w-full max-w-[14rem]">
        <SentimentGaugeChart sentimentData={sentimentData} percentages={percentages} />
        <p
          data-testid="sentiment-gauge-number"
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 text-center text-[length:min(1.25rem,13cqi)] font-semibold leading-none tabular-nums whitespace-nowrap text-text-strong"
        >
          {gaugeShareNumber(net, percentages, i18n.language)}
        </p>
      </div>
      {/* Inline dot: when the words wrap ("Überwiegend / negativ") it stays with the first line. */}
      <p data-testid="sentiment-words" className="mt-2 max-w-full text-center text-base font-semibold leading-snug text-text-strong text-balance hyphens-auto [overflow-wrap:break-word]">
        <span data-testid="sentiment-tone-dot" data-tone={tone} className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ backgroundColor: sentimentCssVar(tone) }} aria-hidden="true" />
        {words}
      </p>
      <p data-testid="sentiment-share" className="max-w-full text-center text-sm text-muted hyphens-auto [overflow-wrap:break-word]">{shareText}</p>
    </div>
  )
}

const FILTER_VALUES: readonly SentimentFilter[] = ['positive', 'negative', 'neutral', 'mixed']

function filterValueOf(name: string): SentimentFilter {
  return FILTER_VALUES.find((value) => value === name) ?? 'all'
}

type ChipProps = Readonly<Pick<SentimentGaugeProps, 'sentimentData' | 'sentimentFilter' | 'onSentimentFilterChange'>>

/** The legend doubles as the sentiment filter; a long label (de "Neutrale Stimmung") wraps inside its chip. */
function SentimentFilterChips({ sentimentData, sentimentFilter, onSentimentFilterChange }: ChipProps) {
  const { t, i18n } = useTranslation('categories')
  return (
    <div data-testid="sentiment-chips" className="flex flex-wrap justify-center gap-1.5 mt-3 max-w-[min(100%,17.5rem)] mx-auto">
      {sentimentData.map(s => {
        const pressed = sentimentFilter === s.name
        return (
          <button
            key={s.name}
            type="button"
            onClick={() => onSentimentFilterChange(pressed ? 'all' : filterValueOf(s.name))}
            aria-pressed={pressed}
            className={clsx(
              'flex max-w-full items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-colors active:scale-95 focus-ring',
              pressed ? 'bg-accent-subtle text-accent-text ring-1 ring-inset ring-accent/40' : 'bg-bg-hover text-text hover:bg-border'
            )}
          >
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sentimentCssVar(s.name) }} aria-hidden="true" />
            <span className="min-w-0 capitalize text-left hyphens-auto [overflow-wrap:break-word]">{sentimentLabel(t, s.name)}</span>
            {/* text-muted, not an opacity fade: opacity-70 on these 12px
                counts failed WCAG AA contrast in both themes. */}
            <span className="flex-shrink-0 whitespace-nowrap tabular-nums text-muted">{formatPercent(s.percentage, i18n.language)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Placeholder while the scoped breakdown loads (never the previous scope's number). */
function GaugeSkeleton() {
  return (
    <div data-testid="sentiment-gauge-loading" className="flex flex-col items-center gap-2" aria-hidden="true">
      <div className="skeleton aspect-[2/1] w-full max-w-[14rem]" />
      <div className="skeleton h-4 w-32 max-w-full" />
    </div>
  )
}

export function SentimentGauge({
  sentimentData,
  sentimentFilter,
  onSentimentFilterChange,
  percentages,
  scopeLabel = null,
  isLoading = false,
}: SentimentGaugeProps) {
  const { t } = useTranslation('categories')
  const headingId = useId()
  // The same −1 … +1 scale and words as every other page; the share is the secondary line.
  const net = netFromCounts(percentages)
  const title = scopeLabel === null ? t('overallSentiment') : t('scopedSentiment', { category: scopeLabel })
  return (
    <section className="card" aria-labelledby={headingId} aria-busy={isLoading}>
      <h2 id={headingId} className="text-base sm:text-lg font-semibold tracking-tight text-text-strong mb-2 hyphens-auto [overflow-wrap:break-word]">{title}</h2>
      {isLoading ? <GaugeSkeleton /> : (
        <>
          <GaugeSummary net={net} sentimentData={sentimentData} percentages={percentages} />
          <SentimentFilterChips sentimentData={sentimentData} sentimentFilter={sentimentFilter} onSentimentFilterChange={onSentimentFilterChange} />
        </>
      )}
    </section>
  )
}
