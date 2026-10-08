/**
 * @fileoverview The Documents tab prototype viewer: the framed preview, its feedback revise and legacy HTML actions.
 * @module pages/ProjectDetail/DocumentPrototypeView
 */

import { Loader2, Wand2, AlertCircle } from 'lucide-react'
import { useCallback, useId, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { useTransientFlag } from './useTransientFlag'
import ModalShell from '../../components/ModalShell/ModalShell'
import PrototypeLinkActions, { PrototypeLinkLifetimeNote } from '../../components/PrototypeLinkActions'
import PrototypeRenderer from '../../components/PrototypeRenderer'
import PrototypePinsReview from '../../components/PrototypePins/PrototypePinsReview'
import { parsePrototypeSpec, looksLikeHtmlDocument } from '../../components/prototypeSpec'
import type { InheritedExtraSources } from './documentLineage'

// ── Prototype feedback → regenerate ──────────────────────────────────────────
// The generated prototype is usually a user-facing view. This lets the reviewer
// give feedback (e.g. "show the admin's perspective") and get a revised
// prototype that still honors the PRD/PR-FAQ but is re-centered on the feedback.


function PrototypeFeedbackButton({
  projectId, basePrototypeId, title, sourcePrdId, sourcePrfaqId, sourcesDropped, extraSources,
  onJobStarted, t,
}: {
  readonly projectId: string
  readonly basePrototypeId: string
  readonly title: string
  /** The base prototype's own sources, so a revision keeps the spec it revises. */
  readonly sourcePrdId: string
  readonly sourcePrfaqId: string
  /** The base prototype's optional inputs, for the same reason. */
  readonly extraSources: InheritedExtraSources
  /**
   * A source this prototype was built from has been deleted, so the revision will
   * read the latest of that type instead. Said out loud rather than left silent:
   * the fallback is justified, but an unexplained change of spec is the behaviour
   * this whole flow exists to remove.
   */
  readonly sourcesDropped: boolean
  /** Tells the Background Jobs panel to pick the revision up. */
  readonly onJobStarted?: () => void
  readonly t: TFunction<'projectDetail'>
}) {
  const { i18n } = useTranslation('projectDetail')
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  // Lowers itself, so it cannot still claim "started" after the panel has
  // reported the revision finished or failed.
  const started = useTransientFlag()
  const [error, setError] = useState<string | null>(null)
  const headingId = useId()

  // Closes as soon as the revision is *started*: the jobs panel owns the wait
  // from here, and it survives the navigation that used to destroy the only
  // progress indication. Only a failure to start is reported inline.
  const onSubmit = useCallback(async () => {
    const fb = feedback.trim()
    if (fb === '') return
    setBusy(true)
    setError(null)
    try {
      await projectsApi.buildPrototype(projectId, {
        response_language: i18n.language,
        title,
        feedback: fb,
        base_prototype_id: basePrototypeId,
        // Inherit the base prototype's own sources. Without these the backend
        // re-resolves "the newest of each type", so revising a prototype built
        // from June's PRD would quietly re-base it on September's — a revision
        // that changes the spec as well as the feedback, which is not what
        // "revise this" means. Blank for a prototype that recorded no source
        // falls back to today's behaviour.
        source_prd_id: sourcePrdId,
        source_prfaq_id: sourcePrfaqId,
        // Inherited for the same reason as the two ids above, and it is the same
        // defect class: re-deriving the defaults would ground the revision in
        // whatever research exists NOW, so a report created between the build and
        // the revision would silently join it — or the product-context flag would
        // be dropped — while the user only asked to change the feedback.
        //
        // The flag-and-ids pair, in the shape `usePrototypeBuild` sends it: the
        // flag is the switch and the ids are gated on it. One rule for one API
        // field — deriving the flag here instead was a second rule for the same
        // field, and the two could have drifted apart.
        use_product_context: extraSources.useProductContext,
        use_research: extraSources.useResearch,
        selected_research_ids: extraSources.useResearch ? [...extraSources.researchIds] : [],
        // Inherited for the same reason, and the reason bites harder here: a
        // visually-grounded prototype takes its whole palette and layout from these
        // mockups, so dropping them makes the revision come back in the default
        // theme — the largest possible unrequested change, from a button that only
        // promised to act on the feedback. No flag to gate them on: the list is the
        // request, exactly as the build card sends it.
        selected_product_doc_ids: [...extraSources.visualIds],
      })
      // The form closes but the text is kept: the revision can still fail
      // minutes later, in the jobs panel, and clearing it would mean retyping
      // the feedback to retry.
      setOpen(false)
      started.set()
      onJobStarted?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Revision failed')
    } finally {
      setBusy(false)
    }
  }, [feedback, projectId, basePrototypeId, title, sourcePrdId, sourcePrfaqId, extraSources,
      i18n.language, onJobStarted, started])

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-warn underline underline-offset-2"
          title={t('documents.prototype.feedbackTitle', { defaultValue: 'Give feedback to regenerate this prototype' })}
        >
          <Wand2 size={12} /> {t('documents.prototype.feedbackButton', { defaultValue: 'Revise with feedback' })}
        </button>
        {/* The panel is the real progress report, but it is a refetch away and
            renders nothing until the job appears — so say something here too. */}
        {started.isSet ? <span className="text-ok">{t('documents.prototype.started')}</span> : null}
      </span>
    )
  }

  return (
    // ModalShell: dialog semantics, focus trap, and Escape / backdrop close —
    // both disabled while the start request is in flight, as the backdrop
    // click was before.
    <ModalShell
      isOpen
      onClose={() => setOpen(false)}
      ariaLabelledBy={headingId}
      panelClassName="max-w-lg max-h-[90vh]"
      dismissable={!busy}
    >
        <div className="dialog-header">
          <div className="min-w-0 space-y-1">
            <h2 id={headingId} className="dialog-title">{t('documents.prototype.feedbackHeading', { defaultValue: 'Revise prototype with feedback' })}</h2>
            <p className="dialog-description">{t('documents.prototype.feedbackHint', { defaultValue: 'Describe what to change. The PRD/PR-FAQ stays in effect; the prototype is re-centered on your feedback (e.g. “show the admin’s perspective”).' })}</p>
          </div>
        </div>
        <div className="dialog-body">
          {sourcesDropped ? (
            <p data-testid="revision-rebased-note" className="text-xs text-warn mb-3">
              {t('documents.prototype.feedbackRebased')}
            </p>
          ) : null}
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={5}
            autoFocus
            aria-labelledby={headingId}
            placeholder={t('documents.prototype.feedbackPlaceholder', { defaultValue: 'e.g. Change this to the admin dashboard view — show approvals, user management, and metrics instead of the end-user screens.' })}
            className="input"
            disabled={busy}
          />
          {error ? <p className="text-xs text-danger mt-2 inline-flex items-center gap-1"><AlertCircle size={12} /> {error}</p> : null}
        </div>
        <div className="dialog-footer">
          <button onClick={() => setOpen(false)} disabled={busy} className="btn btn-secondary">
            {t('cancel', { defaultValue: 'Cancel', ns: 'common' })}
          </button>
          <button
            onClick={onSubmit}
            disabled={busy || feedback.trim() === ''}
            className="btn btn-primary"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {busy
              ? t('documents.prototype.feedbackBuilding', { defaultValue: 'Revising…' })
              : t('documents.prototype.feedbackSubmit', { defaultValue: 'Regenerate' })}
          </button>
        </div>
    </ModalShell>
  )
}

