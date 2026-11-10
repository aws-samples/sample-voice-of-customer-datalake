/**
 * @fileoverview A PR/FAQ or PRD in the project's document pane, with margin comments, "Ask
 * personas to review" and "Share for review" (docs/document-review.md). Every way of working
 * with AI may ask personas: they review and comment, they never write the document.
 *
 * @module pages/ProjectDetail/DocumentReviewView
 */
import { Loader2, Share2, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DocumentComments from '../../components/DocumentComments/DocumentComments'
import ShareForReviewDialog from './ShareForReviewDialog'
import { useDocumentComments } from './useDocumentComments'
import { serverReason } from '../../lib/errors'
import type { ProjectDocument } from '../../api/types'

interface DocumentReviewViewProps {
  readonly projectId: string
  readonly document: ProjectDocument
  /** The markdown as the pane shows it (stored ids already turned into names). */
  readonly markdown: string
  readonly hasPersonas: boolean
}

type ReviewState = { readonly kind: 'idle' } | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly filed: number; readonly personas: number } | { readonly kind: 'failed'; readonly message: string }

function PersonaReviewButton({ run, disabled }: Readonly<{
  run: () => Promise<{ filed: number; personas: readonly unknown[] }>; disabled: boolean
}>) {
  const { t } = useTranslation('components')
  const [state, setState] = useState<ReviewState>({ kind: 'idle' })
  const start = async () => {
    setState({ kind: 'running' })
    try {
      const result = await run()
      setState({ kind: 'done', filed: result.filed, personas: result.personas.length })
    } catch (failure) {
      setState({ kind: 'failed', message: serverReason(failure) ?? t('documentComments.personaReviewFailed') })
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || state.kind === 'running'}
        title={t('documentComments.personaReviewHint')} onClick={() => void start()}>
        {state.kind === 'running' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <UsersRound size={14} aria-hidden />}
        {state.kind === 'running' ? t('documentComments.personaReviewRunning') : t('documentComments.personaReview')}
      </button>
      <span role="status" className="text-xs text-muted">
        {state.kind === 'done' ? t('documentComments.personaReviewDone', { count: state.filed, personas: state.personas }) : null}
      </span>
      {state.kind === 'failed' ? <span role="alert" className="text-xs text-danger">{state.message}</span> : null}
    </span>
  )
}

export default function DocumentReviewView({ projectId, document, markdown, hasPersonas }: DocumentReviewViewProps) {
  const { t } = useTranslation('components')
  const comments = useDocumentComments(projectId, document.document_id)
  const [sharing, setSharing] = useState(false)
  if (comments.query.isError) {
    // Comments are extra: the document itself always shows.
    return (
      <div className="space-y-2">
        <p role="alert" className="text-xs text-warn">{t('documentComments.loadFailed')}</p>
        <div className="md-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown></div>
      </div>
    )
  }
  const toolbar = comments.canEdit ? (
    <span className="inline-flex flex-wrap gap-2">
      <PersonaReviewButton run={comments.personaReview} disabled={!hasPersonas} />
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSharing(true)}>
        <Share2 size={14} aria-hidden />{comments.share === null ? t('reviewShare.open') : t('reviewShare.openActive')}
      </button>
    </span>
  ) : null
  return (
    <>
      <DocumentComments markdown={markdown} threads={comments.query.data?.threads ?? []}
        viewed={{ documentId: document.document_id }}
        actions={comments.actions} canComment={comments.query.isSuccess} toolbar={toolbar} />
      {sharing ? (
        <ShareForReviewDialog share={comments.share} onCreate={comments.createShare} onRevoke={comments.revokeShare}
          onClose={() => setSharing(false)} />
      ) : null}
    </>
  )
}
