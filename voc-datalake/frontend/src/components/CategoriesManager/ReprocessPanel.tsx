/**
 * @fileoverview "Reprocess existing feedback" — re-derive stored reviews after the
 * categories change (admin only, Administration → Taxonomy).
 *
 * Mode choice (re-categorise processed text, reprocess from raw data, re-infer dimensions),
 * the slice it replays (window, sources, categories: `ReprocessSliceFields`), whether
 * manual corrections are overwritten, a cost note (one model call per review), a
 * confirmation, live progress polled from the job, cancel, and resume for a job that
 * stopped at the per-job ceiling. Nothing is deleted: reviews are updated in place and
 * the previous version of each is kept (docs/categories.md → "Reprocessing a slice").
 *
 * @module components/CategoriesManager/ReprocessPanel
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { ALL_TIME_CUSTOM_DAYS } from '../../api/baseUrl'
import { isTerminalJob } from '../../api/reprocessApi'
import type { ReprocessMode, ReprocessStart } from '../../api/reprocessApi'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import RadioCard from '../RadioCard/RadioCard'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useLatestJob, useReprocessMutations } from './useReprocessJob'
import { JobProgress } from './ReprocessJobProgress'
import ReprocessSliceFields from './ReprocessSliceFields'
import { MODES, jobWindowLabel, modeTitleKey } from './reprocessCopy'
import { buildStart } from './reprocessForm'
import type { ReprocessForm } from './reprocessForm'

const INITIAL_FORM: ReprocessForm = {
  mode: 'processed',
  includeManual: false,
  windowKind: 'days',
  daysInput: String(ALL_TIME_CUSTOM_DAYS),
  dateFrom: '',
  dateTo: '',
  dateBasis: 'processed',
  sources: [],
  categoriesInput: '',
}

function ModeChoice({ mode, onChange }: Readonly<{ mode: ReprocessMode; onChange: (m: ReprocessMode) => void }>) {
  const { t } = useTranslation('components')
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.modeLabel')}</legend>
      {MODES.map((m) => (
        <RadioCard
          key={m.value}
          name="reprocess-mode"
          value={m.value}
          checked={mode === m.value}
          onSelect={onChange}
          title={t(m.titleKey)}
          hint={t(m.descriptionKey)}
          textTestId="reprocess-mode-text"
        />
      ))}
    </fieldset>
  )
}

/** Whether the last start request was a resume (`{resume: <job_id>}`). */
function isResume(request: unknown): boolean {
  return typeof request === 'object' && request !== null && 'resume' in request
}

/** The message of a refused start; a refused resume says why the job can't be resumed (404 / 409). */
function startErrorKey(status: number | null | undefined, resuming: boolean): string {
  if (resuming && status === 404) return 'categoriesManager.reprocess.resumeGone'
  if (resuming && status === 409) return 'categoriesManager.reprocess.resumeRefused'
  return status === 409 ? 'categoriesManager.reprocess.alreadyRunning' : 'categoriesManager.reprocess.startError'
}

function StartError({ error, resuming }: Readonly<{ error: unknown; resuming: boolean }>) {
  const { t } = useTranslation('components')
  const status = apiErrorStatus(error)
  return (
    <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
      <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
      {t(startErrorKey(status, resuming))}
    </p>
  )
}

/** "Re-categorise processed reviews for the last 30 days, sources web, app." */
function confirmMessage(request: ReprocessStart, t: TFunction): string {
  const window = jobWindowLabel({
    days: 'days' in request ? request.days : 0,
    date_from: 'date_from' in request ? request.date_from : undefined,
    date_to: 'date_to' in request ? request.date_to : undefined,
    date_basis: 'date_basis' in request ? request.date_basis : 'processed',
  }, t)
  return t('categoriesManager.reprocess.confirmMessage', { mode: t(modeTitleKey(request.mode)), window })
}

export default function ReprocessPanel() {
  const { t } = useTranslation('components')
  const titleId = useId()
  const [form, setForm] = useState<ReprocessForm>(INITIAL_FORM)
  const [confirming, setConfirming] = useState(false)
  const { data: job } = useLatestJob()
  const { start, cancel } = useReprocessMutations(() => setConfirming(false))
  const request = buildStart(form)
  const busy = job != null && !isTerminalJob(job)
  const update = (patch: Partial<ReprocessForm>) => setForm((current) => ({ ...current, ...patch }))

  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-labelledby={titleId}>
      <div className="flex items-center gap-2">
        <RefreshCw size={16} className="text-accent" aria-hidden="true" />
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('categoriesManager.reprocess.title')}</h3>
      </div>
      <p className="text-sm text-muted">{t('categoriesManager.reprocess.description')}</p>

      <ModeChoice mode={form.mode} onChange={(mode) => update({ mode })} />
      <ReprocessSliceFields form={form} onChange={update} invalid={request === null} />
      <p className="text-xs text-warn">{t('categoriesManager.reprocess.costNote')}</p>

      <StickyActionBar variant="inline" className="py-2">
        <button type="button" onClick={() => setConfirming(true)} disabled={busy || request === null || start.isPending} className="btn btn-primary">
          <RefreshCw size={16} aria-hidden="true" />
          {t('categoriesManager.reprocess.start')}
        </button>
      </StickyActionBar>
      {start.isError && <StartError error={start.error} resuming={isResume(start.variables)} />}
      {job != null && (
        <JobProgress
          job={job}
          onCancel={() => cancel.mutate(job.job_id)}
          cancelling={cancel.isPending}
          onResume={busy ? undefined : () => start.mutate({ resume: job.job_id })}
          resuming={start.isPending}
        />
      )}

      {request !== null && (
        <ConfirmModal
          isOpen={confirming}
          title={t('categoriesManager.reprocess.confirmTitle')}
          message={confirmMessage(request, t)}
          confirmLabel={t('categoriesManager.reprocess.start')}
          variant="warning"
          isLoading={start.isPending}
          onConfirm={() => start.mutate(request)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  )
}
