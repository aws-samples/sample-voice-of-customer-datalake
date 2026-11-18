/**
 * "New" without the wizard (useBlankDocument), on the page: the Documents section's New creates a blank custom
 * document at once under the first free "Untitled document" name and opens it with its title selected, renamed in
 * place (Enter saves the title alone, then the caret goes to the text); a PRD / PR/FAQ section's New → Blank opens
 * the draft pane on "Untitled PRD", which files the hand-written document on Enter (refusing an empty name or one a
 * series of that type already has) or files nothing on Escape. No dialog in either. The editor is a stand-in
 * (canvas-editor-fixtures).
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfigStore } from '../../store/configStore'
import { makeProject, preloadDocumentPage } from './project-detail-fixtures'
import { projectDataApiModule, projectDataMocks } from './project-data-fixtures'
import { renderProjectDetailPage as renderPage } from './project-detail-page-fixtures'
import { emptyProductContext } from './productContextFields'
import { selectedRange } from '@test/selectText'
import type { ProjectDocument } from '../../api/types'

const { getProject, getJobs, getProductContext } = projectDataMocks
const api = vi.hoisted(() => ({
  createDocument: vi.fn<(projectId: string, body: unknown) => Promise<unknown>>(),
  startHandWrittenDocument: vi.fn<(projectId: string, body: unknown) => Promise<unknown>>(),
  updateDocument: vi.fn<(projectId: string, documentId: string, body: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    ...projectDataApiModule().projectsApi,
    listProductDocs: () => Promise.resolve({ docs: [] }),
    createDocument: (projectId: string, body: unknown) => api.createDocument(projectId, body),
    startHandWrittenDocument: (projectId: string, body: unknown) => api.startHandWrittenDocument(projectId, body),
    updateDocument: (projectId: string, documentId: string, body: Record<string, unknown>) =>
      api.updateDocument(projectId, documentId, body),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))
vi.mock('../../components/Document/edit/editor/CanvasEditor', async () => ({
  default: (await import('../../components/DocumentCanvas/actions/canvas-editor-fixtures')).FakeCanvasEditor,
}))
vi.mock('./DocumentReviewView', async () => ({
  default: (await import('../../components/DocumentCanvas/actions/canvas-editor-fixtures')).FakeReviewView,
}))
vi.mock('./useDocumentComments', () => ({
  useDocumentComments: () => ({ query: { isSuccess: false }, share: null, createShare: vi.fn(), revokeShare: vi.fn() }),
}))

await preloadDocumentPage()

const project = makeProject({ project_id: 'proj-1', name: 'Blank pages', description: '' })
const untitled: ProjectDocument = {
  document_id: 'doc-old', document_type: 'custom', title: 'Untitled document', content: 'kept', created_at: '2026-09-01T10:00:00Z',
}
const checkout: ProjectDocument = {
  document_id: 'prd-1', document_type: 'prd', base_title: 'Checkout', version: 1, title: 'Checkout (v1)', content: '# Checkout',
  created_at: '2026-09-01T10:00:00Z',
}

function prime(documents: ProjectDocument[]) {
  vi.clearAllMocks()
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com/v1' } }))
  getProject.mockResolvedValue({ project, personas: [], documents })
  getJobs.mockResolvedValue({ jobs: [] })
  getProductContext.mockResolvedValue({ context: emptyProductContext() })
}

/** A string field of a body the mocked API received ('' when it has none). */
function field(body: unknown, key: string): string {
  if (typeof body !== 'object' || body === null) return ''
  const value: unknown = Reflect.get(body, key)
  return typeof value === 'string' ? value : ''
}

/** The blank custom document the server answers (empty content, the name the page asked for). */
function createdAs(title: string): ProjectDocument {
  return { document_id: 'doc-new', document_type: 'custom', title, content: '', created_at: new Date().toISOString() }
}

type User = ReturnType<typeof userEvent.setup>

async function openDocumentsTab(user: User) {
  await user.click(await screen.findByRole('tab', { name: /documents/i }))
}

/** The page rendered, its Documents tab open and New Document pressed: the new document's title field. */
async function newDocument(): Promise<{ user: User; title: HTMLElement }> {
  const user = userEvent.setup()
  renderPage()
  await openDocumentsTab(user)
  await user.click(screen.getByRole('button', { name: 'New Document' }))
  return { user, title: await screen.findByRole('textbox', { name: 'Document title' }) }
}

