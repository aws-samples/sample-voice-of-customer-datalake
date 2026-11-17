/**
 * @fileoverview A run's event journal folded into per-step status, so the
 * read-only run graph can light up the planned flow (KiroCrew's run graph:
 * deliberately NOT a control surface); and (7.51.00) the state of a lane of an
 * engineering run's stage (one task of a step, and the agent on it) with its
 * border.
 *
 * The lane's states and border: Adapted from kirodotdev/KiroCrew
 * `website/src/components/workflows/WorkflowRunGraph.tsx` (`chipClass`: a node
 * nothing has run on yet is DASHED), Apache-2.0 (THIRD-PARTY-LICENSES.md).
 *
 * @module components/WorkflowEditor/runState
 */
import type { RunEvent } from '../../api/agentsApi'

type StepStatus = 'idle' | 'running' | 'done' | 'failed'

export interface StepState {
  status: StepStatus
  /** How many times the step started (loop rounds). */
  rounds: number
  /** The latest verdict / decision summary on the step. */
  lastSummary?: string
  /** (7.51.00) A gate step's verdict, as pass or fail. */
  gate?: 'pass' | 'fail'
  /** (7.51.00) The step the run is on ("you are here"). */
  here?: boolean
}

/** What a run graph knows of a lane (KiroCrew planModel's `GraphNodeState`, without `unknown`: a lane is a task posted). */
export type LaneState = 'ran_ok' | 'ran_failed' | 'running' | 'stopped' | 'planned'

/** A lane's border (WorkflowRunGraph's `chipClass`): dashed while nothing has run on it, solid once it has. */
export function laneBorder(state: LaneState): string {
  switch (state) {
    case 'ran_failed': return 'border-danger/60'
    case 'running': return 'border-accent'
    case 'ran_ok': return 'border-ok/50'
    case 'stopped': return 'border-border'
    case 'planned': return 'border-dashed border-border opacity-70'
  }
}

/**
 * Events are applied in `seq` order; a step that started again after it
 * finished (a loop round) is running again. `currentNodeId` marks the step the
 * run itself reports as current, when the journal has not caught up.
 */
export function stepStates(events: readonly RunEvent[], currentNodeId?: string | null): Map<string, StepState> {
  const states = new Map<string, StepState>()
  const get = (id: string): StepState => states.get(id) ?? { status: 'idle', rounds: 0 }
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.node_id === undefined) continue
    const prev = get(event.node_id)
    switch (event.kind) {
      case 'node_started':
        states.set(event.node_id, { ...prev, status: 'running', rounds: prev.rounds + 1 })
        break
      case 'node_finished':
        states.set(event.node_id, { ...prev, status: 'done' })
        break
      case 'node_failed':
        states.set(event.node_id, { ...prev, status: 'failed', lastSummary: event.summary })
        break
      case 'verdict':
      case 'decision':
        states.set(event.node_id, { ...prev, lastSummary: event.summary })
        break
      default:
        break
    }
  }
  if (currentNodeId !== undefined && currentNodeId !== null && get(currentNodeId).status === 'idle') {
    states.set(currentNodeId, { ...get(currentNodeId), status: 'running' })
  }
  return states
}
