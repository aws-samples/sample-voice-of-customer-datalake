/**
 * @fileoverview One decision: verdict, rationale, measures, dates, evidence and its actions —
 * Edit, "Draft PR/FAQ" (Pursue only, then where that PR/FAQ stands), "Revisit" (a new
 * decision prefilled from this one) and, once launched, its release watch.
 * @module pages/ProjectDetail/decisions/DecisionCard
 */
import { Activity, FilePlus2, FileText, Loader2, Newspaper, Pencil } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import ReviewLink from '../../../components/ReviewLink/ReviewLink'
import ReleaseWatchSection from '../../../components/ReleaseWatch/ReleaseWatchSection'
import type { Decision } from '../../../api/decisionSchema'
import type { ProjectDocument } from '../../../api/types'
import { projectDocumentPath } from '../useDocumentSelection'
import { decisionDeepLink } from './decisionDraft'
import VerdictBadge from './VerdictBadge'
import type { SeededJob } from './useSeededPrfaqs'

interface DecisionCardProps {
  readonly projectId: string
  readonly decision: Decision
  readonly documents: readonly ProjectDocument[]
  readonly canEdit: boolean
  readonly isPursuing: boolean
  /** The PR/FAQ job this decision seeded, once the jobs list has it. */
  readonly prfaqJob?: SeededJob
  readonly onEdit: () => void
  readonly onPursue: () => void
}

function Measure({ label, value }: Readonly<{ label: string; value: string }>) {
  if (value === '') return null
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm whitespace-pre-wrap">{value}</dd>
    </div>
  )
}

function Evidence({ decision, documents }: Readonly<{ decision: Decision; documents: readonly ProjectDocument[] }>) {
  const { t } = useTranslation('decisions')
  if (decision.feedbackIds.length === 0 && decision.documentIds.length === 0) return null
  const titleOf = (id: string) => documents.find((d) => d.document_id === id)?.title ?? id
  return (
    <div className="text-sm space-y-1">
      <p className="text-xs text-muted">{t('evidence')}</p>
      <div className="flex flex-wrap gap-2">
        {decision.feedbackIds.map((id, index) => (
          <ReviewLink key={id} feedbackId={id} className="link">{t('releaseWatch.evidenceItem', { n: index + 1 })}</ReviewLink>
        ))}
        {decision.documentIds.map((id) => <span key={id} className="badge badge-muted">{titleOf(id)}</span>)}
      </div>
    </div>
  )
}

function PursueButton({ decision, isPursuing, onPursue }: Readonly<Pick<DecisionCardProps, 'decision' | 'isPursuing' | 'onPursue'>>) {
  const { t } = useTranslation('decisions')
  if (decision.verdict !== 'pursue') return null
  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={onPursue} disabled={isPursuing} title={t('actions.pursueHint')}>
      {isPursuing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Newspaper size={14} aria-hidden />}
      {decision.seededPrfaqJobId === null ? t('actions.pursue') : t('actions.pursueAgain')}
    </button>
  )
}

/**
 * Where the PR/FAQ this decision asked for stands: requested (the job runs),
 * ready (a link that opens that document on the Documents tab) or failed. Nothing while the job is not
 * known — the "appears when the job finishes" note never outlives the job.
 */
function PrfaqStatus({ projectId, job, documents }: Readonly<{
  projectId: string; job: SeededJob | undefined; documents: readonly ProjectDocument[]
}>) {
  const { t } = useTranslation('decisions')
  if (job === undefined) return null
  if (job.status === 'failed') return <p className="text-xs text-danger">{t('actions.prfaqFailed')}</p>
  if (job.status !== 'completed') return <p className="text-xs text-muted">{t('actions.pursued')}</p>
  const documentId = job.result.document_id
  if (documentId === undefined) return null
  const title = documents.find((d) => d.document_id === documentId)?.title ?? job.result.title ?? 'PR/FAQ'
  return (
    <Link to={projectDocumentPath(projectId, documentId)} className="inline-flex items-center gap-1 text-xs link">
      <FileText size={13} aria-hidden />{t('actions.prfaqReady', { title })}
    </Link>
  )
}

function DecidedLine({ decision }: Readonly<{ decision: Decision }>) {
  const { t } = useTranslation('decisions')
  const date = decision.decidedAt.slice(0, 10)
  return (
    <p className="text-xs text-muted">
      {decision.decidedByName === '' ? t('decidedOn', { date }) : t('decidedBy', { name: decision.decidedByName, date })}
    </p>
  )
}

export default function DecisionCard({ projectId, decision, documents, canEdit, isPursuing, prfaqJob, onEdit, onPursue }: DecisionCardProps) {
  const { t } = useTranslation('decisions')
  const [showWatch, setShowWatch] = useState(false)
  const revisit = decisionDeepLink(projectId, { title: decision.title, feedbackIds: decision.feedbackIds })
  return (
    <article className="card p-4 space-y-3" aria-label={decision.title}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="font-semibold text-text-strong break-words">{decision.title}</h3>
          <DecidedLine decision={decision} />
        </div>
        <VerdictBadge verdict={decision.verdict} />
      </header>
      <p className="text-sm whitespace-pre-wrap">{decision.rationale}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Measure label={t('fields.successMetric')} value={decision.successMetric} />
        <Measure label={t('fields.killCriterion')} value={decision.killCriterion} />
        <Measure label={t('fields.reviewBy')} value={decision.reviewBy ?? ''} />
        <Measure label={t('fields.launchedAt')} value={decision.launchedAt ?? ''} />
      </dl>
      <Evidence decision={decision} documents={documents} />
      <PrfaqStatus projectId={projectId} job={prfaqJob} documents={documents} />
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit}><Pencil size={14} aria-hidden />{t('actions.edit')}</button>
            <PursueButton decision={decision} isPursuing={isPursuing} onPursue={onPursue} />
            <Link to={revisit} className="btn btn-ghost btn-sm"><FilePlus2 size={14} aria-hidden />{t('actions.revisit')}</Link>
          </>
        )}
        {decision.launchedAt !== null && (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showWatch} onClick={() => setShowWatch((v) => !v)}>
            <Activity size={14} aria-hidden />{showWatch ? t('actions.hideReleaseWatch') : t('actions.releaseWatch')}
          </button>
        )}
      </div>
      {showWatch && decision.launchedAt !== null && (
        <ReleaseWatchSection query={{ launchedAt: decision.launchedAt, label: decision.title.slice(0, 120) }} />
      )}
    </article>
  )
}
