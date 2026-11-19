/**
 * Settings › Category routing (audit §3.4 Settings): a stored category the deployment no longer configures is kept,
 * and said as a state beside the select ("No longer configured", warn, "Pick a configured category"), never as an
 * option's text; and not before the categories are read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

const categoriesState: { data: unknown } = { data: undefined }

vi.mock('../../../../hooks/useCategories', () => ({ useCategoriesConfig: () => categoriesState }))
vi.mock('../../../../components/DimensionFields/DimensionDefaultsSection', () => ({ default: () => <div data-testid="dimension-defaults" /> }))

import { renderWithDraft, sampleForm } from '../../test/draftHarness'
import CategoryRoutingSection from './CategoryRoutingSection'

const CONFIGURED = { categories: [{ id: 'cat_1', name: 'ease_of_use', subcategories: [] }] }

describe('CategoryRoutingSection: a category no longer configured', () => {
  beforeEach(() => { categoriesState.data = CONFIGURED })

  it('keeps the stored name in the select and says the state beside it, with what to do', () => {
    renderWithDraft(<CategoryRoutingSection />, sampleForm({ category: 'ux' }))
    const select = screen.getByLabelText("The form's category")
    // (the option is the plain name: "ux (no longer configured)" read a state as if it were a category)
    expect(screen.getByRole('option', { name: 'ux', selected: true })).toBeInTheDocument()
    expect(screen.getByText('No longer configured')).toHaveClass('badge', 'badge-warn')
    expect(select).toHaveAccessibleDescription(/No longer configured\s*Pick a configured category\./u)
    expect(select).toHaveClass('border-warn')
  })

  it('says nothing for a configured category', () => {
    renderWithDraft(<CategoryRoutingSection />, sampleForm({ category: 'ease_of_use' }))
    expect(screen.queryByText('No longer configured')).not.toBeInTheDocument()
  })

  it('says nothing while the categories are still being read', () => {
    categoriesState.data = undefined
    renderWithDraft(<CategoryRoutingSection />, sampleForm({ category: 'ux' }))
    expect(screen.queryByText('No longer configured')).not.toBeInTheDocument()
  })
})
