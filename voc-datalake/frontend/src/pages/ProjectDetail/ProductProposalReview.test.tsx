/**
 * The proposal review (7.104.00): rows grouped as Proposed, Conflicts, Gaps and Unchanged; each proposed row's current
 * value and who wrote it, the proposed value (editable), the confidence and the citations (an unverified quote and a
 * deleted source marked); Accept selected, Accept all proposed (proposed rows only, leaving out a field changed since
 * the extract), a conflict only on its own selection, an accept against a changed field's new value, the answer's
 * conflicts, a 409 that reads the proposal again, a proposal closed meanwhile (the tab's line, not the review's), a
 * selected row that changed since unselected, the outcome cleared by a newer proposal, Dismiss, and the viewer who
 * accepts nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { SIGNED_IN_SUB, fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { PROJECT, fieldProposal, latestOf, proposalOf } from './product-sources-fixtures'
import ProductProposalReview from './ProductProposalReview'
import { productProposalKey, useProductProposal } from './useProductProposal'
import type { QueryClient } from '@tanstack/react-query'
import type { ProductFieldProposal, ProductProposalLatest } from '../../api/projectTypes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', async (importOriginal) => (await import('@test/fetchApiRoutes')).authStoreWithOriginal(importOriginal))

const LATEST = `/projects/${PROJECT}/product-proposals/latest`
const ACCEPT = `/projects/${PROJECT}/product-proposals/pp-1/accept`

const NAME = fieldProposal({
  status: 'proposed', value: 'Parcel Pilot', confidence: 'high',
  citations: [{ source_id: 'S1', quote: 'Parcel Pilot tells you when', page: 2, verified: true }],
})
const SUMMARY = fieldProposal({
  status: 'proposed', value: 'A delivery-tracking app.', confidence: 'medium', seen: '', current: 'Tracks parcels.', changed_since: true,
  citations: [{ source_id: 'S2', quote: 'tracking app', page: null, verified: false }],
})
const FEATURES = fieldProposal({ status: 'conflict', value: 'Live arrival window', seen: 'Maps', current: 'Maps', note: 'The deck contradicts the typed value.' })

function latest(): ProductProposalLatest {
  return latestWith(NAME)
}

/** The same answer with another Product name row. */
function latestWith(name: ProductFieldProposal): ProductProposalLatest {
  return latestOf(proposalOf({ product_name: name, product_summary: SUMMARY, key_features: FEATURES, free_form_notes: fieldProposal({ status: 'unchanged' }) }, {
    sources: [
      { source_id: 'S1', doc_id: 'doc-1', name: 'brief.md', kind: 'file', chars_sent: 900, cut: false, deleted: false },
      { source_id: 'S2', doc_id: 'doc-2', name: 'pricing.pdf', kind: 'file', chars_sent: 900, cut: false, deleted: true },
    ],
  }), {
    field_meta: {
      product_summary: { by: 'person', sub: SIGNED_IN_SUB, at: '2026-11-25T10:00:00Z' },
      key_features: { by: 'person', sub: 'someone-else', at: '2026-11-25T10:00:00Z' },
    },
  })
}

function Harness({ canEdit }: Readonly<{ canEdit: boolean }>) {
  const state = useProductProposal(PROJECT)
  const proposal = state.latest?.proposal ?? null
  if (state.latest === undefined || proposal === null) return <p>No proposal</p>
  return <ProductProposalReview latest={state.latest} proposal={proposal} state={state} canEdit={canEdit} />
}

async function renderReview({
  canEdit = true,
  accept = (): unknown => ({ applied: ['product_name'], conflicts: [], status: 'partly_applied' }),
  dismiss = (): unknown => ({ proposal_id: 'pp-1', status: 'dismissed' }),
  latestAnswer = latest,
  client = createTestQueryClient(),
}: {
  canEdit?: boolean; accept?: RouteHandler; dismiss?: RouteHandler; latestAnswer?: RouteHandler; client?: QueryClient
} = {}) {
  routeFetchApi({
    [`GET ${LATEST}`]: latestAnswer,
    [`POST ${ACCEPT}`]: accept,
    [`POST /projects/${PROJECT}/product-proposals/pp-1/dismiss`]: dismiss,
  })
  renderWithQueryClient(<Harness canEdit={canEdit} />, client)
  await screen.findByRole('heading', { name: /proposed product description/i })
}

