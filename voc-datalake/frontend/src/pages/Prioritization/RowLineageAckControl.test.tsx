/**
 * The "Keep both versions" toggle (#399) and the quiet acknowledged badge.
 *
 * Mounted in isolation with the rows API mocked: what is pinned is the request each
 * press sends (the set on screen, the direction), the re-read it triggers, and that the
 * badge renders the acknowledged state in words. Whether a row IS acknowledged is
 * `lineageAck.test.ts`'s concern.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import { RowLineageAckControl } from './RowLineageAckControl'
import { RowLineageBadge } from './RowLineagePanels'
import { PRIORITIZATION_SCORES_KEY } from './prioritizationKeys'
import { doc } from './prioritization-unit-fixtures'
import type { RowLineage } from './rowLineage'

const mockSetRowLineageAck = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('../../api/prioritizationRowsApi', () => ({
  prioritizationRowsApi: {
    setRowLineageAck: (rowId: string, input: unknown) => mockSetRowLineageAck(rowId, input),
  },
}))

const t = (key: string) => i18n.t(key, { ns: 'prioritization' })

const crossing: RowLineage = { state: 'crossGeneration', reason: 'repeatedType', stale: false, fresherDocumentIds: [] }
const documents = [doc('prd_2', 'prd', 'PRD v2', '2026-02-01'), doc('prd_1', 'prd', 'PRD v1', '2026-01-01')]
const rowWith = (lineage: RowLineage) => ({ row_id: 'row-1', project_id: 'p1', documents, lineage })

function mount(lineage: RowLineage) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <RowLineageAckControl row={rowWith(lineage)} />
    </QueryClientProvider>,
  )
  return { invalidate }
}

beforeEach(() => {
  mockSetRowLineageAck.mockReset()
  mockSetRowLineageAck.mockResolvedValue({ success: true })
})

describe('RowLineageAckControl', () => {
  it('marks a crossing row intentional for the documents on screen and re-reads the page', async () => {
    const { invalidate } = mount(crossing)

    await userEvent.click(screen.getByRole('button', { name: t('lineage.acknowledge') }))

    expect(mockSetRowLineageAck).toHaveBeenCalledWith('row-1', {
      project_id: 'p1', acknowledged: true, document_ids: ['prd_2', 'prd_1'],
    })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: PRIORITIZATION_SCORES_KEY }))
  })

  it('offers Undo on an acknowledged row, which withdraws the mark', async () => {
    mount({ ...crossing, acknowledged: true })

    expect(screen.getByText(t('lineage.acknowledgedNote'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('lineage.acknowledge') })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: t('lineage.acknowledgeUndo') }))

    expect(mockSetRowLineageAck).toHaveBeenCalledWith('row-1', expect.objectContaining({ acknowledged: false }))
  })

  it('says so when the change could not be saved', async () => {
    mockSetRowLineageAck.mockRejectedValue(new Error('API Error: 409'))
    mount(crossing)

    await userEvent.click(screen.getByRole('button', { name: t('lineage.acknowledge') }))

    expect(await screen.findByRole('alert')).toHaveTextContent(t('lineage.acknowledgeFailed'))
  })

  it('renders nothing on a row that does not cross generations', () => {
    mount({ ...crossing, state: 'coherent', reason: 'oneChain' })

    expect(screen.queryByTestId('row-lineage-ack')).not.toBeInTheDocument()
  })
})

describe('RowLineageBadge on an acknowledged row', () => {
  it('shows the quiet acknowledged label instead of the warning', () => {
    render(<RowLineageBadge lineage={{ ...crossing, acknowledged: true }} />)

    const badge = screen.getByTestId('row-lineage')
    expect(badge).toHaveAttribute('data-lineage', 'acknowledged')
    expect(badge).toHaveTextContent(t('lineage.acknowledged'))
    expect(badge).toHaveTextContent(t('lineage.acknowledgedReason'))
    expect(badge).not.toHaveTextContent(t('lineage.crossGeneration'))
  })

  it('still warns on a crossing nobody acknowledged', () => {
    render(<RowLineageBadge lineage={crossing} />)

    expect(screen.getByTestId('row-lineage')).toHaveAttribute('data-lineage', 'crossGeneration')
    expect(screen.getByTestId('row-lineage')).toHaveTextContent(t('lineage.crossGeneration'))
  })
})
