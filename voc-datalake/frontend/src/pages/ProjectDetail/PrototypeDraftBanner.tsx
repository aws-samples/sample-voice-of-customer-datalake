/**
 * The draft banner on a prototype's pane (docs/prototype-builder.md, part 2): a draft made from an
 * editor's instruction, shown in the preview but not saved. It names the instruction and the model's
 * summary (plain text lines), switches the preview between the draft and the current version, and
 * offers **Apply as vN** (the next version of the series) and **Discard** (the draft's job delete).
 *
 * A draft whose series moved past its base (or an Apply answered 409) says so and offers only Discard:
 * the editor asks again on the newest version. `PrototypeWithDraft` is what the pane mounts: the banner
 * and, while Draft is chosen, the draft's frame in place of the current version's preview.
 *
 * @module pages/ProjectDetail/PrototypeDraftBanner
 */
import { Check, Loader2, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { HTTP_CONFLICT, apiErrorStatus } from '../../api/apiErrorStatus'
import { summaryLines } from '../../api/prototypeDraftSchema'
import type { PinOutcome, PrototypeDraft } from '../../api/prototypeDraftSchema'
import type { AppliedDraft } from '../../api/projectsApi'
import type { ProjectDocument } from '../../api/types'
import { DraftOutcomes, IncorporationResult } from './PrototypeDraftOutcomes'
import PressedChoices from '../../components/PressedChoices/PressedChoices'
import { HtmlPrototypeFrame } from '../../components/PrototypeRenderer'
import { refusalReason } from '../../lib/errors'
import type { ShownDraft } from './prototypeDraft'
import { usePrototypeDraft, usePrototypeDraftActions } from './usePrototypeDraft'

type DraftPreview = 'draft' | 'current'
const PREVIEWS: readonly DraftPreview[] = ['draft', 'current']

/** The instruction the draft was made from and the model's summary, as text (never Markdown, never HTML). */
function DraftSummary({ draft }: Readonly<{ draft: PrototypeDraft }>) {
  const { t } = useTranslation('projectDetail')
  const lines = summaryLines(draft.summary)
  return (
    <>
      <p className="break-words"><span className="font-medium">{t('documents.prototype.draft.instructionLabel')}</span> {draft.instruction}</p>
      {lines.length > 0 ? (
        <div>
          <p className="font-medium">{t('documents.prototype.draft.summaryLabel')}</p>
          <ul className="list-disc pl-5 break-words">
            {lines.map((line, index) => <li key={`${String(index)}:${line}`}>{line}</li>)}
          </ul>
        </div>
      ) : null}
    </>
  )
}

/** A failed action's words: the server's reason for a refusal trying again cannot fix, else `retryText`; null without an error. */
function failureText(error: unknown, retryText: string): string | null {
  if (error === null || error === undefined) return null
  return refusalReason(error) ?? retryText
}

function ActionIcon({ pending, Icon }: Readonly<{ pending: boolean; Icon: LucideIcon }>) {
  return pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Icon size={14} aria-hidden />
}

function DraftActions({ projectId, documentId, shown, onSelectDoc, onApplied }: Readonly<{
  projectId: string; documentId: string; shown: ShownDraft; onSelectDoc: (doc: ProjectDocument) => void
  onApplied: (applied: AppliedDraft) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const { draft } = shown
  const { apply, discard } = usePrototypeDraftActions(projectId, documentId, draft.draft_id, onSelectDoc, onApplied)
  const conflict = apiErrorStatus(apply.error) === HTTP_CONFLICT
  const stale = shown.state === 'stale' || conflict
  const busy = apply.isPending || discard.isPending
  const next = draft.base_version + 1
  // A 409 is said as the stale note above, not as a failure.
  const failure = failureText(conflict ? null : apply.error, t('documents.prototype.draft.applyFailed'))
    ?? failureText(discard.error, t('documents.prototype.draft.discardFailed'))
  return (
    <>
      {stale ? <p role="status" className="text-warn">{t('documents.prototype.draft.stale')}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {stale ? null : (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { apply.mutate() }}>
            <ActionIcon pending={apply.isPending} Icon={Check} />
            {t('documents.prototype.draft.apply', { n: next })}
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { discard.mutate() }}>
          <ActionIcon pending={discard.isPending} Icon={Trash2} />
          {t('documents.prototype.draft.discard')}
        </button>
      </div>
      {failure === null ? null : <p role="alert" className="text-[12px] text-danger">{failure}</p>}
    </>
  )
}

/**
 * The open prototype's preview (`children`) with its series' draft, when an editor has one: the banner
 * above, and the draft in the frame until the editor switches to the current version. Without a draft
 * (or for a viewer) it is `children` alone.
 */
export function PrototypeWithDraft({ projectId, document, documents, canEdit, onSelectDoc, children }: Readonly<{
  projectId: string
  document: ProjectDocument
  documents: readonly ProjectDocument[]
  canEdit: boolean
  onSelectDoc: (doc: ProjectDocument) => void
  children: ReactNode
}>) {
  const shown = usePrototypeDraft(projectId, document, documents, canEdit)
  // Per draft: a newer draft opens on itself again.
  const [chosen, setChosen] = useState<{ readonly draftId: string; readonly preview: DraftPreview } | null>(null)
  // A feedback draft's Apply result outlives its banner (the applied draft has none): until dismissed.
  const [applied, setApplied] = useState<{ readonly result: AppliedDraft; readonly outcomes: readonly PinOutcome[] } | null>(null)
  const incorporation = applied?.result.incorporation ?? null
  const result = incorporation === null ? null : (
    <IncorporationResult projectId={projectId} documentId={document.document_id} version={applied?.result.document?.version}
      incorporation={incorporation} outcomes={applied?.outcomes ?? []} onDismiss={() => { setApplied(null) }} />
  )
  if (shown === null) return <>{result}{children}</>
  const { draft } = shown
  const preview = chosen?.draftId === draft.draft_id ? chosen.preview : 'draft'
  return (
    <>
      {result}
      <PrototypeDraftBanner projectId={projectId} documentId={document.document_id} shown={shown} preview={preview}
        onPreviewChange={(next) => { setChosen({ draftId: draft.draft_id, preview: next }) }} onSelectDoc={onSelectDoc}
        onApplied={(next) => { setApplied({ result: next, outcomes: draft.outcomes }) }} />
      {preview === 'draft' ? <DraftPreviewFrame url={draft.preview_url} title={document.title} /> : children}
    </>
  )
}

function PrototypeDraftBanner({ projectId, documentId, shown, preview, onPreviewChange, onSelectDoc, onApplied }: Readonly<{
  projectId: string
  /** The prototype version open in the pane (the draft routes are addressed through it). */
  documentId: string
  shown: ShownDraft
  preview: DraftPreview
  onPreviewChange: (preview: DraftPreview) => void
  onSelectDoc: (doc: ProjectDocument) => void
  onApplied: (applied: AppliedDraft) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-testid="prototype-draft-banner"
      className="mb-3 min-w-0 space-y-2 rounded-lg border border-info/30 bg-info-subtle px-3 py-2.5 text-[13px] text-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="min-w-0 font-semibold text-text-strong">{t('documents.prototype.draft.heading')}</h3>
        <PressedChoices label={t('documents.prototype.draft.previewLabel')} choices={PREVIEWS} value={preview}
          onChange={onPreviewChange}
          display={(choice) => (choice === 'draft' ? t('documents.prototype.draft.showDraft') : t('documents.prototype.draft.showCurrent'))}
          className="flex flex-wrap gap-1" pressedClassName="btn btn-secondary btn-sm border-accent text-accent-text"
          idleClassName="btn btn-ghost btn-sm" />
      </div>
      <DraftSummary draft={shown.draft} />
      <DraftOutcomes projectId={projectId} documentId={documentId} draft={shown.draft} />
      {/* Keyed by the draft: an Apply or Discard's state (a 409, an error) never outlives its draft. */}
      <DraftActions key={shown.draft.draft_id} projectId={projectId} documentId={documentId} shown={shown} onSelectDoc={onSelectDoc}
        onApplied={onApplied} />
    </section>
  )
}

/**
 * The draft in the preview, in place of the current version's: its own signed URL in the same frame
 * component, sandboxed without popups, and with no pin bridge. Nothing listens to this frame, so a pin
 * its widget might post is dropped (a draft has no pin form until it is applied).
 */
function DraftPreviewFrame({ url, title }: Readonly<{ url: string | null; title: string }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <p className="mb-2 text-xs text-muted">{t('documents.prototype.draft.previewHeading')}</p>
      <div className="flex-1 overflow-hidden border rounded-lg bg-card min-w-0">
        {url === null ? (
          <p className="p-4 text-sm text-muted">{t('documents.prototype.draft.noPreview')}</p>
        ) : (
          <HtmlPrototypeFrame url={url} draft title={t('documents.prototype.draft.frameTitle', { title })}
            className="w-full h-full border-0 rounded-lg" />
        )}
      </div>
    </div>
  )
}
