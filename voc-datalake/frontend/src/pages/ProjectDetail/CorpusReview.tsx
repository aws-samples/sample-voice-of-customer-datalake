/**
 * @fileoverview One review of a persona's or document's corpus, read through `GET /feedback/{id}` (the review modal's
 * query key, so an opened review is not fetched twice). A 404 (erased, deleted, or not visible to the caller) is an
 * answer, shown as "no longer available" and never retried; any other failure offers a retry. The corpus modal and
 * the document page's evidence cards each render the loaded review their own way.
 *
 * @module pages/ProjectDetail/CorpusReview
 */
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { apiErrorStatus, retryOnceUnlessNotFound } from '../../api/apiErrorStatus'
import { metricsKeys } from '../../api/queryKeys'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import type { FeedbackItem } from '../../api/types'

interface CorpusReviewProps {
  readonly feedbackId: string
  /** Shown while the review loads (a `role="status"` element). */
  readonly loading: ReactNode
  /** The text size of the "no longer available" note. */
  readonly textSize: 'text-xs' | 'text-sm'
  readonly render: (feedback: FeedbackItem) => ReactNode
}

export default function CorpusReview({ feedbackId, loading, textSize, render }: CorpusReviewProps) {
  const { t } = useTranslation('projectDetail')
  const query = useQuery({
    queryKey: metricsKeys.feedback(feedbackId),
    queryFn: () => api.getFeedbackById(feedbackId),
    retry: retryOnceUnlessNotFound,
  })
  if (query.isLoading) return <>{loading}</>
  if (apiErrorStatus(query.error) === 404) {
    return <p className={clsx('p-3 rounded-lg border border-dashed border-border text-muted', textSize)}>{t('corpus.unavailable')}</p>
  }
  if (query.isError || query.data === undefined) {
    return <LoadFailed message={t('corpus.loadFailed')} onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
  }
  return <>{render(query.data)}</>
}
