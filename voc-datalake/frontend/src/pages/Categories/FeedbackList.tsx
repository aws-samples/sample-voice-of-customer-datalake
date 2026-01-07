import { useState } from 'react'
import { ChevronDown, ChevronUp, MessageSquare, Star, ExternalLink } from 'lucide-react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import type { FeedbackItem } from '../../api/client'
import { getSentimentColorClass } from './types'

interface FeedbackListProps {
  readonly feedback: FeedbackItem[]
  readonly selectedCategories: string[]
}

export function FeedbackList({ feedback, selectedCategories }: FeedbackListProps) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  if (selectedCategories.length === 0) {
    return (
      <div className="card text-center py-8 sm:py-12">
        <MessageSquare size={36} className="sm:w-12 sm:h-12 mx-auto text-gray-300 mb-3 sm:mb-4" />
        <p className="text-gray-500 text-sm sm:text-base">Select categories above to view feedback</p>
      </div>
    )
  }

  if (feedback.length === 0) {
    return (
      <div className="card text-center py-8 sm:py-12">
        <MessageSquare size={36} className="sm:w-12 sm:h-12 mx-auto text-gray-300 mb-3 sm:mb-4" />
        <p className="text-gray-500 text-sm sm:text-base">No feedback found for selected categories</p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 sm:mb-4">
        <h2 className="text-base sm:text-lg font-semibold">
          Feedback ({feedback.length})
        </h2>
        <span className="text-xs sm:text-sm text-gray-500">
          Showing feedback for: {selectedCategories.map(c => c.replace('_', ' ')).join(', ')}
        </span>
      </div>
      <div className="space-y-3 sm:space-y-4 max-h-[500px] sm:max-h-[600px] overflow-y-auto pr-1 sm:pr-2">
        {feedback.map((item) => (
          <FeedbackCard
            key={item.feedback_id}
            item={item}
            isExpanded={expandedItems.has(item.feedback_id)}
            onToggle={() => toggleExpand(item.feedback_id)}
          />
        ))}
      </div>
    </div>
  )
}

function FeedbackCard({
  item,
  isExpanded,
  onToggle,
}: Readonly<{
  item: FeedbackItem
  isExpanded: boolean
  onToggle: () => void
}>) {
  const sentimentClass = getSentimentColorClass(item.sentiment_label)
  const text = item.original_text
  const truncatedText = text.length > 150 ? text.slice(0, 150) + '...' : text

  return (
    <div className="border border-gray-200 rounded-lg p-3 sm:p-4 hover:border-gray-300 transition-colors">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-1.5 sm:mb-2">
            <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium', sentimentClass)}>
              {item.sentiment_label}
            </span>
            <span className="px-2 py-0.5 bg-gray-100 rounded-full text-xs capitalize">
              {item.source_platform}
            </span>
            {item.rating != null && (
              <span className="flex items-center gap-0.5 text-xs text-yellow-600">
                <Star size={12} fill="currentColor" />
                {item.rating}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-700">{isExpanded ? text : truncatedText}</p>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-start">
          <Link
            to={`/feedback/${item.feedback_id}`}
            className="p-1.5 sm:p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="View details"
          >
            <ExternalLink size={14} className="sm:w-4 sm:h-4 text-gray-500" />
          </Link>
          <button
            onClick={onToggle}
            className="p-1.5 sm:p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            {isExpanded ? <ChevronUp size={14} className="sm:w-4 sm:h-4" /> : <ChevronDown size={14} className="sm:w-4 sm:h-4" />}
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-gray-500">Category:</span> <span className="capitalize">{item.category}</span></div>
          <div><span className="text-gray-500">Date:</span> {new Date(item.source_created_at).toLocaleDateString()}</div>
          {item.problem_summary && (
            <div className="col-span-2"><span className="text-gray-500">Issue:</span> {item.problem_summary}</div>
          )}
        </div>
      )}
    </div>
  )
}
