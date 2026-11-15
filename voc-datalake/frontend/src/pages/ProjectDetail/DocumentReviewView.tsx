/**
 * @fileoverview A PR/FAQ or PRD on the document canvas, with margin comments and "Ask personas
 * to review" and "Revise from comments" in the rail (docs/document-review.md). The rail is "Comments |
 * Evidence" when the page gives evidence. Every way of working with AI may ask personas: they review
 * and comment, they never write the document. A revision's outcome (recommendations, the proposed
 * changes, the applied version) shows above the canvas (DocumentCanvas/revise); after any pass the
 * rail asks personas "to review again". "Share for review" is the page's action bar's (DocumentActionsBar).
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
import ReviseButton from '../../components/DocumentCanvas/revise/ReviseButton'
import RevisePanel from '../../components/DocumentCanvas/revise/RevisePanel'
import { threadsToConsider } from '../../components/DocumentCanvas/revise/reviseChanges'
import { useRevisePass } from '../../components/DocumentCanvas/revise/useRevisePass'
import { useDocumentComments } from './useDocumentComments'
import { serverReason } from '../../lib/errors'
import type { ReactNode, Ref } from 'react'
import type { ReviseCanvas } from '../../components/DocumentCanvas/revise/useRevisePass'
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
  /** The page's canvas (useCanvasDocument): "Revise from comments" follows its saves, reloads and selects through it. */
  readonly canvas: ReviseCanvas
}

type ReviewState = { readonly kind: 'idle' } | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly filed: number; readonly personas: number } | { readonly kind: 'failed'; readonly message: string }

/** "Ask personas to review": started by its button, or by an applied revision's "Review again". */
function usePersonaReview(run: () => Promise<{ filed: number; personas: readonly unknown[] }>) {
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
  return { state, start }
}

function PersonaReviewButton({ review: { state, start }, disabled, again }: Readonly<{
  review: ReturnType<typeof usePersonaReview>; disabled: boolean
  /** After a "Revise from comments" pass: "Ask personas to review again". */
  again: boolean
}>) {
  const { t } = useTranslation('components')
  const idleLabel = again ? t('projectDetail:canvas.revise.reviewAgain') : t('documentComments.personaReview')
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || state.kind === 'running'}
        title={t('documentComments.personaReviewHint')} onClick={() => void start()}>
        {state.kind === 'running' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <UsersRound size={14} aria-hidden />}
        {state.kind === 'running' ? t('documentComments.personaReviewRunning') : idleLabel}
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

/**
 * The text as edited so far (null: none since the canvas's text): threads and the revision follow it. A draft replaced
 * without a save (Discard, Load the latest: a new generation of the page's canvas) reached the editor without an
 * onChange: the edits seen so far are gone, the text is the canvas's again.
 */
function useEditedText({ generation }: ReviseCanvas, onChange: ((markdown: string) => void) | undefined) {
  const [edited, setEdited] = useState<string | null>(null)
  const [seenGeneration, setSeenGeneration] = useState(generation)
  if (generation !== seenGeneration) {
    setSeenGeneration(generation)
    setEdited(null)
  }
  const change = useCallback((next: string) => {
    setEdited(next)
    onChange?.(next)
  }, [onChange])
  return { edited, change }
}

export default function DocumentReviewView({
  projectId, document, markdown, hasPersonas, editable, onChange, handleRef, onOutlineChange, evidence, canvas,
}: DocumentReviewViewProps) {
  const { t } = useTranslation('components')
  const comments = useDocumentComments(projectId, document.document_id)
  const editor = useRef<CanvasEditorHandle | null>(null)
  const commenting = useRef<CommentedDocumentHandle>(null)
  const { edited, change } = useEditedText(canvas, onChange)
  const setHandle = useCallback((handle: CanvasEditorHandle | null) => {
    editor.current = handle
    assignRef(handleRef, handle)
  }, [handleRef])
  const contentRoot = useCallback(() => editor.current?.root() ?? null, [])
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
  const threads = comments.query.data?.threads ?? []
  const draft = edited ?? markdown
  const personaReview = usePersonaReview(comments.personaReview)
  const revise = useRevisePass({
    projectId, run: comments.revise, markAddressed: comments.markAddressed, clearAddressed: comments.clearAddressed, canvas,
    draft: () => editor.current?.getMarkdown() ?? draft,
    // Into the editor (which fires no onChange for it) and the page's draft: the page is dirty, Save makes the version.
    putDraft: (next) => {
      editor.current?.setMarkdown(next)
      change(next)
    },
  })
  const showThread = useCallback((threadId: string) => { commenting.current?.showThread(threadId) }, [])
  // Revising writes the canvas's draft: an editor of the project on its editable canvas.
  const canRevise = comments.canEdit && editable
  const toolbar = comments.canEdit ? (
    <>
      <PersonaReviewButton review={personaReview} disabled={!hasPersonas} again={revise.passed} />
      {canRevise ? <ReviseButton pass={revise.pass} available={threadsToConsider(threads).length}
        unsaved={revise.holdsAccepted} onStart={() => void revise.start()} /> : null}
    </>
  ) : null
  return (
    <CommentedDocument contentRoot={contentRoot} revision={draft}
      threads={threads} viewed={{ documentId: document.document_id }}
      actions={actions} canComment={canComment} commentRef={commenting} renderRail={renderRail}
      // Comments are extra: the document itself always shows.
      notice={comments.query.isError ? <p role="alert" className="text-xs text-warn">{t('documentComments.loadFailed')}</p> : null}
      toolbar={toolbar}>
      {canRevise ? (
        <RevisePanel controls={revise} draft={draft} threads={threads} onShowThread={showThread}
          onReviewAgain={() => void personaReview.start()} canReview={hasPersonas && personaReview.state.kind !== 'running'} />
      ) : null}
      <CanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title} onChange={change}
        onOutlineChange={onOutlineChange} onCommentSelection={canComment ? onCommentSelection : undefined}
        handleRef={setHandle} className={READING_TEXT_CLASS} />
    </CommentedDocument>
  )
}
