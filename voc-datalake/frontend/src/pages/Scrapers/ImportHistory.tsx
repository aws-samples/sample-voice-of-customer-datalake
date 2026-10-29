/**
 * @fileoverview "Import history" on the Data sources page: every paste, CSV, JSON,
 * assistant and S3 import of the last 90 days, newest first, with who ran it, its
 * counts and status; a row opens its warnings and errors (docs/import-history.md).
 * Admin-only, like the imports (the page mounts it for admins only).
 * @module pages/Scrapers/ImportHistory
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { importHistoryApi, importHistoryKey } from '../../api/importHistoryApi'
import { formatDateTime } from '../../utils/dateUtils'
import ImportRunDetail from './ImportRunDetail'
import type { ImportRunSummary } from '../../api/importHistoryApi'

const STATUS_CLASS: Record<ImportRunSummary['status'], string> = {
  completed: 'badge-ok', partial: 'badge-warn', failed: 'badge-danger', unknown: 'badge-muted',
}

/** The first page has no cursor. */
const FIRST_PAGE: string | undefined = undefined

/** "s3-upload" is the bucket trigger (uploader unknown); a console run shows the caller's email. */
function useActorLabel() {
  const { t } = useTranslation('scrapers')
  return (run: ImportRunSummary) => {
    if (run.actor === 's3-upload') return t('importHistory.actorS3')
    return run.actor_email || run.actor || '—'
  }
}

function CountsCell({ run }: Readonly<{ run: ImportRunSummary }>) {
  const { t } = useTranslation('scrapers')
  const { counts } = run
  const extra = (['skipped', 'duplicate', 'failed'] as const)
    .filter((key) => counts[key] > 0)
    .map((key) => t(`importHistory.countsShort.${key}`, { count: counts[key] }))
  return (
    <>
      <span>{t('importHistory.importedOf', { imported: counts.imported, received: counts.received })}</span>
      {extra.length > 0 && <span className="block text-muted">{extra.join(', ')}</span>}
    </>
  )
}

function RunRow({ run, selected, onSelect }: Readonly<{ run: ImportRunSummary; selected: boolean; onSelect: () => void }>) {
  const { t, i18n } = useTranslation('scrapers')
  const actorLabel = useActorLabel()
  return (
    <tr className={clsx('border-t border-border align-top', selected && 'bg-hover')}>
      <td className="py-2 pr-2">
        <button type="button" className="link text-left font-medium focus-ring rounded-sm"
          aria-expanded={selected} onClick={onSelect}
          aria-label={t('importHistory.openRun', { method: t(`importHistory.methods.${run.method}`), source: run.source })}>
          {t(`importHistory.methods.${run.method}`)}
        </button>
      </td>
      <td className="py-2 pr-2 break-words">{run.source || '—'}</td>
      <td className="py-2 pr-2 break-all">{actorLabel(run)}</td>
      <td className="py-2 pr-2 whitespace-nowrap">{formatDateTime(run.started_at, i18n.language, '—')}</td>
      <td className="py-2 pr-2"><CountsCell run={run} /></td>
      <td className="py-2"><span className={clsx('badge', STATUS_CLASS[run.status])}>{t(`importHistory.status.${run.status}`)}</span></td>
    </tr>
  )
}

function RunsTable({ runs, selectedId, onSelect }: Readonly<{
  runs: readonly ImportRunSummary[]; selectedId: string | null; onSelect: (runId: string) => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <caption className="sr-only">{t('importHistory.title')}</caption>
        <thead>
          <tr className="text-left text-muted">
            {(['method', 'source', 'actor', 'started', 'counts', 'status'] as const).map((column) => (
              <th key={column} scope="col" className="py-1 pr-2 font-medium">{t(`importHistory.columns.${column}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.run_id} run={run} selected={run.run_id === selectedId} onSelect={() => onSelect(run.run_id)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ImportHistory() {
  const { t } = useTranslation('scrapers')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const query = useInfiniteQuery({
    queryKey: importHistoryKey(),
    queryFn: ({ pageParam }) => importHistoryApi.list(pageParam),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (page) => page.next_cursor,
  })
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? []
  const toggle = (runId: string) => setSelectedId((current) => (current === runId ? null : runId))

  return (
    <section aria-labelledby="import-history-heading" className="pt-2 space-y-3">
      <div>
        <h2 id="import-history-heading" className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted">{t('importHistory.title')}</h2>
        <p className="text-[12px] text-muted mt-1">{t('importHistory.subtitle')}</p>
      </div>
      <div className="card space-y-3">
        {query.isLoading && <div role="status" aria-label={t('importHistory.loading')}><Loader2 className="animate-spin text-accent" size={18} aria-hidden="true" /></div>}
        {query.isError && runs.length === 0 && <LoadFailed onRetry={() => void query.refetch()} retrying={query.isFetching} />}
        {!query.isLoading && !query.isError && runs.length === 0 && <p className="text-sm text-muted">{t('importHistory.empty')}</p>}
        {runs.length > 0 && <RunsTable runs={runs} selectedId={selectedId} onSelect={toggle} />}
        {query.hasNextPage && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {t('importHistory.loadMore')}
          </button>
        )}
      </div>
      {selectedId != null && <ImportRunDetail runId={selectedId} onClose={() => setSelectedId(null)} />}
    </section>
  )
}
