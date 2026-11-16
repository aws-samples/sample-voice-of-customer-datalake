/**
 * The page and its versions, and its comments panel: the latest by default; an older version (`…/v/<n>`, chosen in the
 * toolbar's picker) read-only under its banner, the page's own canvas kept out of sight; Back to latest; Restore makes
 * a new version (History's restore) and the page moves to it; the version on the page never `/v/`; a viewer cannot
 * restore. The comments panel is closed at first; what needs it (a comment started, a thread asked for) opens it for
 * that visit only, an explicit switch stores the choice; the AI flows reach the bar, not while an older version shows.
 * The editor, the review view and the bar are mocked (the bar's View switch stands in for the toolbar's).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { renderWithQueryClient as render } from '@test/query-client'
import { projectsApi } from '../../../api/projectsApi'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { VIEWER_ACCESS } from '../../../pages/ProjectDetail/projectAccess-fixtures'
import DocumentPage from './DocumentPage'
import { useDocumentViewStore } from './usePageView'
import type { ReviewActions } from '../actions/toolbarItems'
import type { VersionChoice } from '../actions/versionChoices'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

const handle = {
  root: vi.fn(), getMarkdown: vi.fn(), setMarkdown: vi.fn(), scrollToHeading: vi.fn(), focus: vi.fn(), clearSelection: vi.fn(),
  run: vi.fn(() => true), can: vi.fn(() => true),
}
const canvasState = {
  content: 'Latest text', title: 'Refunds (v4)', setTitle: vi.fn(), rename: vi.fn(() => Promise.resolve()), draft: '',
  onChange: vi.fn(), dirty: false, saving: false, save: vi.fn(), discard: vi.fn(), conflict: null, titleEditable: false,
  handleRef: { current: handle }, editable: true, selectDoc: vi.fn(), reloadLatest: vi.fn(), guardDialog: null, reviseRefused: null,
}
const AI: ReviewActions = {
  review: { running: false, blocked: false, again: false, start: vi.fn() }, rewrite: null,
}

vi.mock('../../../api/projectsApi', () => ({ projectsApi: { getDocumentVersions: vi.fn(), restoreDocumentVersion: vi.fn() } }))
vi.mock('../actions/useCanvasDocument', () => ({ useCanvasDocument: vi.fn(() => canvasState) }))
vi.mock('../actions/DocumentActionsBar', () => ({
  default: ({ viewing, onChooseVersion, review, view }: {
    viewing: number | null; onChooseVersion: (choice: VersionChoice) => void; review: ReviewActions | null
    view?: { comments?: { toggle: () => void } }
  }) => (
    <div data-testid="actions-bar" data-viewing={String(viewing)} data-review={review === null ? 'none' : 'offered'}>
      <button type="button" onClick={() => onChooseVersion({ kind: 'older', number: 2 })}>Pick v2</button>
      <button type="button" onClick={() => onChooseVersion({ kind: 'own' })}>Pick the page's own</button>
      <button type="button" onClick={() => view?.comments?.toggle()}>Switch comments</button>
    </div>
  ),
}))
vi.mock('../editor/CanvasEditor', () => ({
  default: ({ markdown, editable }: { markdown: string; editable: boolean }) => (
    <div data-testid="canvas" data-editable={String(editable)}>{markdown}</div>
  ),
}))
vi.mock('../../../pages/ProjectDetail/DocumentReviewView', () => ({
  default: function MockReviewView({ markdown, railHidden, onRevealRail, onActions }: {
    markdown: string; railHidden?: boolean; onRevealRail?: () => void; onActions: (actions: ReviewActions | null) => void
  }) {
    useEffect(() => { onActions(AI) }, [onActions])
    return (
      <div data-testid="review-view" data-rail-hidden={String(railHidden)}>
        <div data-testid="review-markdown">{markdown}</div>
        {/* What the review view does when a comment is started (Ctrl+Alt+M) or a thread is asked for. */}
        <button type="button" onClick={onRevealRail}>Start a comment</button>
      </div>
    )
  },
}))
vi.mock('../actions/AssistantDiffOnCanvas', () => ({ default: () => null }))
vi.mock('../../AiCoach/HumanDrivenNotice', () => ({ DocumentCoachingNotice: () => null }))
vi.mock('../../../pages/ProjectDetail/useDocumentComments', () => ({
  useDocumentComments: vi.fn(() => ({ query: { isSuccess: true, data: { threads: [] } }, share: null, createShare: vi.fn(), revokeShare: vi.fn() })),
}))

