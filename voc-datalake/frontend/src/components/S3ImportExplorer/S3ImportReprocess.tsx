/**
 * @fileoverview Reprocess one imported file (issue #144, docs/s3-import.md).
 *
 * A confirmation that explains what a reprocess does (missing rows are imported
 * again, duplicates are skipped, stored rows are NOT re-enriched: that is
 * "Reprocess existing feedback"), then a status line that polls the run until it
 * settles. The run is the platform's source-run record, so a finished run also
 * refreshes the feedback caches (api/feedbackDataWatch.ts).
 *
 * @module components/S3ImportExplorer/S3ImportReprocess
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, AlertCircle, Loader2, RotateCw, X } from 'lucide-react'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import {
  S3_IMPORT_REPROCESS_ROOT, getS3ImportReprocessRun, isRunSettled, reprocessS3ImportFile, type S3ImportRun,
} from '../../api/s3ImportReprocessApi'
import { describeImportKey } from './importKey'

const POLL_INTERVAL_MS = 2_000

export function ReprocessFileButton({ onClick }: Readonly<{ onClick: () => void }>) {
  const { t } = useTranslation('components')
  return (
    <button
      type="button"
      onClick={onClick}
      className="p-2 sm:p-1.5 text-muted hover:text-accent-text hover:bg-accent-subtle rounded-sm"
      title={t('s3Import.reprocess.action')}
      aria-label={t('s3Import.reprocess.action')}
    >
      <RotateCw size={16} aria-hidden />
    </button>
  )
}

function RunStatusLine({ run, filename }: Readonly<{ run: S3ImportRun; filename: string }>) {
  const { t } = useTranslation('components')
  if (!isRunSettled(run)) {
    return (
      <span className="flex items-center gap-2 text-accent-text">
        <Loader2 size={16} className="animate-spin" aria-hidden /> {t('s3Import.reprocess.running', { filename })}
      </span>
    )
  }
  if (run.status === 'completed') {
    return (
      <span className="flex items-center gap-2 text-ok">
        <CheckCircle2 size={16} aria-hidden /> {t('s3Import.reprocess.completed', { filename, count: run.items_found })}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-2 text-danger">
      <AlertCircle size={16} aria-hidden /> {t('s3Import.reprocess.failed', { filename })}
    </span>
  )
}

function RunStatus({ started, onDismiss }: Readonly<{ started: S3ImportRun; onDismiss: () => void }>) {
  const { t } = useTranslation('components')
  const { data, isError } = useQuery({
    queryKey: [S3_IMPORT_REPROCESS_ROOT, started.run_id],
    queryFn: () => getS3ImportReprocessRun(started.run_id),
    initialData: started,
    // Stops once the run settles, and on a failed poll (a 4xx is not retried; see queryPolicies).
    refetchInterval: (query) => (query.state.error !== null || isRunSettled(query.state.data ?? started) ? false : POLL_INTERVAL_MS),
  })
  // A poll that failed leaves the last answer `running`: shown as failed, not as a spinner forever.
  const shown: S3ImportRun = isError && !isRunSettled(data) ? { ...data, status: 'unknown' } : data
  return (
    <div role="status" className="flex items-center justify-between gap-2 border border-border rounded-lg px-3 py-2 text-sm">
      <RunStatusLine run={shown} filename={describeImportKey(started.key).filename} />
      {isRunSettled(shown) && (
        <button type="button" onClick={onDismiss} className="p-1 text-muted hover:text-text rounded-sm"
          aria-label={t('s3Import.reprocess.dismiss')} title={t('s3Import.reprocess.dismiss')}>
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  )
}

/**
 * The confirmation for `fileKey` (null = closed) and, once started, the run's status.
 * Stays mounted after the dialog closes, so the status keeps polling.
 */
export default function S3ImportReprocess({ fileKey, onClose }: Readonly<{ fileKey: string | null; onClose: () => void }>) {
  const { t } = useTranslation('components')
  const [run, setRun] = useState<S3ImportRun | null>(null)
  const start = useMutation({
    mutationFn: (key: string) => reprocessS3ImportFile(key),
    onSuccess: (started) => {
      setRun(started)
      onClose()
    },
  })
  const target = fileKey === null ? null : describeImportKey(fileKey)

  return (
    <>
      <ConfirmModal
        isOpen={fileKey !== null}
        title={t('s3Import.reprocess.confirmTitle', { filename: target?.filename ?? '' })}
        message={t('s3Import.reprocess.confirmMessage', { source: target?.source ?? '' })}
        confirmLabel={t('s3Import.reprocess.confirm')}
        variant="info"
        isLoading={start.isPending}
        onConfirm={() => { if (fileKey !== null) start.mutate(fileKey) }}
        onCancel={() => { start.reset(); onClose() }}
      >
        {start.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {t('s3Import.reprocess.startFailed', { error: start.error.message })}
          </p>
        )}
      </ConfirmModal>
      {run !== null && <RunStatus key={run.run_id} started={run} onDismiss={() => setRun(null)} />}
    </>
  )
}
