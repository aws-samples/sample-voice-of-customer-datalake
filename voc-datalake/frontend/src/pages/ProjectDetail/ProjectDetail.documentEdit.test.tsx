import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest'
import type { ProjectDocument } from '../../api/types'
import { ApiError } from '../../lib/errors'
import { useConfigStore } from '../../store/configStore'
import enProjectDetail from '../../../public/locales/en/projectDetail.json'
import { makeProject } from './project-detail-fixtures'
import { projectDataApiModule, projectDataMocks } from './project-data-fixtures'
import { renderProjectDetailPage } from './project-detail-page-fixtures'
import { emptyProductContext } from './productContextFields'

const {
  getProject: mockGetProject, getJobs: mockGetJobs, getProductContext: mockGetProductContext,
} = projectDataMocks
const mockListProductDocs = vi.fn<(...args: unknown[]) => unknown>()
type EditBody = { title?: string; content?: string; edit_id?: string; expected_revision?: number }
const mockUpdateDocument = vi.fn<(projectId: string, documentId: string, body: EditBody) => unknown>()

/** The one save's (project, document, body), with the fresh edit id reduced to its type. */
function savedEdit(): unknown {
  const call = mockUpdateDocument.mock.calls[0]
  if (call === undefined) return undefined
  const [projectId, documentId, body] = call
  return [projectId, documentId, { ...body, edit_id: typeof body.edit_id }]
}

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    ...projectDataApiModule().projectsApi,
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    updateDocument: (projectId: string, documentId: string, body: EditBody) =>
      mockUpdateDocument(projectId, documentId, body),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))

const project = makeProject({
  project_id: 'proj-1',
  name: 'Versioned documents',
  description: '',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  document_count: 1,
})

const managedDocument: ProjectDocument = {
  document_id: 'prd-2',
  document_type: 'prd',
  base_title: 'Launch',
  version: 2,
  title: 'Launch (v2)',
  content: '# Original content',
  created_at: '2026-09-01T10:00:00Z',
}

const legacyManagedDocument: ProjectDocument = {
  document_id: 'legacy-prfaq-2',
  document_type: 'custom',
  sk: 'PRFAQ#legacy-prfaq-2',
  title: 'Legacy launch (v2)',
  content: '# Original legacy content',
  created_at: '2026-09-01T10:00:00Z',
}

const renderPage = renderProjectDetailPage

type User = ReturnType<typeof userEvent.setup>

/** Open the Documents tab and select the document whose list entry matches `name`. */
async function selectDocument(user: User, name: RegExp) {
  await user.click(await screen.findByRole('tab', { name: /documents/i }))
  await user.click(screen.getByRole('button', { name }))
}

/** In the open edit modal, replace the content with `text` and save. */
async function saveContent(user: User, text: string) {
  const content = screen.getByPlaceholderText(/Write your document/)
  await user.clear(content)
  await user.type(content, text)
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
}

/** Fresh mocks for a project page showing exactly `documents`. */
function primeProjectWith(documents: ProjectDocument[]) {
  vi.clearAllMocks()
  useConfigStore.setState((state) => ({
    config: { ...state.config, apiEndpoint: 'https://api.example.com/v1' },
  }))
  mockGetProject.mockResolvedValue({ project, personas: [], documents })
  mockGetJobs.mockResolvedValue({ jobs: [] })
  mockGetProductContext.mockResolvedValue({ context: emptyProductContext() })
  mockListProductDocs.mockResolvedValue({ docs: [] })
  mockUpdateDocument.mockResolvedValue({ success: true, document: null })
}