// ── Legacy prototype actions: blob-based open/download for pre-migration docs ──
// Only pre-migration prototypes (no `prototype_url`) hit this path; new
// prototypes use plain <a href> links to their stable CDN URL instead.

function LegacyHtmlActions({
  html, safeName,
}: {
  readonly html: string
  readonly safeName: string
}) {
  // Reads `components` rather than taking this page's `projectDetail` `t`, because
  // the labels below are the SAME two labels `PrototypeLinkActions` renders for the
  // non-legacy branch a few lines down. They were a `projectDetail` copy of them,
  // which is how one branch of one control ends up worded differently from the
  // other in seven translations and nobody notices.
  const { t } = useTranslation('components')
  const onDownloadHtml = useCallback(() => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `${safeName}.html`
    a.click()
    URL.revokeObjectURL(blobUrl)
  }, [html, safeName])
  const onOpenInNewTab = useCallback(() => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)
    window.open(blobUrl, '_blank', 'noopener,noreferrer')
    // Revoke after a tick so the new tab has time to load.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  }, [html])

  return (
    <>
      <button onClick={onOpenInNewTab} className="link">
        {t('prototypeLink.openNewTab')}
      </button>
      <button onClick={onDownloadHtml} className="link">
        {t('prototypeLink.downloadHtml')}
      </button>
    </>
  )
}

// ── Prototype view: render the JSON spec natively (no iframe) ────────────────
// PrototypeRenderer/parsePrototypeSpec moved to components/PrototypeRenderer
// so the Prioritization page can reuse it. The prototype's open/download anchors
// and the note saying how long they last moved to components/PrototypeLinkActions
// for the same reason — that page now offers "Open in new tab" too, and the reason
// these must stay anchors is documented there rather than rediscovered per page.

