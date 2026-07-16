import { PieChart, Pie, ResponsiveContainer, Tooltip } from 'recharts'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SentimentData, SentimentFilter } from './types'
import { getSentimentScoreColorClass } from './types'

const SENTIMENT_LABEL_KEYS = ['positive', 'negative', 'neutral', 'mixed'] as const

/** Localized sentiment name; unknown names render as-is. */
function sentimentLabel(t: TFunction<'categories'>, name: string): string {
  return SENTIMENT_LABEL_KEYS.some((k) => k === name) ? t(name) : name
}

interface SentimentGaugeProps {
  readonly sentimentData: SentimentData[]
  readonly avgSentiment: number
  readonly sentimentFilter: SentimentFilter
  readonly onSentimentFilterChange: (filter: SentimentFilter) => void
  readonly percentages: Record<string, number>
}

export function SentimentGauge({
  sentimentData,
  avgSentiment,
  sentimentFilter,
  onSentimentFilterChange,
  percentages,
}: SentimentGaugeProps) {
  const { t } = useTranslation('categories')
  return (
    <div className="card">
      <h2 className="text-base sm:text-lg font-semibold mb-2">{t('overallSentiment')}</h2>
      <div className="flex items-center justify-center">
        <div className="relative w-full max-w-[280px]">
          <ResponsiveContainer width="100%" height={105} minWidth={0}>
            <PieChart>
              <Pie
                data={sentimentData.map(d => ({ ...d, fill: d.color }))}
                cx="50%"
                cy="100%"
                startAngle={180}
                endAngle={0}
                innerRadius={56}
                outerRadius={88}
                paddingAngle={2}
                dataKey="value"
              >
              </Pie>
              <Tooltip
                formatter={(value, name) => {
                  const nameStr = String(name)
                  const pct = percentages[nameStr]?.toFixed(1) ?? '0'
                  return [`${value} (${pct}%)`, sentimentLabel(t, nameStr)]
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-end justify-center pb-1">
            <div className="text-center">
              <p className={clsx('text-2xl font-bold leading-none', getSentimentScoreColorClass(avgSentiment))}>
                {avgSentiment > 0 ? '+' : ''}{avgSentiment.toFixed(0)}
              </p>
              <p className="text-xs text-gray-500">{t('netSentiment')}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 mt-2 max-w-[280px] mx-auto">
        {sentimentData.map(s => {
          const filterValue = s.name === 'positive' || s.name === 'negative' || s.name === 'neutral' || s.name === 'mixed' ? s.name : 'all'
          return (
            <button
              key={s.name}
              onClick={() => onSentimentFilterChange(sentimentFilter === s.name ? 'all' : filterValue)}
              className={clsx(
                'flex items-center justify-center gap-1.5 px-2 py-1 rounded-full text-xs transition-all active:scale-95',
                sentimentFilter === s.name ? 'bg-gray-900 text-white' : 'bg-gray-100 hover:bg-gray-200'
              )}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
              <span className="capitalize">{sentimentLabel(t, s.name)}</span>
              <span className="text-xs opacity-70">{s.percentage.toFixed(0)}%</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
