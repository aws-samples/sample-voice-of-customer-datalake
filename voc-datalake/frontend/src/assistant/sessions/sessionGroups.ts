/**
 * @fileoverview The conversation rail's history, grouped the way chat apps do it
 * (Today / This week / Older, by last activity) and filtered by a title search.
 *
 * @module assistant/sessions/sessionGroups
 */
import { isValid, startOfDay, subDays } from 'date-fns'

const SESSION_GROUPS = ['today', 'week', 'older'] as const
export type SessionGroup = (typeof SESSION_GROUPS)[number]

const WEEK_DAYS = 7

/** A missing or unreadable timestamp counts as old: it never claims to be recent. */
function sessionGroupOf(updatedAt: string, nowMs: number): SessionGroup {
  const date = new Date(updatedAt)
  if (updatedAt === '' || !isValid(date)) return 'older'
  const today = startOfDay(nowMs)
  if (date >= today) return 'today'
  return date >= subDays(today, WEEK_DAYS - 1) ? 'week' : 'older'
}

/** Case- and accent-insensitive "contains", so "cafe" finds "Café". */
function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

export function matchesTitle(title: string, query: string): boolean {
  const needle = folded(query.trim())
  return needle === '' || folded(title).includes(needle)
}

/** Items per group, in SESSION_GROUPS order, empty groups dropped; each group keeps the input order. */
export function groupSessions<T extends { updatedAt: string }>(items: readonly T[], nowMs: number): { group: SessionGroup; items: T[] }[] {
  return SESSION_GROUPS
    .map((group) => ({ group, items: items.filter((item) => sessionGroupOf(item.updatedAt, nowMs) === group) }))
    .filter((entry) => entry.items.length > 0)
}
