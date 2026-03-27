/**
 * @fileoverview PR/FAQ row component for the prioritization table.
 * @module pages/Prioritization/PRFAQRow
 */

import clsx from 'clsx'
import { format } from 'date-fns'
import {
  ChevronDown, ChevronUp, ExternalLink,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import {
  calculatePriorityScore, getPriorityLabel,
} from './prioritizationUtils'
import ScoreSlider from './ScoreSlider'
import type { PRFAQWithProject } from './prioritizationUtils'
import type { PrioritizationScore } from '../../api/types'
import type { ReactElement } from 'react'

function QuickScores({ score }: { readonly score: PrioritizationScore }): ReactElement {
  const { t } = useTranslation('prioritization')
  const priorityScore = score.impact > 0 ? calculatePriorityScore(score) : 0
  const showTTM = score.time_to_market !== 3 || score.impact > 0
  return (
    <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
      <div className="text-center">
        <div className={clsx('text-base sm:text-lg font-bold', score.impact > 0 ? 'text-blue-600' : 'text-gray-300')}>{score.impact === 0 ? '-' : score.impact}</div>
        <div className="text-xs text-gray-400">{t('scores.impact')}</div>
      </div>
      <div className="text-center">
        <div className={clsx('text-base sm:text-lg font-bold', showTTM ? 'text-purple-600' : 'text-gray-300')}>{score.impact > 0 ? score.time_to_market : '-'}</div>
        <div className="text-xs text-gray-400">{t('sort.ttm')}</div>
      </div>
      <div className="text-center px-2 sm:px-3 py-1 bg-gray-50 rounded-lg">
        <div className={clsx('text-lg sm:text-xl font-bold', priorityScore > 0 ? 'text-green-600' : 'text-gray-300')}>{priorityScore > 0 ? priorityScore.toFixed(1) : '-'}</div>
        <div className="text-xs text-gray-400">{t('scores.score')}</div>
      </div>
    </div>
  )
}

function PRFAQRowHeader({
  prfaq,
  index,
  priority,
  score,
  isExpanded,
  onToggle,
}: {
  readonly prfaq: PRFAQWithProject
  readonly index: number
  readonly priority: {
    label: string;
    color: string
  }
  readonly score: PrioritizationScore
  readonly isExpanded: boolean
  readonly onToggle: () => void
}) {
  return (
    <button type="button" className="w-full p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 cursor-pointer hover:bg-gray-50 text-left" onClick={onToggle}>
      <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
        <div className="text-gray-400 font-mono text-sm w-6 hidden sm:block">#{index + 1}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-gray-900 truncate text-sm sm:text-base">{prfaq.title}</h3>
            <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', priority.color)}>{priority.label}</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 mt-1 text-xs sm:text-sm text-gray-500">
            <span className="truncate">{prfaq.project_name}</span>
            <span>•</span>
            <span className="whitespace-nowrap">{format(new Date(prfaq.created_at), 'MMM d, yyyy')}</span>
          </div>
        </div>
      </div>
      <QuickScores score={score} />
      <div className="sm:ml-2">{isExpanded ? <ChevronUp size={20} className="text-gray-400" /> : <ChevronDown size={20} className="text-gray-400" />}</div>
    </button>
  )
}

function PRFAQRowExpanded({
  prfaq, score, onUpdateScore,
}: {
  readonly prfaq: PRFAQWithProject
  readonly score: PrioritizationScore
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  return (
    <div className="border-t px-3 sm:px-4 py-4 bg-gray-50">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="space-y-4">
          <h4 className="font-medium text-gray-900">{t('scores.title')}</h4>
          <ScoreSlider label={t('scores.impact')} value={score.impact === 0 ? 3 : score.impact} onChange={(v) => onUpdateScore('impact', v)} description={t('scores.impactDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <ScoreSlider label={t('scores.timeToMarket')} value={score.time_to_market === 0 ? 3 : score.time_to_market} onChange={(v) => onUpdateScore('time_to_market', v)} description={t('scores.timeToMarketDescription')} lowLabel={t('scores.slow')} highLabel={t('scores.fast')} />
          <ScoreSlider label={t('scores.strategicFit')} value={score.strategic_fit === 0 ? 3 : score.strategic_fit} onChange={(v) => onUpdateScore('strategic_fit', v)} description={t('scores.strategicFitDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <ScoreSlider label={t('scores.confidence')} value={score.confidence === 0 ? 3 : score.confidence} onChange={(v) => onUpdateScore('confidence', v)} description={t('scores.confidenceDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
          <div>
            <label className="text-sm font-medium text-gray-700">{t('notes.label')}</label>
            <textarea value={score.notes} onChange={(e) => onUpdateScore('notes', e.target.value)} placeholder={t('notes.placeholder')} rows={2} className="mt-1 w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-gray-900">{t('preview.title')}</h4>
            <a href={`/projects/${prfaq.project_id}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
              <span className="hidden sm:inline">{t('preview.viewFull')}</span>
              <span className="sm:hidden">{t('preview.viewMobile')}</span>
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="bg-white rounded-lg border p-3 sm:p-4 max-h-48 sm:max-h-64 overflow-y-auto prose prose-sm">
            <ReactMarkdown>{prfaq.content.slice(0, 1500) + (prfaq.content.length > 1500 ? '...' : '')}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PRFAQRow({
  prfaq, index, score, isExpanded, onToggle, onUpdateScore,
}: {
  readonly prfaq: PRFAQWithProject
  readonly index: number
  readonly score: PrioritizationScore
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  const priorityScore = score.impact > 0 ? calculatePriorityScore(score) : 0
  const priority = getPriorityLabel(priorityScore, t)

  return (
    <div className="bg-white rounded-lg border shadow-sm">
      <PRFAQRowHeader prfaq={prfaq} index={index} priority={priority} score={score} isExpanded={isExpanded} onToggle={onToggle} />
      {isExpanded ? <PRFAQRowExpanded prfaq={prfaq} score={score} onUpdateScore={onUpdateScore} /> : null}
    </div>
  )
}
