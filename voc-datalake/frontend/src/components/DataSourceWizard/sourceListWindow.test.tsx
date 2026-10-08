/**
 * QA s3 Low: the wizard's source list always counted the last 30 days, whatever
 * window the user picked, so older feedback never offered its sources. It now
 * counts over the window generation samples from (`sample_walk_days`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import { Sparkles } from 'lucide-react'
import { renderWithQueryClient } from '../../test/query-client'
import DataSourceWizard from './DataSourceWizard'
import { contextConfig, wizardApiMocks } from './dataSourceWizard-fixtures'
import { sourceListDays } from './sourceListWindow'

vi.mock('../../api/client', () => import('./dataSourceWizard-fixtures').then(m => m.wizardApiClientMock()))
vi.mock('../../store/configStore', () => import('./dataSourceWizard-fixtures').then(m => m.wizardConfigStoreMock()))

function renderWithDays(days: number) {
  return renderWithQueryClient(
    <DataSourceWizard
      title="Wizard" accentColor="accent" icon={<Sparkles />}
      personas={[]} documents={[]}
      contextConfig={contextConfig({ days })} onContextChange={vi.fn()}
      renderFinalStep={() => null} finalStepValid onClose={vi.fn()} onSubmit={vi.fn()}
      isSubmitting={false} submitLabel="Go"
    />,
  )
}

describe('the wizard source list window', () => {
  beforeEach(() => {
    wizardApiMocks.getSources.mockReset()
    wizardApiMocks.getSources.mockResolvedValue({ sources: {} })
    wizardApiMocks.getCategoriesConfig.mockResolvedValue({ categories: [] })
  })

  it.each([
    [0, 400],
    [365, 365],
    [7, 7],
    [9999, 400],
  ])('a %i-day selection lists sources over %i days', async (selected, expected) => {
    renderWithDays(selected)

    await waitFor(() => {
      expect(wizardApiMocks.getSources).toHaveBeenCalledWith({ days: expected })
    })
  })

  it('mirrors sample_walk_days', () => {
    expect([0, -1, 1, 400, 401].map(sourceListDays)).toStrictEqual([400, 400, 1, 400, 400])
  })
})
