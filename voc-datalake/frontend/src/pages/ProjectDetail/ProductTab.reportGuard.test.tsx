/**
 * The report card's pre-flight guard.
 *
 * The backend refuses to generate a report from an empty product context, but
 * that refusal happens inside the async job now that the jobs panel owns the
 * wait — so the user would pay for a job that cannot succeed and read the reason
 * as an untranslated job error. The guard has to be here, before the call.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProductTab from './ProductTab'
import type { ProductContext } from '../../api/types'

const mockGetProductContext = vi.fn()
const mockGenerateProductReport = vi.fn()
const mockListProductDocs = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProductContext: (...args: unknown[]) => mockGetProductContext(...args),
    generateProductReport: (...args: unknown[]) => mockGenerateProductReport(...args),
    updateProductContext: vi.fn(),
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
  },
}))

const readyDoc = {
  doc_id: 'doc-1',
  filename: 'strategy.pdf',
  content_type: 'application/pdf',
  size_bytes: 1024,
  status: 'ready' as const,
  error: null,
  extracted_chars: 4000,
  created_at: '2026-08-01T09:00:00Z',
}

const emptyContext: Partial<ProductContext> = {}

const filledContext: Partial<ProductContext> = {
  product_name: 'Reader',
  one_liner: 'A reading app',
}

const generateButton = () => screen.getByRole('button', { name: /generate report/i })

describe('ProductTab report guard', () => {
  // The tab's default mode renders the AI interview, whose effect scrolls the
  // transcript. jsdom has no Element.scrollTo, and the resulting exception
  // renders the whole tab as an empty div — which silently turns any "the API was
  // not called" assertion into a vacuous pass. Restored afterwards so the stub
  // cannot leak into another file's expectations.
  const realScrollTo = Element.prototype.scrollTo

  beforeAll(() => {
    Element.prototype.scrollTo = vi.fn()
  })

  afterAll(() => {
    Element.prototype.scrollTo = realScrollTo
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateProductReport.mockResolvedValue({ job_id: 'job-1' })
    mockListProductDocs.mockResolvedValue({ docs: [] })
  })

  it('refuses to start a report when no context field is filled', async () => {
    const user = userEvent.setup()
    mockGetProductContext.mockResolvedValue({ context: emptyContext })
    render(<ProductTab projectId="proj-1" />)

    await user.click(await waitFor(generateButton))

    // No billable job, and the reason is the translated string rather than a
    // raw backend message surfaced later in the jobs panel.
    expect(mockGenerateProductReport).not.toHaveBeenCalled()
    expect(screen.getByText(/Add at least one product context field/i)).toBeInTheDocument()
  })

  it('starts the report and announces it when any field is filled', async () => {
    const user = userEvent.setup()
    const onJobStarted = vi.fn()
    mockGetProductContext.mockResolvedValue({ context: filledContext })
    render(<ProductTab projectId="proj-1" onJobStarted={onJobStarted} />)

    await user.click(await waitFor(generateButton))

    await waitFor(() => expect(mockGenerateProductReport).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onJobStarted).toHaveBeenCalledTimes(1))
    expect(screen.getByText(/Report started/i)).toBeInTheDocument()
  })

  it('ignores the server-set updated_at when deciding the context is empty', async () => {
    const user = userEvent.setup()
    // A context that has been saved and then cleared carries updated_at and
    // nothing else. Treating that as "filled" would reinstate the doomed job.
    mockGetProductContext.mockResolvedValue({ context: { updated_at: '2026-08-08T10:00:00Z' } })
    render(<ProductTab projectId="proj-1" />)

    await user.click(await waitFor(generateButton))

    expect(mockGenerateProductReport).not.toHaveBeenCalled()
  })

  /**
   * The backend rule is "at least one field **or** a ready uploaded document", and
   * `errorEmpty` says exactly that. A guard that only inspected fields would tell
   * a user who uploaded a document to do what they had already done.
   */
  it('starts the report on a docs-only project, where the fields are empty', async () => {
    const user = userEvent.setup()
    mockGetProductContext.mockResolvedValue({ context: emptyContext })
    mockListProductDocs.mockResolvedValue({ docs: [readyDoc] })
    render(<ProductTab projectId="proj-1" />)

    await user.click(await waitFor(generateButton))

    await waitFor(() => expect(mockGenerateProductReport).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/Add at least one product context field/i)).not.toBeInTheDocument()
  })

  it('blocks when the only uploaded document is still being extracted', async () => {
    const user = userEvent.setup()
    mockGetProductContext.mockResolvedValue({ context: emptyContext })
    // Not `ready` ⇒ the backend will not use it, so the job would still fail.
    mockListProductDocs.mockResolvedValue({ docs: [{ ...readyDoc, status: 'pending' as const }] })
    render(<ProductTab projectId="proj-1" />)

    await user.click(await waitFor(generateButton))

    expect(mockGenerateProductReport).not.toHaveBeenCalled()
  })

  it('defers to the backend when the document list cannot be read', async () => {
    const user = userEvent.setup()
    mockGetProductContext.mockResolvedValue({ context: emptyContext })
    mockListProductDocs.mockRejectedValue(new Error('network'))
    render(<ProductTab projectId="proj-1" />)

    await user.click(await waitFor(generateButton))

    // Failing open: a list call that fails is no reason to block the user.
    await waitFor(() => expect(mockGenerateProductReport).toHaveBeenCalledTimes(1))
  })

  it('does not ask for the document list when a field is already filled', async () => {
    const user = userEvent.setup()
    mockGetProductContext.mockResolvedValue({ context: filledContext })
    render(<ProductTab projectId="proj-1" />)

    await user.click(await waitFor(generateButton))

    await waitFor(() => expect(mockGenerateProductReport).toHaveBeenCalledTimes(1))
    // The common path must not pay for the guard. DocsUpload lists docs for its
    // own pane, so assert on calls made after the click rather than zero calls.
    expect(mockListProductDocs.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
