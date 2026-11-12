/**
 * The page's composition: which canvas a document gets (its own, or inside the review view for a PR/FAQ / PRD),
 * editable or read-only, which content it shows (stored vs display text), the title rule, where the evidence goes,
 * the action bar's seam and what sits around the canvas. The editor, the review view, the save hook, the bar and the
 * assistant's pending edit are other tracks' and mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient as render } from '@test/query-client'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { VIEWER_ACCESS } from '../../../pages/ProjectDetail/projectAccess-fixtures'
import DocumentPage from './DocumentPage'
import type { ReactNode } from 'react'
import type { ProjectDocument } from '../../../api/types'
import type { OutlineItem } from '../editor/CanvasEditor'

const handle = { root: vi.fn(), getMarkdown: vi.fn(), setMarkdown: vi.fn(), scrollToHeading: vi.fn(), focus: vi.fn(), clearSelection: vi.fn() }
const canvasState = {
  content: '', title: 'Notes', setTitle: vi.fn(), onChange: vi.fn(), dirty: false, saving: false,
  save: vi.fn(), discard: vi.fn(), conflict: null, titleEditable: true, handleRef: { current: handle },
  editable: true, selectDoc: vi.fn(), reloadLatest: vi.fn(), guardDialog: null,
}
/** The headings the mocked canvas reports on load. */
const outline: OutlineItem[] = []

vi.mock('../actions/useCanvasDocument', () => ({ useCanvasDocument: vi.fn(() => canvasState) }))
vi.mock('../actions/DocumentActionsBar', () => ({
  default: ({ share, canEdit }: { share: unknown; canEdit: boolean }) => (
    <div data-testid="actions-bar" data-share={share === null ? 'none' : 'comments'} data-can-edit={String(canEdit)} />
  ),
}))
vi.mock('../editor/CanvasEditor', () => ({
  default: function MockCanvasEditor({ markdown, editable, ariaLabel, onOutlineChange }: {
    markdown: string; editable: boolean; ariaLabel: string; onOutlineChange?: (items: readonly OutlineItem[]) => void
  }) {
    useEffect(() => onOutlineChange?.([...outline]), [onOutlineChange])
    return <div data-testid="canvas" data-editable={String(editable)} aria-label={ariaLabel}>{markdown}</div>
  },
}))
vi.mock('../../../pages/ProjectDetail/DocumentReviewView', () => ({
  default: ({ markdown, editable, evidence, handleRef }: {
    markdown: string; editable: boolean; evidence?: ReactNode; handleRef?: unknown
  }) => (
    <div data-testid="review-view" data-editable={String(editable)} data-handle={String(handleRef === canvasState.handleRef)}>
      <div data-testid="review-markdown">{markdown}</div>
      {evidence}
    </div>
  ),
}))
vi.mock('../actions/AssistantDiffOnCanvas', () => ({
  default: ({ projectId, document, state }: { projectId: string; document: ProjectDocument; state: unknown }) => (
    <div data-testid="assistant-diff" data-project={projectId} data-document={document.document_id}
      data-state={String(state === canvasState)} />
  ),
}))
// Its own rule (AI mode, gated types) is HumanDrivenNotice's spec; here only where it sits.
vi.mock('../../AiCoach/HumanDrivenNotice', () => ({
  DocumentCoachingNotice: () => <div data-testid="document-coaching-notice" />,
}))
const comments = { query: { isSuccess: true }, share: null, createShare: vi.fn(), revokeShare: vi.fn() }
vi.mock('../../../pages/ProjectDetail/useDocumentComments', () => ({ useDocumentComments: vi.fn(() => comments) }))

const editor = makeProject({ project_id: 'proj-1', name: 'P', description: '' })
const viewer = { ...editor, access: VIEWER_ACCESS }
const STORED = 'Plan [FR:req123]'
const LINKED = '/feature-requests?request=req123'

