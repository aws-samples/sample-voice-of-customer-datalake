import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Copy, Check, MessageCircle, Star, Clock, Globe, Users, Tag, TrendingUp } from 'lucide-react'
import { format } from 'date-fns'
import { useState } from 'react'
import { api } from '../api/client'
import { useConfigStore } from '../store/configStore'
import SentimentBadge from '../components/SentimentBadge'

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

export default function FeedbackDetail() {
  const { id } = useParams<{ id: string }>()
  const { config } = useConfigStore()
  const navigate = useNavigate()
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'details' | 'similar'>('details')

  const { data: feedback, isLoading } = useQuery({
    queryKey: ['feedback', id],
    queryFn: () => api.getFeedbackById(id!),
    enabled: !!config.apiEndpoint && !!id,
  })

  const { data: similarData } = useQuery({
    queryKey: ['feedback-similar', id],
    queryFn: () => api.getSimilarFeedback(id!, 8),
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  if (!feedback) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Feedback not found</p>
        <Link to="/feedback" className="text-blue-600 hover:underline mt-2 inline-block">
          Back to feedback list
        </Link>
      </div>
    )
  }

  const responses = suggestedResponses[feedback.category] || suggestedResponses.default

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Back button */}
      <Link to="/feedback" className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900">
        <ArrowLeft size={18} />
        Back to feedback
      </Link>

      {/* Main content */}
      <div className="card">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">
                {feedback.source_platform === 'twitter' ? '𝕏' :
                 feedback.source_platform === 'instagram' ? '📷' :
                 feedback.source_platform === 'facebook' ? '📘' :
                 feedback.source_platform === 'reddit' ? '🔴' :
                 feedback.source_platform === 'trustpilot' ? '⭐' :
                 feedback.source_platform === 'google_reviews' ? '🔍' : '📝'}
              </span>
              <div>
                <h1 className="text-xl font-bold text-gray-900 capitalize">
                  {feedback.source_platform.replace('_', ' ')} {feedback.source_channel}
                </h1>
                <p className="text-gray-500 text-sm">ID: {feedback.feedback_id}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {feedback.urgency === 'high' && (
              <span className="badge badge-urgent">Urgent</span>
            )}
            <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} size="md" />
          </div>
        </div>

        {/* Rating */}
        {feedback.rating && (
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm text-gray-500">Rating:</span>
            <div className="flex items-center gap-1">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  size={18}
                  className={i < feedback.rating! ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
                />
              ))}
            </div>
          </div>
        )}

        {/* Original text */}
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

        {/* Key quote */}
        {feedback.direct_customer_quote && (
          <blockquote className="border-l-4 border-blue-400 pl-4 mb-6 italic text-gray-700">
            "{feedback.direct_customer_quote}"
          </blockquote>
        )}

        {/* Analysis */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-3">Classification</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Category</span>
                <span className="font-medium">{feedback.category}</span>
              </div>
              {feedback.subcategory && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Subcategory</span>
                  <span className="font-medium">{feedback.subcategory}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">Journey Stage</span>
                <span className="font-medium">{feedback.journey_stage}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Impact Area</span>
                <span className="font-medium">{feedback.impact_area}</span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-3">Customer Persona</h3>
            <div className="space-y-2">
              {feedback.persona_name && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Persona</span>
                  <span className="font-medium">{feedback.persona_name}</span>
                </div>
              )}
              {feedback.persona_type && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Type</span>
                  <span className="font-medium">{feedback.persona_type}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Problem analysis */}
        {(feedback.problem_summary || feedback.problem_root_cause_hypothesis) && (
          <div className="bg-orange-50 rounded-lg p-4 mb-6">
            <h3 className="text-sm font-medium text-orange-800 mb-2">Problem Analysis</h3>
            {feedback.problem_summary && (
              <p className="text-orange-900 mb-2"><strong>Issue:</strong> {feedback.problem_summary}</p>
            )}
            {feedback.problem_root_cause_hypothesis && (
              <p className="text-orange-800 text-sm"><strong>Possible Root Cause:</strong> {feedback.problem_root_cause_hypothesis}</p>
            )}
          </div>
        )}

        {/* Clickable Tags */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
            <Tag size={14} />
            Tags & Filters
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleTagClick('category', feedback.category)}
              className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded-full text-sm font-medium hover:bg-blue-200 transition-colors cursor-pointer"
            >
              {feedback.category}
            </button>
            {feedback.subcategory && (
              <button
                onClick={() => handleTagClick('keyword', feedback.subcategory!)}
                className="px-3 py-1.5 bg-purple-100 text-purple-800 rounded-full text-sm font-medium hover:bg-purple-200 transition-colors cursor-pointer"
              >
                {feedback.subcategory}
              </button>
            )}
            <button
              onClick={() => handleTagClick('source', feedback.source_platform)}
              className="px-3 py-1.5 bg-green-100 text-green-800 rounded-full text-sm font-medium hover:bg-green-200 transition-colors cursor-pointer"
            >
              {feedback.source_platform}
            </button>
            {feedback.persona_name && (
              <span className="px-3 py-1.5 bg-indigo-100 text-indigo-800 rounded-full text-sm font-medium flex items-center gap-1">
                <Users size={12} />
                {feedback.persona_name}
              </span>
            )}
            <span className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-full text-sm font-medium">
              {feedback.journey_stage}
            </span>
            {feedback.urgency === 'high' && (
              <span className="px-3 py-1.5 bg-red-100 text-red-800 rounded-full text-sm font-medium">
                🔥 Urgent
              </span>
            )}
          </div>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap gap-4 text-sm text-gray-500 pt-4 border-t border-gray-100">
          <div className="flex items-center gap-1">
            <Clock size={14} />
            <span>Created: {format(new Date(feedback.source_created_at), 'PPpp')}</span>
          </div>
          <div className="flex items-center gap-1">
            <Globe size={14} />
            <span>Language: {feedback.original_language}</span>
          </div>
          {feedback.source_url && (
            <a
              href={feedback.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-blue-600 hover:underline"
            >
              <ExternalLink size={14} />
              View original
            </a>
          )}
        </div>
      </div>

      {/* Suggested responses */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <MessageCircle size={20} />
          Suggested Responses
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Copy these responses to share with your team or use as a starting point for your reply.
        </p>
        <div className="space-y-3">
          {responses.map((response, index) => (
            <div key={index} className="bg-gray-50 rounded-lg p-4 flex items-start gap-3">
              <p className="flex-1 text-gray-700">{response}</p>
              <button
                onClick={() => copyResponse(response, index)}
                className="flex-shrink-0 p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
                title="Copy to clipboard"
              >
                {copiedIndex === index ? <Check size={18} className="text-green-600" /> : <Copy size={18} />}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Similar Feedback */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <TrendingUp size={20} />
            Similar Feedback
          </h2>
          <button
            onClick={() => setActiveTab(activeTab === 'similar' ? 'details' : 'similar')}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            {activeTab === 'similar' ? 'Hide' : 'Show'} similar items
          </button>
        </div>
        
        {activeTab === 'similar' && (
          <div className="space-y-3">
            {similarData?.items && similarData.items.length > 0 ? (
              similarData.items.map((item) => (
                <Link
                  key={item.feedback_id}
                  to={`/feedback/${item.feedback_id}`}
                  className="block p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-start justify-between mb-2">
                    <span className="text-xs text-gray-500 capitalize">{item.source_platform}</span>
                    <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
                  </div>
                  <p className="text-sm text-gray-700 line-clamp-2">{item.original_text}</p>
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{item.category}</span>
                    {item.urgency === 'high' && (
                      <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded">Urgent</span>
                    )}
                  </div>
                </Link>
              ))
            ) : (
              <p className="text-sm text-gray-500 text-center py-4">
                {activeTab === 'similar' ? 'Loading similar feedback...' : 'Click "Show" to find similar feedback'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
