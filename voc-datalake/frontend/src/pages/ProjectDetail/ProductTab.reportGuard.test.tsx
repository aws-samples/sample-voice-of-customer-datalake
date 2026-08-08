/**
 * The report card's pre-flight guard.
 *
 * The backend refuses to generate a report from an empty product context, but
 * that refusal happens inside the async job now that the jobs panel owns the
 * wait — so the user would pay for a job that cannot succeed and read the reason
 * as an untranslated job error. The guard has to be here, before the call.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProductTab from './ProductTab'
import type { ProductContext } from '../../api/types'

const mockGetProductContext = vi.fn()
const mockGenerateProductReport = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProductContext: (...args: unknown[]) => mockGetProductContext(...args),
    generateProductReport: (...args: unknown[]) => mockGenerateProductReport(...args),
    updateProductContext: vi.fn(),
    listProductDocs: vi.fn().mockResolvedValue({ docs: [] }),
  },
}))

const emptyContext: Partial<ProductContext> = {}

const filledContext: Partial<ProductContext> = {
  product_name: 'Reader',
  one_liner: 'A reading app',
}

const generateButton = () => screen.getByRole('button', { name: /generate report/i })

describe('ProductTab report guard', () => {
  beforeAll(() => {
    // The tab's default mode renders the AI interview, whose effect scrolls the
    // transcript. jsdom has no Element.scrollTo, and the resulting exception
    // renders the whole tab as an empty div — which silently turns any
    // "the API was not called" assertion into a vacuous pass.
    Element.prototype.scrollTo = vi.fn()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateProductReport.mockResolvedValue({ job_id: 'job-1' })
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
})
