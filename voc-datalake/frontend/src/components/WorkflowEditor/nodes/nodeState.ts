/**
 * @fileoverview What a node says of its run state beside its badge (7.52.00 C2): whether it reads as not reached
 * (planned, or a way not taken: its title muted), and the words its description adds ("Failed: the tests fail").
 *
 * @module components/WorkflowEditor/nodes/nodeState
 */
import { useTranslation } from 'react-i18next'
import type { StepNodeData } from './nodeData'

/** Whether a run state reads as not reached (planned, or a way not taken): its title muted. */
export const isQuiet = (data: StepNodeData): boolean => data.run?.status === 'idle' || data.run?.status === 'skipped'

/** The words a description adds for a run state ("Failed: the tests fail"), none outside a run. */
export function useStateWords(data: StepNodeData): string {
  const { t } = useTranslation('agents')
  const { run } = data
  if (run === undefined) return data.issues[0] ?? ''
  const state = t(`run.stepStatus.${run.status}`)
  return run.status === 'failed' && run.lastSummary !== undefined ? `${state}: ${run.lastSummary}` : state
}
