/**
 * @fileoverview The pieces both erasure panels share (one person, a whole
 * source): the danger section frame, the job status badge (a completed job that
 * still needs something reads so), the "not started" alert and a job's details
 * (legal basis, the copies it reached, every counter, what it still needs, what a
 * later job finished, the files it kept for review and those it could not check;
 * `./erasureOutcome.ts`). The hooks they share are in `useErasureJobs.ts`.
 *
 * @module components/SourcesManager/erasureParts
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { ERASURE_OUTCOME_COUNTERS } from '../../api/sourceProfilesApi'
import type { ErasureJob, ErasureOutcomeCounter } from '../../api/sourceProfilesApi'
import type { Tone } from '../../theme/tones'
import { agentMemoryReachNote, rerunAdvice, reviewGroups } from './erasureOutcome'
import type { FollowUp, JobOutcome, JobReport } from './erasureOutcome'

const STATUS: Record<JobOutcome, { tone: Tone; labelKey: string }> = {
  queued: { tone: 'muted', labelKey: 'components:erasure.status.queued' },
  running: { tone: 'info', labelKey: 'components:erasure.status.running' },
  completed: { tone: 'ok', labelKey: 'components:erasure.status.completed' },
  failed: { tone: 'danger', labelKey: 'components:erasure.status.failed' },
  // A completed job with a follow-up never reads as plain "Completed" (3g-ui): its details say why and what to do.
  operator: { tone: 'warn', labelKey: 'components:erasure.status.operator' },
  rerun: { tone: 'warn', labelKey: 'components:erasure.status.rerun' },
  verifiedAddress: { tone: 'warn', labelKey: 'components:erasure.status.verifiedAddress' },
  lineageOwed: { tone: 'warn', labelKey: 'components:erasure.status.lineageOwed' },
  filesToReview: { tone: 'warn', labelKey: 'components:erasure.status.filesToReview' },
}

/** The job's status, or what a completed job still needs (its `report`, computed once per row by the caller; alone,
 *  of the job by itself). */
export function ErasureStatusBadge({ report }: Readonly<{ report: JobReport }>) {
  const { t } = useTranslation()
  const outcome = STATUS[report.outcome]
  return <span className={clsx('badge', `badge-${outcome.tone}`)}>{t(outcome.labelKey)}</span>
}

export function ErasureSection({ icon: Icon, title, description, children }: Readonly<{
  icon: LucideIcon
  title: string
  description: string
  children: ReactNode
}>) {
  const titleId = useId()
  return (
    <section className="rounded-lg border border-danger/30 p-3 sm:p-4 space-y-3" aria-labelledby={titleId}>
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-danger" aria-hidden="true" />
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{title}</h3>
      </div>
      <p className="text-sm text-muted">{description}</p>
      {children}
    </section>
  )
}

export function ErasureStartError({ text }: Readonly<{ text: string }>) {
  return (
    <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
      <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
      {text}
    </p>
  )
}

