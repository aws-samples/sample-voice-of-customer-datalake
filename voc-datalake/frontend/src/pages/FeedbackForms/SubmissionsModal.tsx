/**
 * SubmissionsModal - displays form submissions in a modal
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Star, MessageSquare, AlertCircle } from 'lucide-react'
import { api } from '../../api/client'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'

interface SubmissionsModalProps {
  readonly formId: string
  readonly formName: string
  readonly onClose: () => void
}

function formatDate(dateStr: string, locale: string): string {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString(locale, {
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
  const { t } = useTranslation('feedbackForms')
  if (rating === null) return <span className="text-muted text-sm">{t('submissions.noRating')}</span>

  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          size={14}
          className={i < rating ? 'text-warn fill-warn' : 'text-muted-strong'}
          aria-hidden="true"
        />
      ))}
      <span className="ml-1 text-sm font-mono text-text">{rating}/{max}</span>
    </div>
  )
}

export default function SubmissionsModal({ formId, formName, onClose }: SubmissionsModalProps) {
  const { t, i18n } = useTranslation('feedbackForms')
  const titleId = useId()
  const { data, isLoading, error } = useQuery({
    queryKey: ['form-submissions', formId],
    queryFn: () => api.getFeedbackFormSubmissions(formId, 50),
  })

  return (
    // ModalShell rather than a bare overlay: role="dialog", a name, a focus trap
    // and Escape, which the hand-rolled overlay had none of.
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-3xl max-h-[85vh]">
        {/* Header */}
        <div className="dialog-header justify-between">
          <div className="min-w-0">
            <h2 id={titleId} className="dialog-title truncate" title={formName}>{formName}</h2>
            <p className="dialog-description">{t('submissions.title')}</p>
          </div>
          <DialogClose onClick={onClose} className="flex-shrink-0" />
        </div>

        {/* Stats Summary */}
        {data?.stats && (
          <div className="grid grid-cols-3 gap-2 sm:gap-4 px-4 py-3 sm:p-4 bg-bg-accent border-b border-border">
            <div className="text-center">
              <p className="text-2xl font-bold font-mono text-text-strong">{data.stats.total_submissions}</p>
              <p className="text-xs font-medium uppercase tracking-[.04em] text-muted">{t('submissions.totalSubmissions')}</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold font-mono text-text-strong">
                {data.stats.avg_rating !== null ? data.stats.avg_rating.toFixed(1) : '—'}
              </p>
              <p className="text-xs font-medium uppercase tracking-[.04em] text-muted">{t('submissions.avgRating')}</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold font-mono text-text-strong">{data.stats.rating_count}</p>
              <p className="text-xs font-medium uppercase tracking-[.04em] text-muted">{t('submissions.rated')}</p>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="dialog-body">
          {isLoading && (
            <div role="status" aria-label={t('common:loading')} className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin text-accent" size={24} aria-hidden="true" />
            </div>
          )}

          {error && (
            <div role="alert" className="flex items-center justify-center gap-2 py-12 text-sm text-danger">
              <AlertCircle size={16} aria-hidden="true" />
              {t('submissions.failedToLoad')}
            </div>
          )}

          {data?.submissions.length === 0 && (
            <div className="text-center py-12">
              <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-bg-hover flex items-center justify-center">
                <MessageSquare size={20} className="text-muted" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-text-strong">{t('submissions.noSubmissions')}</p>
              <p className="text-sm text-muted mt-1">{t('submissions.noSubmissionsHint')}</p>
            </div>
          )}

          {data?.submissions && data.submissions.length > 0 && (
            <div className="space-y-3">
              {data.submissions.map((submission) => (
                <div
                  key={submission.feedback_id}
                  className="border border-border rounded-lg p-3 sm:p-4"
                >
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <RatingStars rating={submission.rating} />
                    <SentimentBadge sentiment={submission.sentiment_label || 'neutral'} />
                  </div>
                  
                  <p className="text-text-strong text-sm leading-relaxed mb-3">
                    {submission.original_text}
                  </p>
                  
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
                      {submission.category && (
                        <span className="badge badge-accent">
                          {submission.category}
                        </span>
                      )}
                      {submission.persona_name && (
                        <span className="text-text">
                          {submission.persona_name}
                        </span>
                      )}
                    </div>
                    <span className="font-mono">{formatDate(submission.created_at, i18n.language)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="dialog-footer">
          <button onClick={onClose} className="btn btn-secondary w-full sm:w-auto">
            {t('submissions.close')}
          </button>
        </div>
    </ModalShell>
  )
}
