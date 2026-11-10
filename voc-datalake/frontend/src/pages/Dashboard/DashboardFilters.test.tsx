import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EMPTY_FACETS } from '../../api/feedbackFacets'
import type { FeedbackFacets } from '../../api/feedbackFacets'
import type { FacetParamsApi } from '../../hooks/useFacetParams'
import { DashboardFilters, FilteredEmpty } from './DashboardFilters'

vi.mock('../../hooks/useDisplayLabels', () => ({
  useDisplayLabels: () => ({ source: (id: string) => id, category: (id: string) => id }),
}))

function renderFilters(facets: FeedbackFacets = EMPTY_FACETS) {
  const params: FacetParamsApi = { facets, toggle: vi.fn(), clearFacet: vi.fn(), clearAll: vi.fn() }
  render(<DashboardFilters params={params} sourceOptions={['web', 'app']} categoryOptions={['delivery']} />)
  return params
}

describe('DashboardFilters', () => {
  it.each([
    ['Source: All sources', 'web', 'sources', 'web'],
    ['Category: All categories', 'delivery', 'categories', 'delivery'],
    ['Sentiment: All sentiments', 'Negative', 'sentiments', 'negative'],
    ['Usefulness: Any usefulness', 'High usefulness', 'usefulness', 'high'],
  ])('toggles a value of the facet behind %s', async (trigger, option, facet, value) => {
    const user = userEvent.setup()
    const params = renderFilters()
    await user.click(screen.getByRole('button', { name: trigger }))
    await user.click(screen.getByRole('checkbox', { name: option }))
    expect(params.toggle).toHaveBeenCalledWith(facet, value)
  })

  it.each([
    ['Source: web', 'sources'],
    ['Category: delivery', 'categories'],
    ['Sentiment: Negative', 'sentiments'],
    ['Usefulness: High usefulness', 'usefulness'],
  ])('clears one facet from the %s panel', async (trigger, facet) => {
    const user = userEvent.setup()
    const params = renderFilters({ ...EMPTY_FACETS, sources: ['web'], categories: ['delivery'], sentiments: ['negative'], usefulness: ['high'] })
    await user.click(screen.getByRole('button', { name: trigger }))
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(params.clearFacet).toHaveBeenCalledWith(facet)
  })

  it('clears every facet from "Clear filters" while one is active', async () => {
    const user = userEvent.setup()
    const params = renderFilters({ ...EMPTY_FACETS, sources: ['web'] })
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(params.clearAll).toHaveBeenCalledTimes(1)
  })

  it('has no "Clear filters" with nothing filtered', () => {
    renderFilters()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })
})

describe('FilteredEmpty', () => {
  it('says nothing matches and clears from its own button', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(<FilteredEmpty onClear={onClear} />)
    expect(screen.getByRole('status')).toHaveTextContent('No feedback matches these filters')
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
