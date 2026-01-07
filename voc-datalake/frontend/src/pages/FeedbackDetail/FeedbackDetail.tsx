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
import { ArrowLeft, ExternalLink, Copy, Check, MessageCircle, Star, Clock, Globe, Users, Tag, TrendingUp } from 'lucide-react'
import { format } from 'date-fns'
import { useState } from 'react'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import SentimentBadge from '../../components/SentimentBadge'

const suggestedResponses: Record<string, string[]> = {
  delivery: [
    "We sincerely apologize for the delay in your delivery. We're looking into this immediately and will ensure your order reaches you as soon as possible.",
    "Thank you for bringing this to our attention. We understand how frustrating delivery issues can be. Our team is investigating and will follow up shortly.",
  ],
  customer_support: [
    "We're sorry to hear about your experience with our support team. This isn't the level of service we strive for. We'd like to make this right.",
    "Thank you for your feedback. We take customer service seriously and will use this to improve our training.",
  ],
  product_quality: [
    "We apologize that our product didn't meet your expectations. Quality is our top priority, and we'd like to offer a replacement or refund.",
    "Thank you for letting us know about this issue. We're committed to quality and would like to resolve this for you.",
  ],
  pricing: [
    "We appreciate your feedback on our pricing. We strive to offer competitive value and would be happy to discuss available options.",
    "Thank you for sharing your concerns. We regularly review our pricing to ensure we're providing fair value.",
  ],
  default: [
    "Thank you for taking the time to share your feedback. We value your input and are committed to improving.",
    "We appreciate you bringing this to our attention. Our team will review this and work on addressing your concerns.",
  ],
}

const platformIcons: Record<string, string> = {
  twitter: '𝕏',
  instagram: '📷',
  facebook: '📘',
  reddit: '🔴',
  trustpilot: '⭐',
  google_reviews: '🔍',
}

function getPlatformIcon(platform: string): string {
  return platformIcons[platform] ?? '📝'
}

function getResponses(category: string): string[] {
  return suggestedResponses[category] ?? suggestedResponses.default
}

// Loading Component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  )
}

// Not Found Component
function FeedbackNotFound() {
  return (
    <div className="text-center py-12">
      <p className="text-gray-500">Feedback not found</p>
      <Link to="/feedback" className="text-blue-600 hover:underline mt-2 inline-block">
        Back to feedback list
      </Link>
    </div>
  )
}

// Header Component
function FeedbackHeader({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
      <div className="flex items-center gap-3">
        <span className="text-xl sm:text-2xl flex-shrink-0">
          {getPlatformIcon(feedback.source_platform)}
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
          <span className="badge badge-urgent">Urgent</span>
        )}
        <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} size="md" />
      </div>
    </div>
  )
}

// Rating Component
function RatingDisplay({ rating }: Readonly<{ rating: number | null | undefined }>) {
  if (!rating) return null
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-sm text-gray-500">Rating:</span>
      <div className="flex items-center gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            size={18}
            className={i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
          />
        ))}
      </div>
    </div>
  )
}

// Original Text Component
function OriginalTextSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <div className="bg-gray-50 rounded-lg p-4 mb-6">
      <h3 className="text-sm font-medium text-gray-500 mb-2">Original Feedback</h3>
      <p className="text-gray-900 whitespace-pre-wrap">{feedback.original_text}</p>
      {feedback.original_language !== 'en' && feedback.normalized_text && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <h4 className="text-sm font-medium text-gray-500 mb-2">
            Translated from {feedback.original_language}
          </h4>
          <p className="text-gray-700">{feedback.normalized_text}</p>
        </div>
      )}
    </div>
  )
}

// Classification Section
function ClassificationSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-500 mb-2 sm:mb-3">Classification</h3>
      <div className="space-y-2 text-sm sm:text-base">
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">Category</span>
          <span className="font-medium text-right">{feedback.category}</span>
        </div>
        {feedback.subcategory && (
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">Subcategory</span>
            <span className="font-medium text-right">{feedback.subcategory}</span>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">Journey Stage</span>
          <span className="font-medium text-right">{feedback.journey_stage}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">Impact Area</span>
          <span className="font-medium text-right">{feedback.impact_area}</span>
        </div>
      </div>
    </div>
  )
}

