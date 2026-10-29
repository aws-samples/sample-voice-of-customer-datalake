/**
 * A PR/FAQ / PRD with its comments in the project's document pane: threads in the margin beside
 * their quote, on the whole document, or "Not found in this version"; the author and resolved
 * filters; comment, reply, resolve and delete through the team routes; the persona review and
 * the share button for editors only; and the document shown even when comments cannot load.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { stubRangeLayout } from '@test/stubRangeLayout'
import { useAuthStore } from '../../store/authStore'
import type { ProjectDocument } from '../../api/types'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
const runAssistJob = vi.fn<() => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))
vi.mock('../../api/assistJobs', () => ({ runAssistJob: () => runAssistJob() }))

const { default: DocumentReviewView } = await import('./DocumentReviewView')

const BASE = '/projects/proj_1/documents/doc_2'
const MARKDOWN = '## Customer problem\n\nCustomers wait two weeks for a refund.'
const DOCUMENT: ProjectDocument = {
  document_id: 'doc_2', document_type: 'prfaq', title: 'Faster refunds', content: MARKDOWN, created_at: '2026-10-28', version: 2,
}

const author = (kind: 'user' | 'persona' | 'reviewer', name: string, extra: Record<string, string> = {}) => ({ kind, name, ...extra })

function thread(id: string, extra: Record<string, unknown>) {
  return {
    comment_id: id, document_id: 'doc_2', version: 2, text: `Comment ${id}`, anchor: null, status: 'open', flagged: false,
    created_at: '2026-10-28T10:00:00Z', author: author('user', 'Rui', { sub: 'sub-rui' }), replies: [], from_review_link: false, ...extra,
  }
}

const anchored = (exact: string) => ({ exact, prefix: '', suffix: '', heading: '' })

const THREADS = [
  thread('c_whole', { text: 'Who is the customer?' }),
  thread('c_quote', { text: 'Name the refund method.', anchor: anchored('two weeks'), author: author('reviewer', 'sam@example.com') }),
  thread('c_gone', { text: 'Old wording', anchor: anchored('three months'), document_id: 'doc_1', version: 1,
    author: author('persona', 'Budget Priya', { persona_id: 'p1' }) }),
  thread('c_done', { text: 'Fixed typo', status: 'resolved' }),
]

function serve({ canEdit = true, threads = THREADS }: { canEdit?: boolean; threads?: unknown[] } = {}) {
  fetchApi.mockImplementation((endpoint, options) => {
    if (endpoint === `${BASE}/comments` && options?.method === undefined) {
      return Promise.resolve({ threads, share: null, can_edit: canEdit })
    }
    return Promise.resolve({ thread: thread('c_new', {}) })
  })
}

function renderView(hasPersonas = true) {
  renderWithQueryClient(<DocumentReviewView projectId="proj_1" document={DOCUMENT} markdown={MARKDOWN} hasPersonas={hasPersonas} />)
}

const threadBy = (name: string) => screen.findByRole('article', { name: `Comment by ${name}` })
const writes = () => fetchApi.mock.calls.filter(([, options]) => options?.method !== undefined)

beforeAll(() => stubRangeLayout())

beforeEach(() => {
  fetchApi.mockReset()
  runAssistJob.mockReset()
  useAuthStore.getState().setUser({ username: 'rui', email: 'rui@example.com', groups: [], sub: 'sub-rui' })
  serve()
})

describe('the comment threads', () => {
  it('places whole-document, quoted and no-longer-found threads, hiding resolved ones', async () => {
    renderView()

    expect(await screen.findByText('Name the refund method.')).toBeInTheDocument()
    const outdated = screen.getByRole('heading', { name: 'Not found in this version' }).closest('section')
    expect(outdated).toHaveTextContent('Old wording')
    expect(screen.getByRole('heading', { name: 'On the whole document' }).closest('section')).toHaveTextContent('Who is the customer?')
    expect(screen.queryByText('Fixed typo')).not.toBeInTheDocument()
  })

  it('marks a thread made on an older version', async () => {
    renderView()

    expect(await threadBy('Budget Priya')).toHaveTextContent('On v1')
  })

  it('shows resolved threads on request', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Who is the customer?')

    await user.click(screen.getByRole('checkbox', { name: 'Show resolved' }))

    expect(await screen.findByText('Fixed typo')).toBeInTheDocument()
  })
})

describe('commenting', () => {
  it('comments on the whole document', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Who is the customer?')

    await user.click(screen.getByRole('button', { name: 'Comment on the whole document' }))
    await user.type(screen.getByLabelText('Add a comment'), 'Add a FAQ on fees')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(writes()).toStrictEqual([
      [`${BASE}/comments`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Add a FAQ on fees' }) })],
    ]))
  })

  it('replies to a thread', async () => {
    const user = userEvent.setup()
    renderView()
    const card = await threadBy('sam@example.com')

    await user.click(within(card).getByRole('button', { name: 'Reply' }))
    await user.type(within(card).getByLabelText('Write a reply'), 'Bank transfer')
    await user.click(within(card).getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`${BASE}/comments/c_quote/replies`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Bank transfer' }) })))
  })

  it('resolves a thread', async () => {
    const user = userEvent.setup()
    renderView()

    await user.click(within(await threadBy('sam@example.com')).getByRole('button', { name: 'Resolve' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`${BASE}/comments/c_quote/resolve`, expect.objectContaining({ method: 'POST' })))
  })

  it('lets a viewer delete only their own threads', async () => {
    serve({ canEdit: false })
    renderView()

    expect(within(await threadBy('Rui')).getByRole('button', { name: 'Delete comment' })).toBeInTheDocument()
    expect(within(await threadBy('sam@example.com')).queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument()
  })
})

describe('the review toolbar', () => {
  it('asks personas to review and says how many comments they filed', async () => {
    runAssistJob.mockResolvedValue({ filed: 3, personas: [{ persona_id: 'p1' }, { persona_id: 'p2' }] })
    const user = userEvent.setup()
    renderView()

    await user.click(await screen.findByRole('button', { name: 'Ask personas to review' }))

    expect(await screen.findByRole('status')).toHaveTextContent('3 comments filed (2 personas asked)')
  })

  it('cannot ask personas when the project has none', async () => {
    renderView(false)

    expect(await screen.findByRole('button', { name: 'Ask personas to review' })).toBeDisabled()
  })

  it('opens the share dialog', async () => {
    const user = userEvent.setup()
    renderView()

    await user.click(await screen.findByRole('button', { name: 'Share for review' }))

    expect(screen.getByRole('dialog', { name: 'Share for review' })).toBeInTheDocument()
  })

  it('offers neither to a viewer', async () => {
    serve({ canEdit: false })
    renderView()
    await screen.findByText('Who is the customer?')

    expect(screen.queryByRole('button', { name: 'Ask personas to review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share for review' })).not.toBeInTheDocument()
  })
})

describe('when comments cannot load', () => {
  it('still shows the document, with a warning', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderView()

    expect(await screen.findByRole('alert')).toHaveTextContent('Comments could not be loaded.')
    expect(screen.getByText('Customers wait two weeks for a refund.')).toBeInTheDocument()
  })
})
