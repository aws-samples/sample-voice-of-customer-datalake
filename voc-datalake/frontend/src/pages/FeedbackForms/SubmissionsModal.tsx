/**
 * SubmissionsModal - displays form submissions in a modal
 */
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  X, Loader2, MessageSquare,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { feedbackFormsApi } from '../../api/feedbackFormsApi'
import RatingStars from '../../components/RatingStars'
import { sentimentTailwindColor } from '../../lib/sentiment'

interface SubmissionsModalProps {
  readonly formId: string
  readonly formName: string
  readonly onClose: () => void
}

function formatDate(dateStr: string): string {
  if (dateStr === '') return ''
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

interface SubmissionCardProps {
  readonly submission: {
    feedback_id: string
    rating: number | null
    sentiment_label: string
    original_text: string
    category: string
    persona_name: string
    created_at: string
  }
}

function SubmissionCard({ submission }: SubmissionCardProps) {
  return (
    <div
      key={submission.feedback_id}
      className="border rounded-lg p-4 hover:bg-gray-50 transition-colors"
    >
      <div className="flex items-start justify-between gap-4 mb-2">
        <RatingStars rating={submission.rating} showLabel fallback={<span className="text-gray-400 text-sm">No rating</span>} />
        <span
          className={clsx(
            'px-2 py-0.5 rounded text-xs font-medium capitalize',
            sentimentTailwindColor(submission.sentiment_label),
          )}
        >
          {submission.sentiment_label === '' ? 'neutral' : submission.sentiment_label}
        </span>
      </div>

      <p className="text-gray-800 text-sm leading-relaxed mb-3">
        {submission.original_text}
      </p>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-3">
          {submission.category === '' ? null : <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
            {submission.category}
          </span>}
          {submission.persona_name === '' ? null : <span className="text-gray-600">
            {submission.persona_name}
          </span>}
        </div>
        <span>{formatDate(submission.created_at)}</span>
      </div>
    </div>
  )
}

interface StatsSummaryProps {
  readonly stats: {
    total_submissions: number;
    avg_rating: number | null;
    rating_count: number
  } | undefined
}

function StatsSummary({ stats }: StatsSummaryProps) {
  const { t } = useTranslation('feedbackForms')
  if (!stats) return null
  return (
    <div className="grid grid-cols-3 gap-4 p-4 bg-gray-50 border-b">
      <div className="text-center">
        <p className="text-2xl font-bold text-gray-900">{stats.total_submissions}</p>
        <p className="text-xs text-gray-500">{t('submissions.totalSubmissions')}</p>
      </div>
      <div className="text-center">
        <p className="text-2xl font-bold text-gray-900">
          {stats.avg_rating === null ? '—' : stats.avg_rating.toFixed(1)}
        </p>
        <p className="text-xs text-gray-500">{t('submissions.avgRating')}</p>
      </div>
      <div className="text-center">
        <p className="text-2xl font-bold text-gray-900">{stats.rating_count}</p>
        <p className="text-xs text-gray-500">{t('submissions.rated')}</p>
      </div>
    </div>
  )
}

export default function SubmissionsModal({
  formId, formName, onClose,
}: SubmissionsModalProps) {
  const { t } = useTranslation('feedbackForms')
  const {
    data, isLoading, error,
  } = useQuery({
    queryKey: ['form-submissions', formId],
    queryFn: () => feedbackFormsApi.getFeedbackFormSubmissions(formId, 50),
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">{formName}</h2>
            <p className="text-sm text-gray-500">{t('submissions.title')}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        <StatsSummary stats={data?.stats} />

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-blue-600" size={32} />
          </div> : null}

          {error ? <div className="text-center py-12 text-red-600">
            {t('submissions.failedToLoad')}
          </div> : null}

          {data?.submissions.length === 0 && (
            <div className="text-center py-12">
              <MessageSquare size={48} className="mx-auto text-gray-300 mb-4" />
              <p className="text-gray-500">{t('submissions.noSubmissions')}</p>
              <p className="text-sm text-gray-400 mt-1">
                {t('submissions.noSubmissionsHint')}
              </p>
            </div>
          )}

          {data?.submissions && data.submissions.length > 0 ? <div className="space-y-3">
            {data.submissions.map((submission) => (
              <SubmissionCard key={submission.feedback_id} submission={submission} />
            ))}
          </div> : null}
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-gray-50">
          <button onClick={onClose} className="btn btn-secondary w-full">
            {t('submissions.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
