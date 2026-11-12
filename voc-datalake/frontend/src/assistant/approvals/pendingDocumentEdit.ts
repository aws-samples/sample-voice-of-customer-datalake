/**
 * @fileoverview The assistant's pending edit of ONE document, read outside the
 * assistant panel (the document canvas shows it as a diff on the page).
 *
 * The approvals live in the thread store (one slot per open conversation); this
 * finds the first unanswered `update_document` interrupt, in any open
 * conversation, whose arguments (parsed with the tool's own schema) name this
 * project and document. Answering it goes through the SAME path as the card
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

function pendingIn(slot: ThreadSlot, projectId: string, documentId: string): PendingDocumentEdit | undefined {
  const { thread } = slot
  for (const interrupt of thread.pendingInterrupts) {
    if (ownEntry(thread.resolutions, interrupt.id) !== undefined) continue
    const name = findToolCall(thread.messages, interrupt.toolCallId)?.function.name ?? interrupt.metadata?.toolName ?? ''
    if (name !== UPDATE_DOCUMENT_TOOL) continue
    const raw = ownEntry(thread.toolCallArgs, interrupt.toolCallId) ?? {}
    const parsed = updateDocumentArgs.safeParse(raw)
    if (!parsed.success || parsed.data.project_id !== projectId || parsed.data.document_id !== documentId) continue
    return {
      threadId: thread.threadId,
      interrupt,
      toolCall: { id: interrupt.toolCallId, name, args: raw },
      args: parsed.data,
      disabled: thread.status !== 'awaiting_approval',
    }
  }
  return undefined
}

/** The first unanswered edit of `documentId` the assistant proposes, or null. */
export function usePendingDocumentEdit(projectId: string, documentId: string): PendingDocumentEdit | null {
  const slots = useThreadStore((s) => s.slots)
  const order = useThreadStore((s) => s.order)
  const found = useMemo(() => {
    for (const id of order) {
      const slot = ownEntry(slots, id)
      const pending = slot === undefined ? undefined : pendingIn(slot, projectId, documentId)
      if (pending !== undefined) return pending
    }
    return null
  }, [slots, order, projectId, documentId])
  // Answered from the card meanwhile (the thread records it a moment later): gone here too.
  const entry = useExecutionEntry(found?.interrupt.id ?? '')
  return found !== null && entry?.phase === 'resolved' ? null : found
}
