/**
 * @fileoverview Feedback detail page showing single feedback item.
 *
 * Features:
 * - Full feedback details with metadata
 * - Suggested response templates by category
 * - Similar feedback items tab
 * - Copy-to-clipboard for responses
 *
 * @module pages/FeedbackDetail
 */

import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, ExternalLink, Star, Clock, Globe, Users, Tag,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useParams, Link, useNavigate,
} from 'react-router-dom'
import { api } from '../../api/client'
import PageLoader from '../../components/PageLoader'
import SentimentBadge from '../../components/SentimentBadge'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { getSourceIcon } from '../../lib/sourceFormat'
import { useConfigStore } from '../../store/configStore'
import { safeFormatDate } from '../../utils/dateUtils'
import { getResponses } from './feedbackDetailHelpers'
import {
  SuggestedResponsesSection, SimilarFeedbackSection,
} from './SimilarFeedbackSection'
import type { FeedbackItem } from '../../api/types'

// Not Found Component
function FeedbackNotFound() {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="text-center py-12">
      <p className="text-gray-500">{t('notFound')}</p>
      <Link to="/feedback" className="text-blue-600 hover:underline mt-2 inline-block">
        {t('backToList')}
      </Link>
    </div>
  )
}

// Header Component
function FeedbackHeader({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
      <div className="flex items-center gap-3">
        <span className="text-xl sm:text-2xl flex-shrink-0">
          {getSourceIcon(feedback.source_platform)}
        </span>
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-bold text-gray-900 capitalize truncate">
            {feedback.source_platform.replace('_', ' ')} {feedback.source_channel}
          </h1>
          <p className="text-gray-500 text-xs sm:text-sm truncate">ID: {feedback.feedback_id}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {feedback.urgency === 'high' && (
          <span className="badge badge-urgent">{t('urgent')}</span>
        )}
        <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} size="md" />
      </div>
    </div>
  )
}

// Rating Component
function RatingDisplay({ rating }: Readonly<{ rating: number | null | undefined }>) {
  const { t } = useTranslation('feedbackDetail')
  if (rating == null) return null
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-sm text-gray-500">{t('rating')}:</span>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((starNum) => (
          <Star
            key={`star-${starNum}`}
            size={18}
            className={starNum <= rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
          />
        ))}
      </div>
    </div>
  )
}

// Original Text Component
function OriginalTextSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="bg-gray-50 rounded-lg p-4 mb-6">
      <h3 className="text-sm font-medium text-gray-500 mb-2">{t('originalFeedback')}</h3>
      <p className="text-gray-900 whitespace-pre-wrap">{feedback.original_text}</p>
      {feedback.original_language !== 'en' && feedback.normalized_text != null && feedback.normalized_text !== '' ? <div className="mt-4 pt-4 border-t border-gray-200">
        <h4 className="text-sm font-medium text-gray-500 mb-2">
          {t('translatedFrom', { language: feedback.original_language })}
        </h4>
        <p className="text-gray-700">{feedback.normalized_text}</p>
      </div> : null}
    </div>
  )
}

// Classification Section
function ClassificationSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-500 mb-2 sm:mb-3">{t('classification')}</h3>
      <div className="space-y-2 text-sm sm:text-base">
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">{t('category')}</span>
          <span className="font-medium text-right">{feedback.category}</span>
        </div>
        {feedback.subcategory != null && feedback.subcategory !== '' ? <div className="flex justify-between gap-2">
          <span className="text-gray-600">{t('subcategory')}</span>
          <span className="font-medium text-right">{feedback.subcategory}</span>
        </div> : null}
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">{t('journeyStage')}</span>
          <span className="font-medium text-right">{feedback.journey_stage}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">{t('impactArea')}</span>
          <span className="font-medium text-right">{feedback.impact_area}</span>
        </div>
      </div>
    </div>
  )
}

