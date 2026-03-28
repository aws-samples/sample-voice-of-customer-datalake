/**
 * @fileoverview Non-component utilities for log panels.
 * @module pages/Settings/logsHelpers
 */

type TFunction = (key: string, options?: Record<string, unknown>) => string

export function formatTimestamp(timestamp: string, t: TFunction): string {
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
