/**
 * @fileoverview A PR/FAQ or PRD on the document canvas, with margin comments in the rail (docs/document-review.md),
 * and the two AI flows the page's toolbar and its Review menu run: "Ask personas to review" (Persona review) and
 * "Revise from comments" (Rewrite from comments). This view owns them (their state, their routes) and reports them to
 * the page (`onActions`, the toolbar's `ReviewActions`); what they say stays here: a review's outcome in the rail (the
 * panel opens for it; a review by the company's personas, the project having none, says so), a revision's failure and
 * its outcome (recommendations, the proposed changes, the applied version) above the canvas (DocumentCanvas/revise).
 * Who a review asks is useReviewPersonas'; with nobody to ask, the review is "Add personas" (`onAddPersonas`: the
 * project's Personas tab). The rail is "Comments | Evidence" when the page gives evidence. Every way of working with
 * AI may ask personas: they review and comment, they never write the document. "Share for review" is the page's
 * toolbar's (DocumentToolbar).
 *
 * The canvas is always the same element, whatever the comments do (loading, failed, refetched),
 * so an unsaved edit is never lost to a remount. Threads are located again on every change of the
 * text: one whose quote is edited away moves to "Not found in this version" at once.
 *
 * @module pages/ProjectDetail/DocumentReviewView
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import CanvasEditor from '../../components/Document/edit/editor/CanvasEditor'
import RailTabs from '../../components/DocumentCanvas/comments/RailTabs'
import { READING_TEXT_CLASS } from '../../components/Document/readingColumn'
import CommentedDocument from '../../components/DocumentComments/CommentedDocument'
import { ReviseFailure } from '../../components/DocumentCanvas/revise/ReviseStatus'
import RevisePanel from '../../components/DocumentCanvas/revise/RevisePanel'
import { reviseBlockedReason, threadsToConsider } from '../../components/DocumentCanvas/revise/reviseChanges'
import { useRevisePass } from '../../components/DocumentCanvas/revise/useRevisePass'
import { useDocumentComments } from './useDocumentComments'
import { useReviewPersonas } from './useReviewPersonas'
import { serverReason } from '../../lib/errors'
import { assignRef } from '../../utils/assignRef'
import type { ReactNode, Ref } from 'react'
import type { TFunction } from 'i18next'
import type { ReviewActions, ReviewPersonas } from '../../components/DocumentCanvas/actions/toolbarItems'
import type { PersonaReviewResult } from '../../api/documentReviewSchema'
import type { ReviseCanvas } from '../../components/DocumentCanvas/revise/useRevisePass'
import type { CanvasEditorHandle } from '../../components/Document/edit/editor/CanvasEditor'
import type { OutlineItem } from '../../components/Document/types'
import type { CommentedDocumentHandle } from '../../components/DocumentComments/CommentedDocument'
import type { CommentActions } from '../../components/DocumentComments/commentTypes'
import type { ProjectDocument } from '../../api/types'

interface DocumentReviewViewProps {
  readonly projectId: string
  readonly document: ProjectDocument
  /** The markdown the canvas shows (stored content when editable, display text when read-only). */
  readonly markdown: string
  /** The project holds personas of its own (else its company's review it, or nobody: useReviewPersonas). */
  readonly hasPersonas: boolean
  /** "Add personas": the project's Personas tab (the page's tab navigation). */
  readonly onAddPersonas: () => void
  readonly editable: boolean
  readonly onChange?: (markdown: string) => void
  readonly handleRef?: Ref<CanvasEditorHandle>
  readonly onOutlineChange?: (items: readonly OutlineItem[]) => void
  /** The evidence cards: given, the rail is two tabs, "Comments | Evidence". */
  readonly evidence?: ReactNode
  /** The page's canvas (useCanvasDocument): "Revise from comments" follows its saves, reloads and selects through it. */
  readonly canvas: ReviseCanvas
  /** The page hid the comments panel (View → Comments); starting a comment shows it again (`onRevealRail`). */
  readonly railHidden?: boolean
  readonly onRevealRail?: () => void
  /** The caret goes to the start of the text once the editor is there (a document just created blank). */
  readonly autoFocus?: boolean
  /** The AI flows as the toolbar runs them (null while there are none to offer: a viewer, comments not loaded). */
  readonly onActions: (actions: ReviewActions | null) => void
}

type ReviewState = { readonly kind: 'idle' } | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly filed: number; readonly personas: number; readonly company: boolean }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * "Ask personas to review": started from the toolbar, or by an applied revision's "Review again". Its outcome is said
 * in the rail, so the panel opens for it (`onDone`).
 */
function usePersonaReview(run: () => Promise<PersonaReviewResult>, onDone: (() => void) | undefined) {
  const { t } = useTranslation('components')
  const [state, setState] = useState<ReviewState>({ kind: 'idle' })
  const start = async () => {
    setState({ kind: 'running' })
    try {
      const result = await run()
      setState({
        kind: 'done', filed: result.filed, personas: result.personas.length, company: result.persona_source === 'company',
      })
    } catch (failure) {
      setState({ kind: 'failed', message: serverReason(failure) ?? t('documentComments.personaReviewFailed') })
    }
    onDone?.()
  }
  return { state, start }
}

