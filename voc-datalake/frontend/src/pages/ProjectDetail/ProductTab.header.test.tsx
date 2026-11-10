/**
 * @fileoverview The Product tab's header and sections: "Fill with AI assistant" opens
 * the assistant on a NEW conversation with the interview request as its (unsent)
 * draft, on this project's page context, and only for someone who can edit; the
 * header reports completeness and the last save; every product field has a place in
 * one of the form's sections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { companyStripModule, productTabApiModule, productTabMocks } from './product-tab-fixtures'
// After the fixtures on purpose: this imports ProductTab, whose module graph runs
// the `vi.mock` factory below, which needs the fixture module evaluated.
import ProductTab from './ProductTab'
import { emptyProductContext, PRODUCT_CONTEXT_FIELD_COUNT } from './productContextFields'
import { pageContextFromLocation } from '../../assistant/page/pageContext'
import { useAssistantUiStore, useThreadStore } from '../../assistant/store/assistantStore'

vi.mock('../../api/projectsApi', () => productTabApiModule())
vi.mock('./CompanyContextStrip', () => companyStripModule())
const { getProductContext: mockGetProductContext, listProductDocs: mockListProductDocs } = productTabMocks

const INTERVIEW_REQUEST = "Interview me to fill in this project's product description."
const fillButton = () => screen.queryByRole('button', { name: /fill with ai assistant/i })

describe('ProductTab header', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAssistantUiStore.getState().reset()
    useThreadStore.getState().reset()
    mockListProductDocs.mockResolvedValue({ docs: [] })
    mockGetProductContext.mockResolvedValue({ context: emptyProductContext() })
  })

  // A NEW conversation is openAssistant's own contract (openAssistant.test.ts); here: the button uses it.
  it('opens the assistant panel with the interview request drafted, not sent', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)

    await user.click(await screen.findByRole('button', { name: /fill with ai assistant/i }))

    const ui = useAssistantUiStore.getState()
    expect({ open: ui.open, draft: ui.pendingDraft?.text }).toStrictEqual({ open: true, draft: INTERVIEW_REQUEST })
    expect(useThreadStore.getState().thread.messages).toStrictEqual([])
  })

  it('sends that request with this project as the page context', () => {
    expect(pageContextFromLocation({ pathname: '/projects/proj-1', search: '?tab=product' }))
      .toStrictEqual({ kind: 'project', path: '/projects/proj-1', tab: 'product', projectId: 'proj-1' })
  })

  it('is not offered to a viewer, whose interview could only end in a refused write', async () => {
    renderWithQueryClient(<ProductTab canEdit={false} projectId="proj-1" />)
    await screen.findByLabelText(/product name/i)

    expect(fillButton()).not.toBeInTheDocument()
  })

  it('reports how complete the description is and when it was last saved', async () => {
    mockGetProductContext.mockResolvedValue({
      context: { ...emptyProductContext(), product_name: 'Acme Go', one_liner: 'Rides', updated_at: '2026-03-04T10:00:00Z' },
    })
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)

    expect(await screen.findByText(`2 of ${PRODUCT_CONTEXT_FIELD_COUNT} fields filled`)).toBeInTheDocument()
    expect(screen.getByText(/^Last saved Mar 4, 2026/)).toBeInTheDocument()
  })

  it('says a never-saved description is not saved yet', async () => {
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)

    expect(await screen.findByText('Not saved yet')).toBeInTheDocument()
  })
})

describe('ProductTab sections', () => {
  beforeEach(() => {
    mockListProductDocs.mockResolvedValue({ docs: [] })
    mockGetProductContext.mockResolvedValue({ context: emptyProductContext() })
  })

  it('groups the form into five titled sections, holding every product field once', async () => {
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />)
    await screen.findByLabelText(/product name/i)

    for (const title of ['The product', 'Customers and problem', 'Offering', 'Goals and boundaries', 'Notes']) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument()
    }
    const labels = [
      /product name/i, /one-liner/i, /current state/i, /target users/i, /problem solved/i, /key features/i,
      /differentiators/i, /success metrics/i, /known limitations/i, /non-goals/i, /notes \(anything else\)/i,
    ]
    expect(labels.map((label) => screen.getAllByLabelText(label).length)).toStrictEqual(labels.map(() => 1))
    expect(labels).toHaveLength(PRODUCT_CONTEXT_FIELD_COUNT)
  })
})
