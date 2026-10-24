/**
 * @fileoverview Execution state of approval cards, shared across every mounted
 * card and keyed by interrupt id.
 *
 * A card's own refs only guard one component instance. The same interrupt can
 * be rendered by more than one card over its life — the panel toggles, the user
 * navigates, `/chat` and the floating panel show one shared thread, another
 * interrupt resolving re-renders the list — and a fresh instance would happily
 * POST the write again. This store is the single-flight guard: `beginExecution`
 * succeeds once per interrupt, and `settleExecution` records the one outcome
 * every card for that interrupt then renders.
 *
 * @module assistant/approvals/executionStore
 */
import { create } from 'zustand'
import { ownEntry } from '../ownEntry'
import type { ToolOutcome } from '../contract'

export type ExecutionEntry =
  | { phase: 'executing' }
  | { phase: 'resolved'; outcome: ToolOutcome }

interface ExecutionStoreState {
  entries: Record<string, ExecutionEntry>
}

const useExecutionStore = create<ExecutionStoreState>()(() => ({ entries: {} }))

function entryOf(interruptId: string): ExecutionEntry | undefined {
  const { entries } = useExecutionStore.getState()
  return ownEntry(entries, interruptId)
}

function setEntry(interruptId: string, entry: ExecutionEntry): void {
  useExecutionStore.setState((s) => ({ entries: { ...s.entries, [interruptId]: entry } }))
}

/** Claim the right to execute. False if the interrupt is already executing or resolved. */
export function beginExecution(interruptId: string): boolean {
  if (entryOf(interruptId) !== undefined) return false
  setEntry(interruptId, { phase: 'executing' })
  return true
}

/** Record the outcome. False if an outcome was already recorded (the caller must not report it again). */
export function settleExecution(interruptId: string, outcome: ToolOutcome): boolean {
  if (entryOf(interruptId)?.phase === 'resolved') return false
  setEntry(interruptId, { phase: 'resolved', outcome })
  return true
}

/** True while a write for this interrupt is in flight. */
export function isExecuting(interruptId: string): boolean {
  return entryOf(interruptId)?.phase === 'executing'
}

export function useExecutionEntry(interruptId: string): ExecutionEntry | undefined {
  return useExecutionStore((s) => ownEntry(s.entries, interruptId))
}

/** Test seam: forget every entry. */
export function resetExecutions(): void {
  useExecutionStore.setState({ entries: {} })
}