// Persona Section
function PersonaSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-500 mb-2 sm:mb-3">Customer Persona</h3>
      <div className="space-y-2 text-sm sm:text-base">
        {feedback.persona_name && (
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">Persona</span>
            <span className="font-medium text-right">{feedback.persona_name}</span>
          </div>
        )}
        {feedback.persona_type && (
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">Type</span>
            <span className="font-medium text-right">{feedback.persona_type}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// Problem Analysis Section
function ProblemAnalysisSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  if (!feedback.problem_summary && !feedback.problem_root_cause_hypothesis) return null
  return (
    <div className="bg-orange-50 rounded-lg p-4 mb-6">
      <h3 className="text-sm font-medium text-orange-800 mb-2">Problem Analysis</h3>
      {feedback.problem_summary && (
        <p className="text-orange-900 mb-2"><strong>Issue:</strong> {feedback.problem_summary}</p>
      )}
      {feedback.problem_root_cause_hypothesis && (
        <p className="text-orange-800 text-sm"><strong>Possible Root Cause:</strong> {feedback.problem_root_cause_hypothesis}</p>
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
  return (
    <div className="mb-4 sm:mb-6">
      <h3 className="text-sm font-medium text-gray-500 mb-2 sm:mb-3 flex items-center gap-2">
        <Tag size={14} />
        Tags & Filters
      </h3>
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        <button
          onClick={() => onTagClick('category', feedback.category)}
          className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-blue-100 text-blue-800 rounded-full text-xs sm:text-sm font-medium hover:bg-blue-200 transition-colors cursor-pointer active:scale-95"
        >
          {feedback.category}
        </button>
        {feedback.subcategory && (
          <button
            onClick={() => onTagClick('keyword', feedback.subcategory ?? '')}
            className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-purple-100 text-purple-800 rounded-full text-xs sm:text-sm font-medium hover:bg-purple-200 transition-colors cursor-pointer active:scale-95"
          >
            {feedback.subcategory}
          </button>
        )}
        <button
          onClick={() => onTagClick('source', feedback.source_platform)}
          className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-green-100 text-green-800 rounded-full text-xs sm:text-sm font-medium hover:bg-green-200 transition-colors cursor-pointer active:scale-95"
        >
          {feedback.source_platform}
        </button>
        {feedback.persona_name && (
          <span className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-indigo-100 text-indigo-800 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1">
            <Users size={12} />
            {feedback.persona_name}
          </span>
        )}
        <span className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-gray-100 text-gray-700 rounded-full text-xs sm:text-sm font-medium">
          {feedback.journey_stage}
        </span>
        {feedback.urgency === 'high' && (
          <span className="px-2.5 sm:px-3 py-1 sm:py-1.5 bg-red-100 text-red-800 rounded-full text-xs sm:text-sm font-medium">
            🔥 Urgent
          </span>
        )}
      </div>
    </div>
  )
}

// Helper to safely format dates
function formatDateSafe(dateString: string | null | undefined): string {
  if (!dateString) return 'Unknown'
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) return 'Unknown'
    return format(date, 'PPpp')
  } catch {
    return 'Unknown'
  }
}

// Metadata Section
function MetadataSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-4 text-xs sm:text-sm text-gray-500 pt-3 sm:pt-4 border-t border-gray-100">
      <div className="flex items-center gap-1">
        <Clock size={14} className="flex-shrink-0" />
        <span className="truncate">Created: {formatDateSafe(feedback.source_created_at)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Globe size={14} className="flex-shrink-0" />
        <span>Language: {feedback.original_language}</span>
      </div>
      {feedback.source_url && (
        <a
          href={feedback.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-blue-600 hover:underline"
        >
          <ExternalLink size={14} className="flex-shrink-0" />
          View original
        </a>
      )}
    </div>
  )
}

// Suggested Responses Section
interface SuggestedResponsesSectionProps {
  readonly responses: string[]
  readonly copiedIndex: number | null
  readonly onCopy: (text: string, index: number) => void
}

function SuggestedResponsesSection({ responses, copiedIndex, onCopy }: SuggestedResponsesSectionProps) {
  return (
    <div className="card">
      <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
        <MessageCircle size={18} className="sm:w-5 sm:h-5" />
        Suggested Responses
      </h2>
      <p className="text-xs sm:text-sm text-gray-500 mb-3 sm:mb-4">
        Copy these responses to share with your team or use as a starting point for your reply.
      </p>
      <div className="space-y-2 sm:space-y-3">
        {responses.map((response, index) => (
          <div key={index} className="bg-gray-50 rounded-lg p-3 sm:p-4 flex items-start gap-2 sm:gap-3">
            <p className="flex-1 text-sm sm:text-base text-gray-700">{response}</p>
            <button
              onClick={() => onCopy(response, index)}
              className="flex-shrink-0 p-1.5 sm:p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-lg transition-colors active:scale-95"
              title="Copy to clipboard"
            >
              {copiedIndex === index ? <Check size={16} className="sm:w-[18px] sm:h-[18px] text-green-600" /> : <Copy size={16} className="sm:w-[18px] sm:h-[18px]" />}
            </button>
          </div>
        ))}
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

function SimilarFeedbackSection({ activeTab, onToggle, similarItems }: SimilarFeedbackSectionProps) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
        <h2 className="text-base sm:text-lg font-semibold flex items-center gap-2">
          <TrendingUp size={18} className="sm:w-5 sm:h-5" />
          <span className="hidden xs:inline">Similar Feedback</span>
          <span className="xs:hidden">Similar</span>
        </h2>
        <button
          onClick={onToggle}
          className="text-xs sm:text-sm text-blue-600 hover:text-blue-700 whitespace-nowrap"
        >
          {activeTab === 'similar' ? 'Hide' : 'Show'}
        </button>
      </div>
      
      {activeTab === 'similar' && (
        <SimilarFeedbackList items={similarItems} />
      )}
    </div>
  )
}

function SimilarFeedbackList({ items }: Readonly<{ items: FeedbackItem[] | undefined }>) {
  if (!items || items.length === 0) {
    return (
      <p className="text-xs sm:text-sm text-gray-500 text-center py-4">
        Loading similar feedback...
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
              <span className="text-xs px-1.5 sm:px-2 py-0.5 bg-red-100 text-red-700 rounded">Urgent</span>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}

// Main Component
export default function FeedbackDetail() {
  const { id } = useParams<{ id: string }>()
  const { config } = useConfigStore()
  const navigate = useNavigate()
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'details' | 'similar'>('details')

  const { data: feedback, isLoading } = useQuery({
    queryKey: ['feedback', id],
    queryFn: () => api.getFeedbackById(id ?? ''),
    enabled: !!config.apiEndpoint && !!id,
  })

  const { data: similarData } = useQuery({
    queryKey: ['feedback-similar', id],
    queryFn: () => api.getSimilarFeedback(id ?? '', 8),
    enabled: !!config.apiEndpoint && !!id && activeTab === 'similar',
  })

  const handleTagClick = (type: string, value: string) => {
    if (type === 'category') {
      navigate(`/feedback?category=${encodeURIComponent(value)}`)
    } else if (type === 'keyword') {
      navigate(`/feedback?q=${encodeURIComponent(value)}`)
    } else if (type === 'source') {
      navigate(`/feedback?source=${encodeURIComponent(value)}`)
    }
  }

  const copyResponse = (text: string, index: number) => {
    navigator.clipboard.writeText(text)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const toggleSimilarTab = () => {
    setActiveTab(activeTab === 'similar' ? 'details' : 'similar')
  }

  if (isLoading) return <LoadingSpinner />
  if (!feedback) return <FeedbackNotFound />

  const responses = getResponses(feedback.category)

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6 px-1 sm:px-0">
      <Link to="/feedback" className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 text-sm sm:text-base">
        <ArrowLeft size={18} />
        <span className="hidden xs:inline">Back to feedback</span>
        <span className="xs:hidden">Back</span>
      </Link>

      <div className="card">
        <FeedbackHeader feedback={feedback} />
        <RatingDisplay rating={feedback.rating} />
        <OriginalTextSection feedback={feedback} />

        {feedback.direct_customer_quote && (
          <blockquote className="border-l-4 border-blue-400 pl-4 mb-6 italic text-gray-700">
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
      />
    </div>
  )
}
