/**
 * @fileoverview The Sources card's list (7.104.00): each source with its kind's icon, its name, its own status and
 * what its reading found — the characters read, the pages, "cut" when its text was cut at the reading's cap, a link's
 * final host, a failure's reason — and a note when its text reads like instructions to a model (it is read as data
 * only, never refused). An editor gets Retry (a PDF, DOCX or PPTX whose read failed: the one kind of file the server
 * reads again, `POST …/refresh`; any other failed file can only be deleted and added again), Fetch again (a link) and
 * Delete.
 *
 * @module pages/ProjectDetail/ProductSourceList
 */
import {
  AlertCircle, CheckCircle2, FileText, Image as ImageIcon, Link2, Loader2, MessageSquareText, Mic, RefreshCw,
  ShieldAlert, Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { formatFileSize } from '../../utils/file'
import { canRetrySource, isReading } from './useProductSources'
import type { ProductDoc } from '../../api/projectTypes'

function KindIcon({ doc }: Readonly<{ doc: ProductDoc }>) {
  const props = { size: 14, className: 'flex-shrink-0 text-muted', 'aria-hidden': true } as const
  if (doc.source_kind === 'url') return <Link2 {...props} />
  if (doc.source_kind === 'interview') return doc.interview_mode === 'voice' ? <Mic {...props} /> : <MessageSquareText {...props} />
  return doc.content_type.startsWith('image/') ? <ImageIcon {...props} /> : <FileText {...props} />
}

function pageHost(url: string | null): string {
  if (url === null || url === '') return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What a source is called: a file's name, a page's title (else its host), or which answers it holds. */
function useSourceName() {
  const { t } = useTranslation('projectDetail')
  return (doc: ProductDoc): string => {
    if (doc.source_kind === 'url') {
      const title = doc.title ?? ''
      const host = pageHost(doc.final_url ?? doc.url)
      if (title !== '') return title
      return host === '' ? doc.filename : host
    }
    if (doc.source_kind === 'interview') {
      return t(doc.interview_mode === 'voice' ? 'product.sources.voiceInterview' : 'product.sources.typedAnswers')
    }
    return doc.filename
  }
}

/** A source still being read: a link is fetched, a file waits for its reader or is read. */
function readingLabelKey(doc: ProductDoc): string {
  if (doc.source_kind === 'url') return 'product.sources.status.fetching'
  return doc.status === 'pending' ? 'product.sources.status.pending' : 'product.sources.status.extracting'
}

function StatusBadge({ doc }: Readonly<{ doc: ProductDoc }>) {
  const { t } = useTranslation('projectDetail')
  if (doc.status === 'ready') {
    return <span className="inline-flex items-center gap-1 text-xs text-ok"><CheckCircle2 size={12} aria-hidden="true" /> {t('product.sources.status.ready')}</span>
  }
  if (doc.status === 'failed') {
    return (
      <Tooltip kind="description" content={doc.error ?? undefined}>
        <span className="inline-flex items-center gap-1 text-xs text-danger"><AlertCircle size={12} aria-hidden="true" /> {t('product.sources.status.failed')}</span>
      </Tooltip>
    )
  }
  const label = readingLabelKey(doc)
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> {t(label)}
    </span>
  )
}

/** The facts of a source's reading, as plain text: its size or host, then what its reading found. */
function useFacts() {
  const { t, i18n } = useTranslation('projectDetail')
  return (doc: ProductDoc): string[] => {
    const facts = [
      doc.source_kind === 'file' && doc.size_bytes > 0 ? formatFileSize(doc.size_bytes, i18n.language) : '',
      doc.source_kind === 'url' ? pageHost(doc.final_url ?? doc.url) : '',
    ]
    if (doc.status === 'ready') {
      facts.push(t('product.sources.chars', { count: doc.extracted_chars }))
      if (doc.pages !== null) facts.push(t('product.sources.pages', { count: doc.pages }))
      if (doc.method === 'model') facts.push(t('product.sources.readByModel'))
    }
    return facts.filter((fact) => fact !== '')
  }
}

/** A coloured fact after the muted ones: "cut" when the text was cut, a failure's reason (its own red, WCAG 1.4.3). */
function MarkedFact({ text, tone, after }: Readonly<{ text: string; tone: 'text-warn' | 'text-danger'; after: boolean }>) {
  return <>{after ? ' · ' : ''}<span className={tone}>{text}</span></>
}

function SourceFacts({ doc }: Readonly<{ doc: ProductDoc }>) {
  const { t } = useTranslation('projectDetail')
  const shown = useFacts()(doc)
  const error = doc.status === 'failed' ? doc.error ?? '' : ''
  return (
    <div className="mt-0.5 text-xs text-muted">
      {shown.join(' · ')}
      {doc.status === 'ready' && doc.truncated ? <MarkedFact text={t('product.sources.cut')} tone="text-warn" after={shown.length > 0} /> : null}
      {error === '' ? null : <MarkedFact text={error} tone="text-danger" after={shown.length > 0} />}
    </div>
  )
}

interface RowActions {
  readonly onRefresh: (docId: string) => void
  readonly onDelete: (docId: string) => void
  /** A Retry or Fetch again is under way: every row's waits for it. */
  readonly refreshing: boolean
}

function SourceActions({ doc, onRefresh, onDelete, refreshing }: Readonly<{ doc: ProductDoc } & RowActions>) {
  const { t } = useTranslation('projectDetail')
  const canRefetch = doc.source_kind === 'url' && !isReading(doc)
  const canRetry = canRetrySource(doc)
  return (
    <div className="ml-2 flex flex-shrink-0 items-center gap-2">
      {canRetry || canRefetch ? (
        <button type="button" className="btn btn-ghost btn-sm" disabled={refreshing} onClick={() => onRefresh(doc.doc_id)}>
          <RefreshCw size={12} aria-hidden="true" />{t(canRetry ? 'product.sources.retry' : 'product.sources.refetch')}
        </button>
      ) : null}
      {/* A 24 x 24 px target at least (WCAG 2.5.8), the icon centred in it. */}
      <button type="button" onClick={() => onDelete(doc.doc_id)}
        className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md text-muted hover:text-danger"
        aria-label={t('product.sources.delete')}>
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

function SourceRow({ doc, actions }: Readonly<{ doc: ProductDoc; actions: RowActions | null }>) {
  const { t } = useTranslation('projectDetail')
  const name = useSourceName()
  return (
    <li className="flex items-start justify-between rounded-md border px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <KindIcon doc={doc} />
          <span className="truncate">{name(doc)}</span>
          <StatusBadge doc={doc} />
        </div>
        <SourceFacts doc={doc} />
        {doc.injection_flag ? (
          <p className="mt-1 flex items-start gap-1 text-xs text-warn">
            <ShieldAlert size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{t('product.sources.injection')}
          </p>
        ) : null}
      </div>
      {actions === null ? null : <SourceActions doc={doc} {...actions} />}
    </li>
  )
}

export default function ProductSourceList({ docs, uploading, loading, actions }: Readonly<{
  docs: readonly ProductDoc[]
  /** Files whose upload is under way (no row of their own yet). */
  uploading: readonly string[]
  loading: boolean
  /** Null for a viewer: the list only. */
  actions: RowActions | null
}>) {
  const { t } = useTranslation('projectDetail')
  if (loading) return <p className="text-xs text-muted">{t('product.sources.loading')}</p>
  return (
    <ul className="space-y-2">
      {uploading.map((filename) => (
        <li key={`uploading-${filename}`} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Loader2 size={14} className="flex-shrink-0 animate-spin text-muted motion-reduce:animate-none" aria-hidden="true" />
          <span className="truncate">{filename}</span>
          <span className="text-xs text-muted">{t('product.sources.status.uploading')}</span>
        </li>
      ))}
      {docs.map((doc) => <SourceRow key={doc.doc_id} doc={doc} actions={actions} />)}
    </ul>
  )
}
