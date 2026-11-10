/**
 * @fileoverview The Logs section's "System errors" tab: every ERROR / CRITICAL
 * (optionally WARNING) log line and platform crash of this deployment's Lambdas,
 * Step Functions workflows and API Gateway 5xx (4xx) answers, grouped by function
 * and message (`GET /logs/system`, admin-only). One row per group; a row expands
 * to the newest raw occurrence and can load every line of that request. Above
 * the groups: the failure queues and the environment; the download carries all of it.
 * @module pages/Settings/SystemLogsPanel
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, Download, Info, Loader2, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { useIsAdmin } from '../../store/authStore'
import { formatDateTime } from '../../utils/dateUtils'
import { SYSTEM_LOG_FILTERS, canShowRequest, type SystemLogFilter, type SystemLogGroup, type SystemLogLevel } from '../../api/systemLogs'
import { LogsEmptyState } from './SourceLogList'
import { SettingsNotice } from './SettingsNotice'
import { formatTimestamp } from './logsFormat'
import SystemEnvironment from './SystemEnvironment'
import SystemFailureQueues from './SystemFailureQueues'
import SystemRequestLines from './SystemRequestLines'
import { downloadSystemLogs } from './systemLogsExport'
import { useSystemEnvironment, useSystemFailureQueues, useSystemLogs } from './useSystemLogs'

/** Logs Insights' row cap (`limit 10000` in shared/system_logs.py): a truncated answer read this many lines. */
const INSIGHTS_ROW_CAP = 10000

const LEVEL_BADGE: Record<SystemLogLevel, string> = {
  ERROR: 'badge-danger',
  CRITICAL: 'badge-danger',
  PLATFORM: 'badge-danger',
  HTTP: 'badge-danger',
  WARNING: 'badge-warn',
}

const groupKey = (group: SystemLogGroup) => `${group.function}|${group.level}|${group.message}`

export default function SystemLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const isAdmin = useIsAdmin()
  const [level, setLevel] = useState<SystemLogFilter>('error')

  if (!isAdmin) return <SettingsNotice text={t('logs.system.adminOnly')} />

  return (
    <div className="space-y-3">
      <select
        value={level}
        onChange={(e) => setLevel(SYSTEM_LOG_FILTERS.find((f) => f === e.target.value) ?? 'error')}
        aria-label={t('logs.system.levelLabel')}
        title={t('logs.system.levelLabel')}
        className="select-sm select w-auto"
      >
        <option value="error">{t('logs.system.levelError')}</option>
        <option value="warning">{t('logs.system.levelWarning')}</option>
      </select>
      <SystemFailureQueues />
      <SystemEnvironment />
      <SystemLogsResult days={days} level={level} />
    </div>
  )
}

function SystemLogsResult({ days, level }: { readonly days: number; readonly level: SystemLogFilter }) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const { data, isLoading, isError, isFetching, refetch } = useSystemLogs(days, level)
  // Loaded up front (also while the Environment block is closed) so the download carries them.
  const queues = useSystemFailureQueues()
  useSystemEnvironment()
  const [exporting, setExporting] = useState(false)

  if (isLoading) return <SearchingState functions={0} />
  if (isError || data === undefined) return <SettingsNotice text={t('logs.system.loadFailed')} />
  if (data.status === 'running') return <SearchingState functions={data.log_groups} />
  // The route's own failure text is English; the reader gets the translated notice.
  if (data.status === 'failed') return <SettingsNotice text={t('logs.system.failed')} />

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {t('logs.system.searched', { count: data.log_groups })}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setExporting(true)
              void downloadSystemLogs(queryClient, { data, days, level }).finally(() => setExporting(false))
            }}
            disabled={exporting}
            title={t('logs.system.downloadTitle')}
            className="btn btn-secondary btn-sm flex items-center gap-1.5"
          >
            {exporting
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <Download size={14} aria-hidden="true" />}
            {t('logs.system.download')}
          </button>
          <button
            type="button"
            onClick={() => {
              void refetch()
              void queues.refetch()
            }}
            disabled={isFetching}
            className="btn btn-secondary btn-sm flex items-center gap-1.5"
          >
            <RefreshCw size={14} className={clsx(isFetching && 'animate-spin')} aria-hidden="true" />
            {t('logs.refresh')}
          </button>
        </div>
      </div>
      {data.truncated && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Info size={14} aria-hidden="true" />
          {t('logs.system.truncated', { rows: INSIGHTS_ROW_CAP })}
        </p>
      )}
      {data.groups.length === 0
        ? <LogsEmptyState message={t('logs.system.empty')} icon={CheckCircle} />
        : <SystemLogGroupList groups={data.groups} />}
    </div>
  )
}

