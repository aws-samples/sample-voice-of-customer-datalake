/**
 * @fileoverview The page view of one prose document on the Documents tab (every type but a prototype), laid out as
 * an editing canvas's wiki page: at the top its menu bar (Document · Edit · Format · Insert · View), the save status,
 * the comments button, Save and Full screen (DocumentActionsBar; sticky from `lg`); then on a wide centred sheet the
 * large title (renamed in place for a research / custom document: InlineTitle) with its details as chips (who wrote
 * it, when it was edited, how long it reads, its type: DocumentMeta), the assistant's pending edit of it
 * (AssistantDiffOnCanvas), the coaching notice, then three zones: the outline ("Contents"), the reading column (the
 * canvas, edited in place by an editor; a PR/FAQ or PRD inside its review view, which owns the comments panel) and
 * the evidence rail (the reviews it was written from; for a commented document the comments panel's second tab).
 * Under the text: what it was made from. View hides the comments panel or the outline, or lets the text take the
 * full width (usePageView).
 *
 * A document just created blank opens once on its title, selected (a custom one: the name is typed over) or with the
 * caret in its text (a PRD / PR/FAQ, named before it was filed): `openOn`.
 *
 * The editable canvas shows the STORED content, so a save never bakes display labels into it; the read-only canvas
 * (viewers, decisions) shows the display text (known ids as names, `[FR:id]` citations linked), as before.
 * Lazy-loaded by DocumentsTab, so the editor's bundle loads only there.
 *
 * Widths: from `xl` the evidence rail sits right of the text, below it otherwise; from `lg` the outline is a sticky
 * column left of it, a "Contents" disclosure above it otherwise. The page scrolls as one with the app.
 *
 * Focus view ("Full screen", `?view=focus`, useFocusView): the page takes the whole window, the canvas and its rail
 * side by side (one column on a phone, the rail under the text); the app's chrome steps aside (focusView). A polite
 * live note says how to leave it. Entering it brings the page's header to the top of the window, then focuses the
 * canvas without scrolling.
 *
 * @module components/DocumentCanvas/page/DocumentPage
 */
import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DocumentCoachingNotice } from '../../AiCoach/HumanDrivenNotice'
import { useLabelKnownIds } from '../../../hooks/useLabelKnownIds'
import DocumentReviewView from '../../../pages/ProjectDetail/DocumentReviewView'
import { featureRequestIdsOf, linkFeatureRequestCitations } from '../../../pages/ProjectDetail/featureRequestCitations'
import { useDocumentComments } from '../../../pages/ProjectDetail/useDocumentComments'
import AssistantDiffOnCanvas from '../actions/AssistantDiffOnCanvas'
import { READING_COLUMN_CLASS, READING_TEXT_CLASS } from '../comments/readingColumn'
import DocumentActionsBar from '../actions/DocumentActionsBar'
import { useCanvasDocument } from '../actions/useCanvasDocument'
import CanvasEditor from '../editor/CanvasEditor'
import DocumentMeta from './DocumentMeta'
import DocumentProvenance from './DocumentProvenance'
import EvidenceCards from './EvidenceCards'
import InlineTitle from './InlineTitle'
import Outline from './Outline'
import { PAGE_SHEET_CLASS, PAGE_SHEET_WIDE_CLASS } from './pageStyles'
import { useFocusView } from './useFocusView'
import { usePageView, type PageView } from './usePageView'
import type { FocusViewControls } from './useFocusView'
import type { RefObject } from 'react'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'
import type { CanvasDocument as CanvasDocumentState } from '../actions/useCanvasDocument'
import type { OutlineItem } from '../editor/CanvasEditor'

/** Document types shown with margin comments, persona review and a review link (docs/document-review.md). */
const COMMENTABLE_TYPES: ReadonlySet<string> = new Set(['prfaq', 'prd'])

interface DocumentPageProps {
  readonly project: Project
  readonly document: ProjectDocument
  readonly documents: ProjectDocument[]
  /** `canEditProject(project)`: viewers read, comment where the server lets them, and export. */
  readonly canEdit: boolean
  readonly onSelectDoc: (doc: ProjectDocument) => void
  readonly onDeleteDoc: () => void
  readonly isDeleting: boolean
  /** A document just created blank: where its page puts the focus once (its title, selected, or its text). */
  readonly openOn?: 'title' | 'text'
  /** The page took `openOn`: a later visit opens as any other. */
  readonly onOpened?: () => void
}

