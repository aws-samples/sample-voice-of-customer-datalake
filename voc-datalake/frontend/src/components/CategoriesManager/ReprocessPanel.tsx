/**
 * @fileoverview "Reprocess existing feedback" — re-categorise stored reviews
 * after the categories change (admin only, Settings → Categories).
 *
 * Mode choice (re-categorise processed text vs. reprocess from raw data), the
 * window (0 = all time), whether manual corrections are overwritten, a cost note
 * (one model call per review), a confirmation, live progress polled from the
 * job, and cancel. Nothing is deleted by either mode — items are updated in place.
 *
 * Labels that vary by value are held in `*Key` table properties with their
 * namespace, so scripts/i18n-check.mjs can see them (it cannot read a template
 * literal key) — hence no `keyPrefix` in this file.
 *
 * @module components/CategoriesManager/ReprocessPanel
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, RefreshCw, Square } from 'lucide-react'
import clsx from 'clsx'
import type { TFunction } from 'i18next'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { ALL_TIME_CUSTOM_DAYS, MAX_CUSTOM_DAYS, parseCustomDaysInput } from '../../api/baseUrl'
import { MAX_REPROCESS_ITEMS, isTerminalJob, latestReprocessJobKey, reprocessApi } from '../../api/reprocessApi'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import type { ReprocessJob, ReprocessJobStatus, ReprocessMode, ReprocessRequest } from '../../api/reprocessApi'
import type { Tone } from '../../theme/tones'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

/** How often a running job is re-read. */
const POLL_INTERVAL_MS = 2_000

/** Copy per mode; a Record, so every mode the API accepts must have a title. */
const MODE_COPY: Record<ReprocessMode, { titleKey: string; descriptionKey: string }> = {
  processed: {
    titleKey: 'components:categoriesManager.reprocess.modes.processed.title',
    descriptionKey: 'components:categoriesManager.reprocess.modes.processed.description',
  },
  raw: {
    titleKey: 'components:categoriesManager.reprocess.modes.raw.title',
    descriptionKey: 'components:categoriesManager.reprocess.modes.raw.description',
  },
  dimensions: {
    titleKey: 'components:categoriesManager.reprocess.modes.dimensions.title',
    descriptionKey: 'components:categoriesManager.reprocess.modes.dimensions.description',
  },
}

/** Display order of the mode choices. */
const MODE_ORDER: readonly ReprocessMode[] = ['processed', 'raw', 'dimensions']
const MODES: ReadonlyArray<{ value: ReprocessMode; titleKey: string; descriptionKey: string }> =
  MODE_ORDER.map((value) => ({ value, ...MODE_COPY[value] }))

const STATUS: Record<ReprocessJobStatus, { tone: Tone; labelKey: string }> = {
  queued: { tone: 'muted', labelKey: 'components:categoriesManager.reprocess.status.queued' },
  running: { tone: 'info', labelKey: 'components:categoriesManager.reprocess.status.running' },
  completed: { tone: 'ok', labelKey: 'components:categoriesManager.reprocess.status.completed' },
  failed: { tone: 'danger', labelKey: 'components:categoriesManager.reprocess.status.failed' },
  cancelled: { tone: 'warn', labelKey: 'components:categoriesManager.reprocess.status.cancelled' },
}

const COUNTERS: ReadonlyArray<{ field: 'scanned' | 'updated' | 'unchanged' | 'skipped_manual' | 'failed'; labelKey: string }> = [
  { field: 'scanned', labelKey: 'components:categoriesManager.reprocess.counters.scanned' },
  { field: 'updated', labelKey: 'components:categoriesManager.reprocess.counters.updated' },
  { field: 'unchanged', labelKey: 'components:categoriesManager.reprocess.counters.unchanged' },
  { field: 'skipped_manual', labelKey: 'components:categoriesManager.reprocess.counters.skipped_manual' },
  { field: 'failed', labelKey: 'components:categoriesManager.reprocess.counters.failed' },
]

function modeTitleKey(mode: ReprocessMode): string {
  return MODE_COPY[mode].titleKey
}

function windowLabel(days: number, t: TFunction): string {
  return days === ALL_TIME_CUSTOM_DAYS
    ? t('categoriesManager.reprocess.allTime')
    : t('categoriesManager.reprocess.lastNDays', { count: days })
}

/** The latest job, polled while it is still moving. */
function useLatestJob() {
  return useQuery({
    queryKey: latestReprocessJobKey(),
    queryFn: () => reprocessApi.getLatest(),
    refetchInterval: (query) => {
      const job = query.state.data
      return job != null && !isTerminalJob(job) ? POLL_INTERVAL_MS : false
    },
  })
}

function useReprocessMutations(onStarted: () => void) {
  const queryClient = useQueryClient()
  const store = (job: ReprocessJob | null) => {
    if (job !== null) queryClient.setQueryData(latestReprocessJobKey(), job)
    void queryClient.invalidateQueries({ queryKey: latestReprocessJobKey() })
  }
  const start = useMutation({
    mutationFn: (request: ReprocessRequest) => reprocessApi.start(request),
    onSuccess: (job) => { store(job); onStarted() },
  })
  const cancel = useMutation({
    mutationFn: (jobId: string) => reprocessApi.cancel(jobId),
    onSuccess: store,
  })
  return { start, cancel }
}

