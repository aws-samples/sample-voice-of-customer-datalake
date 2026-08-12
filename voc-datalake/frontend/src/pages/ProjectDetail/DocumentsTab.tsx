/**
 * DocumentsTab - Documents list and detail view, plus the prototype builder.
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  FileText, Pencil, Trash2, Loader2, Wand2, AlertCircle,
} from 'lucide-react'
import { useCallback, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { projectsApi } from '../../api/projectsApi'
import { resolveDerivation, type DerivationRole, type DerivationSource } from '../../api/derivation'
import { ordinalByType, resolveRevision, type DocumentOrdinal } from '../../api/documentLineage'
import { useTransientFlag } from './useTransientFlag'
import DocumentExportMenu from '../../components/DocumentExportMenu'
import PrototypeLinkActions, { PrototypeLinkLifetimeNote } from '../../components/PrototypeLinkActions'
import PrototypeRenderer, { HtmlPrototypeFrame } from '../../components/PrototypeRenderer'
import { parsePrototypeSpec, looksLikeHtmlDocument } from '../../components/prototypeSpec'
import type {
  ProjectDocument, Project,
} from '../../api/types'

interface DocumentsTabProps {
  readonly project: Project
  readonly documents: ProjectDocument[]
  readonly selectedDoc: ProjectDocument | null
  readonly onSelectDoc: (doc: ProjectDocument) => void
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
  /**
   * A prototype revision was started. Only the jobs panel needs to know: the
   * refreshed document list arrives when the job completes, via useProjectData,
   * whether or not this tab is still mounted.
   */
  readonly onJobStarted?: () => void
  readonly isDeleting: boolean
}

