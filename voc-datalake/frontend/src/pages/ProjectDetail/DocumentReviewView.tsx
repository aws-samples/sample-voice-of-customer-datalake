/**
 * @fileoverview A PR/FAQ or PRD on the document canvas, with margin comments and "Ask personas
 * to review" in the rail (docs/document-review.md). The rail is "Comments | Evidence" when the page
 * gives evidence. Every way of working with AI may ask personas: they review and comment, they
 * never write the document. "Share for review" is the page's action bar's (DocumentActionsBar).
 *
 * The canvas is always the same element, whatever the comments do (loading, failed, refetched),
 * so an unsaved edit is never lost to a remount. Threads are located again on every change of the
 * text: one whose quote is edited away moves to "Not found in this version" at once.
 *
 * @module pages/ProjectDetail/DocumentReviewView
 */
import { Loader2, UsersRound } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import CanvasEditor from '../../components/DocumentCanvas/editor/CanvasEditor'
import RailTabs from '../../components/DocumentCanvas/comments/RailTabs'
import { READING_TEXT_CLASS } from '../../components/DocumentCanvas/comments/readingColumn'
import CommentedDocument from '../../components/DocumentComments/CommentedDocument'
import { useDocumentComments } from './useDocumentComments'
import { serverReason } from '../../lib/errors'
import type { ReactNode, Ref } from 'react'
import type { CanvasEditorHandle, OutlineItem } from '../../components/DocumentCanvas/editor/CanvasEditor'
import type { CommentedDocumentHandle } from '../../components/DocumentComments/CommentedDocument'
import type { CommentActions } from '../../components/DocumentComments/commentTypes'
import type { ProjectDocument } from '../../api/types'

interface DocumentReviewViewProps {
  readonly projectId: string
  readonly document: ProjectDocument
  /** The markdown the canvas shows (stored content when editable, display text when read-only). */
  readonly markdown: string
  readonly hasPersonas: boolean
  readonly editable: boolean
  readonly onChange?: (markdown: string) => void
  readonly handleRef?: Ref<CanvasEditorHandle>
  readonly onOutlineChange?: (items: readonly OutlineItem[]) => void
  /** The evidence cards: given, the rail is two tabs, "Comments | Evidence". */
  readonly evidence?: ReactNode
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

/** Hands the editor's handle to this view and to the page's ref alike. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref !== null && ref !== undefined) ref.current = value
}

export default function DocumentReviewView({
  projectId, document, markdown, hasPersonas, editable, onChange, handleRef, onOutlineChange, evidence,
}: DocumentReviewViewProps) {
  const { t } = useTranslation('components')
  const comments = useDocumentComments(projectId, document.document_id)
  const editor = useRef<CanvasEditorHandle | null>(null)
  const commenting = useRef<CommentedDocumentHandle>(null)
  // The text as edited so far: threads follow it (`revision`).
  const [edited, setEdited] = useState<string | null>(null)
  const setHandle = useCallback((handle: CanvasEditorHandle | null) => {
    editor.current = handle
    assignRef(handleRef, handle)
  }, [handleRef])
  const contentRoot = useCallback(() => editor.current?.root() ?? null, [])
  const change = useCallback((next: string) => {
    setEdited(next)
    onChange?.(next)
  }, [onChange])
  const canComment = comments.query.isSuccess
  // A posted comment has consumed the selection: collapse it on the canvas, so its floating bar closes.
  const { actions: commentActions } = comments
  const actions = useMemo<CommentActions>(() => ({
    ...commentActions,
    create: async (comment) => {
      const created = await commentActions.create(comment)
      editor.current?.clearSelection()
      return created
    },
  }), [commentActions])
  const onCommentSelection = useCallback(() => {
    commenting.current?.commentOnSelection()
  }, [])
  const renderRail = useCallback((rail: ReactNode) => (
    evidence === undefined ? rail : <RailTabs comments={rail} evidence={evidence} />
  ), [evidence])
  return (
    <CommentedDocument contentRoot={contentRoot} revision={edited ?? markdown}
      threads={comments.query.data?.threads ?? []} viewed={{ documentId: document.document_id }}
      actions={actions} canComment={canComment} commentRef={commenting} renderRail={renderRail}
      // Comments are extra: the document itself always shows.
      notice={comments.query.isError ? <p role="alert" className="text-xs text-warn">{t('documentComments.loadFailed')}</p> : null}
      toolbar={comments.canEdit ? <PersonaReviewButton run={comments.personaReview} disabled={!hasPersonas} /> : null}>
      <CanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title} onChange={change}
        onOutlineChange={onOutlineChange} onCommentSelection={canComment ? onCommentSelection : undefined}
        handleRef={setHandle} className={READING_TEXT_CLASS} />
    </CommentedDocument>
  )
}
