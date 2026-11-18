/**
 * The documents list's card menu on the page (DocumentCard, useDocumentCardActions): Rename is the canvas's own PUT
 * (the title alone, with the revision the list holds), the open document is renamed through its page (its unsaved
 * text stays), and Delete asks with the page's confirmation, calls the delete and updates the list, closing the open
 * document only when it is the one deleted. The editor is a stand-in (canvas-editor-fixtures).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest'
import type { ProjectDocument } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import enProjectDetail from '../../../public/locales/en/projectDetail.json'
import enDocuments from '../../../public/locales/en/documents.json'
import { makeProject, preloadDocumentPage, savedEditOf } from './project-detail-fixtures'
import { projectDataApiModule, projectDataMocks } from './project-data-fixtures'
import { renderProjectDetailPage } from './project-detail-page-fixtures'
import { emptyProductContext } from './productContextFields'

const {
  getProject: mockGetProject, getJobs: mockGetJobs, getProductContext: mockGetProductContext,
} = projectDataMocks
type EditBody = { title?: string; content?: string; edit_id?: string; expected_revision?: number }
const mockUpdateDocument = vi.fn<(projectId: string, documentId: string, body: EditBody) => Promise<unknown>>()
const mockDeleteDocument = vi.fn<(projectId: string, documentId: string) => Promise<unknown>>()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    ...projectDataApiModule().projectsApi,
    listProductDocs: () => Promise.resolve({ docs: [] }),
    updateDocument: (projectId: string, documentId: string, body: EditBody) => mockUpdateDocument(projectId, documentId, body),
    deleteDocument: (projectId: string, documentId: string) => mockDeleteDocument(projectId, documentId),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))
vi.mock('../../components/Document/edit/editor/CanvasEditor', async () => ({
  default: (await import('../../components/DocumentCanvas/actions/canvas-editor-fixtures')).FakeCanvasEditor,
}))

await preloadDocumentPage()

const project = makeProject({ project_id: 'proj-1', name: 'Card menus', description: '' })
const notes: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'loaded text', revision: 2,
  created_at: '2026-09-02T10:00:00Z',
}
const other: ProjectDocument = {
  document_id: 'doc-2', document_type: 'research', title: 'Other notes', content: 'other text', revision: 1,
  created_at: '2026-09-01T10:00:00Z',
}

/** What the server holds: a rename and a delete change it, and the next project read returns it. */
const server: { documents: ProjectDocument[] } = { documents: [] }

beforeEach(() => {
  vi.clearAllMocks()
  server.documents = [notes, other]
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com/v1' } }))
  mockGetProject.mockImplementation(() => Promise.resolve({ project, personas: [], documents: server.documents }))
  mockGetJobs.mockResolvedValue({ jobs: [] })
  mockGetProductContext.mockResolvedValue({ context: emptyProductContext() })
  mockUpdateDocument.mockImplementation((_projectId, documentId, body) => {
    server.documents = server.documents.map((d) => (d.document_id === documentId
      ? { ...d, title: body.title ?? d.title, content: body.content ?? d.content, revision: (d.revision ?? 0) + 1 }
      : d))
    return Promise.resolve({ success: true, document: server.documents.find((d) => d.document_id === documentId) })
  })
  mockDeleteDocument.mockImplementation((_projectId, documentId) => {
    server.documents = server.documents.filter((d) => d.document_id !== documentId)
    return Promise.resolve({ success: true })
  })
})

type User = ReturnType<typeof userEvent.setup>

const cardOf = (title: string) => screen.getByRole('button', { name: new RegExp(`${title}$`) })
/** The n-th PUT's (project, document, body), with the fresh edit id reduced to its type. */
const put = (n = 0): unknown => savedEditOf(mockUpdateDocument.mock.calls, n)

async function openDocumentsTab(user: User) {
  await user.click(await screen.findByRole('tab', { name: /documents/i }))
  await screen.findByRole('button', { name: /Other notes$/ })
}

