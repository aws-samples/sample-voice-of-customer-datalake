import { useState } from 'react'
import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import FeedbackFilterPanel from '.'

type PanelProps = ComponentProps<typeof FeedbackFilterPanel>

const baseProps: PanelProps = {
  filters: EMPTY_FEEDBACK_FILTERS,
  onChange: vi.fn(),
  options: { sources: ['webscraper', 'manual_import'], categories: ['delivery', 'pricing'] },
  counts: { sources: { webscraper: 1200, manual_import: 30 } },
}

/** Panel wired to real state, so a sequence of clicks composes like the page. */
function StatefulPanel({ initial = EMPTY_FEEDBACK_FILTERS, onChange, ...rest }: Partial<PanelProps> & {
  initial?: FeedbackFilterState
}) {
  const [filters, setFilters] = useState(initial)
  return (
    <FeedbackFilterPanel
      {...baseProps}
      {...rest}
      filters={filters}
      onChange={(next) => {
        setFilters(next)
        onChange?.(next)
      }}
    />
  )
}

function group(legend: string) {
  return screen.getByRole('group', { name: legend })
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Filters/ }))
}

describe('FeedbackFilterPanel', () => {
  describe('collapse', () => {
    it('starts collapsed with the body hidden', () => {
      render(<FeedbackFilterPanel {...baseProps} />)

      expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('group', { name: 'Sources' })).not.toBeInTheDocument()
    })

    it('expands on click and honours defaultExpanded', async () => {
      const user = userEvent.setup()
      const { unmount } = render(<FeedbackFilterPanel {...baseProps} />)
      await expand(user)
      expect(group('Sources')).toBeInTheDocument()
      unmount()

      render(<FeedbackFilterPanel {...baseProps} defaultExpanded />)
      expect(group('Sources')).toBeInTheDocument()
    })
  })

  describe('groups', () => {
    it('renders sources with counts, categories, sentiment, the enrichment field and urgency', () => {
      render(<FeedbackFilterPanel {...baseProps} defaultExpanded />)

      expect(within(group('Sources')).getByRole('checkbox', { name: /webscraper/ })).toBeInTheDocument()
      expect(within(group('Sources')).getByText('1,200')).toBeInTheDocument()
      expect(within(group('Categories')).getByRole('checkbox', { name: 'pricing' })).toBeInTheDocument()
      expect(within(group('Sentiment')).getAllByRole('checkbox')).toHaveLength(4)
      // Generated from the registry: values plus the unscored bucket.
      expect(within(group('Usefulness')).getAllByRole('checkbox')).toHaveLength(4)
      expect(screen.getByRole('checkbox', { name: 'Urgent only' })).toBeInTheDocument()
    })

    it('renders subcategories only when the page supplies them', () => {
      const { unmount } = render(<FeedbackFilterPanel {...baseProps} defaultExpanded />)
      expect(screen.queryByRole('group', { name: 'Subcategories' })).not.toBeInTheDocument()
      unmount()

      render(
        <FeedbackFilterPanel {...baseProps} options={{ ...baseProps.options, subcategories: ['late'] }} defaultExpanded />
      )
      expect(within(group('Subcategories')).getByRole('checkbox', { name: 'late' })).toBeInTheDocument()
    })

    it('still shows a selected value the window no longer offers, so it can be unchecked', () => {
      render(
        <FeedbackFilterPanel
          {...baseProps}
          filters={{ ...EMPTY_FEEDBACK_FILTERS, sources: ['old_source'] }}
          defaultExpanded
        />
      )
      expect(within(group('Sources')).getByRole('checkbox', { name: 'old source' })).toBeChecked()
    })

    it('says so when a group has no options in the window', () => {
      render(<FeedbackFilterPanel {...baseProps} options={{ sources: [], categories: [] }} defaultExpanded />)
      expect(within(group('Sources')).getByText('None in this period')).toBeInTheDocument()
    })
  })

  describe('changes', () => {
    it('composes selections across groups into one state', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(<StatefulPanel onChange={onChange} defaultExpanded />)

      await user.click(within(group('Sources')).getByRole('checkbox', { name: /webscraper/ }))
      await user.click(within(group('Sources')).getByRole('checkbox', { name: /manual import/ }))
      await user.click(within(group('Sentiment')).getByRole('checkbox', { name: 'Negative' }))
      await user.click(within(group('Usefulness')).getByRole('checkbox', { name: 'High' }))
      await user.click(screen.getByRole('checkbox', { name: 'Urgent only' }))

      expect(onChange).toHaveBeenLastCalledWith({
        ...EMPTY_FEEDBACK_FILTERS,
        sources: ['webscraper', 'manual_import'],
        sentiments: ['negative'],
        enrichment: { usefulness: ['high'] },
        urgentOnly: true,
      })
    })

    it('unchecks a selected value', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      render(<StatefulPanel initial={{ ...EMPTY_FEEDBACK_FILTERS, categories: ['delivery', 'pricing'] }} onChange={onChange} defaultExpanded />)

      await user.click(within(group('Categories')).getByRole('checkbox', { name: 'delivery' }))
      expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FEEDBACK_FILTERS, categories: ['pricing'] })
    })

    it('clears one group without touching the others', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      const initial = { ...EMPTY_FEEDBACK_FILTERS, sources: ['webscraper'], categories: ['delivery'] }
      render(<StatefulPanel initial={initial} onChange={onChange} defaultExpanded />)

      await user.click(within(group('Sources')).getByRole('button', { name: 'Clear' }))
      expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FEEDBACK_FILTERS, categories: ['delivery'] })
    })

    it('multi-selects custom-field values, dropping the key when the last one is unchecked', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      const controls = [{ key: 'region', label: 'Region', values: ['EMEA', 'Las Vegas, NV'] }]
      render(<StatefulPanel customFilterControls={controls} onChange={onChange} defaultExpanded />)

      await user.click(within(group('Region')).getByRole('checkbox', { name: 'EMEA' }))
      await user.click(within(group('Region')).getByRole('checkbox', { name: 'Las Vegas, NV' }))
      expect(onChange).toHaveBeenLastCalledWith({
        ...EMPTY_FEEDBACK_FILTERS, customFields: { region: ['EMEA', 'Las Vegas, NV'] },
      })

      await user.click(within(group('Region')).getByRole('checkbox', { name: 'EMEA' }))
      await user.click(within(group('Region')).getByRole('checkbox', { name: 'Las Vegas, NV' }))
      expect(onChange).toHaveBeenLastCalledWith(EMPTY_FEEDBACK_FILTERS)
    })

    it('shows a selected custom value the suggestions lack verbatim, so it can be unchecked', () => {
      render(
        <FeedbackFilterPanel
          {...baseProps}
          filters={{ ...EMPTY_FEEDBACK_FILTERS, customFields: { tier: ['Gold_VIP'] } }}
          customFilterControls={[{ key: 'tier', label: 'Tier', values: ['Gold'] }]}
          defaultExpanded
        />
      )
      // Not humanized to "Gold VIP": custom values are customer data, not slugs.
      expect(within(group('Tier')).getByRole('checkbox', { name: 'Gold_VIP' })).toBeChecked()
      expect(within(group('Tier')).getByRole('checkbox', { name: 'Gold' })).not.toBeChecked()
    })

    it('renders one group per configured custom field after the urgency group', () => {
      const controls = [
        { key: 'tier', label: 'Tier Status', values: ['Gold'] },
        { key: 'market', label: 'Market', values: ['LVM'] },
      ]
      render(<FeedbackFilterPanel {...baseProps} customFilterControls={controls} defaultExpanded />)

      const legends = screen.getAllByRole('group').map((g) => g.querySelector('legend')?.textContent)
      expect(legends.slice(-3)).toEqual(['Urgency', 'Tier Status', 'Market'])
    })
  })

  describe('header', () => {
    it('shows the active-dimension count and Clear all only while something is active', () => {
      const { rerender } = render(<FeedbackFilterPanel {...baseProps} />)
      expect(screen.queryByText(/active$/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument()

      rerender(
        <FeedbackFilterPanel
          {...baseProps}
          filters={{ ...EMPTY_FEEDBACK_FILTERS, sources: ['a', 'b'], urgentOnly: true }}
        />
      )
      expect(screen.getByText('2 active')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    })

    it('Clear all resets the shared filters and the page-local extras', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      const onClearExtra = vi.fn()
      render(
        <FeedbackFilterPanel
          {...baseProps}
          filters={{ ...EMPTY_FEEDBACK_FILTERS, categories: ['delivery'] }}
          onChange={onChange}
          onClearExtra={onClearExtra}
        />
      )

      await user.click(screen.getByRole('button', { name: 'Clear all' }))
      expect(onChange).toHaveBeenCalledWith(EMPTY_FEEDBACK_FILTERS)
      expect(onClearExtra).toHaveBeenCalledOnce()
    })

    it('announces "Updating…" in a polite status while the page re-queries', () => {
      const { rerender } = render(<FeedbackFilterPanel {...baseProps} />)
      const status = screen.getByRole('status')
      expect(status).toHaveAttribute('aria-live', 'polite')
      expect(status).toBeEmptyDOMElement()

      rerender(<FeedbackFilterPanel {...baseProps} isUpdating />)
      expect(screen.getByRole('status')).toHaveTextContent('Updating…')
    })

    it('offers Clear all for page-local state alone (extraActive)', () => {
      render(<FeedbackFilterPanel {...baseProps} extraActive />)
      expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    })

    it('renders headerExtra and trailing always, and extra only when expanded', async () => {
      const user = userEvent.setup()
      render(
        <FeedbackFilterPanel
          {...baseProps}
          headerExtra={<input aria-label="Search" />}
          trailing={<button type="button">Export PDF</button>}
          extra={<button type="button">Rating</button>}
        />
      )
      expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Export PDF' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Rating' })).not.toBeInTheDocument()

      await expand(user)
      expect(screen.getByRole('button', { name: 'Rating' })).toBeInTheDocument()
    })
  })
})
