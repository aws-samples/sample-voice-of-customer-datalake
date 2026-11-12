/**
 * @fileoverview The assistant's pending edit of this document, shown on its page.
 *
 * When a conversation waits for the user's answer to an `update_document` card that
 * targets this document, the page says so ("The assistant suggests changes to this
 * document"); Review shows the suggestion as a block diff over the saved text, with
 * the card's own Approve / Decline. Both answer the SAME approval through the SAME
 * path as the card in the assistant panel (useApprovalFlow → the tool's executor →
 * resolveApproval), so the write happens once whichever is pressed, and the
 * conversation goes on as if the card had been answered. Nothing here writes on its own.
 *
 * After an approved edit the canvas reloads on the new version, asking first while it
 * holds unsaved changes.
 *
 * @module components/DocumentCanvas/actions/AssistantDiffOnCanvas
 */
import { Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BlockDiff from './BlockDiff'
import { ActionBar } from '../../../assistant/approvals/ActionBar'
import { checkArgs, isApprovable, isDestructive } from '../../../assistant/approvals/approvalGate'
import { outcomeOf } from '../../../assistant/approvals/executionStore'
import { usePendingDocumentEdit } from '../../../assistant/approvals/pendingDocumentEdit'
import { getWriteTool } from '../../../assistant/approvals/registry'
import { createShownRecord } from '../../../assistant/approvals/shown'
import { useApprovalFlow, useExecutionContext } from '../../../assistant/approvals/useApprovalFlow'
import { useExpiry } from '../../../assistant/approvals/useExpiry'
import { resolveApproval } from '../../../assistant/runtime/runtime'
import { useRunEnvironment } from '../../../assistant/runtime/useAssistant'
import type { PendingDocumentEdit } from '../../../assistant/approvals/pendingDocumentEdit'
import type { CanvasDocument } from './useCanvasDocument'
import type { ProjectDocument } from '../../../api/types'

interface AssistantDiffOnCanvasProps {
  readonly projectId: string
  readonly document: ProjectDocument
  /** The canvas (useCanvasDocument): reloaded after an approval, asking first while dirty. */
  readonly state: CanvasDocument
}

function PendingEdit({ pending, document, state }: Readonly<{
  pending: PendingDocumentEdit; document: ProjectDocument; state: CanvasDocument
}>) {
  const { t } = useTranslation('projectDetail')
  const { t: tTools } = useTranslation('assistantTools')
  const headingId = useId()
  const diffId = useId()
  const [reviewing, setReviewing] = useState(false)
  const env = useRunEnvironment()
  const { interrupt, toolCall, threadId, args } = pending
  const flow = useApprovalFlow({
    interruptId: interrupt.id, toolCallId: toolCall.id,
    onResolve: (resolution) => resolveApproval(resolution, env, threadId),
  })
  const [shown] = useState(createShownRecord)
  const ctx = useExecutionContext(shown, threadId)
  const expiry = useExpiry(interrupt.expiresAt)
  const definition = getWriteTool(toolCall.name)
  const check = checkArgs(definition, toolCall.args)
  const destructive = isDestructive(interrupt, definition)
  const { phase } = flow.state
  if (phase === 'resolved') return null
  const canApprove = isApprovable({
    definition, check, expiry, destructive, disabled: pending.disabled, phase,
    adminBlocked: definition?.adminOnly === true && !ctx.isAdmin,
    // A destructive edit needs the card's explicit confirmation: it is approved in the panel only.
    confirmed: false,
  })
  const approve = async () => {
    if (!canApprove || definition === undefined || !check.ok) return
    await flow.approve(definition, check.args, ctx)
    if (outcomeOf(interrupt.id)?.status === 'executed') state.reloadLatest()
  }
  return (
    <section aria-labelledby={headingId} data-testid="assistant-diff-on-canvas"
      className="space-y-3 rounded-lg border border-accent/30 bg-bg-accent p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={16} className="text-accent" aria-hidden="true" />
        <h3 id={headingId} className="mr-auto text-sm font-medium text-text">{t('canvas.actions.assistant.banner')}</h3>
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={reviewing}
          // Only while open: the diff it controls is not rendered while closed.
          aria-controls={reviewing ? diffId : undefined}
          onClick={() => setReviewing((open) => !open)}>
          {reviewing ? t('canvas.actions.assistant.hide') : t('canvas.actions.assistant.review')}
        </button>
      </div>
      {args.change_summary === '' ? null : (
        <p className="text-[13px] text-text"><span className="text-muted">{tTools('preview.changeSummary')}: </span>{args.change_summary}</p>
      )}
      {reviewing ? (
        <>
          {args.title !== undefined && args.title !== document.title ? (
            <p className="text-[13px] text-text">{t('canvas.actions.assistant.newTitle', { title: args.title })}</p>
          ) : null}
          {state.dirty ? <p className="text-[12px] text-warn">{t('canvas.actions.assistant.draftNote')}</p> : null}
          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-card p-2">
            <BlockDiff id={diffId} before={document.content} after={args.content} />
          </div>
          <ActionBar phase={phase} expired={expiry.expired} canApprove={canApprove} destructive={destructive}
            disabled={pending.disabled} onApprove={() => void approve()} onStartDecline={flow.startDecline}
            onCancelDecline={flow.cancelDecline} onDecline={flow.decline} />
        </>
      ) : null}
    </section>
  )
}

export default function AssistantDiffOnCanvas({ projectId, document, state }: AssistantDiffOnCanvasProps) {
  const pending = usePendingDocumentEdit(projectId, document.document_id)
  if (pending === null) return null
  // One card per interrupt: a new suggestion starts closed, with its own flow.
  return <PendingEdit key={pending.interrupt.id} pending={pending} document={document} state={state} />
}
