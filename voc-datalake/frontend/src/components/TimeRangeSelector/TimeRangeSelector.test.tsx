/**
 * @fileoverview Tests for TimeRangeSelector component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TimeRangeSelector from './TimeRangeSelector'
import { useConfigStore } from '../../store/configStore'

// Mock the config store
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(),
}))

describe('TimeRangeSelector', () => {
  const mockSetTimeRange = vi.fn()
  const mockSetCustomDays = vi.fn()
  const mockSetDateBasis = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      timeRange: '7d',
      setTimeRange: mockSetTimeRange,
      customDays: null,
      setCustomDays: mockSetCustomDays,
      dateBasis: 'imported',
      setDateBasis: mockSetDateBasis,
    })
  })

  describe('preset ranges', () => {
    it('renders all preset range buttons on desktop', () => {
      render(<TimeRangeSelector />)

      // Desktop buttons use short labels: 24h, 48h, 7d, 30d, 90d, Custom
      // There may be multiple buttons (mobile dropdown + desktop buttons)
      expect(screen.getAllByRole('button', { name: '24h' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: '48h' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: '7d' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: '30d' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: 'Custom' }).length).toBeGreaterThan(0)
    })

    it('highlights the currently selected range', () => {
      render(<TimeRangeSelector />)

      // Find all buttons with name '7d' and check the desktop one
      const buttons = screen.getAllByRole('button', { name: '7d' })
      const desktopButton = buttons.find(btn => btn.classList.contains('bg-white'))
      expect(desktopButton).toHaveClass('bg-white', 'text-gray-900')
    })

    it('calls setTimeRange when a preset is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: '30d' }))

      expect(mockSetTimeRange).toHaveBeenCalledWith('30d')
    })

    it('clears custom days when preset is selected', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: '24h' }))

      expect(mockSetCustomDays).toHaveBeenCalledWith(null)
    })
  })

  describe('custom "last N days" picker', () => {
    it('opens the picker when Custom is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))

      expect(screen.getByRole('dialog', { name: /select custom range/i })).toBeInTheDocument()
    })

    it('displays a number-of-days input', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))

      expect(screen.getByLabelText('Last N days')).toBeInTheDocument()
    })

    it('disables Apply button when no days are entered', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))

      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('applies a valid number of days and selects the custom range', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.type(screen.getByLabelText('Last N days'), '14')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockSetCustomDays).toHaveBeenCalledWith(14)
      expect(mockSetTimeRange).toHaveBeenCalledWith('custom')
    })

    it('keeps Apply disabled for a non-positive number', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.type(screen.getByLabelText('Last N days'), '0')

      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('keeps Apply disabled for a value above the 90-day cap', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.type(screen.getByLabelText('Last N days'), '91')

      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('closes the picker when Cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('closes the picker when the X button is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.click(screen.getByRole('button', { name: /close custom range/i }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('custom range display', () => {
    it('displays a "Last N days" label when a custom lookback is set', () => {
      ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        timeRange: 'custom',
        setTimeRange: mockSetTimeRange,
        customDays: 15,
        setCustomDays: mockSetCustomDays,
      })

      render(<TimeRangeSelector />)

      // There may be multiple buttons (mobile + desktop)
      expect(screen.getAllByText(/Last 15 days/).length).toBeGreaterThan(0)
    })
  })

  describe('all option', () => {
    it('renders the All preset button', () => {
      render(<TimeRangeSelector />)

      expect(screen.getAllByRole('button', { name: '90d' }).length).toBeGreaterThan(0)
    })

    it('selects the all-time range without a custom window', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: '90d' }))

      expect(mockSetTimeRange).toHaveBeenCalledWith('all')
      expect(mockSetCustomDays).toHaveBeenCalledWith(null)
    })
  })

  describe('date basis picker', () => {
    it('shows "Imported date" on the trigger when filtering by imported date', () => {
      render(<TimeRangeSelector />)

      expect(screen.getByRole('button', { name: /filter dates by: imported date/i })).toBeInTheDocument()
    })

    it('shows "Review date" on the trigger when filtering by review date', () => {
      ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        timeRange: '7d',
        setTimeRange: mockSetTimeRange,
        customDays: null,
        setCustomDays: mockSetCustomDays,
        dateBasis: 'review',
        setDateBasis: mockSetDateBasis,
      })
      render(<TimeRangeSelector />)

      expect(screen.getByRole('button', { name: /filter dates by: review date/i })).toBeInTheDocument()
    })

    it('lists both basis options with explanations when opened', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: /filter dates by: imported date/i }))

      const listbox = screen.getByRole('listbox', { name: 'Filter dates by' })
      expect(listbox).toBeInTheDocument()
      expect(screen.getByText('When the feedback was collected into the platform.')).toBeInTheDocument()
      expect(screen.getByText('When the customer originally wrote the feedback.')).toBeInTheDocument()
    })

    it('marks the active basis as selected in the option list', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: /filter dates by: imported date/i }))

      const options = screen.getAllByRole('option')
      const imported = options.find(o => o.textContent?.includes('Imported date'))
      const review = options.find(o => o.textContent?.includes('Review date'))
      expect(imported).toHaveAttribute('aria-selected', 'true')
      expect(review).toHaveAttribute('aria-selected', 'false')
    })

    it('calls setDateBasis with "review" when the review option is chosen', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(screen.getByRole('button', { name: /filter dates by: imported date/i }))
      const options = screen.getAllByRole('option')
      const review = options.find(o => o.textContent?.includes('Review date'))
      await user.click(review as HTMLElement)

      expect(mockSetDateBasis).toHaveBeenCalledWith('review')
    })

    it('explains the current basis via a tooltip on the trigger', () => {
      render(<TimeRangeSelector />)

      const trigger = screen.getByRole('button', { name: /filter dates by: imported date/i })
      expect(trigger.getAttribute('title')).toMatch(/when data was collected/i)
    })
  })
})
