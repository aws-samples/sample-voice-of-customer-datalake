/**
 * @fileoverview One plan's live progress (docs/assistant-plan-mode.md → "UI"):
 * polls `GET /agents/plans/{id}` every 5 s while the view is mounted (the
 * assistant panel is open, or the Agents page shows it) and stops once the plan
 * reaches a terminal status. Cancel and a step's approve / decline write the
 * answered plan straight into the cache. Approve sends the fingerprint of the
 * paused write it showed; a refusal reloads the plan so the new write is shown.
 *
 * A change seen while polling — the plan ended, or a step now needs approval —
 * is announced through `runNotifications` (opt-in, tab not in front).
 *
 * @module assistant/planProgress/usePlanProgress
 */
import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isTerminalPlan, plansApi, plansKeys } from '../../api/plansApi'
import { announcePlanChange } from '../notifications/runNotifications'
import { useAssistantUiStore } from '../store/assistantStore'
import { useConfigStore } from '../../store/configStore'
import type { PlanNotice } from '../notifications/runNotifications'
import type { PlanView } from '../../api/plansApi'

export const PLAN_POLL_MS = 5000

/** What changed between two polls that the user should hear about, if anything. */
export function planNoticeBetween(before: PlanView | undefined, after: PlanView): PlanNotice | null {
  if (before === undefined) return null
  if (!isTerminalPlan(before.status) && isTerminalPlan(after.status)) {
    return after.status === 'completed' ? 'done' : 'issues'
  }
  const waitingBefore = new Set(before.steps.filter((s) => s.status === 'needs_approval').map((s) => s.id))
  return after.steps.some((s) => s.status === 'needs_approval' && !waitingBefore.has(s.id)) ? 'approval' : null
}

function useAnnounceChanges(plan: PlanView | undefined, onOpen: () => void): void {
  const previous = useRef<PlanView | undefined>(undefined)
  const notify = useAssistantUiStore((s) => s.notify)
  useEffect(() => {
    if (plan === undefined) return
    const notice = planNoticeBetween(previous.current, plan)
    previous.current = plan
    if (notice !== null) announcePlanChange(plan.plan_id, notice, { enabled: notify, onOpen })
  }, [plan, notify, onOpen])
}

/** Approve carries the fingerprint of the paused write the user saw; decline needs none. */
export type StepDecision =
  | { stepId: string; action: 'approve'; fingerprint: string }
  | { stepId: string; action: 'decline' }

export function usePlanProgress(planId: string, { onOpen }: { onOpen: () => void }) {
  const queryClient = useQueryClient()
  const key = plansKeys.detail(planId)
  const configured = useConfigStore((s) => s.config.apiEndpoint !== '')
  const query = useQuery({
    queryKey: key,
    enabled: configured,
    queryFn: () => plansApi.get(planId),
    refetchInterval: (q) => (q.state.data !== undefined && isTerminalPlan(q.state.data.status) ? false : PLAN_POLL_MS),
    // A plan runs for minutes to hours: keep following it while the tab is in the background.
    refetchIntervalInBackground: true,
  })
  const store = (plan: PlanView) => {
    queryClient.setQueryData(key, plan)
    void queryClient.invalidateQueries({ queryKey: plansKeys.list() })
  }
  const cancel = useMutation({ mutationFn: () => plansApi.cancel(planId), onSuccess: store })
  const resolveStep = useMutation({
    mutationFn: (decision: StepDecision) => (decision.action === 'approve'
      ? plansApi.approveStep(planId, decision.stepId, decision.fingerprint)
      : plansApi.declineStep(planId, decision.stepId)),
    onSuccess: store,
    // A 409 means the paused write changed since it was shown: reload it so the user reviews the new one.
    onError: () => { void queryClient.invalidateQueries({ queryKey: key }) },
  })
  useAnnounceChanges(query.data, onOpen)
  return { query, cancel, resolveStep }
}
