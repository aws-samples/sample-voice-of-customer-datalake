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
 * A PR/FAQ / PRD suggestion may name another version of the same series (the
 * assistant read an older one, or a newer one landed since): the banner shows it
 * too and says so ("Proposed on vN; this page shows vM"; the versions are read through
 * the History dialog's list). Approving writes the suggestion's full text as the series'
 * next version, so a suggestion on an OLDER version is compared with this page (what
 * approving produces) and the banner says it replaces the changes made since vN (they
 * stay in History); one on a newer version is compared with that version.
 *
 * After an approved edit the canvas reloads on the new version, asking first while it
 * holds unsaved changes.
 *
 * @module components/DocumentCanvas/actions/AssistantDiffOnCanvas
 */
import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BlockDiff from './BlockDiff'
import { isVersionManagedDocument } from '../../../api/documentLineage'
import { projectsApi } from '../../../api/projectsApi'
import { documentVersionsKey } from '../../../pages/ProjectDetail/documentEdit'
import { ActionBar } from '../../../assistant/approvals/ActionBar'
import { checkArgs, isApprovable, isDestructive } from '../../../assistant/approvals/approvalGate'
import { outcomeOf } from '../../../assistant/approvals/executionStore'
import { usePendingDocumentEdit, usePendingEditTargets } from '../../../assistant/approvals/pendingDocumentEdit'
import { getWriteTool } from '../../../assistant/approvals/registry'
import { createShownRecord } from '../../../assistant/approvals/shown'
import { useApprovalFlow, useExecutionContext } from '../../../assistant/approvals/useApprovalFlow'
import { useExpiry } from '../../../assistant/approvals/useExpiry'
import { resolveApproval } from '../../../assistant/runtime/runtime'
import { useRunEnvironment } from '../../../assistant/runtime/useAssistant'
import type { PendingDocumentEdit } from '../../../assistant/approvals/pendingDocumentEdit'
import type { CanvasDocument } from './useCanvasDocument'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

interface AssistantDiffOnCanvasProps {
  readonly projectId: string
  readonly document: ProjectDocument
  /** The canvas (useCanvasDocument): reloaded after an approval, asking first while dirty. */
  readonly state: CanvasDocument
}

/**
 * What the suggestion is compared with, and the version it was made on (`proposedOn`: null, this page's). Made on an
 * OLDER version, it is compared with this page: approving writes it as the series' next version, so what changes is
 * this page's text (the changes since are replaced; History keeps them). Made on a newer one, with that one.
 */
interface DiffBase {
  readonly content: string
  readonly title: string
  readonly proposedOn: number | null
  /** Made on an older version than this page's: approving replaces the changes made since. */
  readonly replacesNewer: boolean
}

/** "Proposed on vN; this page shows vM" (and, for an older vN, what approving replaces): only for a suggestion made on
 *  another version of the series. */
function OtherVersionNote({ base, shown }: Readonly<{ base: DiffBase; shown: number | undefined }>) {
  const { t } = useTranslation('projectDetail')
  const proposed = base.proposedOn
  if (proposed === null || shown === undefined) return null
  return (
    <p className="text-[13px] text-warn" data-testid="assistant-diff-other-version">
      {t('canvas.actions.assistant.otherVersion', { proposed, current: shown })}
      {base.replacesNewer ? ` ${t('canvas.actions.assistant.replacesSince', { proposed })}` : null}
    </p>
  )
}

function PendingEdit({ pending, base, shownVersion, state }: Readonly<{
  pending: PendingDocumentEdit; base: DiffBase
  /** This page's version number (a PR/FAQ / PRD), said beside a suggestion made on another one. */
  shownVersion: number | undefined
  state: CanvasDocument
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
      <OtherVersionNote base={base} shown={shownVersion} />
      {args.change_summary === '' ? null : (
        <p className="text-[13px] text-text"><span className="text-muted">{tTools('preview.changeSummary')}: </span>{args.change_summary}</p>
      )}
      {reviewing ? (
        <>
          {args.title !== undefined && args.title !== base.title ? (
            <p className="text-[13px] text-text">{t('canvas.actions.assistant.newTitle', { title: args.title })}</p>
          ) : null}
          {state.dirty ? <p className="text-[12px] text-warn">{t('canvas.actions.assistant.draftNote')}</p> : null}
          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-card p-2">
            <BlockDiff id={diffId} before={base.content} after={args.content} />
          </div>
          <ActionBar phase={phase} expired={expiry.expired} canApprove={canApprove} destructive={destructive}
            disabled={pending.disabled} onApprove={() => void approve()} onStartDecline={flow.startDecline}
            onCancelDecline={flow.cancelDecline} onDecline={flow.decline} />
        </>
      ) : null}
    </section>
  )
}

/** The other versions of a PR/FAQ / PRD series, read (the History dialog's list) only while the assistant proposes
 *  an edit of a document that is not this page's version; none for a research / custom document. A PR/FAQ / PRD
 *  version is a document row of its own: its `version_id` is its document id. */
function useOtherSeriesVersions(projectId: string, document: ProjectDocument): readonly DocumentVersion[] {
  const own = document.document_id
  const wanted = usePendingEditTargets(projectId).some((id) => id !== own) && isVersionManagedDocument(document)
  const { data } = useQuery({
    queryKey: documentVersionsKey(projectId, own),
    queryFn: () => projectsApi.getDocumentVersions(projectId, own),
    enabled: wanted,
  })
  return useMemo(() => (wanted && data !== undefined ? data.filter((version) => version.version_id !== own) : []), [data, wanted, own])
}

export default function AssistantDiffOnCanvas({ projectId, document, state }: AssistantDiffOnCanvasProps) {
  const others = useOtherSeriesVersions(projectId, document)
  const ids = useMemo(() => [document.document_id, ...others.map((version) => version.version_id)], [document.document_id, others])
  const pending = usePendingDocumentEdit(projectId, ids)
  if (pending === null) return null
  // The proposal's own version: this page's, or another of its series. On an older one the diff is still against this
  // page (what approving produces: the next version holds the proposal); on a newer one, against that one.
  const proposedOn = others.find((version) => version.version_id === pending.args.document_id)
  const replacesNewer = proposedOn !== undefined && document.version !== undefined && proposedOn.version < document.version
  const base: DiffBase = proposedOn === undefined || replacesNewer
    ? { content: document.content, title: document.title, proposedOn: proposedOn?.version ?? null, replacesNewer }
    : { content: proposedOn.content, title: proposedOn.title, proposedOn: proposedOn.version, replacesNewer }
  // One card per interrupt: a new suggestion starts closed, with its own flow.
  return <PendingEdit key={pending.interrupt.id} pending={pending} base={base} shownVersion={document.version} state={state} />
}
