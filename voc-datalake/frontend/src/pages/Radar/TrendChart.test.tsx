/**
 * The Radar trend's count axis: compact ticks in the UI language and a measured width, like the
 * Dashboard's (verify4 V4: German ticks "10.000" / "7500" were cut at the left edge).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import i18n from 'i18next'
import TrendChart from './TrendChart'

interface AxisStubProps {
  readonly yAxisId?: string
  readonly width?: number | string
  readonly tickFormatter?: (value: unknown) => string
}

vi.mock('recharts', () => {
  const passThrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const YAxis = ({ yAxisId, width, tickFormatter }: AxisStubProps) => (
    <div data-testid={`y-axis-${yAxisId ?? ''}`} data-width={width} data-sample={tickFormatter?.(10000)}
      data-score={tickFormatter?.(-0.5)} />
  )
  return {
    ResponsiveContainer: passThrough, ComposedChart: passThrough, CartesianGrid: () => null, Tooltip: () => null,
    Bar: () => null, Line: () => null, XAxis: () => null, YAxis,
  }
})

describe('Radar TrendChart', () => {
  it('formats the review counts compactly and lets the axis measure its ticks', () => {
    render(<TrendChart trend={[{ date: '2026-10-16', count: 9800, avg_sentiment: -0.4 }]} onDay={() => {}} />)
    const axis = screen.getByTestId('y-axis-count')
    expect([axis.dataset.sample, axis.dataset.width]).toStrictEqual(['10K', 'auto'])
  })

  it('writes the sentiment axis with the decimal mark of the app language (pl "-0,5")', async () => {
    await i18n.changeLanguage('pl')
    try {
      render(<TrendChart trend={[{ date: '2026-10-16', count: 3, avg_sentiment: -0.4 }]} onDay={() => {}} />)
      expect(screen.getByTestId('y-axis-score').dataset.score).toBe('-0,5')
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