/** What a finished review says (else nothing): the comments it filed, and whose personas filed them. */
function doneText(state: ReviewState, t: TFunction<'components'>): string | null {
  if (state.kind !== 'done') return null
  const counts = { count: state.filed, personas: state.personas }
  return state.company
    ? t('documentComments.personaReviewDoneCompany', counts)
    : t('documentComments.personaReviewDone', counts)
}

/**
 * A persona review's outcome, at the top of the rail: how many comments it filed (and, the company's personas having
 * reviewed, that they did: the project has none of its own), or why it failed.
 */
function PersonaReviewStatus({ state }: Readonly<{ state: ReviewState }>) {
  const { t } = useTranslation('components')
  return (
    <>
      <span role="status" className="text-xs text-muted">{doneText(state, t)}</span>
      {state.kind === 'failed' ? <span role="alert" className="text-xs text-danger">{state.message}</span> : null}
    </>
  )
}

interface ActionFacts {
  /** The comments' own rule: their editor may ask personas. */
  readonly canAsk: boolean
  readonly personas: ReviewPersonas
  readonly asking: boolean
  /** A "Revise from comments" pass has run (the review is "again"). */
  readonly again: boolean
  readonly canRevise: boolean
  readonly revising: boolean
  readonly reviseBlocked: string | null
}

/**
 * The flows as the toolbar runs them, one object for as long as what it shows stays the same (`facts`); its starts
 * run the latest of each flow.
 */
function useReviewActions(facts: ActionFacts, startReview: () => void, startRevise: () => void,
  addPersonas: () => void): ReviewActions | null {
  const starts = useRef({ startReview, startRevise, addPersonas })
  useLayoutEffect(() => { starts.current = { startReview, startRevise, addPersonas } })
  const { canAsk, personas, asking, again, canRevise, revising, reviseBlocked } = facts
  return useMemo(() => (canAsk ? {
    review: {
      running: asking, personas, again, start: () => { starts.current.startReview() },
      addPersonas: () => { starts.current.addPersonas() },
    },
    rewrite: canRevise ? { running: revising, reason: reviseBlocked, start: () => { starts.current.startRevise() } } : null,
  } : null), [again, asking, canAsk, canRevise, personas, reviseBlocked, revising])
}

/** Hands the page the flows whenever what they show changes, and nothing once this view is gone. */
function useReportActions(actions: ReviewActions | null, onActions: (actions: ReviewActions | null) => void) {
  useEffect(() => { onActions(actions) }, [actions, onActions])
  useEffect(() => () => { onActions(null) }, [onActions])
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
  projectId, document, markdown, hasPersonas, onAddPersonas, editable, onChange, handleRef, onOutlineChange, evidence,
  canvas, railHidden, onRevealRail, autoFocus, onActions,
}: DocumentReviewViewProps) {
  const { t } = useTranslation('components')
  const { t: tProject } = useTranslation('projectDetail')
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
  const personaReview = usePersonaReview(comments.personaReview, onRevealRail)
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
  const personas = useReviewPersonas(hasPersonas, comments.canEdit)
  const aiActions = useReviewActions({
    canAsk: comments.canEdit, personas, asking: personaReview.state.kind === 'running', again: revise.passed, canRevise,
    revising: revise.pass.kind === 'running',
    reviseBlocked: reviseBlockedReason(threadsToConsider(threads).length, revise.holdsAccepted, tProject),
  }, () => { void personaReview.start() }, () => { void revise.start() }, onAddPersonas)
  useReportActions(aiActions, onActions)
  const toolbar = comments.canEdit ? <PersonaReviewStatus state={personaReview.state} /> : null
  return (
    <CommentedDocument contentRoot={contentRoot} revision={draft}
      threads={threads} viewed={{ documentId: document.document_id }}
      actions={actions} canComment={canComment} commentRef={commenting} renderRail={renderRail}
      railHidden={railHidden} onRevealRail={onRevealRail}
      // Comments are extra: the document itself always shows.
      notice={comments.query.isError ? <p role="alert" className="text-xs text-warn">{t('documentComments.loadFailed')}</p> : null}
      toolbar={toolbar}>
      {canRevise ? <ReviseFailure pass={revise.pass} /> : null}
      {canRevise ? (
        <RevisePanel controls={revise} draft={draft} threads={threads} onShowThread={showThread}
          onReviewAgain={() => void personaReview.start()} canReview={personas !== 'none' && personaReview.state.kind !== 'running'} />
      ) : null}
      <CanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title} onChange={change}
        onOutlineChange={onOutlineChange} onCommentSelection={canComment ? onCommentSelection : undefined}
        handleRef={setHandle} className={READING_TEXT_CLASS} autoFocus={autoFocus} />
    </CommentedDocument>
  )
}
