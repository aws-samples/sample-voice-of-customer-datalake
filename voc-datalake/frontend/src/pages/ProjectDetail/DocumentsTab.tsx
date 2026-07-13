/**
 * DocumentsTab - Documents list and detail view, plus the prototype builder.
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  FileText, Pencil, Trash2, Loader2, Wand2, AlertCircle,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { projectsApi } from '../../api/projectsApi'
import { pollJobToCompletion } from './jobPolling'
import DocumentExportMenu from '../../components/DocumentExportMenu'
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
  readonly onDocumentChanged?: () => void
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
  onDocumentChanged,
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
        <div className="lg:col-span-2 bg-white rounded-xl border p-4 sm:p-6 min-h-[400px] lg:min-h-[500px] overflow-hidden">
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
                  onDocumentChanged={onDocumentChanged}
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
  projectId, basePrototypeId, title, onRegenerated, t,
}: {
  readonly projectId: string
  readonly basePrototypeId: string
  readonly title: string
  readonly onRegenerated?: () => void
  readonly t: TFunc
}) {
  const { i18n } = useTranslation('projectDetail')
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = useCallback(async () => {
    const fb = feedback.trim()
    if (fb === '') return
    setBusy(true)
    setError(null)
    try {
      const start = await projectsApi.buildPrototype(projectId, {
        response_language: i18n.language,
        title,
        feedback: fb,
        base_prototype_id: basePrototypeId,
      })
      const outcome = await pollJobToCompletion(projectId, start.job_id)
      if (outcome.status === 'completed') {
        setOpen(false)
        setFeedback('')
        onRegenerated?.()
        return
      }
      if (outcome.status === 'failed') {
        throw new Error(outcome.job.error || 'Prototype revision failed')
      }
      throw new Error(t('documents.prototype.timeout', { defaultValue: 'Prototype build took too long. Check the Documents tab in a moment.' }))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Revision failed')
    } finally {
      setBusy(false)
    }
  }, [feedback, projectId, basePrototypeId, title, i18n.language, onRegenerated, t])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-orange-600 hover:underline"
        title={t('documents.prototype.feedbackTitle', { defaultValue: 'Give feedback to regenerate this prototype' })}
      >
        <Wand2 size={12} /> {t('documents.prototype.feedbackButton', { defaultValue: 'Revise with feedback' })}
      </button>
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

// ── Prototype view: render the JSON spec natively (no iframe) ────────────────
// PrototypeRenderer/parsePrototypeSpec moved to components/PrototypeRenderer
// so the Prioritization page can reuse it.

function PrototypeView({
  projectId, documentId, html, url, title, prototypeFormat, onDocumentChanged,
}: {
  readonly projectId: string
  readonly documentId: string
  readonly html: string
  readonly url?: string
  readonly title: string
  readonly prototypeFormat?: string
  readonly onDocumentChanged?: () => void
}) {
  const { t } = useTranslation('projectDetail')

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
        <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
          <span>{t('documents.prototype.previewLabel', { defaultValue: 'Live preview' })}</span>
          <div className="flex items-center gap-3">
            <PrototypeFeedbackButton
              projectId={projectId}
              basePrototypeId={documentId}
              title={title}
              onRegenerated={onDocumentChanged}
              t={t}
            />
            {url ? (
              // New prototypes are served from a stable, same-origin CDN URL —
              // plain links, no Blob/createObjectURL indirection needed.
              <>
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  {t('documents.prototype.openNewTab', { defaultValue: 'Open in new tab' })}
                </a>
                <a href={url} download={`${safeName}.html`} className="text-blue-600 hover:underline">
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
