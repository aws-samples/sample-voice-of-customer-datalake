import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { ALL_TYPES, PROBLEM_TYPES } from '../../components/ReviewTypeFilter/reviewTypeSelection'
import { ProblemFiltersBar } from './ProblemFiltersBar'
import type { ProblemFilters, ProblemFiltersApi } from './useProblemFilters'

vi.mock('../../hooks/useDisplayLabels', () => ({
  useDisplayLabels: () => ({ source: (id: string) => id, category: (id: string) => id, subcategory: (id: string) => id }),
}))

const NO_FILTERS: ProblemFilters = {
  sources: [], usefulness: [], category: null, subcategory: null,
  urgentOnly: false, showResolved: false, similarity: 'med', types: PROBLEM_TYPES,
}

function renderBar(change: Partial<ProblemFilters> = {}, anyActive = false) {
  const filters: ProblemFiltersApi = { ...NO_FILTERS, ...change, update: vi.fn(), clear: vi.fn(), anyActive }
  const onExpandAll = vi.fn()
  const onCollapseAll = vi.fn()
  render(
    <ProblemFiltersBar filters={filters} sources={['web', 'app']} categories={['delivery']} subcategories={['late']}
      resolvedCount={2} typeCounts={{ bug: 3 }} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} />,
  )
  return { filters, onExpandAll, onCollapseAll }
}

describe('ProblemFiltersBar', () => {
  it('adds a source to the ones already chosen', async () => {
    const user = userEvent.setup()
    const { filters } = renderBar({ sources: ['app'] })
    await user.click(screen.getByRole('button', { name: 'Source: app' }))
    await user.click(screen.getByRole('checkbox', { name: 'web' }))
    expect(filters.update).toHaveBeenCalledWith({ sources: ['app', 'web'] })
  })

  it('adds a usefulness band', async () => {
    const user = userEvent.setup()
    const { filters } = renderBar()
    await user.click(screen.getByRole('button', { name: 'Usefulness: Any usefulness' }))
    await user.click(screen.getByRole('checkbox', { name: 'High usefulness' }))
    expect(filters.update).toHaveBeenCalledWith({ usefulness: ['high'] })
  })

  it.each([
    ['Source: web', { sources: [] }],
    ['Usefulness: High usefulness', { usefulness: [] }],
  ])('clears the facet from the %s panel', async (trigger, expected) => {
    const user = userEvent.setup()
    const { filters } = renderBar({ sources: ['web'], usefulness: ['high'] })
    await user.click(screen.getByRole('button', { name: trigger }))
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(filters.update).toHaveBeenCalledWith(expected)
  })

  it('resets every narrowing filter from its Clear button while one is active', async () => {
    const user = userEvent.setup()
    const { filters } = renderBar({ urgentOnly: true }, true)
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(filters.clear).toHaveBeenCalledTimes(1)
  })

  const select = (name: string, value: string) => (user: UserEvent) =>
    user.selectOptions(screen.getByRole('combobox', { name }), value)
  const click = (role: 'button' | 'checkbox', name: string | RegExp) => (user: UserEvent) =>
    user.click(screen.getByRole(role, { name }))

  it.each<[string, (user: UserEvent) => Promise<void>, Partial<ProblemFilters>]>([
    ['the All types chip', click('button', 'All types'), { types: ALL_TYPES }],
    ['a type pill while Problems only shows (only that type)', click('button', /^Feature request/), { types: ['feature_request'] }],
    ['the category select', select('Category', 'delivery'), { category: 'delivery' }],
    ['the subcategory select', select('Subcategory', 'late'), { subcategory: 'late' }],
    ['the urgent-only toggle', click('checkbox', 'Urgent only'), { urgentOnly: true }],
    ['the show-resolved toggle', click('checkbox', /Show resolved/), { showResolved: true }],
    ['the similarity select', select('Similarity:', 'high'), { similarity: 'high' }],
  ])('sends %s to update', async (_control, act, expected) => {
    const user = userEvent.setup()
    const { filters } = renderBar()
    await act(user)
    expect(filters.update).toHaveBeenCalledWith(expected)
  })

  it('expands and collapses every row from its buttons', async () => {
    const user = userEvent.setup()
    const { onExpandAll, onCollapseAll } = renderBar()
    await user.click(screen.getByRole('button', { name: 'Expand All' }))
    await user.click(screen.getByRole('button', { name: 'Collapse All' }))
    expect(onExpandAll).toHaveBeenCalledTimes(1)
    expect(onCollapseAll).toHaveBeenCalledTimes(1)
  })
})