describe('ProjectDetail: New document, blank and named in place', () => {
  beforeEach(() => {
    prime([untitled])
    api.createDocument.mockImplementation((_projectId, body) => Promise.resolve({
      document: createdAs(field(body, 'title')),
    }))
  })

  it('creates a blank document at once under the first free name and opens it with the title selected', async () => {
    const { title } = await newDocument()

    expect([api.createDocument.mock.calls, screen.queryByRole('dialog')])
      .toStrictEqual([[['proj-1', { title: 'Untitled document 2', content: '', document_type: 'custom' }]], null])
    await waitFor(() => expect(title).toHaveFocus())
    expect(selectedRange(title)).toStrictEqual([0, 'Untitled document 2'.length])
    expect(screen.getByRole('textbox', { name: 'Untitled document 2' })).toHaveValue('')
  })

  it('renames it on Enter with the title alone (the text stays as typed), then moves on to the text', async () => {
    api.updateDocument.mockImplementation((_projectId, _documentId, body) => Promise.resolve({
      document: { ...createdAs(field(body, 'title')), revision: 2 },
    }))
    const { user, title } = await newDocument()
    await waitFor(() => expect(title).toHaveFocus())

    await user.keyboard('Launch notes{Enter}')

    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(1))
    const [projectId, documentId, body] = api.updateDocument.mock.calls[0] ?? []
    expect([projectId, documentId, { ...body, edit_id: typeof body?.['edit_id'] }])
      .toStrictEqual(['proj-1', 'doc-new', { title: 'Launch notes', expected_revision: 1, edit_id: 'string' }])
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Launch notes' })).toHaveFocus())
  })

  it('says under the Documents section when the blank document could not be created, and opens nothing', async () => {
    api.createDocument.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    renderPage()
    await openDocumentsTab(user)
    await user.click(screen.getByRole('button', { name: 'New Document' }))
    expect(await screen.findByText('The document could not be created. Try again.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Document title' })).not.toBeInTheDocument()
  })
})

describe('ProjectDetail: New PRD → Blank, named before it is filed', () => {
  beforeEach(() => {
    prime([checkout])
    api.startHandWrittenDocument.mockImplementation((_projectId, body) => {
      const title = field(body, 'title')
      return Promise.resolve({
        success: true,
        document: { ...checkout, document_id: 'prd-new', base_title: title, title: `${title} (v1)`, content: '# Overview\n' },
      })
    })
  })

  async function openBlankPrd(user: User) {
    await openDocumentsTab(user)
    await user.click(screen.getByRole('button', { name: 'New PRD' }))
    await user.click(screen.getByRole('menuitem', { name: 'Blank' }))
    return screen.findByRole('textbox', { name: 'Document title' })
  }

  it('opens the draft pane on "Untitled PRD", selected, and files nothing until Enter', async () => {
    const user = userEvent.setup()
    renderPage()
    const title = await openBlankPrd(user)
    expect(screen.getByRole('region', { name: 'New PRD' })).toBeInTheDocument()
    expect([title, ...selectedRange(title)]).toStrictEqual([document.activeElement, 0, 'Untitled PRD'.length])
    expect(api.startHandWrittenDocument).not.toHaveBeenCalled()
  })

  it('files the hand-written PRD under the typed name on Enter and opens its page with the caret in the text', async () => {
    const user = userEvent.setup()
    renderPage()
    await openBlankPrd(user)
    await user.keyboard('Gift cards{Enter}')

    await waitFor(() => expect(api.startHandWrittenDocument).toHaveBeenCalledTimes(1))
    const [projectId, body] = api.startHandWrittenDocument.mock.calls[0] ?? []
    expect([projectId, field(body, 'document_type'), field(body, 'title'), /^[a-f0-9]{32}$/.test(field(body, 'create_id'))])
      .toStrictEqual(['proj-1', 'prd', 'Gift cards', true])
    expect(await screen.findByRole('heading', { name: 'Gift cards (v1)', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'New PRD' })).not.toBeInTheDocument()
  })

  it('refuses the name of a PRD the project has (it would only add a version) and an empty name', async () => {
    const user = userEvent.setup()
    renderPage()
    const title = await openBlankPrd(user)
    await user.clear(title)
    await user.keyboard('checkout{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('This project already has a PRD named “checkout”')
    await user.clear(title)
    await user.keyboard('{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Give it a name first.')
    expect(api.startHandWrittenDocument).not.toHaveBeenCalled()
  })

  it('files nothing on Escape and puts focus back on New PRD', async () => {
    const user = userEvent.setup()
    renderPage()
    await openBlankPrd(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'New PRD' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New PRD' })).toHaveFocus()
    expect(api.startHandWrittenDocument).not.toHaveBeenCalled()
  })

  it('keeps the name for another try when filing it failed', async () => {
    api.startHandWrittenDocument.mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    renderPage()
    const title = await openBlankPrd(user)
    await user.keyboard('Gift cards{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('The PRD could not be created. Try again.')
    expect(title).toHaveValue('Gift cards')
    await user.click(screen.getByRole('button', { name: 'Start writing' }))
    await waitFor(() => expect(api.startHandWrittenDocument).toHaveBeenCalledTimes(2))
    const [first, second] = api.startHandWrittenDocument.mock.calls.map(([, body]) => field(body, 'create_id'))
    expect(second, 'a retry of the same name is the same document').toBe(first)
  })
})

describe('ProjectDetail: one blank at a time', () => {
  it('drops a PRD being named when New Document is chosen, and opens the new document', async () => {
    prime([checkout])
    api.createDocument.mockResolvedValue({ document: createdAs('Untitled document') })
    const user = userEvent.setup()
    renderPage()
    await openDocumentsTab(user)
    await user.click(screen.getByRole('button', { name: 'New PRD' }))
    await user.click(screen.getByRole('menuitem', { name: 'Blank' }))
    expect(await screen.findByRole('region', { name: 'New PRD' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New Document' }))

    expect(await screen.findByRole('textbox', { name: 'Untitled document' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'New PRD' })).not.toBeInTheDocument()
    expect(api.startHandWrittenDocument).not.toHaveBeenCalled()
  })
})
