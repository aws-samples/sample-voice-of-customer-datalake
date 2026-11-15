/**
 * @fileoverview The reviews behind a generated persona or document, ten at a time (#236).
 *
 * Each row reads its review through the existing `GET /feedback/{id}` (same query key as the review
 * modal, so an opened review is not fetched twice) and renders it as a compact FeedbackCard, which
 * opens the shared review modal on top of this one. A 404 (erased, deleted, or not visible to the
 * caller) is an answer, shown as "no longer available" and never retried. Paging is client-side over
 * the stored ids, so at most PAGE_SIZE reads run at once.
 *
 * With cited ids (a persona's `evidence_feedback_ids`, #429) the modal opens on "Cited", the reviews
 * the persona's evidence names, with "All used" (every review its prompt held) one click away.
 *
 * @module pages/ProjectDetail/FeedbackCorpusModal
 */
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import FeedbackCard from '../../components/FeedbackCard/FeedbackCard'
import ModalShell from '../../components/ModalShell/ModalShell'
import CorpusReview from './CorpusReview'

const PAGE_SIZE = 10

function CorpusRow({ feedbackId }: Readonly<{ feedbackId: string }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <CorpusReview feedbackId={feedbackId} textSize="text-sm"
      loading={<p className="p-3 rounded-lg border border-border text-sm text-muted" role="status">{t('corpus.loading')}</p>}
      render={(feedback) => <FeedbackCard feedback={feedback} compact />} />
  )
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

type CorpusView = 'cited' | 'used'

interface ViewSwitchProps {
  readonly view: CorpusView
  readonly citedCount: number
  readonly usedCount: number
  readonly onView: (view: CorpusView) => void
}

/** "Cited (N)" / "All used (M)": which list the modal pages through. */
function ViewSwitch({ view, citedCount, usedCount, onView }: ViewSwitchProps) {
  const { t } = useTranslation('projectDetail')
  const options: ReadonlyArray<{ value: CorpusView; label: string }> = [
    { value: 'cited', label: t('corpus.viewCited', { n: citedCount }) },
    { value: 'used', label: t('corpus.viewUsed', { n: usedCount }) },
  ]
  return (
    <div className="flex gap-2 px-4 pt-3" role="group" aria-label={t('corpus.viewLabel')}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={view === option.value} onClick={() => onView(option.value)}
          className={clsx('btn btn-sm', view === option.value ? 'btn-primary' : 'btn-secondary')}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface FeedbackCorpusModalProps {
  readonly ids: readonly string[]
  /** The reviews the artefact cites; empty = no Cited view. */
  readonly citedIds?: readonly string[]
  readonly onClose: () => void
}

export default function FeedbackCorpusModal({ ids, citedIds = [], onClose }: FeedbackCorpusModalProps) {
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  const [view, setView] = useState<CorpusView>(citedIds.length > 0 ? 'cited' : 'used')
  const [page, setPage] = useState(0)
  const listed = view === 'cited' ? citedIds : ids
  const shown = listed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const changeView = (next: CorpusView) => {
    setView(next)
    setPage(0)
  }
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-2xl max-h-[85vh] flex flex-col">
      <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-text-strong">{t('corpus.title')}</h2>
          <p className="text-xs text-muted mt-1">{view === 'cited' ? t('corpus.citedNote') : t('corpus.note')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-label={t('corpus.close')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {citedIds.length > 0
        ? <ViewSwitch view={view} citedCount={citedIds.length} usedCount={ids.length} onView={changeView} />
        : null}
      <ul className="p-4 space-y-2 overflow-y-auto" aria-label={t('corpus.title')}>
        {shown.map((feedbackId) => <li key={feedbackId}><CorpusRow feedbackId={feedbackId} /></li>)}
      </ul>
      {listed.length > PAGE_SIZE ? <Pager page={page} total={listed.length} onPage={setPage} /> : null}
    </ModalShell>
  )
}
