/**
 * The page edits a document in place on its canvas (voc-wiki): Save writes ONE new
 * version through the document PUT with the revision the canvas loaded and a fresh edit
 * id; a 409 shows the conflict; leaving a dirty document asks first; a new document opens
 * on its canvas. The editor itself is a stand-in (canvas-editor-fixtures), so these specs
 * pin the page's wiring, not TipTap.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest'
import type { ProjectDocument } from '../../api/types'
import { ApiError } from '../../lib/errors'
import { useConfigStore } from '../../store/configStore'
import enProjectDetail from '../../../public/locales/en/projectDetail.json'
import enComponents from '../../../public/locales/en/components.json'
import { makeProject, preloadDocumentPage } from './project-detail-fixtures'
import { projectDataApiModule, projectDataMocks } from './project-data-fixtures'
import { renderProjectDetailPage } from './project-detail-page-fixtures'
import { emptyProductContext } from './productContextFields'

const {
  getProject: mockGetProject, getJobs: mockGetJobs, getProductContext: mockGetProductContext,
} = projectDataMocks
const mockListProductDocs = vi.fn<(...args: unknown[]) => unknown>()
type EditBody = { title?: string; content?: string; edit_id?: string; expected_revision?: number }
const mockUpdateDocument = vi.fn<(projectId: string, documentId: string, body: EditBody) => unknown>()
const mockCreateDocument = vi.fn<(projectId: string, body: unknown) => unknown>()

/** The n-th save's (project, document, body), with the fresh edit id reduced to its type. */
function savedEdit(n = 0): unknown {
  const call = mockUpdateDocument.mock.calls[n]
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
    createDocument: (projectId: string, body: unknown) => mockCreateDocument(projectId, body),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
  },
}))
vi.mock('../../components/DocumentCanvas/editor/CanvasEditor', async () => ({
  default: (await import('../../components/DocumentCanvas/actions/canvas-editor-fixtures')).FakeCanvasEditor,
}))
// A PR/FAQ / PRD reads inside the comments view (T3's); here only its canvas matters.
vi.mock('./DocumentReviewView', async () => {
  const { FakeCanvasEditor } = await import('../../components/DocumentCanvas/actions/canvas-editor-fixtures')
  return {
    default: ({ document, markdown, editable, onChange, handleRef }: {
      document: ProjectDocument; markdown: string; editable: boolean
      onChange?: (markdown: string) => void; handleRef?: React.Ref<never>
    }) => <FakeCanvasEditor markdown={markdown} editable={editable} ariaLabel={document.title} onChange={onChange} handleRef={handleRef} />,
  }
})
vi.mock('./useDocumentComments', () => ({
  useDocumentComments: () => ({ query: { isSuccess: false }, share: null, createShare: vi.fn(), revokeShare: vi.fn() }),
}))

// The page (and its editor) is lazy: loaded once up front, no spec's first findBy waits for its transform.
await preloadDocumentPage()

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

const customDocument: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'loaded text',
  revision: 2, created_at: '2026-09-01T10:00:00Z',
}
const otherDocument: ProjectDocument = {
  document_id: 'doc-2', document_type: 'custom', title: 'Other notes', content: 'other text', created_at: '2026-09-01T10:00:00Z',
}

const actions = enProjectDetail.canvas.actions
const renderPage = renderProjectDetailPage

type User = ReturnType<typeof userEvent.setup>

/** Open the Documents tab and select the document whose list entry matches `name`. */
async function selectDocument(user: User, name: RegExp) {
  await user.click(await screen.findByRole('tab', { name: /documents/i }))
  await user.click(screen.getByRole('button', { name }))
}

/** On the open canvas (named by the document's title), replace the text with `text`. */
async function edit(user: User, title: string, text: string) {
  const canvas = await screen.findByRole('textbox', { name: title })
  await user.clear(canvas)
  await user.type(canvas, text)
}

const saveButton = () => screen.getByRole('button', { name: actions.save })

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
  // A save answers the version it stored: the document as sent, one revision on.
  mockUpdateDocument.mockImplementation((_projectId, documentId, body) => {
    const edited = documents.find((d) => d.document_id === documentId)
    return Promise.resolve({
      success: true,
      document: edited && {
        ...edited, title: body.title ?? edited.title, content: body.content ?? edited.content, revision: (edited.revision ?? 0) + 1,
      },
    })
  })
}

