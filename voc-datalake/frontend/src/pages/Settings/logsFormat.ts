/**
 * @fileoverview Pure helpers of the Logs section: grouping by source and relative timestamps.
 * @module pages/Settings/logsFormat
 */
import type { TFunction } from 'i18next'

/** The fields every per-source log entry carries. */
export interface SourceLog {
  readonly source_platform: string
  readonly message_id: string
  readonly timestamp: string
}

/** Logs grouped by `source_platform`, sources in first-seen order. */
export function groupBySource<T extends SourceLog>(logs: readonly T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()
  for (const log of logs) {
    const group = groups.get(log.source_platform)
    if (group === undefined) groups.set(log.source_platform, [log])
    else group.push(log)
  }
  return [...groups]
}

export function formatTimestamp(timestamp: string, t: TFunction<'settings'>): string {
  try {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return t('logs.justNow')
    if (diffMins < 60) return t('logs.minutesAgo', { count: diffMins })
    if (diffHours < 24) return t('logs.hoursAgo', { count: diffHours })
    if (diffDays < 7) return t('logs.daysAgo', { count: diffDays })

    return date.toLocaleDateString()
  } catch {
    return timestamp
  }
}
