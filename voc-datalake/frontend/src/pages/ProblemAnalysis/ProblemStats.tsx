/**
 * Stats bar for the Problem Analysis page.
 */
import {
  AlertTriangle, MessageSquare, TrendingUp, Layers,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ProblemStatsProps {
  readonly categoryCount: number
  readonly subcategoryCount: number
  readonly problemCount: number
  readonly feedbackCount: number
  readonly urgentCount: number
}

export function ProblemStats({
  categoryCount, subcategoryCount, problemCount, feedbackCount, urgentCount,
}: ProblemStatsProps) {
  const { t } = useTranslation('problemAnalysis')

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4">
      <StatCard icon={<TrendingUp size={14} className="sm:w-4 sm:h-4" />} label={t('stats.categories')} value={categoryCount} />
      <StatCard icon={<Layers size={14} className="sm:w-4 sm:h-4" />} label={t('stats.subcategories')} value={subcategoryCount} />
      <StatCard icon={<AlertTriangle size={14} className="sm:w-4 sm:h-4" />} label={t('stats.problems')} value={problemCount} />
      <StatCard icon={<MessageSquare size={14} className="sm:w-4 sm:h-4" />} label={t('stats.feedback')} value={feedbackCount} />
      <div className="bg-white rounded-xl p-3 sm:p-4 border border-red-200 shadow-sm bg-red-50 col-span-2 sm:col-span-1">
        <div className="flex items-center gap-1.5 sm:gap-2 text-red-600 mb-1">
          <AlertTriangle size={14} className="sm:w-4 sm:h-4" />
          <span className="text-xs sm:text-sm">{t('stats.urgent')}</span>
        </div>
        <p className="text-xl sm:text-2xl font-bold text-red-700">{urgentCount}</p>
      </div>
    </div>
  )
}

function StatCard({
  icon, label, value,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  value: number
}>) {
  return (
    <div className="bg-white rounded-xl p-3 sm:p-4 border border-gray-200 shadow-sm">
      <div className="flex items-center gap-1.5 sm:gap-2 text-gray-600 mb-1">
        {icon}
        <span className="text-xs sm:text-sm">{label}</span>
      </div>
      <p className="text-xl sm:text-2xl font-bold text-gray-900">{value}</p>
    </div>
  )
}
