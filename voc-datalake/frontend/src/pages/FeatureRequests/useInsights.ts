/**
 * @fileoverview The Insights tab's state: the board and window it shows (both in the URL, so a view is
 * a link), its query, and the admin's "Enrich requests" write.
 *
 * Foreign URL parameters are kept (the shared review modal and `?tab=` live there too).
 *
 * @module pages/FeatureRequests/useInsights
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  enrichFeatureRequests, featureRequestInsightKeys, getFeatureRequestInsights, isInsightWindow,
} from '../../api/featureRequestInsights'
import { featureRequestKeys } from '../../api/featureRequestsApi'
import type { InsightWindow } from '../../api/featureRequestInsights'

const BOARD_PARAM = 'board'
const WINDOW_PARAM = 'days'
/** The URL parameters the Insights view owns (dropped when the page leaves the tab). */
export const INSIGHTS_VIEW_PARAMS = [BOARD_PARAM, WINDOW_PARAM] as const
const DEFAULT_WINDOW: InsightWindow = 90

export interface InsightsView {
  /** A board id, or '' for every board. */
  readonly board: string
  readonly days: InsightWindow
}

function windowOf(raw: string | null): InsightWindow {
  const days = Number(raw ?? '')
  return raw !== null && raw !== '' && isInsightWindow(days) ? days : DEFAULT_WINDOW
}

/** The view in the URL and its setter (an empty board or the default window leaves its parameter out). */
export function useInsightsView(): readonly [InsightsView, (change: Partial<InsightsView>) => void] {
  const [params, setParams] = useSearchParams()
  const view: InsightsView = { board: params.get(BOARD_PARAM) ?? '', days: windowOf(params.get(WINDOW_PARAM)) }
  const setView = (change: Partial<InsightsView>) => {
    const next = { ...view, ...change }
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      if (next.board === '') updated.delete(BOARD_PARAM)
      else updated.set(BOARD_PARAM, next.board)
      if (next.days === DEFAULT_WINDOW) updated.delete(WINDOW_PARAM)
      else updated.set(WINDOW_PARAM, String(next.days))
      return updated
    }, { replace: true })
  }
  return [view, setView]
}

export function useInsights(view: InsightsView) {
  const query = { board: view.board === '' ? undefined : view.board, days: view.days }
  return useQuery({
    queryKey: featureRequestInsightKeys.insights(query),
    queryFn: () => getFeatureRequestInsights(query),
    retry: false,
  })
}

/** Admin: queue a page of not-yet-enriched requests; refreshes the figures and the board lists. */
export function useEnrichRequests() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (board: string) => enrichFeatureRequests(board === '' ? undefined : board),
    onSuccess: async () => {
      // The board cache root holds the Insights figures too (featureRequestInsightKeys).
      await queryClient.invalidateQueries({ queryKey: featureRequestKeys.root('app') })
    },
  })
}
