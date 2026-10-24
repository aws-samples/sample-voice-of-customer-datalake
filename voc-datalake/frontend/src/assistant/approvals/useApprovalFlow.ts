/**
 * @fileoverview The approval card's state machine.
 *
 * pending → (declining ⇄ pending) → executing → resolved, or pending → resolved
 * on decline / dismiss. Pending/declining is local to the card; executing and
 * resolved live in the shared execution store keyed by interrupt id, so a card
 * that remounts (panel toggle, navigation, `/chat` and the floating panel on one
 * thread) renders the same phase and can never send the write a second time.
 * `beginExecution` is the single-flight claim, and only the caller whose
 * `settleExecution` records the outcome reports it through `onResolve`.
 *
 * @module assistant/approvals/useApprovalFlow
 */
import { useCallback, useState } from 'react'
import { safeErrorMessage } from './safeError'
import { beginExecution, isExecuting, settleExecution, useExecutionEntry } from './executionStore'
import type { ToolOutcome } from '../contract'
import type { ApprovalResolution, WriteToolDefinition, WriteToolExecutionContext } from '../types'

type CardPhase =
  | { phase: 'pending' }
  | { phase: 'declining' }
  | { phase: 'executing' }
  | { phase: 'resolved'; outcome: ToolOutcome }

interface FlowOptions {
  interruptId: string
  toolCallId: string
  onResolve: (resolution: ApprovalResolution) => void
}

export function useApprovalFlow({ interruptId, toolCallId, onResolve }: FlowOptions) {
  const [local, setLocal] = useState<'pending' | 'declining'>('pending')
  const shared = useExecutionEntry(interruptId)
  const state: CardPhase = shared ?? { phase: local }

  const finish = useCallback((outcome: ToolOutcome) => {
    if (settleExecution(interruptId, outcome)) onResolve({ interruptId, toolCallId, outcome })
  }, [interruptId, toolCallId, onResolve])

  const approve = useCallback(async (definition: WriteToolDefinition, args: unknown, ctx: WriteToolExecutionContext) => {
    if (!beginExecution(interruptId)) return
    try {
      const result = await definition.execute(args, ctx)
      finish({
        status: 'executed',
        summary: result.summary,
        ...(result.data === undefined ? {} : { data: result.data }),
      })
    } catch (error) {
      finish({ status: 'failed', error: safeErrorMessage(error) })
    }
  }, [interruptId, finish])

  const decline = useCallback((reason?: string) => {
    if (isExecuting(interruptId)) return
    finish(reason === undefined || reason === '' ? { status: 'declined' } : { status: 'declined', reason })
  }, [interruptId, finish])

  const startDecline = useCallback(() => {
    if (shared === undefined) setLocal('declining')
  }, [shared])

  const cancelDecline = useCallback(() => {
    if (shared === undefined) setLocal('pending')
  }, [shared])

  return { state, approve, decline, startDecline, cancelDecline }
}
