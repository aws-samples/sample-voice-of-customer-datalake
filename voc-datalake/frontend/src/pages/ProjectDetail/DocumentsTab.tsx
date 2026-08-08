/**
 * DocumentsTab - Documents list and detail view, plus the prototype builder.
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  FileText, Pencil, Trash2, Loader2, Wand2, AlertCircle, Clock,
} from 'lucide-react'
import { useCallback, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { projectsApi } from '../../api/projectsApi'
import { useTransientFlag } from './useTransientFlag'
import DocumentExportMenu from '../../components/DocumentExportMenu'
import PrototypeRenderer, { HtmlPrototypeFrame } from '../../components/PrototypeRenderer'
import { signedUrlExpiresAt, formatExpiry } from '../../components/prototypeLinkLifetime'
import { parsePrototypeSpec, looksLikeHtmlDocument } from '../../components/prototypeSpec'
import { useDeadlinePassed } from '../../components/useDeadlinePassed'
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
  projectId, basePrototypeId, title, onJobStarted, t,
}: {
  readonly projectId: string
  readonly basePrototypeId: string
  readonly title: string
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
  }, [feedback, projectId, basePrototypeId, title, i18n.language, onJobStarted, started])

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
  html, safeName, t,
}: {
  readonly html: string
  readonly safeName: string
  readonly t: TFunc
}) {
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
        {t('documents.prototype.openNewTab', { defaultValue: 'Open in new tab' })}
      </button>
      <button onClick={onDownloadHtml} className="text-blue-600 hover:underline">
        {t('documents.prototype.downloadHtml', { defaultValue: 'Download .html' })}
      </button>
    </>
  )
}

// ── How long this prototype link lasts ──────────────────────────────────────
// The URL is a signed, session-scoped credential, not a durable share link, and
// until now nothing said so: a reviewer would copy it out of "Open in new tab",
// pass it on, and it would die inside the hour with no explanation at either end.
//
// The deadline is read off the URL's own `Expires` rather than from a TTL constant
// mirrored on this side. The signer's TTL is a Python-side fallback
// (CDN_SIGNED_URL_TTL_SECONDS is not set in the stack), so a number hardcoded here
// would be a guess that silently diverges the day it is configured.

function LinkLifetimeNote({
  url, t, locale, noteId,
}: {
  readonly url: string
  readonly t: TFunc
  readonly locale: string
  /**
   * Minted with `useId` by the caller, which also puts it on the anchors'
   * `aria-describedby` — so the warning reaches a screen-reader user at the moment they
   * are about to activate the link, not only someone who happens to hover it. Generated
   * rather than a module constant so two prototype panes on one screen cannot collide.
   */
  readonly noteId: string
}) {
  const expiresAt = signedUrlExpiresAt(url)

  // Flips itself at the deadline via a single timer, so the label cannot keep
  // promising a window that has already closed. Reading `Date.now()` here instead
  // would be impure (eslint's react-hooks/purity), and sampling it once in state
  // would freeze the answer for as long as the pane stays mounted.
  const expired = useDeadlinePassed(expiresAt)

  // Only decides whether the deadline falls on today's date, which does not change
  // meaningfully within a one-hour window — and if the page is open across midnight,
  // a sample from before it errs toward SHOWING the date, which is the safe way to be
  // wrong. Hooks precede the guard below because they cannot be conditional.
  const [sampledNow] = useState(() => Date.now())

  // No readable deadline — an unsigned or malformed URL. Say nothing rather than
  // invent a window: a wrong expiry is worse than none.
  if (expiresAt == null) return null

  return (
    <span
      id={noteId}
      className={clsx('inline-flex items-start gap-1', expired ? 'text-amber-700' : 'text-gray-400')}
    >
      <Clock size={11} className="flex-shrink-0 mt-0.5" />
      {/* Wraps rather than truncates. Under `truncate` the clipped end was the hint —
          i.e. the sentence this label exists for — so a narrow pane silently put the
          warning back out of sight for sighted users. */}
      <span>
        {expired
          ? t('documents.prototype.linkExpired', { defaultValue: 'Link expired — reopen the project' })
          : t('documents.prototype.linkExpires', {
            time: formatExpiry(expiresAt, sampledNow, locale),
            defaultValue: 'Link valid until {{time}}',
          })}
        {' · '}
        {/* Visible rather than a `title`: this warning is the whole point of the
            label, and a tooltip is hover-only — invisible on touch, and announced
            inconsistently. */}
        {t('documents.prototype.linkExpiryHint', {
          defaultValue: 'tied to your session, not a share link',
        })}
      </span>
    </span>
  )
}

// ── Prototype view: render the JSON spec natively (no iframe) ────────────────
// PrototypeRenderer/parsePrototypeSpec moved to components/PrototypeRenderer
// so the Prioritization page can reuse it.

function PrototypeView({
  projectId, documentId, html, url, title, prototypeFormat, onJobStarted,
}: {
  readonly projectId: string
  readonly documentId: string
  readonly html: string
  readonly url?: string
  readonly title: string
  readonly prototypeFormat?: string
  readonly onJobStarted?: () => void
}) {
  const { t, i18n } = useTranslation('projectDetail')
  const lifetimeNoteId = useId()

  const isHtml = prototypeFormat === 'html' || Boolean(url) || (prototypeFormat === undefined && looksLikeHtmlDocument(html))
  const spec = useMemo(() => (isHtml ? null : parsePrototypeSpec(html)), [isHtml, html])

  // Whether the lifetime note will actually render, so `aria-describedby` below
  // points at an element that exists rather than dangling on an id that does not.
  const hasLifetimeNote = signedUrlExpiresAt(url) != null

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
            {url ? <LinkLifetimeNote url={url} t={t} locale={i18n.language} noteId={lifetimeNoteId} /> : null}
          </span>
          <div className="flex items-center gap-3 flex-shrink-0">
            <PrototypeFeedbackButton
              projectId={projectId}
              basePrototypeId={documentId}
              title={title}
              onJobStarted={onJobStarted}
              t={t}
            />
            {url ? (
              // New prototypes are served from a stable, same-origin CDN URL —
              // plain links, no Blob/createObjectURL indirection needed.
              <>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                  aria-describedby={hasLifetimeNote ? lifetimeNoteId : undefined}
                >
                  {t('documents.prototype.openNewTab', { defaultValue: 'Open in new tab' })}
                </a>
                <a
                  href={url}
                  download={`${safeName}.html`}
                  className="text-blue-600 hover:underline"
                  aria-describedby={hasLifetimeNote ? lifetimeNoteId : undefined}
                >
                  {t('documents.prototype.downloadHtml', { defaultValue: 'Download .html' })}
                </a>
              </>
            ) : (
              // Legacy prototypes only have inline `content` — fall back to blobbing it.
              <LegacyHtmlActions html={html} safeName={safeName} t={t} />
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

// ── Badge ───────────────────────────────────────────────────────────────────

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
