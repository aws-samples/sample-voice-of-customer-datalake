/**
 * @fileoverview A run's event journal folded into per-step status, so the
 * read-only run graph can light up the planned flow (KiroCrew's run graph:
 * deliberately NOT a control surface).
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

/** Merge a new page of events into the known ones (dedup by seq, ordered). */
export function mergeEvents(known: readonly RunEvent[], page: readonly RunEvent[]): RunEvent[] {
  const bySeq = new Map(known.map((e) => [e.seq, e]))
  for (const event of page) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
