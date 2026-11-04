/**
 * `/feature-requests` tabs: Boards by default, Insights at `?tab=insights` (a deep link), and leaving
 * Insights drops its board / window parameters. The Insights tab itself is stubbed (InsightsTab.test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { SearchProbe } from './search-probe-fixtures'
import { ADMIN, fakeBoard, fixtureBoard } from './feature-board-fixtures'
import type { FeatureRequestsApi } from '../../api/featureRequestsApi'

const app: { api: FeatureRequestsApi | null } = vi.hoisted(() => ({ api: null }))
vi.mock('./boardContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('./boardContext')>()
  return { ...original, get APP_BOARD_HOST() { return { api: app.api, basePath: '/feature-requests', session: 'app' } } }
})
vi.mock('./InsightsTab', () => ({
  default: ({ boards, isAdmin }: { boards: readonly unknown[]; isAdmin: boolean }) => (
    <p data-testid="insights-stub">{`${boards.length} boards, admin ${String(isAdmin)}`}</p>
  ),
}))
import Page from './FeatureRequests'

function renderPage(entry: string) {
  app.api = fakeBoard(ADMIN, [], {}, { boards: [fixtureBoard('sales', { board_id: 'brd_sales' })] }).api
  renderWithQueryClient(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/feature-requests" element={<Page />} /></Routes>
      <SearchProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  app.api = null
})

describe('the page tabs', () => {
  it('opens on Boards', async () => {
    renderPage('/feature-requests')
    expect(await screen.findByRole('tab', { name: 'Boards' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('insights-stub')).not.toBeInTheDocument()
  })

  it('deep-links Insights with the boards and the admin flag', async () => {
    renderPage('/feature-requests?tab=insights')
    expect(await screen.findByRole('tab', { name: 'Insights' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('1 boards, admin true')).toBeInTheDocument()
  })

  it('switches tabs in the URL, and leaving Insights drops its view', async () => {
    const user = userEvent.setup()
    renderPage('/feature-requests?tab=insights&board=brd_sales&days=30')
    await user.click(await screen.findByRole('tab', { name: 'Boards' }))
    expect(screen.getByTestId('search')).toHaveTextContent(/^$/)
    await user.click(screen.getByRole('tab', { name: 'Insights' }))
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=insights')
  })
})