// Persona Section
function PersonaSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-500 mb-2 sm:mb-3">{t('customerPersona')}</h3>
      <div className="space-y-2 text-sm sm:text-base">
        {feedback.persona_name != null && feedback.persona_name !== '' ? <div className="flex justify-between gap-2">
          <span className="text-gray-600">{t('persona')}</span>
          <span className="font-medium text-right">{feedback.persona_name}</span>
        </div> : null}
        {feedback.persona_type != null && feedback.persona_type !== '' ? <div className="flex justify-between gap-2">
          <span className="text-gray-600">{t('type')}</span>
          <span className="font-medium text-right">{feedback.persona_type}</span>
        </div> : null}
      </div>
    </div>
  )
}

// Problem Analysis Section
function ProblemAnalysisSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  if ((feedback.problem_summary == null || feedback.problem_summary === '') && (feedback.problem_root_cause_hypothesis == null || feedback.problem_root_cause_hypothesis === '')) return null
  return (
    <div className="bg-orange-50 rounded-lg p-4 mb-6">
      <h3 className="text-sm font-medium text-orange-800 mb-2">{t('problemAnalysis')}</h3>
      {feedback.problem_summary != null && feedback.problem_summary !== '' ? <p className="text-orange-900 mb-2"><strong>{t('issue')}</strong> {feedback.problem_summary}</p> : null}
      {feedback.problem_root_cause_hypothesis != null && feedback.problem_root_cause_hypothesis !== '' ? <p className="text-orange-800 text-sm"><strong>{t('possibleRootCause')}</strong> {feedback.problem_root_cause_hypothesis}</p> : null}
    </div>
  )
}

// Tags Section
interface TagsSectionProps {
  readonly feedback: FeedbackItem
  readonly onTagClick: (type: string, value: string) => void
}

function TagsSection({
  feedback, onTagClick,
}: TagsSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="mb-4 sm:mb-6">
      <h3 className="text-sm font-medium text-gray-500 mb-2 sm:mb-3 flex items-center gap-2">
        <Tag size={14} />
        {t('tagsAndFilters')}
      </h3>
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        <button
          onClick={() => onTagClick('category', feedback.category)}
          className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-blue-100 text-blue-800 rounded-full text-xs sm:text-sm font-medium hover:bg-blue-200 transition-colors cursor-pointer active:scale-95"
        >
          {feedback.category}
        </button>
        {feedback.subcategory != null && feedback.subcategory !== '' ? <button
          onClick={() => onTagClick('keyword', feedback.subcategory ?? '')}
          className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-purple-100 text-purple-800 rounded-full text-xs sm:text-sm font-medium hover:bg-purple-200 transition-colors cursor-pointer active:scale-95"
        >
          {feedback.subcategory}
        </button> : null}
        <button
          onClick={() => onTagClick('source', feedback.source_platform)}
          className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-green-100 text-green-800 rounded-full text-xs sm:text-sm font-medium hover:bg-green-200 transition-colors cursor-pointer active:scale-95"
        >
          {feedback.source_platform}
        </button>
        {feedback.persona_name != null && feedback.persona_name !== '' ? <span className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-indigo-100 text-indigo-800 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1">
          <Users size={12} />
          {feedback.persona_name}
        </span> : null}
        <span className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-gray-100 text-gray-700 rounded-full text-xs sm:text-sm font-medium">
          {feedback.journey_stage}
        </span>
        {feedback.urgency === 'high' && (
          <span className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-red-100 text-red-800 rounded-full text-xs sm:text-sm font-medium">
            🔥 {t('urgent')}
          </span>
        )}
      </div>
    </div>
  )
}

// Metadata Section
function MetadataSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-4 text-xs sm:text-sm text-gray-500 pt-3 sm:pt-4 border-t border-gray-100">
      <div className="flex items-center gap-1">
        <Clock size={14} className="flex-shrink-0" />
        <span className="truncate">{t('created', { date: safeFormatDate(feedback.source_created_at, 'PPpp', t('unknown')) })}</span>
      </div>
      <div className="flex items-center gap-1">
        <Globe size={14} className="flex-shrink-0" />
        <span>{t('language', { lang: feedback.original_language })}</span>
      </div>
      {feedback.source_url != null && feedback.source_url !== '' ? <a
        href={feedback.source_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-blue-600 hover:underline"
      >
        <ExternalLink size={14} className="flex-shrink-0" />
        {t('viewOriginal')}
      </a> : null}
    </div>
  )
}

