/**
 * SubmissionsModal - displays form submissions in a modal
 */
import { useQuery } from '@tanstack/react-query'
import { X, Loader2, Star, MessageSquare } from 'lucide-react'
import { api } from '../../api/client'
import clsx from 'clsx'

interface SubmissionsModalProps {
  readonly formId: string
  readonly formName: string
  readonly onClose: () => void
}

function getSentimentColor(sentiment: string): string {
  switch (sentiment) {
    case 'positive': return 'text-green-600 bg-green-50'
    case 'negative': return 'text-red-600 bg-red-50'
    case 'mixed': return 'text-yellow-600 bg-yellow-50'
    default: return 'text-gray-600 bg-gray-50'
  }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

function RatingStars({ rating, max = 5 }: { readonly rating: number | null; readonly max?: number }) {
  if (rating === null) return <span className="text-gray-400 text-sm">No rating</span>
  
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          size={14}
          className={i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
        />
      ))}
      <span className="ml-1 text-sm text-gray-600">{rating}/{max}</span>
    </div>
  )
}

export default function SubmissionsModal({ formId, formName, onClose }: SubmissionsModalProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['form-submissions', formId],
    queryFn: () => api.getFeedbackFormSubmissions(formId, 50),
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">{formName}</h2>
            <p className="text-sm text-gray-500">Form Submissions</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {/* Stats Summary */}
        {data?.stats && (
          <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 border-b">
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">{data.stats.total_submissions}</p>
              <p className="text-xs text-gray-500">Total Submissions</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">
                {data.stats.avg_rating !== null ? data.stats.avg_rating.toFixed(1) : '—'}
              </p>
              <p className="text-xs text-gray-500">Avg Rating</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">{data.stats.rating_count}</p>
              <p className="text-xs text-gray-500">Rated</p>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin text-blue-600" size={32} />
            </div>
          )}

          {error && (
            <div className="text-center py-12 text-red-600">
              Failed to load submissions
            </div>
          )}

          {data?.submissions && data.submissions.length === 0 && (
            <div className="text-center py-12">
              <MessageSquare size={48} className="mx-auto text-gray-300 mb-4" />
              <p className="text-gray-500">No submissions yet</p>
              <p className="text-sm text-gray-400 mt-1">
                Submissions will appear here once users submit feedback through this form.
              </p>
            </div>
          )}

          {data?.submissions && data.submissions.length > 0 && (
            <div className="space-y-3">
              {data.submissions.map((submission) => (
                <div
                  key={submission.feedback_id}
                  className="border rounded-lg p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <RatingStars rating={submission.rating} />
                    <span
                      className={clsx(
                        'px-2 py-0.5 rounded text-xs font-medium capitalize',
                        getSentimentColor(submission.sentiment_label)
                      )}
                    >
                      {submission.sentiment_label || 'neutral'}
                    </span>
                  </div>
                  
                  <p className="text-gray-800 text-sm leading-relaxed mb-3">
                    {submission.original_text}
                  </p>
                  
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <div className="flex items-center gap-3">
                      {submission.category && (
                        <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                          {submission.category}
                        </span>
                      )}
                      {submission.persona_name && (
                        <span className="text-gray-600">
                          {submission.persona_name}
                        </span>
                      )}
                    </div>
                    <span>{formatDate(submission.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-gray-50">
          <button onClick={onClose} className="btn btn-secondary w-full">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
