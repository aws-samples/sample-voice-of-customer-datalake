/**
 * @fileoverview The Sources card's foot (7.104.00): Extract, its steps while it runs (starting, reading the sources,
 * thinking with the time so far, checking the citations, the proposal saved; also listed in Background jobs) and,
 * when it failed or went stale, why (by its code, in the person's language) and what to do: try again, or after a
 * time-out retry at `xhigh` (the person's choice, owner decision 10). With sources still being read it asks first,
 * since those are left out.
 *
 * @module pages/ProjectDetail/ProductExtractPanel
 */
import { useState } from 'react'
import { AlertCircle, Loader2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { formatClock } from './voice/voiceFormat'
import { isReading } from './useProductSources'
import type { ProductDoc, ProductExtractEffort, ProjectJob } from '../../api/projectTypes'
import type { ProductExtract } from './useProductExtract'

/** Each step the job writes (shared/jobs.py `starting`, then shared/product_extract.py's), as the person reads it. */
const STEP_KEYS: Readonly<Record<string, string>> = {
  starting: 'product.extract.steps.starting',
  reading_sources: 'product.extract.steps.readingSources',
  thinking: 'product.extract.steps.thinking',
  checking_citations: 'product.extract.steps.checkingCitations',
  saved: 'product.extract.steps.saved',
}

const FAILURE_KEYS: Readonly<Record<string, string>> = {
  refused: 'product.extract.failed.refused',
  timed_out: 'product.extract.failed.timedOut',
  cut: 'product.extract.failed.cut',
  unreadable: 'product.extract.failed.unreadable',
}

function RunningLine({ job, elapsed }: Readonly<{ job: ProjectJob | null; elapsed: number }>) {
  const { t } = useTranslation('projectDetail')
  const key = STEP_KEYS[job?.current_step ?? ''] ?? 'product.extract.steps.queued'
  return (
    <p role="status" className="flex items-center gap-1.5 text-xs text-muted">
      <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {t(key, { elapsed: formatClock(elapsed) })}
    </p>
  )
}

/** A failed extract's reason, by its code (`error_code`) in the person's language: never the job's `error`, which is
 * the server's English (the Background Jobs panel shows that); a stale one (no progress for the panel's threshold)
 * says it stopped. */
function FailureLine({ job, stale, pending, onRetry }: Readonly<{
  job: ProjectJob; stale: boolean; pending: boolean; onRetry: (effort: ProductExtractEffort) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const code = stale ? '' : job.error_code ?? ''
  const reason = t(stale ? 'product.extract.failed.stale' : FAILURE_KEYS[code] ?? 'product.extract.failed.generic')
  return (
    <div role="alert" className="space-y-2">
      <p className="flex items-start gap-1 text-xs text-danger">
        <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{reason}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => onRetry('max')}>{t('product.extract.tryAgain')}</button>
        {code === 'timed_out' ? (
          <Tooltip kind="description" content={t('product.extract.retryXhighHint')}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => onRetry('xhigh')}>
              {t('product.extract.retryXhigh')}
            </button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

function ExtractButton({ ready, extract, onClick }: Readonly<{ ready: number; extract: ProductExtract; onClick: () => void }>) {
  const { t } = useTranslation('projectDetail')
  const busy = extract.running || extract.pending
  return (
    <>
      <button type="button" className="btn btn-primary w-full" disabled={ready === 0 || busy} onClick={onClick}>
        {busy
          ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Sparkles size={14} aria-hidden="true" />}
        {t(extract.running ? 'product.extract.running' : 'product.extract.button')}
      </button>
      <p className="text-[12px] text-muted">{t(ready === 0 ? 'product.extract.noReady' : 'product.extract.hint')}</p>
    </>
  )
}

export default function ProductExtractPanel({ docs, extract }: Readonly<{ docs: readonly ProductDoc[]; extract: ProductExtract }>) {
  const { t } = useTranslation('projectDetail')
  const [confirming, setConfirming] = useState<ProductExtractEffort | null>(null)
  const reading = docs.filter(isReading).length
  const ask = (effort: ProductExtractEffort) => {
    if (reading > 0) setConfirming(effort)
    else extract.start(effort)
  }
  const failed = !extract.running && (extract.job?.status === 'failed' || extract.stale) ? extract.job : null
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <ExtractButton ready={docs.filter((doc) => doc.status === 'ready').length} extract={extract} onClick={() => ask('max')} />
      {extract.running ? <RunningLine job={extract.job} elapsed={extract.elapsed} /> : null}
      {failed === null ? null : <FailureLine job={failed} stale={extract.stale} pending={extract.pending} onRetry={ask} />}
      {extract.startError === null ? null : <p role="alert" className="text-xs text-danger">{t(extract.startError)}</p>}
      <ConfirmModal
        isOpen={confirming !== null}
        variant="info"
        title={t('product.extract.confirmTitle')}
        message={t('product.extract.confirmLeftOut', { count: reading })}
        confirmLabel={t('product.extract.confirm')}
        onConfirm={() => {
          if (confirming !== null) extract.start(confirming)
          setConfirming(null)
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  )
}
