/**
 * @fileoverview Building blocks shared by the Logs section's panels: per-source
 * log groups with expandable entries, the refresh bar, the loading/empty states,
 * and the panel that composes them.
 * @module pages/Settings/SourceLogList
 */

import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, Loader2, RefreshCw, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { formatTimestamp, groupBySource } from './logsFormat'
import type { SourceLog } from './logsFormat'

/** Entries shown per source before the "N more" line. */
const ENTRIES_PER_SOURCE = 5

export function LogsLoadingState() {
  return (
    <div className="card flex items-center justify-center py-8">
      <Loader2 size={24} className="animate-spin text-muted" />
    </div>
  )
}

export function LogsEmptyState({ message, icon: Icon, tone = 'ok' }: { readonly message: string; readonly icon: LucideIcon; readonly tone?: 'ok' | 'muted' }) {
  return (
    <div className="card flex flex-col items-center justify-center py-8 text-muted">
      <Icon size={20} className={clsx('mb-2', tone === 'ok' ? 'text-ok' : 'text-muted')} />
      <p className="text-sm">{message}</p>
    </div>
  )
}

/** The panel's right-aligned Refresh button. */
function RefreshBar({ onRefresh }: { readonly onRefresh: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex justify-end">
      <button type="button" onClick={onRefresh} className="btn btn-secondary btn-sm flex items-center gap-1.5">
        <RefreshCw size={14} />
        {t('logs.refresh')}
      </button>
    </div>
  )
}

/** How one kind of log renders inside a source group. */
export interface LogEntryView<T> {
  /** The collapsed row's leading icon and text. */
  readonly summary: (log: T) => ReactNode
  /** The expanded body. */
  readonly detail: (log: T) => ReactNode
}

/**
 * One source's card: a header (badge, optional action) and its first entries, each
 * expandable. The expanded entry is the panel's state, so one entry is open across
 * every source at a time.
 */
function SourceLogGroup<T extends SourceLog>({ source, badge, action, logs, view, expandedLog, onExpand }: Readonly<{
  source: string
  badge: ReactNode
  action?: ReactNode
  logs: readonly T[]
  view: LogEntryView<T>
  expandedLog: string | null
  onExpand: (logKey: string | null) => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className={clsx('flex items-center mb-3', action === undefined ? 'gap-2' : 'justify-between')}>
        {action === undefined ? <>
          <span className="font-medium text-text-strong">{source}</span>
          {badge}
        </> : <>
          <div className="flex items-center gap-2">
            <span className="font-medium text-text-strong">{source}</span>
            {badge}
          </div>
          {action}
        </>}
      </div>

      <div className="space-y-2">
        {logs.slice(0, ENTRIES_PER_SOURCE).map((log, idx) => {
          const logKey = `${log.source_platform}-${log.message_id}-${idx}`
          const isExpanded = expandedLog === logKey
          return (
            <div key={logKey} className="border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => onExpand(isExpanded ? null : logKey)}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-bg-hover"
              >
                <div className="flex items-center gap-2 min-w-0">{view.summary(log)}</div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-muted">{formatTimestamp(log.timestamp, t)}</span>
                  <ChevronDown size={14} className={clsx('text-muted transition-transform', isExpanded && 'rotate-180')} />
                </div>
              </button>

              {isExpanded && (
                <div className="p-3 bg-bg-accent border-t border-border text-sm">{view.detail(log)}</div>
              )}
            </div>
          )
        })}
        {logs.length > ENTRIES_PER_SOURCE && (
          <p className="text-xs text-muted text-center py-2">
            {t('logs.moreEntries', { count: logs.length - ENTRIES_PER_SOURCE })}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * A whole per-source log panel: loading spinner, the empty state, or the Refresh
 * bar over one {@link SourceLogGroup} per source. Owns the "which entry is open"
 * state so a single entry is expanded across every source.
 */
export function SourceLogPanel<T extends SourceLog>({
  isLoading, logs, emptyMessage, onRefresh, view, badge, action,
}: Readonly<{
  isLoading: boolean
  logs: readonly T[]
  emptyMessage: string
  onRefresh: () => void
  view: LogEntryView<T>
  /** The header badge for a source with `count` entries. */
  badge: (count: number) => ReactNode
  /** Optional per-source header action (e.g. Clear). */
  action?: (source: string) => ReactNode
}>) {
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  if (isLoading) return <LogsLoadingState />
  if (logs.length === 0) return <LogsEmptyState message={emptyMessage} icon={CheckCircle} />

  return (
    <div className="space-y-3">
      <RefreshBar onRefresh={onRefresh} />
      {groupBySource(logs).map(([source, sourceLogs]) => (
        <SourceLogGroup
          key={source}
          source={source}
          badge={badge(sourceLogs.length)}
          action={action?.(source)}
          logs={sourceLogs}
          view={view}
          expandedLog={expandedLog}
          onExpand={setExpandedLog}
        />
      ))}
    </div>
  )
}