function getTagRoute(type: string, value: string): string | undefined {
  const encoded = encodeURIComponent(value)
  const routes: Record<string, string> = {
    category: `/feedback?category=${encoded}`,
    keyword: `/feedback?q=${encoded}`,
    source: `/feedback?source=${encoded}`,
  }
  if (Object.hasOwn(routes, type)) {
    return routes[type]
  }
  return undefined
}

// Main Component
export default function FeedbackDetail() {
  const { id } = useParams<{ id: string }>()
  const { config } = useConfigStore()
  const navigate = useNavigate()
  const {
    copy, copiedKey,
  } = useCopyToClipboard()
  const [activeTab, setActiveTab] = useState<'details' | 'similar'>('details')

  const hasValidId = id != null && id !== ''

  const {
    data: feedback, isLoading,
  } = useQuery({
    queryKey: ['feedback', id],
    queryFn: () => api.getFeedbackById(id ?? ''),
    enabled: config.apiEndpoint.length > 0 && hasValidId,
  })

  const { data: similarData } = useQuery({
    queryKey: ['feedback-similar', id],
    queryFn: () => api.getSimilarFeedback(id ?? '', 8),
    enabled: config.apiEndpoint.length > 0 && hasValidId && activeTab === 'similar',
  })

  const handleTagClick = (type: string, value: string) => {
    const route = getTagRoute(type, value)
    if (route != null) void navigate(route)
  }

  const copyResponse = (text: string, index: number) => {
    copy(text, String(index))
  }

  const toggleSimilarTab = () => {
    setActiveTab(activeTab === 'similar' ? 'details' : 'similar')
  }

  if (isLoading) return <PageLoader />
  if (!feedback) return <FeedbackNotFound />

  return <FeedbackDetailContent
    feedback={feedback}
    similarData={similarData}
    copiedKey={copiedKey}
    activeTab={activeTab}
    onTagClick={handleTagClick}
    onCopy={copyResponse}
    onToggleTab={toggleSimilarTab}
  />
}

function FeedbackDetailContent({
  feedback, similarData, copiedKey, activeTab, onTagClick, onCopy, onToggleTab,
}: Readonly<{
  feedback: FeedbackItem
  similarData: { items?: FeedbackItem[] } | undefined
  copiedKey: string | null
  activeTab: 'details' | 'similar'
  onTagClick: (type: string, value: string) => void
  onCopy: (text: string, index: number) => void
  onToggleTab: () => void
}>) {
  const { t } = useTranslation('feedbackDetail')
  const responses = getResponses(feedback.category)

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6 px-1 sm:px-0">
      <Link to="/feedback" className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 text-sm sm:text-base">
        <ArrowLeft size={18} />
        <span className="hidden xs:inline">{t('backToFeedback')}</span>
        <span className="xs:hidden">{t('back')}</span>
      </Link>

      <div className="card">
        <FeedbackHeader feedback={feedback} />
        <RatingDisplay rating={feedback.rating} />
        <OriginalTextSection feedback={feedback} />

        {feedback.direct_customer_quote != null && feedback.direct_customer_quote !== '' ? <blockquote className="border-l-4 border-blue-400 pl-4 mb-6 italic text-gray-700">
          "{feedback.direct_customer_quote}"
        </blockquote> : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 mb-4 sm:mb-6">
          <ClassificationSection feedback={feedback} />
          <PersonaSection feedback={feedback} />
        </div>

        <ProblemAnalysisSection feedback={feedback} />
        <TagsSection feedback={feedback} onTagClick={onTagClick} />
        <MetadataSection feedback={feedback} />
      </div>

      <SuggestedResponsesSection
        responses={responses}
        copiedKey={copiedKey}
        onCopy={onCopy}
      />

      <SimilarFeedbackSection
        activeTab={activeTab}
        onToggle={onToggleTab}
        similarItems={similarData?.items}
      />
    </div>
  )
}
