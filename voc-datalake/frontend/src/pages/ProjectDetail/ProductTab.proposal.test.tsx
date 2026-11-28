/**
 * @fileoverview The Product tab with an extract's proposal (7.104.00): an open proposal is reviewed full width above
 * the form, and each field it proposes shows a "Proposed" badge that scrolls to its row; an accept reads the form's
 * shared context again; a proposal that closed under an accept says so outside the review; a failed read of the
 * proposal says so with Try again; a dismissed or superseded proposal is history (no review, no badge); a badge arriving keeps a
 * field's unsaved draft and its focus (the control is never remounted). The gaps panel sits beside the form with the
 * proposal's questions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { projectJobsKey } from '../../api/projectQueryKeys'
import { ApiError } from '../../lib/errors'
import { companyStripModule, productTabApiModule, productTabMocks } from './product-tab-fixtures'
// After the fixtures on purpose: this imports ProductTab, whose module graph runs the `vi.mock` factories below.
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import { extractJob, fieldProposal, latestOf, proposalOf } from './product-sources-fixtures'
import { productProposalKey } from './useProductProposal'
import type { ProductProposal } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => ({
  projectsApi: { ...productTabApiModule().projectsApi, acceptProductProposal: (...args: unknown[]) => accept(...args) },
}))
vi.mock('./CompanyContextStrip', () => companyStripModule())
const accept = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>())

const NAME = fieldProposal({ status: 'proposed', value: 'Parcel Pilot', confidence: 'high' })

function serve(proposal: ProductProposal) {
  productTabMocks.getLatestProductProposal.mockResolvedValue(latestOf(proposal))
}

beforeEach(() => {
  vi.clearAllMocks()
  productTabMocks.getProductContext.mockResolvedValue({ context: emptyProductContext() })
  productTabMocks.listProductDocs.mockResolvedValue({ docs: [] })
  // vi.clearAllMocks keeps an implementation: a test that served a completed extract would read the proposal again.
  productTabMocks.getJobs.mockResolvedValue({ success: true, jobs: [] })
  accept.mockResolvedValue({ applied: ['product_name'], conflicts: [], status: 'applied' })
})

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

describe('ProductTab with a proposal', () => {
  it('reviews an open proposal above the form, with a Proposed badge on its field that scrolls to the row', async () => {
    // jsdom implements no scrolling: the badge's call is what is checked.
    const scrolled = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrolled, configurable: true, writable: true })
    serve(proposalOf({ product_name: NAME }, { questions: [{ field: 'differentiators', question: 'What makes it different?' }] }))
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)
    const review = await screen.findByRole('region', { name: /proposed product description/i })
    const form = screen.getByRole('region', { name: 'The product' })
    expect(review.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const badge = screen.getByRole('button', { name: 'Proposed: review the proposed value of Product name' })
    // Review Q8 (7.104.00 round 2): a target of at least 24 x 24 px.
    expect(badge).toHaveClass('min-h-6', 'min-w-6')
    await user.click(badge)
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: 'Questions' })).toHaveTextContent('What makes it different?')
  })

  it('reads the form\'s context again after an accept', async () => {
    serve(proposalOf({ product_name: NAME }))
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)
    await user.click(await screen.findByRole('button', { name: 'Accept selected' }))
    await waitFor(() => expect(accept).toHaveBeenCalledWith('proj-1', 'pp-1', { fields: { product_name: { seen: '' } } }))
    await waitFor(() => expect(productTabMocks.getProductContext).toHaveBeenCalledTimes(2))
  })

  it('keeps a field\'s unsaved draft and its focus when an extract completes with a proposal for it', async () => {
    const client = createTestQueryClient()
    productTabMocks.getJobs.mockResolvedValue({ success: true, jobs: [extractJob()] })
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />, client)
    const features = await screen.findByLabelText('Key features')
    await user.click(features)
    await user.type(features, 'Live arrival window')
    productTabMocks.getJobs.mockResolvedValue({ success: true, jobs: [extractJob({ status: 'completed', progress: 100, result: { proposal_id: 'pp-1' } })] })
    serve(proposalOf({ key_features: fieldProposal({ status: 'proposed', value: 'Route alerts', confidence: 'high' }) }))
    await act(() => client.invalidateQueries({ queryKey: projectJobsKey('proj-1') }))
    await screen.findByRole('button', { name: 'Proposed: review the proposed value of Key features' })
    const after = screen.getByLabelText('Key features')
    expect(after).toBe(features)
    expect(after).toHaveValue('Live arrival window')
    expect(after).toHaveFocus()
    expect(productTabMocks.updateProductContext).not.toHaveBeenCalled()
  })

  // Review Q3 (7.104.00 round 2): the accept's answer reads the proposal again before its error reaches the review,
  // which that read removed (dismissed) or replaced (superseded, a new proposal id resets the mutation): the line
  // never showed. The tab keeps it, outside the review. Review Q1 (7.72.00 gate, round 3): beside the newer proposal
  // under review it said "Extract again", which that proposal makes needless; it says so in its own words.
  const CLOSED = 'This proposal was replaced by a newer extract or dismissed. Extract again for a new one.'
  const REPLACED = 'This proposal was replaced by the newer proposal below.'
  it.each([
    ['dismissed', () => latestOf(proposalOf({ product_name: NAME }, { status: 'dismissed' })), CLOSED, false],
    ['superseded by a newer one under review',
      () => latestOf(proposalOf({ product_name: NAME }, { proposal_id: 'pp-2', job_id: 'job-2' })), REPLACED, true],
    ['superseded by a newer one dismissed too',
      () => latestOf(proposalOf({ product_name: NAME }, { proposal_id: 'pp-2', job_id: 'job-2', status: 'dismissed' })),
      CLOSED, false],
  ] as const)('says the proposal closed when the latest answer turned %s under an accept', async (_case, after, line, reviewed) => {
    productTabMocks.getLatestProductProposal
      .mockResolvedValueOnce(latestOf(proposalOf({ product_name: NAME })))
      .mockResolvedValue(after())
    accept.mockRejectedValue(new ApiError(409, 'This proposal is closed: extract again for a new one', 'proposal_closed'))
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)
    await user.click(await screen.findByRole('button', { name: 'Accept selected' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(line)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByRole('region', { name: /proposed product description/i }) !== null).toBe(reviewed)
  })

  it('clears the closed line once another proposal is read', async () => {
    const client = createTestQueryClient()
    productTabMocks.getLatestProductProposal
      .mockResolvedValueOnce(latestOf(proposalOf({ product_name: NAME })))
      .mockResolvedValue(latestOf(proposalOf({ product_name: NAME }, { proposal_id: 'pp-2', job_id: 'job-2' })))
    accept.mockRejectedValueOnce(new ApiError(409, 'This proposal is closed: extract again for a new one', 'proposal_closed'))
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />, client)
    await user.click(await screen.findByRole('button', { name: 'Accept selected' }))
    await screen.findByText(REPLACED)
    productTabMocks.getLatestProductProposal.mockResolvedValue(
      latestOf(proposalOf({ product_name: NAME }, { proposal_id: 'pp-3', job_id: 'job-3' })))
    await act(() => client.invalidateQueries({ queryKey: productProposalKey('proj-1') }))
    await waitFor(() => expect(screen.queryByText(REPLACED)).not.toBeInTheDocument())
  })

  it('says a failed read of the proposal, with Try again, instead of showing none', async () => {
    productTabMocks.getLatestProductProposal
      .mockRejectedValueOnce(new ApiError(500, 'Internal server error'))
      .mockResolvedValue(latestOf(proposalOf({ product_name: NAME })))
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent("The extract's proposal could not be loaded.")
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('region', { name: /proposed product description/i })).toBeInTheDocument()
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument()
  })

  it.each(['dismissed', 'superseded', 'applied'] as const)('shows no review and no badge for a %s proposal', async (status) => {
    serve(proposalOf({ product_name: NAME }, { status }))
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)
    await screen.findByLabelText(/product name/i)
    await waitFor(() => expect(productTabMocks.getLatestProductProposal).toHaveBeenCalledWith('proj-1'))
    expect(screen.queryByRole('region', { name: /proposed product description/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Proposed:/ })).not.toBeInTheDocument()
  })
})
