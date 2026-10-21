/**
 * @fileoverview Tests for AdvancedFeedbackFilters — the shared-model extra
 * dimensions added to the DataSourceWizard feedback step.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdvancedFeedbackFilters } from './AdvancedFeedbackFilters'
import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import type { CustomFilterControl } from '../FeedbackFilterPanel'

const tierControl: CustomFilterControl = {
  key: 'tier',
  label: 'Tier Status',
  values: ['Gold', 'Platinum'],
}

describe('AdvancedFeedbackFilters', () => {
  it('renders the urgent-only toggle (enrichment registry is always present)', () => {
    render(
      <AdvancedFeedbackFilters
        feedback={EMPTY_FEEDBACK_FILTERS}
        onChange={vi.fn()}
        customFilterControls={[]}
      />
    )
    // usefulness is a registry field, so the section renders even with no
    // custom controls; the urgent-only checkbox is always offered.
    expect(screen.getByLabelText(/urgent/i)).toBeInTheDocument()
  })

  it('renders a configured custom-field group with its values', () => {
    render(
      <AdvancedFeedbackFilters
        feedback={EMPTY_FEEDBACK_FILTERS}
        onChange={vi.fn()}
        customFilterControls={[tierControl]}
      />
    )
    expect(screen.getByText('Tier Status')).toBeInTheDocument()
    expect(screen.getByText('Gold')).toBeInTheDocument()
    expect(screen.getByText('Platinum')).toBeInTheDocument()
  })

  it('sets urgentOnly when the toggle is clicked', async () => {
    const onChange = vi.fn()
    render(
      <AdvancedFeedbackFilters
        feedback={EMPTY_FEEDBACK_FILTERS}
        onChange={onChange}
        customFilterControls={[]}
      />
    )
    await userEvent.click(screen.getByLabelText(/urgent/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ urgentOnly: true }))
  })

  it('adds a custom-field value to customFields when checked', async () => {
    const onChange = vi.fn()
    render(
      <AdvancedFeedbackFilters
        feedback={EMPTY_FEEDBACK_FILTERS}
        onChange={onChange}
        customFilterControls={[tierControl]}
      />
    )
    await userEvent.click(screen.getByText('Gold'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ customFields: { tier: ['Gold'] } })
    )
  })

  it('does not crash when feedback and controls are omitted (wire-shape guard)', () => {
    // A stale caller may pass neither; the component must degrade, not throw.
    render(
      // @ts-expect-error — deliberately exercising the undefined-prop guard
      <AdvancedFeedbackFilters onChange={vi.fn()} />
    )
    expect(screen.getByLabelText(/urgent/i)).toBeInTheDocument()
  })
})