describe('ProjectDetail managed document edits', () => {
  beforeEach(() => {
    primeProjectWith([managedDocument])
  })

  it('submits content only and preserves the canonical selected title', async () => {
    const user = userEvent.setup()
    renderPage()

    await selectDocument(user, /Launch \(v2\)/)
    expect(screen.getByRole('heading', { name: 'Launch (v2)', level: 2 }))
      .toBeInTheDocument()

    await user.click(screen.getByTitle('Edit document'))
    const title = screen.getByPlaceholderText('Document title...')
    expect({
      disabled: title.matches(':disabled'),
      holdsTitle: screen.queryByDisplayValue('Launch (v2)') === title,
    }).toStrictEqual({ disabled: true, holdsTitle: true })

    await saveContent(user, '# Edited content')

    await waitFor(() => {
      expect(savedEdit()).toStrictEqual(['proj-1', 'prd-2', { content: '# Edited content', expected_revision: 2, edit_id: 'string' }])
    })
    expect(screen.getByRole('heading', { name: 'Launch (v2)', level: 2 }))
      .toBeInTheDocument()
  })

  it('uses the legacy managed sort key to protect the title and omit it from updates', async () => {
    mockGetProject.mockResolvedValue({
      project,
      personas: [],
      documents: [legacyManagedDocument],
    })
    const user = userEvent.setup()
    renderPage()

    await selectDocument(user, /Legacy launch \(v2\)/)
    await user.click(screen.getByTitle('Edit document'))

    expect(screen.getByPlaceholderText('Document title...')).toBeDisabled()
    await saveContent(user, '# Edited legacy content')

    await waitFor(() => {
      expect(savedEdit()).toStrictEqual(['proj-1', 'legacy-prfaq-2', { content: '# Edited legacy content', edit_id: 'string' }])
    })
  })

  // QA s3 F4: an edit is a NEW version; the page shows the one just saved.
  it('shows the saved version after an edit, not the edited one', async () => {
    mockUpdateDocument.mockResolvedValue({
      success: true,
      document: { ...managedDocument, document_id: 'prd-3', version: 3, title: 'Launch (v3)', content: '# Edited content' },
    })
    const user = userEvent.setup()
    renderPage()

    await selectDocument(user, /Launch \(v2\)/)
    await user.click(screen.getByTitle('Edit document'))
    await saveContent(user, '# Edited content')

    expect(await screen.findByRole('heading', { name: 'Launch (v3)', level: 2 })).toBeInTheDocument()
  })
})

// e2e concurrency.spec (two tabs, one document): the second tab's save used to
// land silently on top of the first. It now carries the revision it loaded, and a
// 409 shows the conflict with Load the latest / Save mine anyway.
describe('ProjectDetail document stale-save conflict', () => {
  const customDocument: ProjectDocument = {
    document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'loaded text',
    revision: 2, created_at: '2026-09-01T10:00:00Z',
  }
  const stale = () => new ApiError(409, 'The document was changed by someone else; reload it and try again')

  beforeEach(() => {
    primeProjectWith([customDocument])
  })

  async function editAndSave(user: User, text: string) {
    await selectDocument(user, /Notes/)
    await user.click(screen.getByTitle('Edit document'))
    await saveContent(user, text)
  }

  it('sends the revision the editor loaded', async () => {
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')

    await waitFor(() => {
      expect(savedEdit()).toStrictEqual(['proj-1', 'doc-1', {
        title: 'Notes', content: 'my edit', expected_revision: 2, edit_id: 'string',
      }])
    })
  })

  it('a 409 shows the conflict and keeps the draft, rather than closing as saved', async () => {
    mockUpdateDocument.mockRejectedValueOnce(stale())
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(enProjectDetail.documentModal.conflict)
    expect(screen.getByPlaceholderText(/Write your document/)).toHaveValue('my edit')
  })

  it('Load the latest reopens the editor on the other save', async () => {
    mockUpdateDocument.mockRejectedValueOnce(stale())
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')
    mockGetProject.mockResolvedValue({
      project, personas: [], documents: [{ ...customDocument, content: 'their edit', revision: 3 }],
    })

    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: enProjectDetail.documentModal.conflictReload }))

    await waitFor(() => expect(screen.getByPlaceholderText(/Write your document/)).toHaveValue('their edit'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await saveContent(user, 'on top of theirs')
    await waitFor(() => expect(mockUpdateDocument).toHaveBeenLastCalledWith('proj-1', 'doc-1', expect.objectContaining({
      content: 'on top of theirs', expected_revision: 3,
    })))
  })

  it('Save mine anyway saves the draft without the check', async () => {
    mockUpdateDocument.mockRejectedValueOnce(stale())
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')

    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: enProjectDetail.documentModal.conflictSaveAnyway }))

    await waitFor(() => expect(mockUpdateDocument).toHaveBeenCalledTimes(2))
    const [, , body] = mockUpdateDocument.mock.calls[1] ?? []
    expect(body).toMatchObject({ content: 'my edit' })
    expect(body).not.toHaveProperty('expected_revision')
    await waitFor(() => expect(screen.queryByPlaceholderText(/Write your document/)).not.toBeInTheDocument())
  })
})
