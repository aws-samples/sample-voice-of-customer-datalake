/**
 * @fileoverview One import run with the warnings and errors its import returned
 * (`GET /scrapers/manual/history/{run_id}`, docs/import-history.md).
 * @module pages/Scrapers/ImportRunDetail
 */
import { useQuery } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { importHistoryApi, importRunKey } from '../../api/importHistoryApi'
import { formatDateTime } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import type { ImportRunDetail as RunDetail } from '../../api/importHistoryApi'

const COUNT_KEYS = ['received', 'imported', 'skipped', 'duplicate', 'failed'] as const

function MessageList({ title, messages, total }: Readonly<{ title: string; messages: readonly string[]; total: number }>) {
  const { t, i18n } = useTranslation('scrapers')
  if (messages.length === 0) return null
  return (
    <section aria-label={title} className="space-y-1">
      <h4 className="text-[12px] font-semibold text-text-strong">
        {title} <span className="text-muted font-normal">({formatCount(total, i18n.language)})</span>
      </h4>
      <ul className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border text-[12px] font-mono">
        {messages.map((message, index) => <li key={`${String(index)}-${message}`} className="px-2 py-1 break-words">{message}</li>)}
      </ul>
      {total > messages.length && (
        <p className="text-[12px] text-muted">{t('importHistory.detail.moreNotShown', { count: total - messages.length })}</p>
      )}
    </section>
  )
}

function RunFacts({ run }: Readonly<{ run: RunDetail }>) {
  const { t, i18n } = useTranslation('scrapers')
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-5">
      {COUNT_KEYS.map((key) => (
        <div key={key}>
          <dt className="text-muted">{t(`importHistory.counts.${key}`)}</dt>
          <dd className="text-text-strong font-medium">{formatCount(run.counts[key], i18n.language)}</dd>
        </div>
      ))}
      <div className="col-span-2 sm:col-span-5">
        <dt className="text-muted">{t('importHistory.detail.finished')}</dt>
        <dd>{formatDateTime(run.finished_at, i18n.language, '—')}</dd>
      </div>
      <div className="col-span-2 sm:col-span-5">
        <dt className="text-muted">{t('importHistory.detail.rawFile')}</dt>
        <dd className="font-mono break-all">{run.raw_s3_key ?? t('importHistory.detail.noRawFile')}</dd>
      </div>
    </dl>
  )
}

export default function ImportRunDetail({ runId, onClose }: Readonly<{ runId: string; onClose: () => void }>) {
  const { t } = useTranslation('scrapers')
  const { data: run, isLoading, isError } = useQuery({
    queryKey: importRunKey(runId),
    queryFn: () => importHistoryApi.get(runId),
  })
  return (
    <div className="card space-y-3" role="region" aria-label={t('importHistory.detail.title')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-strong">{t('importHistory.detail.title')}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t('importHistory.detail.close')}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {isLoading && <Loader2 className="animate-spin text-accent" size={18} aria-label={t('importHistory.detail.loading')} />}
      {!isLoading && (isError || run == null) && <p role="alert" className="text-sm text-danger">{t('importHistory.detail.loadFailed')}</p>}
      {run != null && (
        <>
          <RunFacts run={run} />
          <MessageList title={t('importHistory.detail.errors')} messages={run.errors} total={run.error_count} />
          <MessageList title={t('importHistory.detail.warnings')} messages={run.warnings} total={run.warning_count} />
          {run.warnings.length === 0 && run.errors.length === 0 && <p className="text-[12px] text-muted">{t('importHistory.detail.noMessages')}</p>}
          {run.truncated && <p className="text-[12px] text-muted">{t('importHistory.detail.truncated')}</p>}
        </>
      )}
    </div>
  )
}