export default function DocumentsTab({
  project,
  documents,
  selectedDoc,
  onSelectDoc,
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
  onJobStarted,
  isDeleting,
}: DocumentsTabProps) {
  const { t } = useTranslation('projectDetail')
  // One pass for the whole list rather than one per row, and memoised because the
  // list re-renders on every selection change while the documents themselves do not.
  const ordinals = useMemo(() => ordinalByType(documents), [documents])

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={onCreateDoc}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
        >
          <FileText size={16} />{t('documents.newDocument')}
        </button>
      </div>
      <div className="flex flex-col lg:grid lg:grid-cols-3 gap-4 lg:gap-6">
        {/* Document List */}
        <div className="flex lg:flex-col gap-3 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 -mx-4 px-4 lg:mx-0 lg:px-0">
          {documents.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-xl border flex-shrink-0 w-full">
              <FileText size={32} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-500">{t('documents.noDocuments')}</p>
            </div>
          ) : (
            documents.map((d) => (
              <button
                key={d.document_id}
                onClick={() => onSelectDoc(d)}
                className={clsx(
                  'flex-shrink-0 w-56 lg:w-full text-left p-3 lg:p-4 rounded-lg border',
                  selectedDoc?.document_id === d.document_id
                    ? 'bg-blue-50 border-blue-300'
                    : 'bg-white hover:border-blue-200',
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <DocumentTypeBadge type={d.document_type} />
                  {/* Six prototypes called "Prototype", four sharing a date, is the
                      real shape of this list — the badge and the date do not tell
                      them apart, and neither does the title. The ordinal does, and
                      it is derived from creation order rather than stored, so it
                      needs no migration and cannot disagree with the records. */}
                  <DocumentOrdinalLabel ordinal={ordinals.get(d.document_id)} t={t} />
                  <span className="text-xs text-gray-400">{format(new Date(d.created_at), 'MMM d')}</span>
                </div>
                <h4 className="font-medium line-clamp-2 text-sm lg:text-base">{d.title}</h4>
              </button>
            ))
          )}
        </div>

        {/* Document Detail */}
        <div
          data-testid="document-detail-pane"
          className={clsx(
            'lg:col-span-2 bg-white rounded-xl border p-4 sm:p-6 min-h-[400px] overflow-hidden',
            // A prototype is a whole generated application; a PRD is prose. They do
            // not want the same pane. The fixed 500px minimum meant the most
            // tangible artifact the product makes previewed in ~430px whether the
            // monitor was 900px or 1440px tall — #288 stopped the jobs panel pushing
            // it down the page, but a taller viewport still bought it nothing.
            // 70vh is deliberately short of the full viewport so the pane still fits
            // above the fold on a laptop rather than introducing a scroll.
            selectedDoc?.document_type === 'prototype' ? 'lg:min-h-[70vh]' : 'lg:min-h-[500px]',
          )}
        >
          {selectedDoc ? (
            <div className="h-full flex flex-col">
              <div className="flex items-start justify-between mb-4 gap-2">
                <h2 className="text-xl font-bold">{selectedDoc.title}</h2>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <DocumentExportMenu document={selectedDoc} project={project} />
                  <button
                    onClick={onEditDoc}
                    className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                    title={t('documents.editDocument')}
                  >
                    <Pencil size={18} />
                  </button>
                  <button
                    onClick={onDeleteDoc}
                    disabled={isDeleting}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                    title={t('documents.deleteDocument')}
                  >
                    {isDeleting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                  </button>
                </div>
              </div>
              {selectedDoc.document_type === 'prototype' ? (
                <PrototypeView
                  projectId={project.project_id}
                  documentId={selectedDoc.document_id}
                  html={selectedDoc.content}
                  url={selectedDoc.prototype_url}
                  title={selectedDoc.title}
                  prototypeFormat={selectedDoc.prototype_format}
                  // Blank when the inherited source no longer exists, because the
                  // API rejects an id it cannot resolve — and a prototype whose PRD
                  // has since been deleted would otherwise become permanently
                  // unrevisable. Blank reads as "not aimed", so the revision falls
                  // back to newest-of-type: not a silent substitution, since the
                  // document it would have preserved is gone.
                  sourcePrdId={stillPresent(selectedDoc.source_prd_id, documents)}
                  sourcePrfaqId={stillPresent(selectedDoc.source_prfaq_id, documents)}
                  sourcesDropped={hasDroppedSource(selectedDoc, documents)}
                  onJobStarted={onJobStarted}
                />
              ) : (
                <div className="prose prose-sm max-w-none overflow-y-auto flex-1" style={{
                  overflowWrap: 'break-word',
                  wordBreak: 'break-word',
                }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedDoc.content}</ReactMarkdown>
                </div>
              )}
              {/* Below the content, not above it: provenance is what the document
                  was made from, not what it says. Both branches above own the
                  pane's flexible height, so a footer here stays visible without
                  pushing the preview down the page. */}
              <RevisionFooter doc={selectedDoc} documents={documents} onSelectDoc={onSelectDoc} />
              <DerivationFooter doc={selectedDoc} documents={documents} onSelectDoc={onSelectDoc} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">{t('documents.selectDocument')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Prototype feedback → regenerate ──────────────────────────────────────────
// The generated prototype is usually a user-facing view. This lets the reviewer
// give feedback (e.g. "show the admin's perspective") and get a revised
// prototype that still honors the PRD/PR-FAQ but is re-centered on the feedback.

type TFunc = (key: string, opts?: Record<string, unknown>) => string

function PrototypeFeedbackButton({
  projectId, basePrototypeId, title, sourcePrdId, sourcePrfaqId, sourcesDropped, onJobStarted, t,
}: {
  readonly projectId: string
  readonly basePrototypeId: string
  readonly title: string
  /** The base prototype's own sources, so a revision keeps the spec it revises. */
  readonly sourcePrdId: string
  readonly sourcePrfaqId: string
  /**
   * A source this prototype was built from has been deleted, so the revision will
   * read the latest of that type instead. Said out loud rather than left silent:
   * the fallback is justified, but an unexplained change of spec is the behaviour
   * this whole flow exists to remove.
   */
  readonly sourcesDropped: boolean
  /** Tells the Background Jobs panel to pick the revision up. */
  readonly onJobStarted?: () => void
  readonly t: TFunc
}) {
  const { i18n } = useTranslation('projectDetail')
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  // Lowers itself, so it cannot still claim "started" after the panel has
  // reported the revision finished or failed.
  const started = useTransientFlag()
  const [error, setError] = useState<string | null>(null)

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
  }, [feedback, projectId, basePrototypeId, title, sourcePrdId, sourcePrfaqId,
      i18n.language, onJobStarted, started])

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-orange-600 hover:underline"
          title={t('documents.prototype.feedbackTitle', { defaultValue: 'Give feedback to regenerate this prototype' })}
        >
          <Wand2 size={12} /> {t('documents.prototype.feedbackButton', { defaultValue: 'Revise with feedback' })}
        </button>
        {/* The panel is the real progress report, but it is a refetch away and
            renders nothing until the job appears — so say something here too. */}
        {started.isSet ? <span className="text-emerald-700">{t('documents.prototype.started')}</span> : null}
      </span>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setOpen(false)}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-1">{t('documents.prototype.feedbackHeading', { defaultValue: 'Revise prototype with feedback' })}</h3>
        <p className="text-xs text-gray-500 mb-3">{t('documents.prototype.feedbackHint', { defaultValue: 'Describe what to change. The PRD/PR-FAQ stays in effect; the prototype is re-centered on your feedback (e.g. “show the admin’s perspective”).' })}</p>
        {sourcesDropped ? (
          <p data-testid="revision-rebased-note" className="text-xs text-amber-700 mb-3">
            {t('documents.prototype.feedbackRebased')}
          </p>
        ) : null}
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={5}
          autoFocus
          placeholder={t('documents.prototype.feedbackPlaceholder', { defaultValue: 'e.g. Change this to the admin dashboard view — show approvals, user management, and metrics instead of the end-user screens.' })}
          className="w-full px-3 py-2 border rounded-lg text-sm"
          disabled={busy}
        />
        {error ? <p className="text-xs text-red-600 mt-2 inline-flex items-center gap-1"><AlertCircle size={12} /> {error}</p> : null}
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={() => setOpen(false)} disabled={busy} className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50">
            {t('cancel', { defaultValue: 'Cancel', ns: 'common' })}
          </button>
          <button
            onClick={onSubmit}
            disabled={busy || feedback.trim() === ''}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {busy
              ? t('documents.prototype.feedbackBuilding', { defaultValue: 'Revising…' })
              : t('documents.prototype.feedbackSubmit', { defaultValue: 'Regenerate' })}
          </button>
        </div>
      </div>
    </div>
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
      <button onClick={onOpenInNewTab} className="text-blue-600 hover:underline">
        {t('prototypeLink.openNewTab')}
      </button>
      <button onClick={onDownloadHtml} className="text-blue-600 hover:underline">
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

function PrototypeView({
  projectId, documentId, html, url, title, prototypeFormat, sourcePrdId, sourcePrfaqId,
  sourcesDropped, onJobStarted,
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
        <div className="flex items-center justify-between mb-2 text-xs text-gray-500 gap-3">
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className="flex-shrink-0">{t('documents.prototype.previewLabel', { defaultValue: 'Live preview' })}</span>
            {/* Only signed CDN prototypes have a lifetime to report; legacy inline
                ones are rendered from `content` and never expire. */}
            {url ? <PrototypeLinkLifetimeNote url={url} noteId={lifetimeNoteId} /> : null}
          </span>
          <div className="flex items-center gap-3 flex-shrink-0">
            <PrototypeFeedbackButton
              projectId={projectId}
              basePrototypeId={documentId}
              title={title}
              sourcePrdId={sourcePrdId}
              sourcePrfaqId={sourcePrfaqId}
              sourcesDropped={sourcesDropped}
              onJobStarted={onJobStarted}
              t={t}
            />
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
        <div className="flex-1 overflow-hidden border rounded-lg bg-white">
          <HtmlPrototypeFrame url={url} html={html} title={title} className="w-full h-full border-0 rounded-lg" />
        </div>
      </div>
    )
  }

  if (!spec) {
    // Legacy / malformed prototype — show as plain text so the user can still inspect.
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
          <span>{t('documents.prototype.rawLabel', { defaultValue: 'Raw output (parse failed — please regenerate)' })}</span>
          <button onClick={onDownload} className="text-blue-600 hover:underline">
            {t('documents.prototype.downloadHtml', { defaultValue: 'Download' })}
          </button>
        </div>
        <pre className="flex-1 overflow-auto bg-gray-50 text-xs p-3 rounded-lg border whitespace-pre-wrap break-all">{html}</pre>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
        <span>{t('documents.prototype.previewLabel', { defaultValue: 'Live preview' })}</span>
        <button onClick={onDownload} className="text-blue-600 hover:underline">
          {t('documents.prototype.downloadJson', { defaultValue: 'Download .json' })}
        </button>
      </div>
      <div className="flex-1 overflow-auto border rounded-lg bg-white p-4">
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

function DerivationFooter({
  doc, documents, onSelectDoc,
}: {
  readonly doc: ProjectDocument
  readonly documents: readonly ProjectDocument[]
  readonly onSelectDoc: (doc: ProjectDocument) => void
}) {
  const { t } = useTranslation('projectDetail')
  const derivation = useMemo(() => resolveDerivation(doc, documents), [doc, documents])

  // The resolver hands back ids, not documents, and `onSelectDoc` needs the
  // document — so the list is searched here, once, on click only.
  const onSelectSource = useCallback((documentId: string) => {
    const target = documents.find((d) => d.document_id === documentId)
    if (target) onSelectDoc(target)
  }, [documents, onSelectDoc])

  // 'none' is a legitimate answer — a hand-authored document, or an old record
  // with nothing to reconstruct — not a gap to advertise. Nothing renders: no
  // panel, no "unknown", no invented provenance to fill the space.
  if (derivation.origin === 'none') return null

  // Literal keys so the i18n extractor still sees them, in a record so that
  // adding a role to DERIVATION_ROLES is a compile error here rather than a
  // silently missing label.
  const roleLabels: Record<DerivationRole, string> = {
    reference: t('documents.derivation.roles.reference'),
    prototype_prd: t('documents.derivation.roles.prototypePrd'),
    prototype_prfaq: t('documents.derivation.roles.prototypePrfaq'),
    merge_input: t('documents.derivation.roles.mergeInput'),
  }

  // The non-document inputs. Most PRDs are generated from feedback alone, and
  // without these such a document would read as built from nothing.
  const inputs = [
    derivation.feedback_count > 0
      ? t('documents.derivation.feedbackUsed', { count: derivation.feedback_count })
      : null,
    derivation.persona_ids.length > 0
      ? t('documents.derivation.personasUsed', { count: derivation.persona_ids.length })
      : null,
    derivation.product_context_included ? t('documents.derivation.productContext') : null,
  ].filter((label): label is string => label !== null)

  return (
    <section data-testid="document-derivation" className="mt-4 pt-3 border-t text-xs text-gray-500">
      <h3 className="font-medium text-gray-600 mb-1.5">{t('documents.derivation.builtFrom')}</h3>
      {derivation.sources.length > 0 ? (
        <ul className="space-y-1">
          {derivation.sources.map((source) => (
            // Role in the key too: the same document can contribute twice under
            // two roles, and neither entry should be dropped as a duplicate.
            <li key={`${source.role}:${source.document_id}`}>
              <DerivationSourceRow
                source={source}
                roleLabel={roleLabels[source.role]}
                unavailableLabel={t('documents.derivation.unavailable')}
                onSelect={onSelectSource}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {/* The generator feeds the model at most three of the reference documents
          selected, so a record can say five selected and three used. Said in the
          same neutral grey as the rest, with no icon and no warning colour: the
          cap is deliberate, and fixing it is a separate issue from showing it.
          Nothing is said at all when the two numbers agree. */}
      {derivation.selected_document_count > derivation.sources.length ? (
        <p className="mt-1.5">
          {t('documents.derivation.selectedUsed', {
            used: derivation.sources.length,
            selected: derivation.selected_document_count,
          })}
        </p>
      ) : null}
      {inputs.length > 0 ? <p className="mt-1.5">{inputs.join(' · ')}</p> : null}
    </section>
  )
}

/** One contributing document: navigable while it exists, plain text once it does not. */
function DerivationSourceRow({
  source, roleLabel, unavailableLabel, onSelect,
}: {
  readonly source: DerivationSource
  readonly roleLabel: string
  readonly unavailableLabel: string
  readonly onSelect: (documentId: string) => void
}) {
  const label = (
    <>
      {/* The same badge the list cards use, keyed on the document_type the
          resolver now returns alongside the title. */}
      {source.document_type ? <DocumentTypeBadge type={source.document_type} /> : null}
      <span className="truncate">{source.title || source.document_id}</span>
    </>
  )
  const role = <span className="flex-shrink-0 text-gray-400">{roleLabel}</span>

  // A source whose document has been deleted stays visible — the relation
  // outlived its target — but must not be a control that leads nowhere.
  if (!source.resolved) {
    return (
      <span className="flex items-center gap-2 min-w-0">
        {label}
        <span className="flex-shrink-0">{unavailableLabel}</span>
        {role}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2 min-w-0">
      <button
        type="button"
        onClick={() => onSelect(source.document_id)}
        className="flex items-center gap-2 min-w-0 text-left text-blue-600 hover:underline"
      >
        {label}
      </button>
      {role}
    </span>
  )
}

/**
 * A source id to send, or '' when that document is no longer in the project.
 *
 * The API refuses an id it cannot resolve — deliberately, so a build never runs
 * against a document the user did not pick. That makes an INHERITED id a
 * liability: a prototype whose PRD was deleted afterwards would send a dead id on
 * every revision attempt and could never be revised again. Dropping it to '' is
 * the same fallback `usePrototypeBuild.effectiveSourceId` applies to a stale
 * selection, and it is not a silent substitution — the document whose spec would
 * have been preserved does not exist any more.
 */
function stillPresent(
  documentId: string | null | undefined,
  documents: readonly ProjectDocument[],
): string {
  if (documentId == null || documentId === '') return ''
  return documents.some((d) => d.document_id === documentId) ? documentId : ''
}

/**
 * True when this prototype names a source document that is no longer in the
 * project, so a revision cannot keep the spec it was built from.
 *
 * The fallback is justified — the document is gone — but leaving it unsaid would
 * make it a silent substitution, which is the exact class of behaviour the source
 * picker exists to remove. So the revision panel says it out loud.
 */
function hasDroppedSource(
  doc: ProjectDocument,
  documents: readonly ProjectDocument[],
): boolean {
  return ([doc.source_prd_id, doc.source_prfaq_id]).some(
    (id) => id != null && id !== '' && stillPresent(id, documents) === '',
  )
}

// ── Succession: what this document replaces ──────────────────────────────────
// A separate section from the derivation footer, and separate on purpose: "this
// revises that" is a different relation from "this was built from that". A
// revision is ALSO built from a PRD, so folding the two would show a prototype as
// though it had been assembled out of its own predecessor.
//
// `revised_from_id` and `revision_feedback` have been written on every
// feedback-driven revision since that feature shipped and have arrived on every
// project read ever since, read by nothing. This is the first consumer.

function RevisionFooter({
  doc, documents, onSelectDoc,
}: {
  readonly doc: ProjectDocument
  readonly documents: readonly ProjectDocument[]
  readonly onSelectDoc: (doc: ProjectDocument) => void
}) {
  const { t } = useTranslation('projectDetail')
  const revision = useMemo(() => resolveRevision(doc, documents), [doc, documents])

  const onSelectBase = useCallback((documentId: string) => {
    const target = documents.find((d) => d.document_id === documentId)
    if (target) onSelectDoc(target)
  }, [documents, onSelectDoc])

  // Not a revision. Most documents are not, so this renders nothing rather than
  // an empty heading.
  if (revision === null) return null

  return (
    <section data-testid="document-revision" className="mt-4 pt-3 border-t text-xs text-gray-500">
      <h3 className="font-medium text-gray-600 mb-1.5">{t('documents.revision.heading')}</h3>
      <p className="flex items-center gap-2 min-w-0">
        {revision.resolved ? (
          <button
            type="button"
            onClick={() => onSelectBase(revision.revisedFromId)}
            className="truncate text-left text-blue-600 hover:underline"
          >
            {revision.title === null || revision.title === '' ? revision.revisedFromId : revision.title}
          </button>
        ) : (
          // The predecessor has been deleted. The relation still happened, so it
          // is still reported — just not as a control that leads nowhere. Same
          // rule the derivation footer follows for a deleted source.
          <>
            <span className="truncate">{revision.revisedFromId}</span>
            <span className="flex-shrink-0">{t('documents.derivation.unavailable')}</span>
          </>
        )}
      </p>
      {/* The feedback IS the reason this revision exists, so it is the one piece
          of stored text worth surfacing here. Capped by the backend at 2000
          chars; clamped rather than scrolled so a long note cannot push the
          preview off the pane. */}
      {revision.feedback === '' ? null : (
        <p className="mt-1.5 italic line-clamp-3">
          {t('documents.revision.feedback', { feedback: revision.feedback })}
        </p>
      )}
    </section>
  )
}

// ── Badges ──────────────────────────────────────────────────────────────────

/**
 * "2 of 3" for a document whose type has more than one.
 *
 * Silent for a type with a single document: "1 of 1" is noise on every PRD in
 * every project that has one, and the number only earns its space once there is
 * something to confuse it with.
 */
function DocumentOrdinalLabel({
  ordinal, t,
}: {
  readonly ordinal: DocumentOrdinal | undefined
  readonly t: TFunc
}) {
  if (ordinal === undefined || ordinal.total < 2) return null

  return (
    <span className="text-xs font-medium text-gray-500 flex-shrink-0">
      {t('documents.ordinal', { ordinal: ordinal.ordinal, total: ordinal.total })}
    </span>
  )
}

function DocumentTypeBadge({ type }: { readonly type: string }) {
  const styles: Record<string, string> = {
    prd: 'bg-blue-100 text-blue-700',
    prfaq: 'bg-green-100 text-green-700',
    custom: 'bg-purple-100 text-purple-700',
    product_report: 'bg-indigo-100 text-indigo-700',
    prototype: 'bg-orange-100 text-orange-700',
  }
  const style = styles[type] ?? 'bg-amber-100 text-amber-700'

  return (
    <span className={clsx('text-xs font-medium px-2 py-0.5 rounded', style)}>
      {type.toUpperCase().replace('_', ' ')}
    </span>
  )
}
