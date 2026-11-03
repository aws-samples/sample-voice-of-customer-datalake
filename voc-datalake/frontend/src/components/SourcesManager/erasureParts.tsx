/**
 * @fileoverview The pieces both erasure panels share (one person, a whole
 * source): the danger section frame, the job status badge, the "not
 * started" alert and a job's details (legal basis, the copies it reached, the
 * uploaded files it kept for review). The hooks they share are in `useErasureJobs.ts`.
 *
 * @module components/SourcesManager/erasureParts
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import type { ErasureJob, ErasureStatus } from '../../api/sourceProfilesApi'
import type { Tone } from '../../theme/tones'

const STATUS: Record<ErasureStatus, { tone: Tone; labelKey: string }> = {
  queued: { tone: 'muted', labelKey: 'components:erasure.status.queued' },
  running: { tone: 'info', labelKey: 'components:erasure.status.running' },
  completed: { tone: 'ok', labelKey: 'components:erasure.status.completed' },
  failed: { tone: 'danger', labelKey: 'components:erasure.status.failed' },
}

export function ErasureStatusBadge({ status }: Readonly<{ status: ErasureStatus }>) {
  const { t } = useTranslation()
  return <span className={clsx('badge', `badge-${STATUS[status].tone}`)}>{t(STATUS[status].labelKey)}</span>
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

/**
 * What a job did beyond its feedback counts: its legal basis, the Radar reviews it
 * deleted and the workspace items it marked, and the uploaded files it kept because
 * they also hold rows it did not erase (keys only; an admin reviews them).
 */
export function ErasureJobDetails({ job }: Readonly<{ job: ErasureJob }>) {
  const { t } = useTranslation('components', { keyPrefix: 'erasure' })
  const review = job.files_needing_review
  return (
    <>
      {job.legal_basis !== undefined && <span className="text-muted">{t('legalBasisShown', { basis: job.legal_basis })}</span>}
      {(job.deleted_radar_items > 0 || job.artifacts_marked > 0) && (
        <span className="text-text">{t('copies', { radar: job.deleted_radar_items, artifacts: job.artifacts_marked })}</span>
      )}
      {review !== undefined && review.count > 0 && (
        <div className="basis-full text-warn">
          <p>{t('reviewFiles', { files: review.count })}</p>
          <ul className="font-mono text-muted">{review.keys.map((key) => <li key={key}>{key}</li>)}</ul>
        </div>
      )}
    </>
  )
}