type BarProps = Readonly<{
  project: Project; document: ProjectDocument; canEdit: boolean; state: CanvasDocumentState
  onDeleteDoc: () => void; isDeleting: boolean; focus: FocusViewControls
  focusButtonRef: RefObject<HTMLButtonElement | null>; view: PageView; onRename: () => void
}>

/**
 * The bar of a PR/FAQ or PRD: its review link, the threads its PDF may include and the comments button's count are
 * the comments' (the same query DocumentReviewView reads), offered once they have loaded.
 */
function CommentableActionsBar(props: BarProps) {
  const comments = useDocumentComments(props.project.project_id, props.document.document_id)
  const { query } = comments
  const threads = query.isSuccess ? query.data.threads : null
  return (
    <DocumentActionsBar {...props} share={query.isSuccess ? comments : null} threads={threads}
      openThreads={threads?.filter((thread) => thread.status === 'open').length} />
  )
}

/** Where the page puts its focus as it opens (`openOn`), taken once; its owner is told it was taken. */
function useOpening(openOn: DocumentPageProps['openOn'], onOpened: (() => void) | undefined) {
  // Taken when the page opens: the page's later renders (the fresh mark cleared) keep it.
  const [opening] = useState(openOn)
  useEffect(() => {
    if (opening !== undefined) onOpened?.()
  }, [onOpened, opening])
  return opening
}

/** The page's three zones under its header: the outline, the reading column (with the comments panel or the
 * evidence beside it) and, under the text, what it was made from. */
function PageText({ project, document, documents, state, markdown, view, autoFocus, onSelectDoc }: Readonly<{
  project: Project; document: ProjectDocument; documents: ProjectDocument[]; state: CanvasDocumentState
  markdown: string; view: PageView; autoFocus: boolean; onSelectDoc: (doc: ProjectDocument) => void
}>) {
  const [outline, setOutline] = useState<readonly OutlineItem[]>([])
  const commentable = view.comments !== undefined
  const { editable } = state
  const evidence = (titled: boolean) => (
    <EvidenceCards feedbackIds={document.input_feedback_ids} featureRequestIds={featureRequestIdsOf(document)}
      erasedEvidence={document.erased_evidence} titled={titled} />
  )
  return (
    <div className={clsx(outline.length > 0 && view.outline.on && 'lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6')}>
      {view.outline.on ? (
        <Outline items={outline} onNavigate={(id) => state.handleRef.current?.scrollToHeading(id)} className="mb-4 lg:mb-0" />
      ) : null}
      <div className="min-w-0">
        {commentable ? (
          <DocumentReviewView projectId={project.project_id} document={document} markdown={markdown}
            hasPersonas={project.persona_count > 0} editable={editable} onChange={state.onChange}
            handleRef={state.handleRef} onOutlineChange={setOutline} evidence={evidence(false)} canvas={state}
            railHidden={!view.comments.on} onRevealRail={view.revealComments} autoFocus={autoFocus} />
        ) : (
          <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_16rem] xl:gap-8">
            <article className={READING_COLUMN_CLASS} data-reading-column="">
              <CanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title}
                onChange={state.onChange} onOutlineChange={setOutline} handleRef={state.handleRef}
                className={READING_TEXT_CLASS} autoFocus={autoFocus} />
            </article>
            <div className="mt-8 xl:mt-0 xl:sticky xl:top-20 xl:self-start">{evidence(true)}</div>
          </div>
        )}
        {/* The versions are Document → History. */}
        <div className="mt-6 space-y-2">
          <DocumentProvenance document={document} documents={documents} onSelectDoc={onSelectDoc} />
        </div>
      </div>
    </div>
  )
}

/** The large title (renamed in place where it may be) and its details. */
function PageHeading({ project, document, state, markdown, titleRef, selectOnOpen }: Readonly<{
  project: Project; document: ProjectDocument; state: CanvasDocumentState; markdown: string
  titleRef: RefObject<HTMLInputElement | null>; selectOnOpen: boolean
}>) {
  const renamable = state.editable && state.titleEditable
  return (
    <>
      <InlineTitle title={renamable ? state.title : document.title} editable={renamable} onRename={state.rename}
        inputRef={titleRef} onDone={() => state.handleRef.current?.focus()} selectOnOpen={selectOnOpen} />
      <DocumentMeta project={project} document={document} text={state.editable ? state.draft : markdown} />
    </>
  )
}

