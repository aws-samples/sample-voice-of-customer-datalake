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
  const mockSetCustomDateRange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      timeRange: '7d',
      setTimeRange: mockSetTimeRange,
      customDateRange: null,
      setCustomDateRange: mockSetCustomDateRange,
    })
  })

  describe('preset ranges', () => {
    it('renders time preset range buttons on desktop', () => {
      render(<TimeRangeSelector />)
      
      expect(screen.getAllByRole('button', { name: '24h' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: '48h' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: '7d' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: '30d' }).length).toBeGreaterThan(0)
    })

    it('renders custom range button on desktop', () => {
      render(<TimeRangeSelector />)
      
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

    it('clears custom date range when preset is selected', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      
      await user.click(screen.getByRole('button', { name: '24h' }))
      
      expect(mockSetCustomDateRange).toHaveBeenCalledWith(null)
    })
  })

  describe('custom date picker', () => {
    it('opens date picker when Custom is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      
      await user.click(screen.getByRole('button', { name: 'Custom' }))
      
      expect(screen.getByRole('dialog', { name: /select custom date range/i })).toBeInTheDocument()
    })

    it('displays start and end date inputs', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      
      await user.click(screen.getByRole('button', { name: 'Custom' }))
      
      expect(screen.getByLabelText('Start Date')).toBeInTheDocument()
      expect(screen.getByLabelText('End Date')).toBeInTheDocument()
    })

    it('disables Apply button when dates are not selected', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      
      await user.click(screen.getByRole('button', { name: 'Custom' }))
      
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('closes picker when Cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      
      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('closes picker when X button is clicked', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      
      await user.click(screen.getByRole('button', { name: 'Custom' }))
      await user.click(screen.getByRole('button', { name: /close date picker/i }))
      
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('custom date range display', () => {
    it('displays formatted date range when custom range is set', () => {
      ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        timeRange: 'custom',
        setTimeRange: mockSetTimeRange,
        customDateRange: { start: '2025-01-01', end: '2025-01-15' },
        setCustomDateRange: mockSetCustomDateRange,
      })
      
      render(<TimeRangeSelector />)
      
      // Should show formatted date range - there may be multiple buttons (mobile + desktop)
      expect(screen.getAllByText(/Jan 1 - Jan 15/).length).toBeGreaterThan(0)
    })

    it.todo('shows Clear button when custom range is active')
  })
})