describe('ProjectDetail managed document edits', () => {
  beforeEach(() => {
    primeProjectWith([managedDocument])
  })

  it('saves the content only (a PRD title is its series\'), with the version it loaded', async () => {
    const user = userEvent.setup()
    renderPage()

    await selectDocument(user, /Launch \(v2\)/)
    expect(await screen.findByRole('heading', { name: 'Launch (v2)', level: 2 })).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()

    await edit(user, 'Launch (v2)', '# Edited content')
    expect(screen.getByTestId('canvas-save-status')).toHaveTextContent(actions.status.unsaved)
    await user.click(saveButton())

    await waitFor(() => {
      expect(savedEdit()).toStrictEqual(['proj-1', 'prd-2', { content: '# Edited content', expected_revision: 2, edit_id: 'string' }])
    })
  })

  it('uses the legacy managed sort key to protect the title and omit it from updates', async () => {
    primeProjectWith([legacyManagedDocument])
    const user = userEvent.setup()
    renderPage()

    await selectDocument(user, /Legacy launch \(v2\)/)
    expect(await screen.findByRole('heading', { name: 'Legacy launch (v2)', level: 2 })).toBeInTheDocument()
    await edit(user, 'Legacy launch (v2)', '# Edited legacy content')
    await user.keyboard('{Control>}s{/Control}')

    await waitFor(() => {
      expect(savedEdit()).toStrictEqual(['proj-1', 'legacy-prfaq-2', { content: '# Edited legacy content', edit_id: 'string' }])
    })
  })

  /** Opens Launch (v2) and edits it, with the save answering the next version, Launch (v3). */
  async function editLaunchSavingV3() {
    mockUpdateDocument.mockResolvedValue({
      success: true,
      document: { ...managedDocument, document_id: 'prd-3', version: 3, title: 'Launch (v3)', content: '# Edited content' },
    })
    const user = userEvent.setup()
    renderPage()
    await selectDocument(user, /Launch \(v2\)/)
    await edit(user, 'Launch (v2)', '# Edited content')
    return user
  }

  // QA s3 F4: an edit is a NEW version; the page shows the one just saved.
  it('shows the saved version after an edit, not the edited one', async () => {
    const user = await editLaunchSavingV3()
    await user.click(saveButton())

    expect(await screen.findByRole('heading', { name: 'Launch (v3)', level: 2 })).toBeInTheDocument()
    expect(screen.getByTestId('canvas-save-status')).toHaveTextContent(/Saved · v3/)
  })

  // A new version (a new id) of the same series is the same page: a half-written comment, the undo history and
  // the rail's tab stay; the canvas, which holds what was saved, is not reset.
  it('keeps the same page (and canvas) when a save makes the next version', async () => {
    const user = await editLaunchSavingV3()
    const pane = screen.getByTestId('document-detail-pane')
    const canvas = screen.getByRole('textbox', { name: 'Launch (v2)' })

    await user.click(saveButton())

    expect(await screen.findByRole('heading', { name: 'Launch (v3)', level: 2 })).toBeInTheDocument()
    expect([screen.getByTestId('document-detail-pane'), screen.getByRole('textbox', { name: 'Launch (v3)' })]).toStrictEqual([pane, canvas])
    expect(canvas).toHaveValue('# Edited content')
    expect(saveButton()).toBeDisabled()
  })
})

