/**
 * @fileoverview What the Dashboard shows when the selected window has no feedback.
 *
 * "No feedback in this window" and "this workspace has no feedback" are
 * different situations (E2E F4: production held 16,799 items, all older than the
 * widest 90-day preset, and the Dashboard said the workspace was empty). This
 * asks the all-time summary (`days=0`, same date basis) to tell them apart:
 *
 * - all-time total 0 → the welcome/onboarding state ({@link DashboardEmptyState})
 *   for an administrator who can set things up; for anyone else (a restricted
 *   or a regular viewer) a {@link ScopedEmptyState} naming what they can see,
 *   with no setup action;
 * - otherwise → a notice naming the newest feedback date and the all-time count,
 *   with a one-click "Show all time" that switches the selector to the
 *   All time preset (and the scope notice above it for a restricted viewer).
 *
 * The all-time query goes through `useSummaryQuery`, so when the window already
 * IS all time it is the same cache entry and no second request is made.
 *
 * @module pages/Dashboard/DashboardWindowEmpty
 */

import type { ReactNode } from 'react'
import { CalendarSearch, History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DateRangeParams } from '../../api/client'
import { ALL_TIME_CUSTOM_DAYS } from '../../api/baseUrl'
import type { MetricsSummary } from '../../api/types'
import { useSummaryQuery } from '../../hooks/useSummaryQuery'
import { formatCalendarDay } from '../../utils/dateUtils'
import { useConfigStore } from '../../store/configStore'
import ScopeNotice from '../../components/ScopeNotice/ScopeNotice'
import ScopedEmptyState from '../../components/ScopeNotice/ScopedEmptyState'
import { useCanSetUp, useViewerScope } from '../../components/ScopeNotice/useViewerScope'
import DashboardEmptyState from './DashboardEmptyState'

/** The newest `YYYY-MM-DD` day with feedback in a summary, or null when none has any. */
function newestFeedbackDay(summary: MetricsSummary | undefined): string | null {
  return (summary?.daily_totals ?? [])
    .filter((row) => row.count > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .reduce<string | null>((newest, row) => (newest === null || row.date > newest ? row.date : newest), null)
}

interface DashboardWindowEmptyProps {
  /** The (empty) window the Dashboard asked for; its date basis is kept for the all-time check. */
  readonly dateParams: DateRangeParams
  readonly apiEndpoint: string
  readonly loading: ReactNode
}

export default function DashboardWindowEmpty({ dateParams, apiEndpoint, loading }: DashboardWindowEmptyProps) {
  const { t, i18n } = useTranslation('dashboard')
  const { setTimeRange, setCustomDays } = useConfigStore()
  const { data: allTime, isLoading, isError } = useSummaryQuery(
    { ...dateParams, days: ALL_TIME_CUSTOM_DAYS },
    apiEndpoint,
  )
  const viewer = useViewerScope()
  const canSetUp = useCanSetUp()

  if (isLoading || viewer.isLoading) return <>{loading}</>

  const allTimeTotal = allTime?.total_feedback ?? 0
  // A failed all-time check must not claim the workspace is empty: say only
  // what is known (this window is empty) and still offer the wider window.
  // "Empty" is the caller's view: the welcome (import feedback, set things up)
  // is only for an administrator who can act on it; a restricted or regular
  // viewer is told what they can see instead (owner rule 2026-10-21).
  if (!isError && allTimeTotal === 0) {
    return canSetUp ? <DashboardEmptyState /> : <ScopedEmptyState scope={viewer.scope ?? { kind: 'all' }} />
  }

  const newestDay = newestFeedbackDay(allTime)
  const showAllTime = () => {
    setTimeRange('all')
    setCustomDays(null)
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <section className="max-w-md text-center" aria-labelledby="dashboard-window-empty-title">
        <ScopeNotice className="mb-4 text-left" />
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-hover text-muted">
          <CalendarSearch size={24} aria-hidden="true" />
        </div>
        <h2 id="dashboard-window-empty-title" className="mb-2 text-xl font-bold tracking-tight text-text-strong">
          {t('windowEmpty.heading')}
        </h2>
        <p className="mb-6 text-muted">
          {newestDay === null
            ? t('windowEmpty.bodyUnknown')
            : t('windowEmpty.body', { date: formatCalendarDay(newestDay, i18n.language, 'long'), count: allTimeTotal })}
        </p>
        <button type="button" className="btn btn-primary" onClick={showAllTime}>
          <History size={16} aria-hidden="true" />
          {t('windowEmpty.showAllTime')}
        </button>
      </section>
    </div>
  )
}