export function PrototypeView({
  projectId, documentId, html, url, title, prototypeFormat, sourcePrdId, sourcePrfaqId,
  sourcesDropped, extraSources, canEdit, onJobStarted,
}: {
  readonly projectId: string
  readonly documentId: string
  readonly html: string
  readonly url?: string
  readonly title: string
  readonly prototypeFormat?: string
  /** Passed through to a revision so it inherits this prototype's sources. */
  readonly sourcePrdId: string
  readonly sourcePrfaqId: string
  /** One of those sources has been deleted, so the revision cannot inherit it. */
  readonly sourcesDropped: boolean
  /** The optional inputs the base was built with, passed through to a revision. */
  readonly extraSources: InheritedExtraSources
  /** False for a viewer: no "revise with feedback" (it starts a billable job the gate would refuse). */
  readonly canEdit: boolean
  readonly onJobStarted?: () => void
}) {
  const { t } = useTranslation('projectDetail')
  // Shared by the lifetime note and the anchors that describe themselves with it.
  // `useId` rather than a constant so two prototype panes cannot collide.
  const lifetimeNoteId = useId()

  const isHtml = prototypeFormat === 'html' || Boolean(url) || (prototypeFormat === undefined && looksLikeHtmlDocument(html))
  const spec = useMemo(() => (isHtml ? null : parsePrototypeSpec(html)), [isHtml, html])

  const safeName = title.replace(/[^\w\-가-힣]+/g, '_')
  const onDownload = useCallback(() => {
    const blob = new Blob([html], { type: 'application/json;charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `${safeName}.json`
    a.click()
    URL.revokeObjectURL(blobUrl)
  }, [html, safeName])

  // Newer format: a self-contained HTML document, served either from a CDN
  // URL (new, S3-only prototypes) or inline (legacy, pre-migration prototypes).
  if (isHtml) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Wraps rather than overflowing: on a phone the label and the three
            actions do not fit one row, and the non-shrinking action group used to
            paint over the "Live preview" label. */}
        <div className="flex flex-wrap items-center justify-between mb-2 text-xs text-muted gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className="flex-shrink-0">{t('documents.prototype.previewLabel', { defaultValue: 'Live preview' })}</span>
            {/* Only signed CDN prototypes have a lifetime to report; legacy inline
                ones are rendered from `content` and never expire. */}
            {url ? <PrototypeLinkLifetimeNote url={url} noteId={lifetimeNoteId} /> : null}
          </span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
            {canEdit ? (
              <PrototypeFeedbackButton
                projectId={projectId}
                basePrototypeId={documentId}
                title={title}
                sourcePrdId={sourcePrdId}
                sourcePrfaqId={sourcePrfaqId}
                sourcesDropped={sourcesDropped}
                extraSources={extraSources}
                onJobStarted={onJobStarted}
                t={t}
              />
            ) : null}
            {url ? (
              // New prototypes are served from a stable, same-origin CDN URL —
              // plain links, no Blob/createObjectURL indirection needed. Shared with
              // the Prioritization row, which offers the open half of this.
              <PrototypeLinkActions url={url} noteId={lifetimeNoteId} downloadName={safeName} />
            ) : (
              // Legacy prototypes only have inline `content` — fall back to blobbing it.
              // No `t`: it reads the same shared `components` labels the branch above
              // does, so the two spellings of one control cannot drift apart.
              <LegacyHtmlActions html={html} safeName={safeName} />
            )}
          </div>
        </div>
        <PrototypePinsReview projectId={projectId} documentId={documentId} url={url} html={html} title={title}
          canEdit={canEdit} />
      </div>
    )
  }

  if (!spec) {
    // Legacy / malformed prototype — show as plain text so the user can still inspect.
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-2 text-xs text-muted">
          <span>{t('documents.prototype.rawLabel', { defaultValue: 'Raw output (parse failed — please regenerate)' })}</span>
          <button onClick={onDownload} className="link">
            {t('documents.prototype.downloadHtml', { defaultValue: 'Download' })}
          </button>
        </div>
        <pre
          tabIndex={0}
          role="region"
          aria-label={t('documents.prototype.rawLabel', { defaultValue: 'Raw output (parse failed — please regenerate)' })}
          className="flex-1 overflow-auto bg-bg-accent text-xs p-3 rounded-lg border whitespace-pre-wrap break-all focus-ring"
        >{html}</pre>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between mb-2 text-xs text-muted">
        <span>{t('documents.prototype.previewLabel', { defaultValue: 'Live preview' })}</span>
        <button onClick={onDownload} className="link">
          {t('documents.prototype.downloadJson', { defaultValue: 'Download .json' })}
        </button>
      </div>
      <div className="flex-1 overflow-auto border rounded-lg bg-card p-4">
        <PrototypeRenderer spec={spec} />
      </div>
    </div>
  )
}

// ── Provenance: what the selected document was built from ────────────────────
// First consumer of api/derivation.ts. `resolveDerivation` is already total —
// absent, null, empty and malformed records all read as "no lineage", and it
// reconstructs the answer for documents written before the field existed — so
// this calls it and trusts it instead of parsing defensively on top.
//
// In the detail pane rather than on the list cards: a card is 224px wide and
// already carries a badge, a date and a two-line title.