// e2e concurrency.spec (two tabs, one document): the second tab's save used to
// land silently on top of the first. It carries the revision it loaded, and a
// 409 shows the conflict with Load the latest / Save mine anyway.
describe('ProjectDetail document stale-save conflict', () => {
  const stale = () => new ApiError(409, 'The document was changed by someone else; reload it and try again')

  beforeEach(() => {
    primeProjectWith([customDocument])
  })

  async function editAndSave(user: User, text: string) {
    await selectDocument(user, /Notes/)
    await edit(user, 'Notes', text)
    await user.click(saveButton())
  }

  it('sends the title, the content and the revision the canvas loaded', async () => {
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')

    await waitFor(() => {
      expect(savedEdit()).toStrictEqual(['proj-1', 'doc-1', {
        title: 'Notes', content: 'my edit', expected_revision: 2, edit_id: 'string',
      }])
    })
  })

  it('a 409 shows the conflict and keeps the draft, rather than marking it saved', async () => {
    mockUpdateDocument.mockRejectedValueOnce(stale())
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(enProjectDetail.documentModal.conflict)
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('my edit')
    expect(screen.getByTestId('canvas-save-status')).toHaveTextContent(actions.status.unsaved)
  })

  it('Load the latest reloads the canvas on the other save', async () => {
    mockUpdateDocument.mockRejectedValueOnce(stale())
    const user = userEvent.setup()
    renderPage()
    await editAndSave(user, 'my edit')
    mockGetProject.mockResolvedValue({
      project, personas: [], documents: [{ ...customDocument, content: 'their edit', revision: 3 }],
    })

    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: enProjectDetail.documentModal.conflictReload }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('their edit'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await edit(user, 'Notes', 'on top of theirs')
    await user.click(saveButton())
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
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

describe('ProjectDetail unsaved changes', () => {
  beforeEach(() => {
    primeProjectWith([customDocument, otherDocument])
  })

  /** "Notes" open on its canvas with a draft that is not saved. */
  async function withDraft(): Promise<User> {
    const user = userEvent.setup()
    renderPage()
    await selectDocument(user, /Notes/)
    await edit(user, 'Notes', 'half written')
    return user
  }

  it('asks before opening another document; Cancel keeps the draft, Discard opens it', async () => {
    const user = await withDraft()

    await user.click(screen.getByRole('button', { name: /Other notes/ }))
    const dialog = await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })
    await user.click(within(dialog).getByRole('button', { name: enComponents.unsavedChanges.cancel }))
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('half written')

    await user.click(screen.getByRole('button', { name: /Other notes/ }))
    await user.click(within(await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title }))
      .getByRole('button', { name: enComponents.unsavedChanges.discard }))
    expect(await screen.findByRole('textbox', { name: 'Other notes' })).toHaveValue('other text')
    expect(mockUpdateDocument).not.toHaveBeenCalled()
  })

  it('asks before switching the project tab', async () => {
    const user = await withDraft()

    await user.click(screen.getByRole('tab', { name: /overview/i }))

    expect(await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('half written')
  })

  it('Discard on the bar goes back to the saved text', async () => {
    const user = await withDraft()

    await user.click(screen.getByRole('button', { name: actions.discard }))

    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('loaded text')
    expect(saveButton()).toBeDisabled()
  })
})

describe('ProjectDetail new document', () => {
  it('opens the created document on its canvas', async () => {
    primeProjectWith([customDocument])
    const created: ProjectDocument = { ...otherDocument, document_id: 'doc-new', title: 'Fresh page', content: 'Hello' }
    mockCreateDocument.mockResolvedValue({ success: true, document: created })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('tab', { name: /documents/i }))

    await user.click(screen.getByRole('button', { name: enProjectDetail.documents.newDocument }))
    await user.type(screen.getByPlaceholderText(enProjectDetail.documentModal.titlePlaceholder), 'Fresh page')
    await user.type(screen.getByPlaceholderText(enProjectDetail.documentModal.contentPlaceholder), 'Hello')
    await user.click(screen.getByRole('button', { name: enProjectDetail.documentModal.create }))

    expect(await screen.findByRole('textbox', { name: 'Fresh page' })).toHaveValue('Hello')
    expect(mockCreateDocument).toHaveBeenCalledWith('proj-1', { title: 'Fresh page', content: 'Hello', document_type: 'custom' })
  })
})

describe('ProjectDetail document deep link', () => {
  beforeEach(() => {
    primeProjectWith([managedDocument, legacyManagedDocument])
  })

  it('opens the document `?doc=` names — a reload, or the Decisions card link', async () => {
    renderPage('/projects/proj-1?tab=documents&doc=legacy-prfaq-2')

    expect(await screen.findByRole('heading', { name: 'Legacy launch (v2)', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Launch (v2)', level: 2 })).not.toBeInTheDocument()
  })
})