export default function DocumentPage({
  project, document, documents, canEdit, onSelectDoc, onDeleteDoc, isDeleting, openOn, onOpened,
}: DocumentPageProps) {
  // Stored ids inside generated text (`technical_support`, `proj_…`) read as their names.
  const labelIds = useLabelKnownIds()
  const state = useCanvasDocument({ project, document, onSelectDoc })
  const commentable = COMMENTABLE_TYPES.has(document.document_type)
  const view = usePageView(commentable)
  const opening = useOpening(openOn, onOpened)
  const titleRef = useRef<HTMLInputElement>(null)
  // An editor of the project on a document edited here (a decision is edited in its tab: it reads as a viewer's).
  const { editable } = state
  // Editable: the stored version the canvas is on, not the selected copy (a newer one, refetched while the canvas
  // holds changes, must not reach the editor: its save meets it as a conflict).
  const markdown = editable ? state.content : linkFeatureRequestCitations(labelIds(document.content))
  const { handleRef } = state
  const headerRef = useRef<HTMLElement>(null)
  const enterFrame = useRef(0)
  useEffect(() => () => { cancelAnimationFrame(enterFrame.current) }, [])
  // The focus view drops the chrome above the page, and the app's scroll area, shorter by it, loses some of its
  // scroll: a page read from further down would open with its header (the title, Save, the way out) above the
  // window. Once the chrome is gone (the next frame), the header is brought to the top of the window; then the canvas
  // takes focus without scrolling, a phone's browser too (a tall editable box, scrolled to, put a phone past the
  // header), so the caret does not drag the page away from it.
  const focusCanvas = useCallback(() => {
    cancelAnimationFrame(enterFrame.current)
    enterFrame.current = requestAnimationFrame(() => {
      headerRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })
      handleRef.current?.focus({ scroll: false })
    })
  }, [handleRef])
  const focusButtonRef = useRef<HTMLButtonElement>(null)
  const focus = useFocusView(focusCanvas, focusButtonRef)
  const { t } = useTranslation('projectDetail')
  const renameTitle = () => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }
  const barProps: BarProps = {
    project, document, canEdit, state, onDeleteDoc, isDeleting, focus, focusButtonRef, view, onRename: renameTitle,
  }
  return (
    // Unsaved, a phone pins the Save bar over the page's foot: the padding keeps it off the last lines. In focus view
    // the page is the window (the shell has stepped aside): no card edge, its full height.
    <div data-testid="document-detail-pane" data-focus-view={focus.active ? '' : undefined}
      className={clsx('bg-card min-w-0',
        focus.active ? 'min-h-screen' : 'rounded-xl border lg:min-h-[500px]', state.dirty && 'max-sm:pb-20')}>
      <p aria-live="polite" className="sr-only" data-testid="canvas-focus-note">{focus.active ? t('canvas.focus.announce') : ''}</p>
      {/* The canvas's menu bar and actions: one row (wrapping on a phone), kept in reach while the text scrolls (from
          lg). The focus view brings it to the top of the window and keeps it there at every width: its way out is in
          it, and the page reflowing as the app's chrome steps aside must not scroll it away. */}
      <header ref={headerRef} className={clsx('border-b border-border bg-card px-3 py-1.5 sm:px-4',
        focus.active ? 'sticky top-0 z-20' : 'rounded-t-xl lg:sticky lg:top-0 lg:z-20')}>
        {commentable ? <CommentableActionsBar {...barProps} /> : <DocumentActionsBar {...barProps} share={null} threads={null} />}
      </header>
      <div className={clsx(view.fullWidth.on ? PAGE_SHEET_WIDE_CLASS : PAGE_SHEET_CLASS,
        view.fullWidth.on && '[&_[data-reading-column]]:max-w-none')}>
        <div className="mb-6">
          <PageHeading project={project} document={document} state={state} markdown={markdown} titleRef={titleRef}
            selectOnOpen={opening === 'title'} />
        </div>
        <AssistantDiffOnCanvas projectId={project.project_id} document={document} state={state} />
        {canEdit ? (
          <DocumentCoachingNotice documentType={document.document_type} title={document.title}
            hasContent={document.content.trim() !== ''} />
        ) : null}
        <PageText project={project} document={document} documents={documents} state={state} markdown={markdown}
          view={view} autoFocus={opening === 'text'} onSelectDoc={onSelectDoc} />
      </div>
    </div>
  )
}