/** How many of a job's deleted reviews were a workspace's (shown beside the deleted-reviews count; none: nothing). */
export function ErasureWorkspaceItems({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  if (job.deleted_workspace_items <= 0) return null
  return <span className="text-text">{t('workspaceItems', { items: job.deleted_workspace_items })}</span>
}

/** Keys the job kept: a list named by its text and described by its cut note, when there is one (keys only, never
 *  content). */
function ReviewList({ text, keys, noteId }: Readonly<{ text: string; keys: readonly string[]; noteId?: string }>) {
  const textId = useId()
  return (
    <div className="basis-full text-warn">
      <p id={textId}>{text}</p>
      <ul aria-labelledby={textId} aria-describedby={noteId} className="font-mono text-muted break-all">
        {keys.map((key) => <li key={key}>{key}</li>)}
      </ul>
    </div>
  )
}

/** The job's list holds more keys than the first ones it kept: the admin checks the rest by hand. */
function CutNote({ id, text }: Readonly<{ id: string; text: string }>) {
  return <p id={id} className="basis-full text-warn">{text}</p>
}

/** Each optional counter's label, shown once above 0; null for those a follow-up or a list names instead (the
 *  unverified accounts, the documents not checked, the malformed ids). */
const COUNTER_KEYS: Record<ErasureOutcomeCounter, string | null> = {
  participants_erased: 'counters.participantsErased',
  participants_not_erased: 'counters.participantsNotErased',
  deleted_export_objects: 'counters.exportObjects',
  project_rows_deidentified: 'counters.projectRows',
  form_test_responses_deleted: 'counters.formTestResponses',
  product_docs_not_checked: null,
  agent_memory_people_erased: 'counters.agentMemoryErased',
  agent_memory_people_refused: 'counters.agentMemoryRefused',
  agent_memory_accounts_not_erased: null,
  engineering_rows_marked: 'counters.engineeringRows',
  project_ids_malformed: null,
  unscoped_rows_skipped: 'counters.unscopedRows',
}

function OutcomeCounters({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  return ERASURE_OUTCOME_COUNTERS.filter((name) => job[name] > 0).map((name) => {
    const key = COUNTER_KEYS[name]
    return key === null ? null : <span key={name} className="text-text">{t(key, { n: job[name] })}</span>
  })
}

/** The rerun follow-ups' reasons, and the rerun text each gets (`rerunAdvice`). */
const RERUN_KEYS = {
  deploymentProjects: 'followUp.deploymentProjects',
  agentMemory: 'followUp.agentMemory',
} as const
const ADVICE_KEYS = {
  workspace: 'followUp.rerunWorkspace',
  ownRequest: 'followUp.rerunOwnRequest',
  plain: 'followUp.rerun',
} as const
/** Why the lineage is owed, by code (7.97.00). An erasure's job is always the erase mode's: a daily retention window
 *  writes no erasure job, so the next run is always the erasure's words. */
const OWED_REASON_KEYS = {
  not_backfilled: 'followUp.owedReasons.not_backfilled',
  incomplete: 'followUp.owedReasons.incomplete',
  failed_before_marks: 'followUp.owedReasons.failed_before_marks',
  owe_failed: 'followUp.owedReasons.owe_failed',
} as const

type LineageStep = Extract<FollowUp, { kind: 'lineageOwed' }>

/** One follow-up's text: what the row says, then what to do. */
function useFollowUpText(job: ErasureJob): (step: FollowUp) => string {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const lineage = (step: LineageStep): string => {
    if (step.code === undefined) {
      // A row the view gave no code (it always does since 7.97.00): the server's English words.
      return t('followUp.lineageOwed', { reason: step.reason === '' ? t('followUp.lineageOwedNoReason') : step.reason })
    }
    // An owe that could not be recorded is made by no later run: its reason says what to do instead.
    const next = step.code === 'owe_failed' ? '' : t('followUp.owedNext.erase')
    return t('followUp.lineageOwedCoded', { reason: t(OWED_REASON_KEYS[step.code]), next }).trim()
  }
  const rerun = (step: FollowUp) => t(ADVICE_KEYS[rerunAdvice(step, job)])
  return (step) => {
    switch (step.kind) {
      case 'malformedRows': return t('followUp.malformedRows', { count: step.malformed })
      case 'indexRowsKeptAgain': return t('followUp.indexRowsKeptAgain', { count: step.kept })
      case 'malformedProjectIds': return t('followUp.malformedProjectIds', { count: step.ids })
      case 'agentMemoryAccounts': return t('followUp.agentMemoryAccounts', { count: step.accounts })
      case 'lineageOwed': return lineage(step)
      case 'filesToReview': return t('followUp.filesToReview')
      case 'participants': {
        // Two keys, so no blank is left where the kept count is not said.
        if (step.kept === 0) return t('followUp.participants', { rerun: rerun(step) })
        return t('followUp.participantsKept', { kept: t('followUp.indexRowsKept', { count: step.kept }), rerun: rerun(step) })
      }
      default: return t(RERUN_KEYS[step.kind], { rerun: rerun(step) })
    }
  }
}

/** What the job still needs, each with its reason and what to do (the report's steps); nothing when it needs
 *  nothing. */
function FollowUps({ job, steps }: Readonly<{ job: ErasureJob; steps: readonly FollowUp[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure.followUp' })
  const titleId = useId()
  const text = useFollowUpText(job)
  if (steps.length === 0) return null
  return (
    <div className="basis-full text-warn">
      <p id={titleId} className="font-medium">{t('title')}</p>
      <ul aria-labelledby={titleId} className="list-disc ps-4">
        {steps.map((step) => <li key={step.kind}>{text(step)}</li>)}
      </ul>
    </div>
  )
}

/** The job's review registries check when it was not complete (7.93.00), a replay of owed lineage, what a later job
 *  finished, and what an address cannot reach in the agents' memory. */
function Notes({ job, report }: Readonly<{ job: ErasureJob; report: JobReport }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const { resolved } = report
  return (
    <>
      {job.review_registries !== undefined && job.review_registries !== 'complete' && (
        <span className="text-warn">{t(`registries.${job.review_registries}`)}</span>
      )}
      {job.lineage_owed_replayed === true && <span className="text-text">{t('lineageReplayed')}</span>}
      {resolved.includes('lineage') && (
        <span className="text-text">{t(job.status === 'failed' ? 'lineageMadeLaterFailed' : 'lineageMadeLater')}</span>
      )}
      {report.rerunDone && <span className="text-text">{t('rerunDoneLater')}</span>}
      {agentMemoryReachNote(job) && <span className="basis-full text-muted">{t('agentMemoryReach')}</span>}
    </>
  )
}

/** What the job kept for review, by kind, each list described by the cut note (one `more` for the whole list). */
function ReviewLists({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const noteId = useId()
  const review = job.files_needing_review
  const { uploads, folders, documents } = reviewGroups(review?.keys ?? [])
  const cut = review?.more === true ? noteId : undefined
  return (
    <>
      {uploads.length > 0 && <ReviewList text={t('reviewFiles', { files: uploads.length })} keys={uploads} noteId={cut} />}
      {folders.length > 0 && <ReviewList text={t('reviewFolders', { folders: folders.length })} keys={folders} noteId={cut} />}
      {documents.length > 0 && <ReviewList text={t('reviewDocuments', { files: documents.length })} keys={documents} noteId={cut} />}
      {cut !== undefined && <CutNote id={cut} text={t('reviewMore', { count: review?.keys.length ?? 0 })} />}
    </>
  )
}

/** The documents the job could not check, out of their total (the counter, or the keys when it says fewer), with the
 *  list's cut note; the text alone when the job kept no key. */
function NotCheckedList({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const noteId = useId()
  const keys = job.files_not_checked?.keys ?? []
  const total = Math.max(job.product_docs_not_checked, keys.length)
  if (total === 0) return null
  const text = t('notChecked', { count: total })
  if (keys.length === 0) return <p className="basis-full text-warn">{text}</p>
  // Listed out of a larger total, or only the first ones (`more`); none when the list is whole.
  const listedNote = total > keys.length ? t('notCheckedListed', { listed: keys.length, total }) : null
  const moreNote = job.files_not_checked?.more === true ? t('notCheckedMore', { count: keys.length }) : null
  const note = listedNote ?? moreNote
  return (
    <>
      <ReviewList text={text} keys={keys} noteId={note === null ? undefined : noteId} />
      {note !== null && <CutNote id={noteId} text={note} />}
    </>
  )
}

/**
 * What a job did beyond its feedback counts: its legal basis, the Radar reviews it
 * deleted, the board requests and +1s it de-identified, the workspace artifacts it marked,
 * every other counter its row holds, its review registries check and lineage, what it still
 * needs (its `report`, computed once per row by the caller; alone, of the job by itself), and
 * what it kept for review (keys only; an admin reviews them): the uploaded files that also hold
 * rows it did not erase, the S3 import originals folders of the items it deleted (no row says
 * which file in them an item came from), the documents that hold the address, and those it could
 * not check.
 */
export function ErasureJobDetails({ job, report }: Readonly<{ job: ErasureJob; report: JobReport }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  return (
    <>
      {job.legal_basis !== undefined && <span className="text-muted">{t('legalBasisShown', { basis: job.legal_basis })}</span>}
      {(job.deleted_radar_items > 0 || job.artifacts_marked > 0) && (
        <span className="text-text">{t('copies', { radar: job.deleted_radar_items, artifacts: job.artifacts_marked })}</span>
      )}
      {job.board_items_deidentified > 0 && (
        <span className="text-text">{t('boards', { rows: job.board_items_deidentified })}</span>
      )}
      {job.member_rows_deidentified > 0 && (
        <span className="text-text">{t('members', { rows: job.member_rows_deidentified })}</span>
      )}
      <OutcomeCounters job={job} />
      <Notes job={job} report={report} />
      <FollowUps job={job} steps={report.steps} />
      <ReviewLists job={job} />
      <NotCheckedList job={job} />
    </>
  )
}