function ModeChoice({ mode, onChange }: Readonly<{ mode: ReprocessMode; onChange: (m: ReprocessMode) => void }>) {
  const { t } = useTranslation('components')
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.modeLabel')}</legend>
      {MODES.map((m) => (
        <label
          key={m.value}
          className={clsx(
            'flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer',
            mode === m.value ? 'border-accent bg-accent-subtle' : 'border-border hover:bg-bg-hover',
          )}
        >
          <input
            type="radio"
            name="reprocess-mode"
            value={m.value}
            checked={mode === m.value}
            onChange={() => onChange(m.value)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="block text-sm font-medium text-text-strong">{t(m.titleKey)}</span>
            <span className="block text-xs text-text">{t(m.descriptionKey)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function JobProgress({ job, onCancel, cancelling }: Readonly<{ job: ReprocessJob; onCancel: () => void; cancelling: boolean }>) {
  const { t } = useTranslation('components')
  const running = !isTerminalJob(job)
  const status = STATUS[job.status]
  return (
    <div className="rounded-md border border-border bg-bg-accent p-3 space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge badge-${status.tone}`}>
          {running && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {t(status.labelKey)}
        </span>
        <span className="text-xs text-muted">{t(modeTitleKey(job.mode))} · {windowLabel(job.days, t)}</span>
        {running && (
          <button type="button" onClick={onCancel} disabled={cancelling} className="btn btn-danger btn-sm ml-auto">
            {cancelling ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
            {t('categoriesManager.reprocess.cancel')}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        {COUNTERS.map((c) => (
          <div key={c.field}>
            <dt className="text-muted">{t(c.labelKey)}</dt>
            <dd className="font-mono text-text-strong">{job[c.field].toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {job.stopped_at_ceiling && (
        <p className="text-xs text-warn">{t('categoriesManager.reprocess.stoppedAtCeiling', { max: MAX_REPROCESS_ITEMS.toLocaleString() })}</p>
      )}
      {job.error !== undefined && <p role="alert" className="text-xs text-danger">{job.error}</p>}
    </div>
  )
}

function StartError({ error }: Readonly<{ error: unknown }>) {
  const { t } = useTranslation('components')
  return (
    <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
      <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
      {apiErrorStatus(error) === 409 ? t('categoriesManager.reprocess.alreadyRunning') : t('categoriesManager.reprocess.startError')}
    </p>
  )
}

function WindowFields({ daysInput, onDaysChange, includeManual, onIncludeManualChange, invalid }: Readonly<{
  daysInput: string
  onDaysChange: (value: string) => void
  includeManual: boolean
  onIncludeManualChange: (value: boolean) => void
  invalid: boolean
}>) {
  const { t } = useTranslation('components')
  const daysId = useId()
  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <label htmlFor={daysId} className="block text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.daysLabel')}</label>
          <input
            id={daysId}
            type="number"
            inputMode="numeric"
            min={ALL_TIME_CUSTOM_DAYS}
            max={MAX_CUSTOM_DAYS}
            value={daysInput}
            onChange={(e) => onDaysChange(e.target.value)}
            aria-invalid={invalid}
            className="input font-mono py-1.5 w-32"
          />
        </div>
        <label className="flex items-center gap-2 text-sm min-h-9">
          <input
            type="checkbox"
            checked={includeManual}
            onChange={(e) => onIncludeManualChange(e.target.checked)}
            className="rounded-sm accent-accent"
          />
          <span className="text-text">{t('categoriesManager.reprocess.includeManual')}</span>
        </label>
      </div>
      <p className="text-xs text-muted">{t('categoriesManager.reprocess.daysHint', { max: MAX_CUSTOM_DAYS })}</p>
    </>
  )
}

export default function ReprocessPanel() {
  const { t } = useTranslation('components')
  const titleId = useId()
  const [mode, setMode] = useState<ReprocessMode>('processed')
  const [daysInput, setDaysInput] = useState(String(ALL_TIME_CUSTOM_DAYS))
  const [includeManual, setIncludeManual] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { data: job } = useLatestJob()
  const { start, cancel } = useReprocessMutations(() => setConfirming(false))
  const days = parseCustomDaysInput(daysInput)
  const busy = job != null && !isTerminalJob(job)

  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-labelledby={titleId}>
      <div className="flex items-center gap-2">
        <RefreshCw size={16} className="text-accent" aria-hidden="true" />
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('categoriesManager.reprocess.title')}</h3>
      </div>
      <p className="text-sm text-muted">{t('categoriesManager.reprocess.description')}</p>

      <ModeChoice mode={mode} onChange={setMode} />
      <WindowFields
        daysInput={daysInput}
        onDaysChange={setDaysInput}
        includeManual={includeManual}
        onIncludeManualChange={setIncludeManual}
        invalid={days === null}
      />
      <p className="text-xs text-warn">{t('categoriesManager.reprocess.costNote')}</p>

      <StickyActionBar variant="inline" className="py-2">
        <button type="button" onClick={() => setConfirming(true)} disabled={busy || days === null || start.isPending} className="btn btn-primary">
          <RefreshCw size={16} aria-hidden="true" />
          {t('categoriesManager.reprocess.start')}
        </button>
      </StickyActionBar>
      {start.isError && <StartError error={start.error} />}
      {job != null && <JobProgress job={job} onCancel={() => cancel.mutate(job.job_id)} cancelling={cancel.isPending} />}

      {days !== null && (
        <ConfirmModal
          isOpen={confirming}
          title={t('categoriesManager.reprocess.confirmTitle')}
          message={t('categoriesManager.reprocess.confirmMessage', { mode: t(modeTitleKey(mode)), window: windowLabel(days, t) })}
          confirmLabel={t('categoriesManager.reprocess.start')}
          variant="warning"
          isLoading={start.isPending}
          onConfirm={() => start.mutate({ mode, days, include_manual: includeManual })}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  )
}
