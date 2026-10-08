/**
 * @fileoverview Tests for TimeRangeSelector component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { tabTimes } from '@test/keyboard'
import TimeRangeSelector from './TimeRangeSelector'

const mockUseConfigStore = vi.fn<() => Record<string, unknown>>()
vi.mock('../../store/configStore', () => ({
  useConfigStore: () => mockUseConfigStore(),
}))

describe('TimeRangeSelector', () => {
  const mockSetTimeRange = vi.fn()
  const mockSetCustomDays = vi.fn()
  const mockSetDateBasis = vi.fn()

  /** Point the mocked store at a 7-day imported-date state, with `overrides`. */
  function mockStore(overrides: Record<string, unknown> = {}) {
    mockUseConfigStore.mockReturnValue({
      timeRange: '7d',
      setTimeRange: mockSetTimeRange,
      customDays: null,
      setCustomDays: mockSetCustomDays,
      dateBasis: 'imported',
      setDateBasis: mockSetDateBasis,
      ...overrides,
    })
  }

  /** Mount and click the button named `name`. */
  async function renderAndClick(name: string | RegExp): Promise<UserEvent> {
    const user = userEvent.setup()
    render(<TimeRangeSelector />)
    await user.click(screen.getByRole('button', { name }))
    return user
  }

  const openCustomPicker = () => renderAndClick('Custom')
  const openBasisPicker = () => renderAndClick(/filter dates by: imported date/i)

  /** The desktop (`tab`-styled) button named `name`, as opposed to its mobile twin. */
  function desktopButton(name: string): HTMLElement {
    const button = screen.getAllByRole('button', { name }).find(b => b.classList.contains('tab'))
    if (!button) throw new Error(`no desktop "${name}" button on screen`)
    return button
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockStore()
  })

  describe('preset ranges', () => {
    it.each(['24h', '48h', '7d', '30d', 'Custom'])('renders the %s preset button on desktop', (name) => {
      render(<TimeRangeSelector />)

      // Desktop buttons use short labels; there may be multiple buttons
      // (mobile dropdown + desktop buttons)
      expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0)
    })

    it('highlights the currently selected range', () => {
      render(<TimeRangeSelector />)

      expect(desktopButton('7d')).toHaveClass('tab', 'tab-active')
    })

    it('calls setTimeRange when a preset is clicked', async () => {
      await renderAndClick('30d')

      expect(mockSetTimeRange).toHaveBeenCalledWith('30d')
    })

    it('clears custom days when preset is selected', async () => {
      await renderAndClick('24h')

      expect(mockSetCustomDays).toHaveBeenCalledWith(null)
    })
  })

  describe('custom "last N days" picker', () => {
    it('opens the picker when Custom is clicked', async () => {
      await openCustomPicker()

      expect(screen.getByRole('dialog', { name: /custom range/i })).toBeInTheDocument()
    })

    it('displays a number-of-days input', async () => {
      await openCustomPicker()

      expect(screen.getByLabelText('Last N days')).toBeInTheDocument()
    })

    it('disables Apply button when no days are entered', async () => {
      await openCustomPicker()

      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it('applies a valid number of days and selects the custom range', async () => {
      const user = await openCustomPicker()

      await user.type(screen.getByLabelText('Last N days'), '14')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockSetCustomDays).toHaveBeenCalledWith(14)
      expect(mockSetTimeRange).toHaveBeenCalledWith('custom')
    })

    it.each([
      ['0 as an all-time custom range', '0', 0],
      ['the 9999-day maximum', '9999', 9999],
    ])('applies %s', async (_what, typed, days) => {
      const user = await openCustomPicker()

      await user.type(screen.getByLabelText('Last N days'), typed)
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(mockSetCustomDays).toHaveBeenCalledWith(days)
      expect(mockSetTimeRange).toHaveBeenCalledWith('custom')
    })

    it.each(['10000', '-1', '2.5'])('keeps Apply disabled for %s', async (typed) => {
      const user = await openCustomPicker()

      await user.type(screen.getByLabelText('Last N days'), typed)

      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    })

    it.each([
      ['Cancel is clicked', 'Cancel'],
      ['the X button is clicked', /close custom range/i],
    ])('closes the picker when %s', async (_how, name) => {
      const user = await openCustomPicker()

      await user.click(screen.getByRole('button', { name }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('custom range display', () => {
    it('displays a "Last N days" label when a custom lookback is set', () => {
      mockStore({ timeRange: 'custom', customDays: 15 })

      render(<TimeRangeSelector />)

      // There may be multiple buttons (mobile + desktop)
      expect(screen.getAllByText(/Last 15 days/).length).toBeGreaterThan(0)
    })

    it('displays "All time" when the custom lookback is 0', () => {
      mockStore({ timeRange: 'custom', customDays: 0 })

      render(<TimeRangeSelector />)

      expect(screen.getAllByText('All time').length).toBeGreaterThan(0)
    })
  })

  describe('90-day and all-time presets', () => {
    it('renders both a 90d and an All preset button', () => {
      render(<TimeRangeSelector />)

      expect(screen.getAllByRole('button', { name: '90d' }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: 'All' }).length).toBeGreaterThan(0)
    })

    it('the 90d button selects the 90-day preset, not all time', async () => {
      await renderAndClick('90d')

      expect(mockSetTimeRange).toHaveBeenCalledWith('90d')
      expect(mockSetCustomDays).toHaveBeenCalledWith(null)
    })

    it('the All button selects the all-time range without a custom window', async () => {
      await renderAndClick('All')

      expect(mockSetTimeRange).toHaveBeenCalledWith('all')
      expect(mockSetCustomDays).toHaveBeenCalledWith(null)
    })

    it('labels the all-time selection "All time" in the mobile trigger', () => {
      mockStore({ timeRange: 'all' })

      render(<TimeRangeSelector />)

      expect(screen.getByRole('button', { name: /time range: all time/i })).toBeInTheDocument()
    })
  })

  describe('date basis picker', () => {
    it('shows "Imported date" on the trigger when filtering by imported date', () => {
      render(<TimeRangeSelector />)

      expect(screen.getByRole('button', { name: /filter dates by: imported date/i })).toBeInTheDocument()
    })

    it('shows "Review date" on the trigger when filtering by review date', () => {
      mockStore({ dateBasis: 'review' })
      render(<TimeRangeSelector />)

      expect(screen.getByRole('button', { name: /filter dates by: review date/i })).toBeInTheDocument()
    })

    it('lists both basis options with explanations when opened', async () => {
      await openBasisPicker()

      const listbox = screen.getByRole('listbox', { name: 'Filter dates by' })
      expect(listbox).toBeInTheDocument()
      expect(screen.getByText('When the feedback was collected into the platform.')).toBeInTheDocument()
      expect(screen.getByText('When the customer originally wrote the feedback.')).toBeInTheDocument()
    })

    it('marks the active basis as selected in the option list', async () => {
      await openBasisPicker()

      expect(screen.getByRole('option', { name: /Imported date/ })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('option', { name: /Review date/ })).toHaveAttribute('aria-selected', 'false')
    })

    it('calls setDateBasis with "review" when the review option is chosen', async () => {
      const user = await openBasisPicker()

      await user.click(screen.getByRole('option', { name: /Review date/ }))

      expect(mockSetDateBasis).toHaveBeenCalledWith('review')
    })

    it('explains the current basis via a tooltip on the trigger', () => {
      render(<TimeRangeSelector />)

      const trigger = screen.getByRole('button', { name: /filter dates by: imported date/i })
      expect(trigger.getAttribute('title')).toMatch(/when data was collected/i)
    })
  })

  describe('keyboard and mobile semantics', () => {
    // Design audit D-OVL: focus stayed on the trigger when the basis listbox
    // opened, Tab walked out behind the open popups, and Escape left focus on
    // <body> instead of the control that opened them.
    it('moves focus to the selected basis option and supports arrow keys', async () => {
      const user = await openBasisPicker()
      expect(screen.getByRole('option', { name: /imported date/i })).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(screen.getByRole('option', { name: /review date/i })).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(screen.getByRole('option', { name: /imported date/i })).toHaveFocus()
    })

    it('Escape closes the basis listbox and returns focus to its trigger', async () => {
      const user = await openBasisPicker()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /filter dates by: imported date/i })).toHaveFocus()
    })

    it('closes the basis listbox when Tab leaves it', async () => {
      const user = await openBasisPicker()
      await user.tab()
      await user.tab()
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('Escape on the custom range input returns focus to the Custom button', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)
      const custom = desktopButton('Custom')
      await user.click(custom)
      expect(screen.getByRole('spinbutton')).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(custom).toHaveFocus()
    })

    it('closes the custom range popover when Tab leaves it', async () => {
      const user = userEvent.setup()
      render(<><TimeRangeSelector /><button type="button">After</button></>)
      await user.click(desktopButton('Custom'))
      const dialog = screen.getByRole('dialog')
      const stops = dialog.querySelectorAll('button:not([disabled]), input').length
      await tabTimes(user, stops + 1)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    it('closes the custom range popover on Escape', async () => {
      const user = userEvent.setup()
      render(<TimeRangeSelector />)

      await user.click(desktopButton('Custom'))
      expect(screen.getByRole('dialog', { name: /custom range/i })).toBeInTheDocument()
      await user.keyboard('{Escape}')

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('exposes the selected preset as a pressed toggle', () => {
      render(<TimeRangeSelector />)

      expect(desktopButton('7d')).toHaveAttribute('aria-pressed', 'true')
    })

    it('mobile panel groups ranges and date basis as toggle buttons, not a listbox', async () => {
      await renderAndClick(/time range: 7 days/i)

      expect(screen.getByRole('group', { name: 'Filter dates by' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '7 Days' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })
})
