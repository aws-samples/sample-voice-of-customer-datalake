/**
 * @fileoverview The run's Reports (the run workspace's Reports tab, 7.51.00): the run's commit, PR and goal reports
 * (`…/reports`, the report builder's versions in the workspace bucket), grouped by level, goal first. Choosing one
 * shows it on the shared document component (§6.4 [52] step 4: the panel variant, documents/runReportDocument.ts),
 * at the version picked from its menu (a version is never changed: a newer one is written beside it).
 *
 * The version on screen never changes by itself: a newer one the index lists says so, with **Show v<n>**.
 *
 * The Markdown is the server's (`engineering/reports/render.py`), made from the run's records and its agents' findings:
 * it is read through the shared safe-Markdown policy for agent text (`model`: safe links, no images, no raw HTML).
 *
 * @module pages/Agents/EngineeringReports
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { apiErrorStatus, retryOnceUnlessNotFound } from '../../api/apiErrorStatus'
import { REPORT_LEVELS, engineeringRunsApi, engineeringRunsKeys } from '../../api/engineeringRunsApi'
import { formatDateTime } from '../../utils/dateUtils'
import { groupsInOrder } from './engineeringRunText'
import { useEngineeringReports } from './useEngineeringRun'
import { newerReport, reportDocumentOf, reportVersions, runReportAdapter } from './documents/runReportDocument'
import ReadOnlySurface from './documents/ReadOnlySurface'
import type { ReactNode } from 'react'
import type { EngineeringReport, EngineeringReportEntry } from '../../api/engineeringRunsApi'

const sameReport = (a: EngineeringReportEntry, b: EngineeringReportEntry) => a.level === b.level && a.subject === b.subject

/** The version menu: the latest first, then each earlier one. */
function VersionMenu({ entry, version, onChange }: Readonly<{
  entry: EngineeringReportEntry; version: number; onChange: (n: number) => void
}>) {
  const { t } = useTranslation('agents')
  const pickerId = useId()
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={pickerId} className="text-[12px] text-muted">{t('engineeringRun.reports.version')}</label>
      <select id={pickerId} className="select select-sm w-auto" value={version} onChange={(event) => onChange(Number(event.target.value))}>
        {reportVersions(entry).map((n) => (
          <option key={n} value={n}>
            {n === entry.latest_version ? t('engineeringRun.reports.latest', { n }) : t('engineeringRun.reports.versionN', { n })}
          </option>
        ))}
      </select>
    </div>
  )
}

/** A newer version than the one on screen: said, and shown only when asked (the screen never moves by itself). */
function NewerVersion({ entry, version, onShow }: Readonly<{
  entry: EngineeringReportEntry; version: number; onShow: (n: number) => void
}>) {
  const { t } = useTranslation('documents')
  const newer = newerReport(entry, version)
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      {newer === null ? null : (
        <>
          {t('live.newer', { version: `v${String(newer)}` })}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onShow(newer)}>
            {t('live.show', { version: `v${String(newer)}` })}
          </button>
        </>
      )}
    </p>
  )
}

/** The version on the panel, or why it is not shown: never written (no retry), or a failed read (a retry). */
function ReportBody({ runId, entry, version, query, missing, meta }: Readonly<{
  runId: string; entry: EngineeringReportEntry; version: number; query: UseQueryResult<EngineeringReport, unknown>
  missing: boolean; meta: ReactNode
}>) {
  const { t } = useTranslation('agents')
  if (missing) return <p className="text-sm text-muted">{t('engineeringRun.reports.missing')}</p>
  if (query.isError) {
    return <LoadFailed message={t('engineeringRun.reports.readFailed')} onRetry={() => { void query.refetch() }}
      retrying={query.isFetching} />
  }
  return (
    <ReadOnlySurface adapter={runReportAdapter(runId, entry)} variant="panel" title={entry.subject} headingLevel={3} meta={meta}
      stored={query.data === undefined ? undefined : reportDocumentOf(entry, version, query.data)} mode="read" compare={null} fullPath={null} />
  )
}

function ReportView({ runId, entry }: Readonly<{ runId: string; entry: EngineeringReportEntry }>) {
  const { t, i18n } = useTranslation('agents')
  // The version on screen: the latest the index named when the report was opened, then the one picked.
  const [version, setVersion] = useState(entry.latest_version)
  const query = useQuery({
    queryKey: engineeringRunsKeys.report(runId, entry.level, entry.subject, version),
    queryFn: () => engineeringRunsApi.report(runId, entry.level, entry.subject, version),
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
  // A version below the latest can have been counted and never written (its build failed before the put): its 404
  // is for good, so it says so, with no retry. The latest the index lists was written, so its 404 is a failed read.
  const missing = query.isError && apiErrorStatus(query.error) === 404 && version < entry.latest_version
  const builtAt = query.data?.builtAt ?? ''
  const meta = builtAt === '' ? null
    : <p className="text-[12px] text-muted">{t('engineeringRun.reports.builtAt', { when: formatDateTime(builtAt, i18n.language, '—') })}</p>
  return (
    <section className="space-y-2" aria-label={t('engineeringRun.reports.title', { subject: entry.subject })}>
      <div className="flex flex-wrap items-center gap-2">
        <VersionMenu entry={entry} version={version} onChange={setVersion} />
        <NewerVersion entry={entry} version={version} onShow={setVersion} />
      </div>
      <ReportBody runId={runId} entry={entry} version={version} query={query} missing={missing} meta={meta} />
    </section>
  )
}

export function ReportsPanel({ runId, live }: Readonly<{ runId: string; live: boolean }>) {
  const { t } = useTranslation('agents')
  const query = useEngineeringReports(runId, live)
  const [chosen, setChosen] = useState<EngineeringReportEntry | null>(null)
  if (query.isLoading) return <div className="skeleton h-16" />
  const failed = query.isError && (
    <LoadFailed message={t('engineeringRun.reports.loadFailed')} onRetry={() => { void query.refetch() }}
      retrying={query.isFetching} />
  )
  // A failed poll keeps the index already read (and the report open); only a first read that failed has nothing.
  if (query.data === undefined) return failed || null
  const entries = query.data
  if (entries.length === 0) return <>{failed}<p className="text-sm text-muted">{t('engineeringRun.reports.none')}</p></>
  // The chosen report as the index has it now (its latest version may have moved on).
  const current = chosen === null ? undefined : entries.find((entry) => sameReport(entry, chosen))
  return (
    <div className="space-y-4">
      {failed}
      {groupsInOrder(REPORT_LEVELS, entries.map((entry) => entry.level)).map((level) => {
        const name = t(`engineeringRun.reports.levels.${level}`, { defaultValue: level })
        return (
          <section key={level} aria-label={name} className="space-y-2">
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{name}</h3>
            <ul className="space-y-1">
              {entries.filter((entry) => entry.level === level).map((entry) => (
                <li key={entry.subject}>
                  <button type="button" aria-pressed={current !== undefined && sameReport(current, entry)}
                    className="btn btn-ghost btn-sm max-w-full justify-start text-left break-all"
                    onClick={() => setChosen(entry)}>
                    {t('engineeringRun.reports.entry', { subject: entry.subject, n: entry.latest_version })}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {current !== undefined && <ReportView key={`${current.level}/${current.subject}`} runId={runId} entry={current} />}
    </div>
  )
}
