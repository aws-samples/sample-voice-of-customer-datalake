import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  PieChart, Pie, ResponsiveContainer, Tooltip,
} from 'recharts'
import { getSentimentScoreColorClass } from './types'
import type {
  SentimentData, SentimentFilter,
} from './types'

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
  const dataWithFill = sentimentData.map((entry) => ({
    ...entry,
    fill: entry.color,
  }))

  return (
    <div className="card">
      <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{t('overallSentiment')}</h2>
      <div className="flex items-center justify-center">
        <div className="relative w-full max-w-[280px]">
          <ResponsiveContainer width="100%" height={160} minWidth={0} minHeight={0} className="sm:!h-[200px]">
            <PieChart>
              <Pie
                data={dataWithFill}
                cx="50%"
                cy="100%"
                startAngle={180}
                endAngle={0}
                innerRadius="55%"
                outerRadius="85%"
                paddingAngle={2}
                dataKey="value"
              />
              <Tooltip
                formatter={(value, name) => {
                  const nameStr = String(name)
                  const pct = percentages[nameStr].toFixed(1)
                  return [`${value} (${pct}%)`, name]
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-end justify-center pb-2 sm:pb-4">
            <div className="text-center">
              <p className={clsx('text-2xl sm:text-3xl font-bold', getSentimentScoreColorClass(avgSentiment))}>
                {avgSentiment > 0 ? '+' : ''}{avgSentiment.toFixed(0)}
              </p>
              <p className="text-xs text-gray-500">{t('netSentiment')}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-2 sm:gap-4 mt-3 sm:mt-4">
        {sentimentData.map((s) => {
          const filterValue = s.name === 'positive' || s.name === 'negative' || s.name === 'neutral' || s.name === 'mixed' ? s.name : 'all'
          return (
            <button
              key={s.name}
              onClick={() => onSentimentFilterChange(sentimentFilter === s.name ? 'all' : filterValue)}
              className={clsx(
                'flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-xs sm:text-sm transition-all active:scale-95',
                sentimentFilter === s.name ? 'bg-gray-900 text-white' : 'bg-gray-100 hover:bg-gray-200',
              )}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
              <span className="capitalize">{s.name}</span>
              <span className="text-xs opacity-70">{s.percentage.toFixed(0)}%</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