function doc(overrides: Partial<ProjectDocument>): ProjectDocument {
  return {
    document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: STORED,
    created_at: '2026-01-05T00:00:00Z', ...overrides,
  }
}

/** `onCanvas`: the stored text the canvas is on (its baseline); the selected document's own by default. */
function renderPage(document: ProjectDocument, canEdit = true, onCanvas = document.content) {
  // The canvas's own rule (useCanvasDocument): a viewer's canvas is never editable.
  if (!canEdit) canvasState.editable = false
  canvasState.content = onCanvas
  return render(
    <MemoryRouter>
      <DocumentPage project={canEdit ? editor : viewer} document={document} documents={[document]} canEdit={canEdit}
        onSelectDoc={vi.fn()} onDeleteDoc={vi.fn()} isDeleting={false} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  outline.splice(0)
  canvasState.titleEditable = true
  canvasState.editable = true
  canvasState.dirty = false
  comments.query.isSuccess = true
  vi.clearAllMocks()
})

describe('DocumentPage: a document with no comments (research, custom)', () => {
  it('is edited in place: the editable canvas on the stored content', () => {
    renderPage(doc({}))
    const canvas = screen.getByTestId('canvas')
    expect(canvas).toHaveAttribute('data-editable', 'true')
    // Stored, not display text: a save must never bake the citation links into the content.
    expect(canvas).toHaveTextContent(STORED)
    expect(canvas.textContent).not.toContain(LINKED)
  })

  it('gives the editable canvas the version it is on, not a newer copy the page selected meanwhile', () => {
    // Dirty by its title only, the canvas stays on the version it loaded: the refetched text must not replace its own.
    renderPage(doc({ content: 'Theirs, refetched', revision: 5 }), true, STORED)
    expect(screen.getByTestId('canvas')).toHaveTextContent(STORED)
  })

  it('makes the title an inline field that Enter leaves for the text', async () => {
    const user = userEvent.setup()
    renderPage(doc({}))
    const title = screen.getByRole('textbox', { name: 'Document title' })
    expect(title).toHaveValue('Notes')
    await user.type(title, 'X')
    expect(canvasState.setTitle).toHaveBeenLastCalledWith('NotesX')
    await user.keyboard('{Enter}')
    expect(handle.focus).toHaveBeenCalledWith()
  })

  it('shows the evidence beside the text and its type', () => {
    renderPage(doc({}))
    expect(screen.getByRole('heading', { name: 'Evidence' })).toBeInTheDocument()
    expect(screen.getByText('CUSTOM')).toBeInTheDocument()
    expect(screen.queryByTestId('review-view')).not.toBeInTheDocument()
  })

  it('hands the bar no review link', () => {
    renderPage(doc({}))
    expect(screen.getByTestId('document-detail-pane')).toBeInTheDocument()
    expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-share', 'none')
  })

  it('is a read-only canvas on the display text for a viewer', () => {
    renderPage(doc({}), false)
    const canvas = screen.getByTestId('canvas')
    expect(canvas).toHaveAttribute('data-editable', 'false')
    expect(canvas.textContent).toContain(LINKED)
    expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-can-edit', 'false')
  })

  it('shows a viewer the title as a heading', () => {
    renderPage(doc({}), false)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Notes' })).toBeInTheDocument()
  })

  it('keeps the title a heading when the hook says it is not editable', () => {
    canvasState.titleEditable = false
    renderPage(doc({}))
    expect(screen.queryByRole('textbox', { name: 'Document title' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Notes' })).toBeInTheDocument()
  })

  it('keeps the provenance under the text', () => {
    renderPage(doc({
      derivation: {
        sources: [{ document_id: 'gone_1', role: 'reference' }], selected_document_count: 1, feedback_count: 4,
        persona_ids: [], visual_document_ids: [], product_context_included: false,
      },
    }))
    expect(screen.getByTestId('document-derivation')).toHaveTextContent('4 feedback items used')
  })
})

describe('DocumentPage: a PR/FAQ or PRD', () => {
  const prd = doc({ document_type: 'prd', title: 'Checkout PRD (v2)', version: 2 })

  it('puts the editable canvas in the review view, on the stored content', () => {
    canvasState.titleEditable = false
    renderPage(prd)
    const review = screen.getByTestId('review-view')
    expect(review).toHaveAttribute('data-editable', 'true')
    expect(review).toHaveAttribute('data-handle', 'true')
    expect(screen.getByTestId('review-markdown')).toHaveTextContent(STORED)
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument()
  })

  it('gives the review view the evidence for its second rail tab', () => {
    renderPage(prd)
    const review = screen.getByTestId('review-view')
    expect(within(review).getByTestId('evidence-cards')).toBeInTheDocument()
    // Inside a tab, which names it: no heading of its own.
    expect(within(review).queryByRole('heading', { name: 'Evidence' })).not.toBeInTheDocument()
  })

  it('hands the bar the comments’ review link once they load, and shows the series title as a heading', () => {
    canvasState.titleEditable = false
    renderPage(prd)
    expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-share', 'comments')
    expect(screen.getByRole('heading', { level: 2, name: 'Checkout PRD (v2)' })).toBeInTheDocument()
  })

  it('offers no review link while the comments are unavailable', () => {
    comments.query.isSuccess = false
    renderPage(prd)
    expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-share', 'none')
  })

  it('is read-only on the display text for a viewer', () => {
    renderPage(prd, false)
    expect(screen.getByTestId('review-view')).toHaveAttribute('data-editable', 'false')
    expect(screen.getByTestId('review-markdown').textContent).toContain(LINKED)
  })
})

describe('DocumentPage: a decision', () => {
  it('is a read-only canvas on the display text, even for an editor', () => {
    canvasState.editable = false
    canvasState.titleEditable = false
    renderPage(doc({ document_type: 'decision', title: 'Go with plan B' }))
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-editable', 'false')
    expect(screen.getByTestId('canvas').textContent).toContain(LINKED)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('DocumentPage: around the canvas', () => {
  it('shows the assistant’s pending edit of this document after the action bar, before the coaching notice', () => {
    renderPage(doc({}))
    const diff = screen.getByTestId('assistant-diff')
    // This project and document; the canvas it reloads after an approved edit is the page's own.
    expect(Object.fromEntries(Object.entries(diff.dataset))).toStrictEqual({
      testid: 'assistant-diff', project: 'proj-1', document: 'doc-1', state: 'true',
    })
    const bar = screen.getByTestId('actions-bar')
    const notice = screen.getByTestId('document-coaching-notice')
    expect(bar.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(diff.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps a phone’s pinned Save bar off the text only while there are unsaved changes', () => {
    const { unmount } = renderPage(doc({}))
    expect(screen.getByTestId('document-detail-pane')).not.toHaveClass('max-sm:pb-20')
    unmount()
    canvasState.dirty = true
    renderPage(doc({}))
    expect(screen.getByTestId('document-detail-pane')).toHaveClass('max-sm:pb-20')
  })
})

describe('DocumentPage: the outline', () => {
  it('lists the headings the canvas reports and scrolls the canvas to one', async () => {
    const user = userEvent.setup()
    outline.push({ id: 'goals', level: 2, text: 'Goals' }, { id: 'risks', level: 2, text: 'Risks' })
    renderPage(doc({}))
    const nav = await screen.findByRole('navigation', { name: 'Contents' })
    await user.click(within(nav).getByRole('link', { name: 'Risks' }))
    expect(handle.scrollToHeading).toHaveBeenCalledWith('risks')
  })

  it('takes no column when the document has no headings', () => {
    renderPage(doc({}))
    expect(screen.queryByRole('navigation', { name: 'Contents' })).not.toBeInTheDocument()
  })
})
