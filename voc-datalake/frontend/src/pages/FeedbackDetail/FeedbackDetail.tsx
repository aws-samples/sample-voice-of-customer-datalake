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

import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Clock, Globe, Users, Tag, Inbox, Flame } from 'lucide-react'
import { format } from 'date-fns'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import RatingStars from '../../components/RatingStars'
import CategoryChangeControl, { ManualCategoryBadge } from '../../components/CategoryChangeControl/CategoryChangeControl'
import FeedbackDimensionChips from '../../components/FeedbackDimensions/FeedbackDimensionChips'
import DimensionsEditControl from '../../components/FeedbackDimensions/DimensionsEditControl'
import { SourceIcon } from '../../components/SourceIcon/SourceIcon'
import { SimilarFeedbackSection, SuggestedResponsesSection } from './FeedbackDetailSections'

/** Categories with tailored reply templates in `feedbackDetail:responses`. */
const RESPONSE_CATEGORIES = new Set(['delivery', 'customer_support', 'product_quality', 'pricing'])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function getResponses(category: string, t: TFunction): string[] {
  const key = RESPONSE_CATEGORIES.has(category) ? category : 'default'
  const value: unknown = t(`feedbackDetail:responses.${key}`, { returnObjects: true })
  return isStringArray(value) ? value : []
}

function LoadingSpinner() {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="flex items-center justify-center h-full py-12" role="status">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" aria-hidden="true" />
      <span className="sr-only">{t('loading')}</span>
    </div>
  )
}

function FeedbackNotFound() {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="card flex flex-col items-center text-center py-12 gap-2">
      <Inbox size={24} className="text-muted" aria-hidden="true" />
      <p className="text-sm font-medium text-text-strong">{t('notFound')}</p>
      <Link to="/categories" className="btn btn-secondary btn-sm mt-2">
        <ArrowLeft size={14} aria-hidden="true" />
        {t('backToList')}
      </Link>
    </div>
  )
}

function FeedbackHeader({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  const title = `${feedback.source_platform.replace(/_/g, ' ')} ${feedback.source_channel}`.trim()
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center">
          <SourceIcon platform={feedback.source_platform} channel={feedback.source_channel} size={20} />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-strong capitalize truncate" title={title}>
            {title}
          </h1>
          <p className="text-muted font-mono text-xs sm:text-sm truncate" title={feedback.feedback_id}>
            {t('sourceId', { id: feedback.feedback_id })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {feedback.urgency === 'high' && (
          <span className="badge badge-warn">{t('urgent')}</span>
        )}
        <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} size="md" />
      </div>
    </div>
  )
}

function RatingDisplay({ rating }: Readonly<{ rating: number | null | undefined }>) {
  const { t } = useTranslation('feedbackDetail')
  if (!rating) return null
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-sm text-muted">{t('rating')}:</span>
      <RatingStars rating={rating} size={16} />
    </div>
  )
}

/** Section label inside the main card — an h2 under the page h1. */
const SECTION_LABEL = 'text-sm font-medium text-muted mb-2 sm:mb-3'

function OriginalTextSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="bg-bg-accent border border-border rounded-lg p-4 mb-6">
      <h2 className="text-sm font-medium text-muted mb-2">{t('originalFeedback')}</h2>
      <p className="text-text-strong whitespace-pre-wrap">{feedback.original_text}</p>
      {feedback.original_language !== 'en' && feedback.normalized_text && (
        <div className="mt-4 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-muted mb-2">
            {t('translatedFrom', { language: feedback.original_language })}
          </h3>
          <p className="text-text">{feedback.normalized_text}</p>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: Readonly<{ label: string; value: string | null | undefined }>) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text">{label}</span>
      <span className="font-medium text-right text-text-strong min-w-0 break-words">{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}

function ClassificationSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div>
      <h2 className={SECTION_LABEL}>{t('classification')}</h2>
      <div className="space-y-2 text-sm">
        <DetailRow label={t('category')} value={feedback.category} />
        {feedback.subcategory && <DetailRow label={t('subcategory')} value={feedback.subcategory} />}
        <DetailRow label={t('journeyStage')} value={feedback.journey_stage} />
        <DetailRow label={t('impactArea')} value={feedback.impact_area} />
        {feedback.author !== undefined && <DetailRow label={t('author')} value={feedback.author} />}
        {feedback.title !== undefined && <DetailRow label={t('reviewTitle')} value={feedback.title} />}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ManualCategoryBadge feedback={feedback} />
          <CategoryChangeControl feedback={feedback} />
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <FeedbackDimensionChips feedback={feedback} />
          <DimensionsEditControl feedback={feedback} />
        </div>
      </div>
    </div>
  )
}

function PersonaSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div>
      <h2 className={SECTION_LABEL}>{t('customerPersona')}</h2>
      <div className="space-y-2 text-sm">
        {feedback.persona_name && <DetailRow label={t('persona')} value={feedback.persona_name} />}
        {feedback.persona_type && <DetailRow label={t('type')} value={feedback.persona_type} />}
        {!feedback.persona_name && !feedback.persona_type && <p className="text-muted">—</p>}
      </div>
    </div>
  )
}

function ProblemAnalysisSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  if (!feedback.problem_summary && !feedback.problem_root_cause_hypothesis) return null
  return (
    <div className="bg-warn-subtle border border-warn/30 rounded-lg p-4 mb-6">
      <h2 className="text-sm font-medium text-warn mb-2">{t('problemAnalysis')}</h2>
      {feedback.problem_summary && (
        <p className="text-text-strong mb-2"><strong>{t('issue')}</strong> {feedback.problem_summary}</p>
      )}
      {feedback.problem_root_cause_hypothesis && (
        <p className="text-text text-sm"><strong>{t('possibleRootCause')}</strong> {feedback.problem_root_cause_hypothesis}</p>
      )}
    </div>
  )
}

// Tags Section
interface TagsSectionProps {
  readonly feedback: FeedbackItem
  readonly onTagClick: (type: string, value: string) => void
}

function TagsSection({ feedback, onTagClick }: TagsSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="mb-4 sm:mb-6">
      <h2 className={`${SECTION_LABEL} flex items-center gap-2`}>
        <Tag size={14} aria-hidden="true" />
        {t('tagsAndFilters')}
      </h2>
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={() => onTagClick('category', feedback.category)}
          className="px-3 py-1.5 bg-accent-subtle text-accent-text rounded-full text-xs sm:text-sm font-medium hover:bg-accent/25 focus-ring transition-colors cursor-pointer active:scale-95"
        >
          {feedback.category}
        </button>
        {feedback.subcategory && (
          <button
            type="button"
            onClick={() => onTagClick('keyword', feedback.subcategory ?? '')}
            className="px-3 py-1.5 bg-info-subtle text-info rounded-full text-xs sm:text-sm font-medium hover:bg-info/25 focus-ring transition-colors cursor-pointer active:scale-95"
          >
            {feedback.subcategory}
          </button>
        )}
        <button
          type="button"
          onClick={() => onTagClick('source', feedback.source_platform)}
          className="px-3 py-1.5 bg-bg-hover text-text border border-border rounded-full text-xs sm:text-sm font-medium hover:border-border-strong focus-ring transition-colors cursor-pointer active:scale-95"
        >
          {feedback.source_platform}
        </button>
        {feedback.persona_name && (
          <span className="px-3 py-1.5 bg-aim-subtle text-aim rounded-full text-xs sm:text-sm font-medium flex items-center gap-1">
            <Users size={12} aria-hidden="true" />
            {feedback.persona_name}
          </span>
        )}
        {feedback.journey_stage && (
          <span className="px-3 py-1.5 bg-bg-hover text-muted rounded-full text-xs sm:text-sm font-medium">
            {feedback.journey_stage}
          </span>
        )}
        {feedback.urgency === 'high' && (
          <span className="inline-flex items-center gap-1 px-3 py-1.5 bg-warn-subtle text-warn rounded-full text-xs sm:text-sm font-medium">
            <Flame size={14} aria-hidden="true" />{t('urgent')}
          </span>
        )}
      </div>
    </div>
  )
}

// Helper to safely format dates
function formatDateSafe(dateString: string | null | undefined, unknown: string): string {
  if (!dateString) return unknown
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) return unknown
    return format(date, 'PPpp')
  } catch {
    return unknown
  }
}

function MetadataSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  const unknown = t('unknown')
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-4 text-xs sm:text-sm text-muted pt-3 sm:pt-4 border-t border-border">
      <div className="flex items-center gap-1 min-w-0">
        <Clock size={14} className="flex-shrink-0" aria-hidden="true" />
        <span className="truncate" title={t('reviewDateHint')}>
          {t('reviewDate', { date: formatDateSafe(feedback.source_created_at, unknown) })}
        </span>
      </div>
      <div className="flex items-center gap-1 min-w-0">
        <Clock size={14} className="flex-shrink-0" aria-hidden="true" />
        <span className="truncate" title={t('importedHint')}>
          {t('imported', { date: formatDateSafe(feedback.processed_at, unknown) })}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Globe size={14} className="flex-shrink-0" aria-hidden="true" />
        <span>{t('language', { lang: feedback.original_language || unknown })}</span>
      </div>
      {feedback.source_url && (
        <a
          href={feedback.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 link focus-ring rounded-sm sm:ml-auto"
        >
          <ExternalLink size={14} className="flex-shrink-0" aria-hidden="true" />
          {t('viewOriginal')}
        </a>
      )}
    </div>
  )
}

// Main Component
export default function FeedbackDetail() {
  const { id } = useParams<{ id: string }>()
  const { config } = useConfigStore()
  const navigate = useNavigate()
  const { t } = useTranslation('feedbackDetail')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'details' | 'similar'>('details')

  const { data: feedback, isLoading } = useQuery({
    queryKey: ['feedback', id],
    queryFn: () => api.getFeedbackById(id ?? ''),
    enabled: !!config.apiEndpoint && !!id,
  })

  const { data: similarData, isLoading: similarLoading, isError: similarError } = useQuery({
    queryKey: ['feedback-similar', id],
    queryFn: () => api.getSimilarFeedback(id ?? '', 8),
    enabled: !!config.apiEndpoint && !!id && activeTab === 'similar',
  })

  // Tag clicks deep-link into the consolidated Categories page (issue #198),
  // which reads these params via useCategoryFilters.
  const handleTagClick = (type: string, value: string) => {
    if (type === 'category') {
      void navigate(`/categories?category=${encodeURIComponent(value)}`)
    } else if (type === 'keyword') {
      void navigate(`/categories?q=${encodeURIComponent(value)}`)
    } else if (type === 'source') {
      void navigate(`/categories?source=${encodeURIComponent(value)}`)
    }
  }

  const copyResponse = (text: string, index: number) => {
    void navigator.clipboard.writeText(text)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const toggleSimilarTab = () => {
    setActiveTab(activeTab === 'similar' ? 'details' : 'similar')
  }

  if (isLoading) return <LoadingSpinner />
  if (!feedback) return <FeedbackNotFound />

  const responses = getResponses(feedback.category, t)

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <Link to="/categories" className="btn btn-ghost btn-sm -ml-2">
        <ArrowLeft size={16} aria-hidden="true" />
        {t('backToFeedback')}
      </Link>

      <div className="card">
        <FeedbackHeader feedback={feedback} />
        <RatingDisplay rating={feedback.rating} />
        <OriginalTextSection feedback={feedback} />

        {feedback.direct_customer_quote && (
          <blockquote className="border-l-4 border-accent pl-4 mb-6 italic text-text">
            "{feedback.direct_customer_quote}"
          </blockquote>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 mb-4 sm:mb-6">
          <ClassificationSection feedback={feedback} />
          <PersonaSection feedback={feedback} />
        </div>

        <ProblemAnalysisSection feedback={feedback} />
        <TagsSection feedback={feedback} onTagClick={handleTagClick} />
        <MetadataSection feedback={feedback} />
      </div>

      <SuggestedResponsesSection
        responses={responses}
        copiedIndex={copiedIndex}
        onCopy={copyResponse}
      />

      <SimilarFeedbackSection
        activeTab={activeTab}
        onToggle={toggleSimilarTab}
        similarItems={similarData?.items}
        isLoading={similarLoading}
        isError={similarError}
      />
    </div>
  )
}
