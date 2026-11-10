/**
 * The Data Sources step's "Feature requests" card: off by default, the board picker only once ticked
 * (archived boards never offered), unticking clears the picked boards, and the context summary names
 * what will be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { SEEDED_BOARD } from '../../api/featureBoardsSchema'
import { contextConfig } from './dataSourceWizard-fixtures'
import type { FeatureBoard } from '../../api/featureBoardsSchema'

const listBoards = vi.hoisted(() => vi.fn())
vi.mock('../../api/featureRequestsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/featureRequestsApi')>(),
  appFeatureRequestsApi: { listBoards },
}))
vi.mock('../../hooks/useDisplayLabels', () => ({ useDisplayLabels: () => ({ source: (id: string) => id, category: (id: string) => id }) }))
import FeatureRequestsSource from './FeatureRequestsSource'
import ContextSummary from './ContextSummary'
import { featureRequestEvidenceFields } from './featureRequestEvidence'
import { MAX_EVIDENCE_BOARDS } from './types'

const board = (id: string, name: string, archived = false): FeatureBoard => ({ ...SEEDED_BOARD, board_id: id, slug: id, name, archived })

beforeEach(() => {
  listBoards.mockReset().mockResolvedValue({
    boards: [board('brd_sales', 'Sales requests'), board('brd_old', 'Old board', true)],
    viewer: { email: '', name: '', is_admin: false, pool: 'app' },
  })
})

describe('the Feature requests card', () => {
  it('is off by default and reads no boards', () => {
    renderWithQueryClient(<FeatureRequestsSource contextConfig={contextConfig()} onContextChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: /Feature requests/ })).not.toBeChecked()
    expect(listBoards).not.toHaveBeenCalled()
  })

  it('ticks on with no board picked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithQueryClient(<FeatureRequestsSource contextConfig={contextConfig()} onContextChange={onChange} />)
    await user.click(screen.getByRole('checkbox', { name: /Feature requests/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ useFeatureRequests: true, featureRequestBoardIds: [] }))
  })

  it('offers the non-archived boards once ticked, and picks one', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithQueryClient(<FeatureRequestsSource contextConfig={contextConfig({ useFeatureRequests: true })} onContextChange={onChange} />)
    await user.click(await screen.findByRole('button', { name: 'Sales requests' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ featureRequestBoardIds: ['brd_sales'] }))
    expect(screen.queryByRole('button', { name: 'Old board' })).not.toBeInTheDocument()
  })

  it('at the cap says so and disables only the boards not picked', async () => {
    const ids = Array.from({ length: MAX_EVIDENCE_BOARDS }, (_, n) => `brd_${n}`)
    listBoards.mockResolvedValue({
      boards: [...ids.map((id) => board(id, `Board ${id}`)), board('brd_extra', 'Extra board')],
      viewer: { email: '', name: '', is_admin: false, pool: 'app' },
    })
    renderWithQueryClient(<FeatureRequestsSource
      contextConfig={contextConfig({ useFeatureRequests: true, featureRequestBoardIds: ids })} onContextChange={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Extra board' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Board brd_0' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent(String(MAX_EVIDENCE_BOARDS))
  })

  it('below the cap shows no cap note and every board can be picked', async () => {
    renderWithQueryClient(<FeatureRequestsSource contextConfig={contextConfig({ useFeatureRequests: true })} onContextChange={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Sales requests' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clears the picked boards when unticked', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithQueryClient(<FeatureRequestsSource
      contextConfig={contextConfig({ useFeatureRequests: true, featureRequestBoardIds: ['brd_sales'] })} onContextChange={onChange} />)
    await user.click(screen.getByRole('checkbox', { name: /Feature requests/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ useFeatureRequests: false, featureRequestBoardIds: [] }))
  })

  it('says so when the boards cannot be read', async () => {
    listBoards.mockRejectedValue(new Error('API Error: 500'))
    renderWithQueryClient(<FeatureRequestsSource contextConfig={contextConfig({ useFeatureRequests: true })} onContextChange={vi.fn()} />)
    expect(await screen.findByText('Could not load the boards. Every board will be read.')).toBeInTheDocument()
  })
})

describe('the context summary', () => {
  it('names every board, or the picked ones', async () => {
    const { unmount } = renderWithQueryClient(<ContextSummary config={contextConfig({ useFeatureRequests: true })} personas={[]} documents={[]} />)
    expect(screen.getByTestId('summary-feature-requests')).toHaveTextContent('Feature requests: All boards')
    unmount()
    renderWithQueryClient(<ContextSummary config={contextConfig({ useFeatureRequests: true, featureRequestBoardIds: ['brd_sales'] })} personas={[]} documents={[]} />)
    expect(await screen.findByText(/Sales requests/)).toBeInTheDocument()
  })

  it('says nothing about board requests while unticked', () => {
    renderWithQueryClient(<ContextSummary config={contextConfig()} personas={[]} documents={[]} />)
    expect(screen.queryByTestId('summary-feature-requests')).not.toBeInTheDocument()
  })
})

describe('featureRequestEvidenceFields', () => {
  it('sends at most MAX_EVIDENCE_BOARDS boards', () => {
    const ids = Array.from({ length: MAX_EVIDENCE_BOARDS + 5 }, (_, i) => `brd_${i}`)
    expect(featureRequestEvidenceFields({ useFeatureRequests: true, featureRequestBoardIds: ids }).feature_request_board_ids)
      .toHaveLength(MAX_EVIDENCE_BOARDS)
  })
})
