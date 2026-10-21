import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mirror the i18n convention of the page tests: interpolate the real template
// so a missing/renamed key would surface as a failing assertion rather than
// passing on an echoed key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'emptyWindowFallback'
        ? `No feedback in the selected time range. Showing your most recent data instead (from ${String(opts?.date)}).`
        : key,
  }),
}))

import EmptyWindowBanner from './index'

describe('EmptyWindowBanner', () => {
  it('names the date the fallback data is from', () => {
    render(<EmptyWindowBanner date="2026-09-21" />)
    expect(
      screen.getByText(/Showing your most recent data instead \(from 2026-09-21\)/),
    ).toBeInTheDocument()
  })

  it('is exposed as a status region for assistive tech', () => {
    render(<EmptyWindowBanner date="2026-09-21" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