/** Right-click the card titled `title` and choose `item` in its menu. */
async function chooseOnCard(user: User, title: string, item: string) {
  fireEvent.contextMenu(cardOf(title))
  await user.click(within(screen.getByRole('menu', { name: `Actions for “${title}”` })).getByRole('menuitem', { name: item }))
}

describe('ProjectDetail card Rename', () => {
  it('saves the title alone with the revision the list holds, and the list shows the new name', async () => {
    const user = userEvent.setup()
    renderProjectDetailPage()
    await openDocumentsTab(user)

    await chooseOnCard(user, 'Other notes', enDocuments.menu.rename)
    await user.keyboard('Interview log{Enter}')

    await waitFor(() => expect(put()).toStrictEqual(['proj-1', 'doc-2', { title: 'Interview log', expected_revision: 1, edit_id: 'string' }]))
    expect(await screen.findByRole('button', { name: /Interview log$/ })).toBeInTheDocument()
    expect(mockGetProject.mock.calls.length).toBeGreaterThan(1)
  })

  it('renames the open document through its page: the page title follows, its unsaved text stays the draft', async () => {
    const user = userEvent.setup()
    renderProjectDetailPage()
    await openDocumentsTab(user)
    await user.click(cardOf('Notes'))
    const canvas = await screen.findByRole('textbox', { name: 'Notes' })
    await user.clear(canvas)
    await user.type(canvas, 'half written')

    await chooseOnCard(user, 'Notes', enDocuments.menu.rename)
    await user.keyboard('Field notes{Enter}')

    await waitFor(() => expect(put()).toStrictEqual(['proj-1', 'doc-1', { title: 'Field notes', expected_revision: 2, edit_id: 'string' }]))
    expect(await screen.findByRole('textbox', { name: enDocuments.page.titleLabel })).toHaveValue('Field notes')
    expect(canvas).toHaveValue('half written')
    expect(screen.getByTestId('canvas-save-status')).toHaveTextContent(enDocuments.actions.status.unsaved)
  })
})

/** The page rendered, its Documents tab open and the Notes card's document open on its canvas. */
async function openNotes(): Promise<User> {
  const user = userEvent.setup()
  renderProjectDetailPage()
  await openDocumentsTab(user)
  await user.click(cardOf('Notes'))
  await screen.findByRole('textbox', { name: 'Notes' })
  return user
}

describe('ProjectDetail card Delete', () => {
  const confirmDialog = () => screen.findByRole('dialog', { name: enProjectDetail.confirmDelete.documentTitle })

  it('asks first, deletes on Delete and drops the card; the open document stays open', async () => {
    const user = await openNotes()

    await chooseOnCard(user, 'Other notes', enProjectDetail.documents.deleteDocument)
    const dialog = await confirmDialog()
    expect(dialog).toHaveTextContent(enProjectDetail.confirmDelete.documentMessage)
    await user.click(within(dialog).getByRole('button', { name: enProjectDetail.confirmDelete.confirm }))

    expect(mockDeleteDocument).toHaveBeenCalledWith('proj-1', 'doc-2')
    await waitFor(() => expect(screen.queryByRole('button', { name: /Other notes$/ })).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument()
  })

  it('closes the open document when it is the one deleted, as the page\'s Delete does', async () => {
    const user = await openNotes()

    await chooseOnCard(user, 'Notes', enProjectDetail.documents.deleteDocument)
    await user.click(within(await confirmDialog()).getByRole('button', { name: enProjectDetail.confirmDelete.confirm }))

    expect(mockDeleteDocument).toHaveBeenCalledWith('proj-1', 'doc-1')
    expect(await screen.findByText(enProjectDetail.documents.selectDocument)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: /Notes$/ })).not.toBeInTheDocument())
  })

  it('deletes nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    renderProjectDetailPage()
    await openDocumentsTab(user)

    await chooseOnCard(user, 'Other notes', enProjectDetail.documents.deleteDocument)
    await user.click(within(await confirmDialog()).getByRole('button', { name: 'Cancel' }))

    expect(mockDeleteDocument).not.toHaveBeenCalled()
    expect(cardOf('Other notes')).toBeInTheDocument()
  })
})
