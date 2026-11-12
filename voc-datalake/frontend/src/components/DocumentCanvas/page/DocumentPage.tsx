/**
 * @fileoverview The page view of one prose document on the Documents tab (every type but a prototype): a header (the
 * title, editable in place for a research / custom document; its type; the action bar with the save status, Share,
 * Export, History and Delete), the assistant's pending edit of it (AssistantDiffOnCanvas), the coaching notice, then three zones: the outline ("Contents"), the reading column
 * (the canvas, edited in place by an editor; a PR/FAQ or PRD inside its review view, which owns the comments margin)
 * and the evidence rail (the reviews it was written from; for a commented document the review view's second tab).
 * Under the text: what it was made from.
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
 * live note says how to leave it.
 *
 * @module components/DocumentCanvas/page/DocumentPage
 */
import clsx from 'clsx'
import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DocumentCoachingNotice } from '../../AiCoach/HumanDrivenNotice'
import { DocumentTypeBadge } from '../../DocumentTypeBadge/DocumentTypeBadge'
import { useLabelKnownIds } from '../../../hooks/useLabelKnownIds'
import DocumentReviewView from '../../../pages/ProjectDetail/DocumentReviewView'
import { featureRequestIdsOf, linkFeatureRequestCitations } from '../../../pages/ProjectDetail/featureRequestCitations'
import { useDocumentComments } from '../../../pages/ProjectDetail/useDocumentComments'
import AssistantDiffOnCanvas from '../actions/AssistantDiffOnCanvas'
import { READING_COLUMN_CLASS, READING_TEXT_CLASS } from '../comments/readingColumn'
import DocumentActionsBar from '../actions/DocumentActionsBar'
import { useCanvasDocument } from '../actions/useCanvasDocument'
import CanvasEditor from '../editor/CanvasEditor'
import DocumentProvenance from './DocumentProvenance'
import EvidenceCards from './EvidenceCards'
import Outline from './Outline'
import { useFocusView } from './useFocusView'
import type { FocusViewControls } from './useFocusView'
import type { KeyboardEvent, RefObject } from 'react'
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
}

type BarProps = Readonly<{
  project: Project; document: ProjectDocument; canEdit: boolean; state: CanvasDocumentState
  onDeleteDoc: () => void; isDeleting: boolean; focus: FocusViewControls
  focusButtonRef: RefObject<HTMLButtonElement | null>
}>

/**
 * The bar of a PR/FAQ or PRD: its review link and the threads its PDF may include are the comments' (the same query
 * DocumentReviewView reads), offered once they have loaded.
 */
function CommentableActionsBar(props: BarProps) {
  const comments = useDocumentComments(props.project.project_id, props.document.document_id)
  const { query } = comments
  return <DocumentActionsBar {...props} share={query.isSuccess ? comments : null} threads={query.isSuccess ? query.data.threads : null} />
}

function DocumentTitle({ document, state, editable }: Readonly<{
  document: ProjectDocument; state: CanvasDocumentState; editable: boolean
}>) {
  const { t } = useTranslation('projectDetail')
  const inputId = useId()
  if (!editable) {
    return <h2 className="text-lg sm:text-xl font-bold tracking-tight text-text-strong min-w-0 break-words">{document.title}</h2>
  }
  // Enter leaves the title for the text, as in the editors people know; the title saves with the content.
  const toText = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    state.handleRef.current?.focus()
  }
  return (
    <>
      <label htmlFor={inputId} className="sr-only">{t('canvas.page.titleLabel')}</label>
      <input id={inputId} type="text" value={state.title} onChange={(event) => state.setTitle(event.target.value)}
        onKeyDown={toText} autoComplete="off" spellCheck
        className="block w-full min-w-0 -mx-1 px-1 rounded-md border border-transparent bg-transparent text-lg sm:text-xl font-bold tracking-tight text-text-strong hover:border-border focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
    </>
  )
}

/**
 * The element the caret is in (the selection's focus: its text's element, or the element itself on an empty line),
 * measured rather than the caret's own box, which is empty there. On an empty document it is the canvas itself.
 */
function caretElement(): Element | null {
  const node = window.getSelection()?.focusNode ?? null
  return node instanceof Element ? node : (node?.parentElement ?? null)
}

const onScreen = (element: Element): boolean => {
  const box = element.getBoundingClientRect()
  return box.bottom > 0 && box.top < window.innerHeight
}

/** Scrolls `pane` to its top (its header in view); a caret that was on screen and would leave it is brought back. */
function showHeaderKeepingCaret(pane: HTMLElement | null): void {
  if (pane === null) return
  const caret = caretElement()
  const caretWasShown = caret !== null && onScreen(caret)
  pane.scrollIntoView({ block: 'start' })
  if (caretWasShown && !onScreen(caret)) caret.scrollIntoView({ block: 'nearest' })
}

