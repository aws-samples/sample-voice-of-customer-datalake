/**
 * @fileoverview The reviews behind a generated persona or document, ten at a time (#236).
 *
 * Each row reads its review through the existing `GET /feedback/{id}` (same query key as the review
 * modal, so an opened review is not fetched twice) and renders it as a compact FeedbackCard, which
 * opens the shared review modal on top of this one. A 404 (erased, deleted, or not visible to the
 * caller) is an answer, shown as "no longer available" and never retried. Paging is client-side over
 * the stored ids, so at most PAGE_SIZE reads run at once.
 *
 * @module pages/ProjectDetail/FeedbackCorpusModal
 */
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { apiErrorStatus, retryOnceUnlessNotFound } from '../../api/apiErrorStatus'
import { metricsKeys } from '../../api/queryKeys'
import FeedbackCard from '../../components/FeedbackCard/FeedbackCard'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import ModalShell from '../../components/ModalShell/ModalShell'

const PAGE_SIZE = 10

const isNotFound = (error: unknown): boolean => apiErrorStatus(error) === 404

function CorpusRow({ feedbackId }: Readonly<{ feedbackId: string }>) {
  const { t } = useTranslation('projectDetail')
  const query = useQuery({
    queryKey: metricsKeys.feedback(feedbackId),
    queryFn: () => api.getFeedbackById(feedbackId),
    retry: retryOnceUnlessNotFound,
  })
  if (query.isLoading) {
    return <p className="p-3 rounded-lg border border-border text-sm text-muted" role="status">{t('corpus.loading')}</p>
  }
  if (isNotFound(query.error)) {
    return <p className="p-3 rounded-lg border border-dashed border-border text-sm text-muted">{t('corpus.unavailable')}</p>
  }
  if (query.isError || query.data === undefined) {
    return <LoadFailed message={t('corpus.loadFailed')} onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
  }
  return <FeedbackCard feedback={query.data} compact />
}

function Pager({ page, total, onPage }: Readonly<{ page: number; total: number; onPage: (next: number) => void }>) {
  const { t } = useTranslation('projectDetail')
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0)
  const from = page * PAGE_SIZE + 1
  const to = Math.min((page + 1) * PAGE_SIZE, total)
  return (
    <div className="flex items-center justify-between gap-3 p-3 border-t border-border text-sm">
      <button type="button" className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {t('corpus.previous')}
      </button>
      <span className="text-muted" aria-live="polite">{t('corpus.range', { from, to, total })}</span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>
        {t('corpus.next')}
      </button>
    </div>
  )
}

interface FeedbackCorpusModalProps {
  readonly ids: readonly string[]
  readonly onClose: () => void
}

export default function FeedbackCorpusModal({ ids, onClose }: FeedbackCorpusModalProps) {
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  const [page, setPage] = useState(0)
  const shown = ids.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-2xl max-h-[85vh] flex flex-col">
      <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-text-strong">{t('corpus.title')}</h2>
          <p className="text-xs text-muted mt-1">{t('corpus.note')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-label={t('corpus.close')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <ul className="p-4 space-y-2 overflow-y-auto" aria-label={t('corpus.title')}>
        {shown.map((feedbackId) => <li key={feedbackId}><CorpusRow feedbackId={feedbackId} /></li>)}
      </ul>
      {ids.length > PAGE_SIZE ? <Pager page={page} total={ids.length} onPage={setPage} /> : null}
    </ModalShell>
  )
}