/** The review, its latest answer a mock a test changes, and a way to read it again (the page's refetch). */
async function renderRereadable() {
  const client = createTestQueryClient()
  const answer = vi.fn(latest)
  await renderReview({ latestAnswer: answer, client })
  return { user: userEvent.setup(), answer, reread: () => act(() => client.invalidateQueries({ queryKey: productProposalKey(PROJECT) })) }
}

/** The server's refusal of an accept or a dismiss on a proposal no longer open (shared/product_proposals.py). */
const closed = (): never => { throw new ApiError(409, 'This proposal is closed: extract again for a new one', 'proposal_closed') }

const row = (field: string): HTMLElement => {
  const element = document.getElementById(`product-proposal-${field}`)
  if (element === null) throw new Error(`no row for ${field}`)
  return element
}

beforeEach(() => {
  resetFetchApi()
})

describe('ProductProposalReview', () => {
  it('groups the rows: Proposed, Conflicts, Gaps (named together) and Unchanged', async () => {
    await renderReview()
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toStrictEqual(['Proposed', 'Conflicts', 'Gaps', 'Unchanged'])
    expect(screen.getByText(/One-liner · Current state · Target users/)).toBeInTheDocument()
  })

  it('shows each value beside the current one and who wrote it, with its confidence and citations', async () => {
    await renderReview()
    const name = within(row('product_name'))
    expect(name.getByText('High confidence')).toBeInTheDocument()
    expect(name.getByRole('list', { name: 'Citations' })).toHaveTextContent('brief.md · p. 2“Parcel Pilot tells you when”')
    expect(within(row('key_features')).getByText(/typed by a teammate/)).toBeInTheDocument()
  })

  it('marks a quote not found in its source, a deleted source and a value with no verified source', async () => {
    await renderReview()
    const summary = within(row('product_summary'))
    expect(summary.getByText(/Current · typed by you/)).toBeInTheDocument()
    expect(summary.getByRole('list', { name: 'Citations' })).toHaveTextContent(/pricing\.pdf · source deleted.*not found in the source/)
    expect(summary.getByText('No verified source')).toBeInTheDocument()
  })

  it('accepts the selected field against the value it was proposed against', async () => {
    const user = userEvent.setup()
    await renderReview()
    expect(screen.getByRole('checkbox', { name: 'Accept Product name' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Accept What the product does' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    await waitFor(() => expect(sentFetchApiBody(ACCEPT, 'POST')).toStrictEqual({ fields: { product_name: { seen: '' } } }))
    expect(await screen.findByText('1 field applied.')).toBeInTheDocument()
  })

  it('sends an edited value, and accepts a field changed since the extract against its new value', async () => {
    const user = userEvent.setup()
    await renderReview()
    const edit = screen.getByLabelText('Proposed value for Product name')
    await user.clear(edit)
    await user.type(edit, 'Parcel Pilot Go')
    await user.click(screen.getByRole('checkbox', { name: 'Accept What the product does' }))
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    await waitFor(() => expect(sentFetchApiBody(ACCEPT, 'POST')).toStrictEqual({ fields: {
      product_summary: { seen: 'Tracks parcels.' }, product_name: { seen: '', value: 'Parcel Pilot Go' },
    } }))
  })

  it('accepts all proposed rows only, leaving out the field changed since the extract and the conflict', async () => {
    const user = userEvent.setup()
    await renderReview()
    expect(within(row('product_summary')).getByText(/Changed since the extract/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Accept Key features' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Accept all proposed' }))
    await waitFor(() => expect(sentFetchApiBody(ACCEPT, 'POST')).toStrictEqual({ fields: { product_name: { seen: '' } } }))
  })

  it('accepts a conflict only when it is selected on its own', async () => {
    const user = userEvent.setup()
    await renderReview()
    await user.click(screen.getByRole('checkbox', { name: 'Accept Product name' }))
    await user.click(screen.getByRole('checkbox', { name: 'Accept Key features' }))
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    await waitFor(() => expect(sentFetchApiBody(ACCEPT, 'POST')).toStrictEqual({ fields: { key_features: { seen: 'Maps' } } }))
  })

  it('says each field the accept did not write, and why', async () => {
    const user = userEvent.setup()
    await renderReview({ accept: () => ({ applied: [], conflicts: [{ field: 'product_name', reason: 'changed' }, { field: 'key_features', reason: 'person_value' }], status: 'open' }) })
    await user.click(screen.getByRole('button', { name: 'Accept all proposed' }))
    expect(await screen.findByText('Product name changed since the extract and was not applied.')).toBeInTheDocument()
    expect(screen.getByText('Key features holds a value a person typed and was not replaced.')).toBeInTheDocument()
  })

  it('reads the proposal again after a 409, and says every selected field changed', async () => {
    const user = userEvent.setup()
    await renderReview({ accept: () => { throw new ApiError(409, 'Every field changed since the extract, or is a value a person typed', 'conflict') } })
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    expect(await screen.findByText(/Every selected field changed since the extract/)).toBeInTheDocument()
    await waitFor(() => expect(fetchApi.mock.calls.filter(([path]) => path === LATEST).length).toBeGreaterThan(1))
  })

  it('leaves a proposal replaced or dismissed meanwhile to the Product tab\'s line, for an accept and a dismiss', async () => {
    // Review Q3 (7.104.00 round 2): the answer's read of the proposal replaces or removes this review, so the line is
    // the tab's (ProductTab.proposal.test.tsx); the review says nothing of its own, never "every field changed".
    const user = userEvent.setup()
    await renderReview({ accept: closed, dismiss: closed })
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    await waitFor(() => expect(fetchApi.mock.calls.filter(([path]) => path === LATEST).length).toBeGreaterThan(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(fetchApi.mock.calls.filter(([path]) => path === LATEST).length).toBeGreaterThan(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('unselects a selected row whose field changed since, until the person selects it again', async () => {
    // Review Q4 (7.104.00 round 2): a pre-selected row stayed checked after the proposal was read again with its field
    // changed (someone typed in the form), so Accept selected wrote over the value just typed.
    const { user, answer, reread } = await renderRereadable()
    const name = () => screen.getByRole('checkbox', { name: 'Accept Product name' })
    expect(name()).toBeChecked()
    answer.mockReturnValue(latestWith({ ...NAME, current: 'Typed just now', changed_since: true }))
    await reread()
    await waitFor(() => expect(name()).not.toBeChecked())
    expect(screen.getByRole('button', { name: 'Accept selected' })).toBeDisabled()
    await user.click(name())
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    await waitFor(() => expect(sentFetchApiBody(ACCEPT, 'POST')).toStrictEqual({ fields: { product_name: { seen: 'Typed just now' } } }))
  })

  it('clears the last accept\'s outcome once a newer proposal arrives', async () => {
    const { user, answer, reread } = await renderRereadable()
    await user.click(screen.getByRole('button', { name: 'Accept selected' }))
    expect(await screen.findByText('1 field applied.')).toBeInTheDocument()
    answer.mockReturnValue(latestOf(proposalOf({ product_name: NAME }, { proposal_id: 'pp-2', job_id: 'job-2' })))
    await reread()
    await waitFor(() => expect(screen.queryByText('1 field applied.')).not.toBeInTheDocument())
    expect(screen.getByRole('checkbox', { name: 'Accept Product name' })).toBeChecked()
  })

  it('dismisses the proposal', async () => {
    const user = userEvent.setup()
    await renderReview()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`/projects/${PROJECT}/product-proposals/pp-1/dismiss`, expect.objectContaining({ method: 'POST' })))
  })

  it('for a viewer, shows the proposal with no checkbox, editor, accept or dismiss', async () => {
    await renderReview({ canEdit: false })
    expect(screen.getByText('Parcel Pilot')).toBeInTheDocument()
    expect([...screen.queryAllByRole('checkbox'), ...screen.queryAllByRole('textbox'), ...screen.queryAllByRole('button')]).toStrictEqual([])
    expect(screen.getByText(/Only an editor of this project can accept/)).toBeInTheDocument()
  })
})
