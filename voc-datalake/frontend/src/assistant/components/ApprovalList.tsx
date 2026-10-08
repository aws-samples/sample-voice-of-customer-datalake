/**
 * @fileoverview One approval card (from the approvals module) per pending
 * interrupt. Interrupts already resolved — answered here, or auto-declined
 * because they expired — show a one-line status instead of a card.
 *
 * @module assistant/components/ApprovalList
 */
import { useTranslation } from 'react-i18next'
import ApprovalCard from '../approvals/ApprovalCard'
import { findToolCall } from '../thread/reducer'
import { ownEntry } from '../ownEntry'
import type { PageContext } from '../contract'
import type { ApprovalResolution, AssistantToolCall } from '../types'
import type { ThreadState } from '../thread/types'

interface ApprovalListProps {
  thread: ThreadState
  page: PageContext
  onResolve: (resolution: ApprovalResolution) => void
}

function toolCallFor(thread: ThreadState, toolCallId: string, fallbackName: string | undefined): AssistantToolCall {
  const call = findToolCall(thread.messages, toolCallId)
  return {
    id: toolCallId,
    name: call?.function.name ?? fallbackName ?? '',
    args: ownEntry(thread.toolCallArgs, toolCallId) ?? {},
  }
}

export default function ApprovalList({ thread, page, onResolve }: Readonly<ApprovalListProps>) {
  const { t } = useTranslation('assistant')
  if (thread.pendingInterrupts.length === 0) return null
  const disabled = thread.status !== 'awaiting_approval'
  return (
    <section className="space-y-2" aria-label={t('approvals.title')}>
      {thread.pendingInterrupts.map((interrupt) => {
        const resolution = ownEntry(thread.resolutions, interrupt.id)
        if (resolution !== undefined) {
          const status = resolution.outcome.status
          return (
            <p key={interrupt.id} className="rounded-lg border border-border bg-bg-accent px-3 py-2 text-[12px] text-muted">
              {interrupt.message ?? interrupt.metadata?.toolName ?? ''} — {t(`approvals.resolved.${status}`)}
            </p>
          )
        }
        return (
          <ApprovalCard
            key={interrupt.id}
            interrupt={interrupt}
            toolCall={toolCallFor(thread, interrupt.toolCallId, interrupt.metadata?.toolName)}
            page={page}
            onResolve={onResolve}
            disabled={disabled}
          />
        )
      })}
    </section>
  )
}
