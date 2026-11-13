/**
 * @fileoverview The run monitor's Reports panel: the run's commit, PR and goal reports (`…/reports`, the report
 * builder's versions in the workspace bucket), grouped by level, goal first. Choosing one shows its latest version's
 * Markdown, with a picker for any earlier version (a version is never changed: a newer one is written beside it).
 *
 * The Markdown is the server's (`engineering/reports/render.py`), made from the run's records and its agents' findings:
 * it is rendered as Markdown only (no raw HTML), like the other documents the app shows.
 *
 * @module pages/Agents/EngineeringReports
 */
import { useId, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { apiErrorStatus, retryOnceUnlessNotFound } from '../../api/apiErrorStatus'
import { REPORT_LEVELS, engineeringRunsApi, engineeringRunsKeys } from '../../api/engineeringRunsApi'
import { formatDateTime } from '../../utils/dateUtils'
import { groupsInOrder } from './engineeringRunText'
import { useEngineeringReports } from './useEngineeringRun'
import type { EngineeringReport, EngineeringReportEntry } from '../../api/engineeringRunsApi'

const sameReport = (a: EngineeringReportEntry, b: EngineeringReportEntry) => a.level === b.level && a.subject === b.subject

function ReportView({ runId, entry }: Readonly<{ runId: string; entry: EngineeringReportEntry }>) {
  const { t, i18n } = useTranslation('agents')
  const pickerId = useId()
  // null: the latest the index names (so a newer version written later is read when the index shows it); a number:
  // that version. Either way the read names its version, which never changes once written.
  const [version, setVersion] = useState<number | null>(null)
  const shown = version ?? entry.latest_version
  const query = useQuery({
    queryKey: engineeringRunsKeys.report(runId, entry.level, entry.subject, shown),
    queryFn: () => engineeringRunsApi.report(runId, entry.level, entry.subject, shown),
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
    // Following the latest: the version on screen stays until the newer one is read (a picked version never does).
    placeholderData: version === null ? keepPreviousData : undefined,
  })
  // A version below the latest can have been counted and never written (its build failed before the put): its 404
  // is for good, so it says so, with no retry. The latest the index lists was written, so its 404 is a failed read.
  const missing = query.isError && apiErrorStatus(query.error) === 404 && shown < entry.latest_version
  const versions = Array.from({ length: entry.latest_version }, (_, index) => entry.latest_version - index)
  return (
    <section className="space-y-2" aria-label={t('engineeringRun.reports.title', { subject: entry.subject })}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={pickerId} className="text-[12px] text-muted">{t('engineeringRun.reports.version')}</label>
        <select id={pickerId} className="input input-sm w-auto" value={version ?? ''}
          onChange={(event) => setVersion(event.target.value === '' ? null : Number(event.target.value))}>
          <option value="">{t('engineeringRun.reports.latest', { n: entry.latest_version })}</option>
          {versions.slice(1).map((n) => <option key={n} value={n}>{t('engineeringRun.reports.versionN', { n })}</option>)}
        </select>
        {query.data !== undefined && query.data.builtAt !== '' && (
          <span className="text-[12px] text-muted">
            {t('engineeringRun.reports.builtAt', { when: formatDateTime(query.data.builtAt, i18n.language, '—') })}
          </span>
        )}
      </div>
      <ReportBody query={query} missing={missing} />
    </section>
  )
}

/** The version's Markdown, or why it is not shown: loading, never written (no retry), or a failed read (a retry). */
function ReportBody({ query, missing }: Readonly<{ query: UseQueryResult<EngineeringReport, unknown>; missing: boolean }>) {
  const { t } = useTranslation('agents')
  if (query.isLoading) return <div className="skeleton h-24" />
  if (missing) return <p className="text-sm text-muted">{t('engineeringRun.reports.missing')}</p>
  if (query.isError) {
    return <LoadFailed message={t('engineeringRun.reports.readFailed')} onRetry={() => { void query.refetch() }}
      retrying={query.isFetching} />
  }
  if (query.data === undefined) return null
  return (
    <div className="md-content break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{query.data.markdown}</ReactMarkdown>
    </div>
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
