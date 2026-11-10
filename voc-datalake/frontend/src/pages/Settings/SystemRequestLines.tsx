/**
 * @fileoverview "Show the whole request" in an expanded System errors row: every
 * log line (any level, INFO included) of the group's newest invocation
 * (`GET /logs/system/request`, polled while running), oldest first. Not offered
 * for API Gateway rows (their id is the gateway's, not a function's) or rows
 * without a request id.
 * @module pages/Settings/SystemRequestLines
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListTree, Loader2, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import type { SystemLogGroup } from '../../api/systemLogs'
import type { SystemRequestLine } from '../../api/systemDiagnostics'
import { formatDateTime } from '../../utils/dateUtils'
import { SettingsNotice } from './SettingsNotice'
import { useSystemRequest } from './useSystemLogs'

/** The server's line cap (shared/system_logs: ≤ 500 lines per request). */
const REQUEST_LINE_CAP = 500

const LEVEL_TEXT: Readonly<Record<string, string>> = {
  ERROR: 'text-danger',
  CRITICAL: 'text-danger',
  FATAL: 'text-danger',
  WARNING: 'text-warn',
  WARN: 'text-warn',
}

export default function SystemRequestLines({ group }: { readonly group: SystemLogGroup }) {
  const { t } = useTranslation('settings')
  const [requested, setRequested] = useState(false)
  if (!requested) {
    return (
      <button
        type="button"
        onClick={() => setRequested(true)}
        className="btn btn-secondary btn-sm flex items-center gap-1.5"
      >
        <ListTree size={14} aria-hidden="true" />
        {t('logs.system.request.show')}
      </button>
    )
  }
  return <RequestResult group={group} />
}

function RequestResult({ group }: { readonly group: SystemLogGroup }) {
  const { t } = useTranslation('settings')
  const { data, isLoading, isError, refetch } = useSystemRequest(group, true)

  if (isLoading || data?.status === 'running') {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {t('logs.system.request.loading')}
      </p>
    )
  }
  if (isError || data === undefined || data.status === 'failed') {
    return (
      <div className="space-y-2">
        <SettingsNotice text={t(data?.status === 'failed' ? 'logs.system.request.failed' : 'logs.system.request.loadFailed')} />
        <button type="button" onClick={() => void refetch()} className="btn btn-secondary btn-sm flex items-center gap-1.5">
          <RefreshCw size={14} aria-hidden="true" />
          {t('logs.system.request.retry')}
        </button>
      </div>
    )
  }
  if (data.lines.length === 0) return <p className="text-xs text-muted">{t('logs.system.request.empty')}</p>

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-text">
        {t('logs.system.request.title', { count: data.lines.length })}
      </p>
      {data.truncated && (
        <p className="text-xs text-muted">{t('logs.system.request.truncated', { lines: REQUEST_LINE_CAP })}</p>
      )}
      <RequestLineList lines={data.lines} />
    </div>
  )
}

/** Lines have no id of their own: the position in the (never reordered) log plus its time. */
const keyedLines = (lines: readonly SystemRequestLine[]) =>
  lines.map((line, position) => ({ line, key: `${String(position)}@${line.timestamp}` }))

function RequestLineList({ lines }: { readonly lines: readonly SystemRequestLine[] }) {
  const { t, i18n } = useTranslation('settings')
  return (
    <ol aria-label={t('logs.system.request.linesLabel')} className="max-h-96 overflow-auto rounded-lg border border-border bg-bg divide-y divide-border">
      {keyedLines(lines).map(({ line, key }) => (
        <li key={key} className="grid grid-cols-[auto_auto_1fr] gap-x-2 px-2 py-1 font-mono text-xs">
          <span className="text-muted whitespace-nowrap">{formatDateTime(line.timestamp, i18n.language, line.timestamp)}</span>
          <span className={clsx('font-medium', LEVEL_TEXT[line.level] ?? 'text-muted')}>{line.level}</span>
          <pre className="whitespace-pre-wrap break-words text-text">{line.message}</pre>
        </li>
      ))}
    </ol>
  )
}