const editor = makeProject({ project_id: 'proj-1', name: 'P', description: '' })
const viewer = { ...editor, access: VIEWER_ACCESS }
const PRFAQ: ProjectDocument = {
  document_id: 'prfaq_4', document_type: 'prfaq', title: 'Refunds (v4)', base_title: 'Refunds', content: 'Latest text',
  created_at: '2026-10-04T00:00:00Z', version: 4,
}

function version(n: number): DocumentVersion {
  return {
    version_id: `prfaq_${String(n)}`, document_id: `prfaq_${String(n)}`, version: n, title: `Refunds (v${String(n)})`,
    content: `Text of v${String(n)}`, created_at: '2026-10-01T00:00:00Z', current: n === 4,
  }
}

function LocationProbe() {
  return <p data-testid="path">{useLocation().pathname}</p>
}

function renderPage(entry: string, canEdit = true) {
  canvasState.editable = canEdit
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <DocumentPage project={canEdit ? editor : viewer} document={PRFAQ} documents={[PRFAQ]} canEdit={canEdit}
        onSelectDoc={vi.fn()} onDeleteDoc={vi.fn()} isDeleting={false} />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const path = () => screen.getByTestId('path').textContent
const banner = () => screen.queryByRole('region', { name: 'Older version' })
const ownText = () => screen.getByTestId('review-markdown')

beforeEach(() => {
  vi.clearAllMocks()
  useDocumentViewStore.setState({ comments: false, outline: true, fullWidth: true })
  vi.mocked(projectsApi.getDocumentVersions).mockResolvedValue([4, 3, 2, 1].map(version))
})

describe('DocumentPage: versions', () => {
  it('shows the latest by default: no banner, its own canvas, nothing fetched', () => {
    renderPage('/projects/proj-1/documents/prfaq_4')
    expect(banner()).toBeNull()
    expect(ownText()).toBeVisible()
    expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-viewing', 'null')
    expect(projectsApi.getDocumentVersions).not.toHaveBeenCalled()
  })

  it('shows an older version chosen in the picker read-only under its banner, its own canvas kept out of sight', async () => {
    const user = userEvent.setup()
    renderPage('/projects/proj-1/documents/prfaq_4')
    await user.click(screen.getByRole('button', { name: 'Pick v2' }))

    const region = await screen.findByRole('region', { name: 'Older version' })
    const older = await screen.findByText('Text of v2')
    expect({
      path: path(), banner: region.textContent.includes('Viewing v2 of 4 · read only'), editable: older.dataset['editable'],
      title: screen.getByRole('heading', { level: 2 }).textContent, ownShown: ownText().closest('[hidden]') === null,
      bar: screen.getByTestId('actions-bar').dataset['viewing'], note: screen.getByTestId('canvas-focus-note').textContent,
    }).toStrictEqual({
      path: '/projects/proj-1/documents/prfaq_4/v/2', banner: true,
      editable: 'false', title: 'Refunds (v2)', ownShown: false, bar: '2', note: 'Showing v2, an older version, read only.',
    })
  })

  it('goes back to the latest from the banner, focus on the text', async () => {
    const user = userEvent.setup()
    renderPage('/projects/proj-1/documents/prfaq_4/v/2')
    await user.click(await screen.findByRole('button', { name: 'Back to latest' }))

    expect(path()).toBe('/projects/proj-1/documents/prfaq_4')
    expect(banner()).toBeNull()
    expect(ownText()).toBeVisible()
    await waitFor(() => expect(handle.focus).toHaveBeenCalledWith({ scroll: false }))
  })

  it('restores the older version as a new version (asked first), and the page moves to it', async () => {
    const restored = { ...PRFAQ, document_id: 'prfaq_5', version: 5, title: 'Refunds (v5)', content: 'Text of v2' }
    vi.mocked(projectsApi.restoreDocumentVersion).mockResolvedValue(restored)
    const user = userEvent.setup()
    renderPage('/projects/proj-1/documents/prfaq_4/v/2')

    await user.click(await within(await screen.findByRole('region', { name: 'Older version' })).findByRole('button', { name: 'Restore v2' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Restore this version?' })).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(canvasState.selectDoc).toHaveBeenCalledWith(restored))
    expect(vi.mocked(projectsApi.restoreDocumentVersion).mock.calls[0]?.slice(0, 3)).toStrictEqual(['proj-1', 'prfaq_4', 'prfaq_2'])
  })

  it('offers a viewer no Restore', async () => {
    renderPage('/projects/proj-1/documents/prfaq_4/v/2', false)
    const region = await screen.findByRole('region', { name: 'Older version' })
    await screen.findByText('Text of v2')
    expect(within(region).queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Back to latest' })).toBeInTheDocument()
  })

  it('never shows the page\'s own version as `/v/`, nor a version the list does not hold', async () => {
    const { unmount } = renderPage('/projects/proj-1/documents/prfaq_4/v/4')
    expect(path()).toBe('/projects/proj-1/documents/prfaq_4')
    unmount()
    renderPage('/projects/proj-1/documents/prfaq_4/v/9')
    await waitFor(() => expect(path()).toBe('/projects/proj-1/documents/prfaq_4'))
  })

  it('keeps full screen as an older version is chosen and left', async () => {
    const user = userEvent.setup()
    renderPage('/projects/proj-1/documents/prfaq_4/focus')
    await user.click(screen.getByRole('button', { name: 'Pick v2' }))
    expect(path()).toBe('/projects/proj-1/documents/prfaq_4/v/2/focus')
    await user.click(screen.getByRole('button', { name: 'Pick the page\'s own' }))
    expect(path()).toBe('/projects/proj-1/documents/prfaq_4/focus')
  })

  it('hands the bar the AI flows, and none while an older version shows', async () => {
    const user = userEvent.setup()
    renderPage('/projects/proj-1/documents/prfaq_4')
    await waitFor(() => expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-review', 'offered'))
    await user.click(screen.getByRole('button', { name: 'Pick v2' }))
    expect(screen.getByTestId('actions-bar')).toHaveAttribute('data-review', 'none')
  })
})

describe('DocumentPage: the comments panel', () => {
  const railHidden = () => screen.getByTestId('review-view').dataset['railHidden']

  it('is closed at first; a comment started or a thread asked for opens it for this visit, storing nothing', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPage('/projects/proj-1/documents/prfaq_4')
    expect(railHidden()).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Start a comment' }))
    expect([railHidden(), useDocumentViewStore.getState().comments]).toStrictEqual(['false', false])
    unmount()
    renderPage('/projects/proj-1/documents/prfaq_4')
    expect(railHidden(), 'the next visit shows the stored choice').toBe('true')
  })

  it('stores an explicit switch, which the next visit shows', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPage('/projects/proj-1/documents/prfaq_4')
    await user.click(screen.getByRole('button', { name: 'Switch comments' }))
    expect([railHidden(), useDocumentViewStore.getState().comments]).toStrictEqual(['false', true])
    unmount()
    renderPage('/projects/proj-1/documents/prfaq_4')
    expect(railHidden()).toBe('false')
  })
})
