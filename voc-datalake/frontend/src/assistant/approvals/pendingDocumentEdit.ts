/**
 * @fileoverview The assistant's pending edit of ONE document, read outside the
 * assistant panel (the document canvas shows it as a diff on the page).
 *
 * The approvals live in the thread store (one slot per open conversation); this
 * finds the first unanswered `update_document` interrupt, in any open
 * conversation, whose arguments (parsed with the tool's own schema) name this
 * project and the document (or, for a PR/FAQ / PRD, another version of its
 * series: the page shows the diff against that version). Answering it goes through the SAME path as the card
 * (`useApprovalFlow` + `resolveApproval`): the execution store keeps the card and
 * the canvas from ever sending the write twice.
 *
 * @module assistant/approvals/pendingDocumentEdit
 */
import { useMemo } from 'react'
import { useThreadStore } from '../store/assistantStore'
import { findToolCall } from '../thread/reducer'
import { ownEntry } from '../ownEntry'
import { UPDATE_DOCUMENT_TOOL, updateDocumentArgs } from './schemas'
import { useExecutionEntry } from './executionStore'
import type { UpdateDocumentArgs } from './schemas'
import type { ApprovalInterrupt, AssistantToolCall } from '../types'
import type { ThreadSlot } from '../store/assistantStore'

export interface PendingDocumentEdit {
  readonly threadId: string
  readonly interrupt: ApprovalInterrupt
  readonly toolCall: AssistantToolCall
  readonly args: UpdateDocumentArgs
  /** The conversation is not waiting for this answer right now (streaming, or a stale run). */
  readonly disabled: boolean
}

/** Every unanswered `update_document` proposal of `projectId` in one conversation, in its order. */
function pendingIn(slot: ThreadSlot, projectId: string): PendingDocumentEdit[] {
  const { thread } = slot
  return thread.pendingInterrupts.flatMap((interrupt): PendingDocumentEdit[] => {
    if (ownEntry(thread.resolutions, interrupt.id) !== undefined) return []
    const name = findToolCall(thread.messages, interrupt.toolCallId)?.function.name ?? interrupt.metadata?.toolName ?? ''
    if (name !== UPDATE_DOCUMENT_TOOL) return []
    const raw = ownEntry(thread.toolCallArgs, interrupt.toolCallId) ?? {}
    const parsed = updateDocumentArgs.safeParse(raw)
    if (!parsed.success || parsed.data.project_id !== projectId) return []
    return [{
      threadId: thread.threadId,
      interrupt,
      toolCall: { id: interrupt.toolCallId, name, args: raw },
      args: parsed.data,
      disabled: thread.status !== 'awaiting_approval',
    }]
  })
}

/** Every unanswered edit the assistant proposes in `projectId`, in the conversations' order. */
function usePendingProjectEdits(projectId: string): readonly PendingDocumentEdit[] {
  const slots = useThreadStore((s) => s.slots)
  const order = useThreadStore((s) => s.order)
  return useMemo(() => order.flatMap((id) => {
    const slot = ownEntry(slots, id)
    return slot === undefined ? [] : pendingIn(slot, projectId)
  }), [slots, order, projectId])
}

/**
 * The documents of `projectId` the assistant proposes an edit of right now (unanswered): the page reads a PR/FAQ /
 * PRD series' versions only when one of them is not the version it shows.
 */
export function usePendingEditTargets(projectId: string): readonly string[] {
  const edits = usePendingProjectEdits(projectId)
  return useMemo(() => [...new Set(edits.map((edit) => edit.args.document_id))], [edits])
}

/**
 * The unanswered edit the assistant proposes of one of `documentIds`, or null: of the first of them it can (the
 * page's own version first, then the other versions of its series), in the conversations' order.
 */
export function usePendingDocumentEdit(projectId: string, documentIds: readonly string[]): PendingDocumentEdit | null {
  const edits = usePendingProjectEdits(projectId)
  const found = useMemo(() => {
    const rank = (edit: PendingDocumentEdit) => documentIds.indexOf(edit.args.document_id)
    return edits.filter((edit) => rank(edit) >= 0).reduce<PendingDocumentEdit | null>(
      (best, edit) => (best === null || rank(edit) < rank(best) ? edit : best), null)
  }, [edits, documentIds])
  // Answered from the card meanwhile (the thread records it a moment later): gone here too.
  const entry = useExecutionEntry(found?.interrupt.id ?? '')
  return found !== null && entry?.phase === 'resolved' ? null : found
}