export default function DocumentPage({
  project, document, documents, canEdit, onSelectDoc, onDeleteDoc, isDeleting,
}: DocumentPageProps) {
  // Stored ids inside generated text (`technical_support`, `proj_…`) read as their names.
  const labelIds = useLabelKnownIds()
  const state = useCanvasDocument({ project, document, onSelectDoc })
  const [outline, setOutline] = useState<readonly OutlineItem[]>([])
  const commentable = COMMENTABLE_TYPES.has(document.document_type)
  // An editor of the project on a document edited here (a decision is edited in its tab: it reads as a viewer's).
  const { editable } = state
  // Editable: the stored version the canvas is on, not the selected copy (a newer one, refetched while the canvas
  // holds changes, must not reach the editor: its save meets it as a conflict).
  const markdown = editable ? state.content : linkFeatureRequestCitations(labelIds(document.content))
  const hasOutline = outline.length > 0
  const evidence = (titled: boolean) => (
    <EvidenceCards feedbackIds={document.input_feedback_ids} featureRequestIds={featureRequestIdsOf(document)}
      erasedEvidence={document.erased_evidence} titled={titled} />
  )
  const { handleRef } = state
  const paneRef = useRef<HTMLDivElement>(null)
  // The focus view drops the chrome above the page, and focusing the canvas (a tall editable box) scrolls its top to
  // the window's: a phone opened it scrolled past the header (the title, Save, the way out). Once the editor has
  // taken focus (its next frame), the page starts at its top, unless that would hide the caret.
  const focusCanvas = useCallback(() => {
    handleRef.current?.focus()
    requestAnimationFrame(() => { showHeaderKeepingCaret(paneRef.current) })
  }, [handleRef])
  const focusButtonRef = useRef<HTMLButtonElement>(null)
  const focus = useFocusView(focusCanvas, focusButtonRef)
  const { t } = useTranslation('projectDetail')
  const barProps: BarProps = { project, document, canEdit, state, onDeleteDoc, isDeleting, focus, focusButtonRef }
  return (
    // Unsaved, a phone pins the Save bar over the page's foot: the padding keeps it off the last lines. In focus view
    // the page is the window (the shell has stepped aside): no card edge, its full height.
    <div ref={paneRef} data-testid="document-detail-pane" data-focus-view={focus.active ? '' : undefined}
      className={clsx('bg-card p-4 sm:p-6 min-w-0',
        focus.active ? 'min-h-screen lg:px-10' : 'rounded-xl border lg:min-h-[500px]', state.dirty && 'max-sm:pb-20')}>
      <p aria-live="polite" className="sr-only" data-testid="canvas-focus-note">{focus.active ? t('canvas.focus.announce') : ''}</p>
      {/* The title, its type, then the bar as one row: its save status (the version and when) on the left, the
          actions on the right, wrapping on a phone. */}
      <header className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1 basis-64">
            <DocumentTitle document={document} state={state} editable={editable && state.titleEditable} />
          </div>
          <DocumentTypeBadge type={document.document_type} />
        </div>
        {commentable ? <CommentableActionsBar {...barProps} /> : <DocumentActionsBar {...barProps} share={null} threads={null} />}
      </header>
      <AssistantDiffOnCanvas projectId={project.project_id} document={document} state={state} />
      {canEdit ? (
        <DocumentCoachingNotice documentType={document.document_type} title={document.title}
          hasContent={document.content.trim() !== ''} />
      ) : null}
      <div className={clsx(hasOutline && 'lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6')}>
        <Outline items={outline} onNavigate={(id) => state.handleRef.current?.scrollToHeading(id)} className="mb-4 lg:mb-0" />
        <div className="min-w-0">
          {commentable ? (
            <DocumentReviewView projectId={project.project_id} document={document} markdown={markdown}
              hasPersonas={project.persona_count > 0} editable={editable} onChange={state.onChange}
              handleRef={state.handleRef} onOutlineChange={setOutline} evidence={evidence(false)} canvas={state} />
          ) : (
            <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_16rem] xl:gap-8">
              <article className={READING_COLUMN_CLASS}>
                <CanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title}
                  onChange={state.onChange} onOutlineChange={setOutline} handleRef={state.handleRef}
                  className={READING_TEXT_CLASS} />
              </article>
              <div className="mt-8 xl:mt-0 xl:sticky xl:top-4 xl:self-start">{evidence(true)}</div>
            </div>
          )}
          {/* The versions are the bar's History. */}
          <div className="mt-6 space-y-2">
            <DocumentProvenance document={document} documents={documents} onSelectDoc={onSelectDoc} />
          </div>
        </div>
      </div>
    </div>
  )
}