function SearchingState({ functions }: { readonly functions: number }) {
  const { t } = useTranslation('settings')
  return (
    <div role="status" className="card flex items-center justify-center gap-2 py-8 text-sm text-muted">
      <Loader2 size={18} className="animate-spin" aria-hidden="true" />
      {functions > 0 ? t('logs.system.searching', { count: functions }) : t('logs.system.searchingStart')}
    </div>
  )
}

function SystemLogGroupList({ groups }: { readonly groups: readonly SystemLogGroup[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="card space-y-2">
      {groups.map((group) => {
        const key = groupKey(group)
        return (
          <SystemLogRow
            key={key}
            group={group}
            isExpanded={expanded === key}
            onToggle={() => setExpanded(expanded === key ? null : key)}
          />
        )
      })}
    </div>
  )
}

function SystemLogRow({ group, isExpanded, onToggle }: Readonly<{
  group: SystemLogGroup
  isExpanded: boolean
  onToggle: () => void
}>) {
  const { t, i18n } = useTranslation('settings')
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-bg-hover"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={clsx('badge font-mono flex-shrink-0', LEVEL_BADGE[group.level])}>{group.level}</span>
          {group.source !== 'lambda' && (
            <span className="badge badge-muted flex-shrink-0" title={t('logs.system.sourceTitle')}>
              {group.source === 'api' ? t('logs.system.sourceApi') : t('logs.system.sourceWorkflow')}
            </span>
          )}
          <span className="text-xs font-mono text-text-strong flex-shrink-0">{group.function}</span>
          <span className="text-sm text-text truncate" title={group.message}>{group.message}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs font-mono text-muted" title={t('logs.system.occurrences', { count: group.count })}>
            {t('logs.system.times', { n: group.count })}
          </span>
          <span className="text-xs text-muted">{formatTimestamp(group.last_seen, t, i18n.language)}</span>
          <ChevronDown size={14} className={clsx('text-muted transition-transform', isExpanded && 'rotate-180')} aria-hidden="true" />
        </div>
      </button>
      {isExpanded && <SystemLogDetail group={group} />}
    </div>
  )
}

function SystemLogDetail({ group }: { readonly group: SystemLogGroup }) {
  const { t, i18n } = useTranslation('settings')
  return (
    <div className="p-3 bg-bg-accent border-t border-border text-sm space-y-2">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text">{group.sample || group.message}</pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="font-medium text-text">{t('logs.system.firstSeen')}</dt>
        <dd className="text-muted">{formatDateTime(group.first_seen, i18n.language, group.first_seen)}</dd>
        <dt className="font-medium text-text">{t('logs.system.lastSeen')}</dt>
        <dd className="text-muted">{formatDateTime(group.last_seen, i18n.language, group.last_seen)}</dd>
        {group.request_id !== null && <>
          <dt className="font-medium text-text">{t('logs.system.requestId')}</dt>
          <dd className="font-mono text-muted break-all">{group.request_id}</dd>
        </>}
      </dl>
      {canShowRequest(group) && <SystemRequestLines group={group} />}
    </div>
  )
}
