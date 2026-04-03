/**
 * @fileoverview Similar feedback and suggested responses sections.
 * @module pages/FeedbackDetail/SimilarFeedbackSection
 */

import {
  Copy, Check, MessageCircle, TrendingUp,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import SentimentBadge from '../../components/SentimentBadge'
import type { FeedbackItem } from '../../api/types'

// Suggested Responses Section
interface SuggestedResponsesSectionProps {
  readonly responses: string[]
  readonly copiedKey: string | null
  readonly onCopy: (text: string, index: number) => void
}

export function SuggestedResponsesSection({
  responses, copiedKey, onCopy,
}: SuggestedResponsesSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="card">
      <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
        <MessageCircle size={18} className="sm:w-5 sm:h-5" />
        {t('suggestedResponses')}
      </h2>
      <p className="text-xs sm:text-sm text-gray-500 mb-3 sm:mb-4">
        {t('suggestedResponsesHint')}
      </p>
      <div className="space-y-2 sm:space-y-3">
        {responses.map((response) => {
          const idx = responses.indexOf(response)
          return (
            <div key={response} className="bg-gray-50 rounded-lg p-3 sm:p-4 flex items-start gap-2 sm:gap-3">
              <p className="flex-1 text-sm sm:text-base text-gray-700">{response}</p>
              <button
                onClick={() => onCopy(response, idx)}
                className="flex-shrink-0 p-1.5 sm:p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-lg transition-colors active:scale-95"
                title={t('copyToClipboard')}
              >
                {copiedKey === String(idx) ? <Check size={16} className="sm:w-[18px] sm:h-[18px] text-green-600" /> : <Copy size={16} className="sm:w-[18px] sm:h-[18px]" />}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Similar Feedback Section
interface SimilarFeedbackSectionProps {
  readonly activeTab: 'details' | 'similar'
  readonly onToggle: () => void
  readonly similarItems: FeedbackItem[] | undefined
}

export function SimilarFeedbackSection({
  activeTab, onToggle, similarItems,
}: SimilarFeedbackSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
        <h2 className="text-base sm:text-lg font-semibold flex items-center gap-2">
          <TrendingUp size={18} className="sm:w-5 sm:h-5" />
          <span className="hidden xs:inline">{t('similarFeedback')}</span>
          <span className="xs:hidden">{t('similar')}</span>
        </h2>
        <button
          onClick={onToggle}
          className="text-xs sm:text-sm text-blue-600 hover:text-blue-700 whitespace-nowrap"
        >
          {activeTab === 'similar' ? t('hide') : t('show')}
        </button>
      </div>

      {activeTab === 'similar' && (
        <SimilarFeedbackList items={similarItems} />
      )}
    </div>
  )
}

function SimilarFeedbackList({ items }: Readonly<{ items: FeedbackItem[] | undefined }>) {
  const { t } = useTranslation('feedbackDetail')
  if (!items || items.length === 0) {
    return (
      <p className="text-xs sm:text-sm text-gray-500 text-center py-4">
        {t('loadingSimilar')}
      </p>
    )
  }

  return (
    <div className="space-y-2 sm:space-y-3">
      {items.map((item) => (
        <Link
          key={item.feedback_id}
          to={`/feedback/${item.feedback_id}`}
          className="block p-2.5 sm:p-3 bg-gray-50 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors"
        >
          <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
            <span className="text-xs text-gray-500 capitalize">{item.source_platform}</span>
            <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
          </div>
          <p className="text-xs sm:text-sm text-gray-700 line-clamp-2">{item.original_text}</p>
          <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-1.5 sm:mt-2">
            <span className="text-xs px-1.5 sm:px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{item.category}</span>
            {item.urgency === 'high' && (
              <span className="text-xs px-1.5 sm:px-2 py-0.5 bg-red-100 text-red-700 rounded">{t('urgent')}</span>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}
