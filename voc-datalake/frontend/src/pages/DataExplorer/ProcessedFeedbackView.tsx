/**
 * @fileoverview Processed Feedback View component for Data Explorer.
 * @module pages/DataExplorer/ProcessedFeedbackView
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Database, ChevronRight, ChevronDown, Eye, Pencil, Loader2, AlertTriangle, type LucideIcon } from 'lucide-react'
import type { FeedbackItem } from '../../api/types'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import { safeFormatDate } from '../../utils/dateUtils'

interface ProcessedFeedbackViewProps {
  readonly data: { count: number; items: FeedbackItem[] } | undefined
  readonly loading: boolean
  readonly searchQuery: string
  readonly onView: (item: FeedbackItem) => void
  readonly onEdit: (item: FeedbackItem) => void
}

export default function ProcessedFeedbackView({ data, loading, searchQuery, onView, onEdit }: ProcessedFeedbackViewProps) {
  const { t } = useTranslation('dataExplorer')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (loading) {
    return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-accent" size={24} /></div>
  }

  const items = data?.items ?? []
  const query = searchQuery.toLowerCase()
  const filtered = query
    ? items.filter(i =>
        i.original_text.toLowerCase().includes(query) ||
        i.category.toLowerCase().includes(query)
      )
    : items

  if (filtered.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <Database size={20} className="mx-auto mb-3 text-muted" aria-hidden="true" />
        <p className="text-sm font-medium text-text-strong">{t('feedback.noFeedback')}</p>
        <p className="text-sm text-muted mt-1">{t('feedback.noFeedbackHint')}</p>
      </div>
    )
  }

  const toggleExpanded = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  return (
    <div>
      <div className="bg-bg-accent px-4 py-2.5 border-b border-border text-xs text-muted" aria-live="polite">
        {t('feedback.showingRecords', { filtered: filtered.length, total: data?.count ?? 0 })}
      </div>
      <ul className="divide-y divide-border max-h-[600px] overflow-y-auto">
        {filtered.map((item) => (
          <FeedbackRow
            key={item.feedback_id}
            item={item}
            isExpanded={expandedId === item.feedback_id}
            onToggleExpand={() => toggleExpanded(item.feedback_id)}
            onView={onView}
            onEdit={onEdit}
          />
        ))}
      </ul>
    </div>
  )
}

interface FeedbackRowProps {
  readonly item: FeedbackItem
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onView: (item: FeedbackItem) => void
  readonly onEdit: (item: FeedbackItem) => void
}

function RowAction({ icon: Icon, label, onClick, className, ...aria }: Readonly<{
  icon: LucideIcon
  label: string
  onClick: () => void
  className?: string
  'aria-expanded'?: boolean
  'aria-controls'?: string
}>) {
  return (
    <button type="button" onClick={onClick} className={clsx('icon-btn p-2', className)} title={label} aria-label={label} {...aria}>
      <Icon size={16} />
    </button>
  )
}

function FeedbackRow({ item, isExpanded, onToggleExpand, onView, onEdit }: FeedbackRowProps) {
  const { t } = useTranslation('dataExplorer')
  const detailsId = useId()
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        {/* Clicking the summary toggles details too, but the chevron button below is
            the keyboard-reachable control for it, so this stays a plain region. */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="badge badge-muted font-mono">{item.source_platform}</span>
            <span className="text-xs text-muted">{safeFormatDate(item.source_created_at, 'MMM d, yyyy HH:mm')}</span>
            <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
          </div>
          <p className="text-sm text-text-strong line-clamp-2">{item.original_text}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className="text-xs text-muted">{t('feedback.category', { category: item.category })}</span>
            {item.urgency === 'high' && (
              <span className="badge badge-danger inline-flex items-center gap-1"><AlertTriangle size={12} aria-hidden="true" />{t('feedback.urgent')}</span>
            )}
          </div>
        </div>
        <div className="flex items-center flex-shrink-0 -mr-2">
          <RowAction icon={Eye} label={t('feedback.view')} onClick={() => onView(item)} className="hover:text-accent-text" />
          <RowAction icon={Pencil} label={t('feedback.edit')} onClick={() => onEdit(item)} className="hover:text-accent-text" />
          <RowAction
            icon={isExpanded ? ChevronDown : ChevronRight}
            label={isExpanded ? t('feedback.hideDetails') : t('feedback.showDetails')}
            onClick={onToggleExpand}
            aria-expanded={isExpanded}
            aria-controls={detailsId}
          />
        </div>
      </div>
      {isExpanded && (
        <div id={detailsId} className="mt-3 p-3 bg-bg-accent border border-border rounded-lg text-xs">
          <pre className="font-mono whitespace-pre-wrap overflow-x-auto text-text">{JSON.stringify(item, null, 2)}</pre>
        </div>
      )}
    </li>
  )
}
