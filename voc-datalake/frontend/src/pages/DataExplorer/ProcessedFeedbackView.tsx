/**
 * @fileoverview Processed Feedback View component for Data Explorer.
 * @module pages/DataExplorer/ProcessedFeedbackView
 */

import { useState } from 'react'
import { Database, ChevronRight, ChevronDown, Eye, Pencil, Trash2, Loader2 } from 'lucide-react'
import type { FeedbackItem } from '../../api/client'
import SentimentBadge from '../../components/SentimentBadge'
import { safeFormatDate } from '../../utils/dateUtils'

interface ProcessedFeedbackViewProps {
  readonly data: { count: number; items: FeedbackItem[] } | undefined
  readonly loading: boolean
  readonly searchQuery: string
  readonly onView: (item: FeedbackItem) => void
  readonly onEdit: (item: FeedbackItem) => void
  readonly onDelete: (item: FeedbackItem) => void
}

export default function ProcessedFeedbackView({ data, loading, searchQuery, onView, onEdit, onDelete }: ProcessedFeedbackViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (loading) {
    return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-gray-400" size={32} /></div>
  }

  const items = data?.items ?? []
  const filtered = searchQuery
    ? items.filter(i =>
        i.original_text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        i.category?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : items

  if (filtered.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Database size={48} className="mx-auto mb-4 opacity-50" />
        <p>No feedback found</p>
      </div>
    )
  }

  const toggleExpanded = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  return (
    <div>
      <div className="bg-gray-50 px-4 py-3 border-b text-sm text-gray-600">
        Showing {filtered.length} of {data?.count ?? 0} records
      </div>
      <div className="divide-y max-h-[600px] overflow-y-auto">
        {filtered.map((item) => (
          <FeedbackRow
            key={item.feedback_id}
            item={item}
            isExpanded={expandedId === item.feedback_id}
            onToggleExpand={() => toggleExpanded(item.feedback_id)}
            onView={onView}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  )
}

interface FeedbackRowProps {
  readonly item: FeedbackItem
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onView: (item: FeedbackItem) => void
  readonly onEdit: (item: FeedbackItem) => void
  readonly onDelete: (item: FeedbackItem) => void
}

function FeedbackRow({ item, isExpanded, onToggleExpand, onView, onEdit, onDelete }: FeedbackRowProps) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium px-2 py-0.5 bg-gray-100 rounded">{item.source_platform}</span>
            <span className="text-xs text-gray-500">{safeFormatDate(item.source_created_at, 'MMM d, yyyy HH:mm')}</span>
            <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
          </div>
          <p className="text-sm text-gray-900 line-clamp-2">{item.original_text}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-gray-500">Category: {item.category}</span>
            {item.urgency === 'high' && (
              <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded">Urgent</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2">
          <button onClick={() => onView(item)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="View">
            <Eye size={16} />
          </button>
          <button onClick={() => onEdit(item)} className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded" title="Edit">
            <Pencil size={16} />
          </button>
          <button onClick={() => onDelete(item)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete">
            <Trash2 size={16} />
          </button>
          <button onClick={onToggleExpand} className="p-1 text-gray-400">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="mt-3 p-3 bg-gray-50 rounded-lg text-xs">
          <pre className="whitespace-pre-wrap overflow-x-auto">{JSON.stringify(item, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
