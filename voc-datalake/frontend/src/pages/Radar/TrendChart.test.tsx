/**
 * The Radar trend: compact count ticks in the UI language and a measured width, like the Dashboard's
 * (verify4 V4: German ticks "10.000" / "7500" were cut at the left edge); labelled axes, a legend,
 * straight lines and the whole window on the x axis; below 10 reviews a sentence instead of a chart.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import i18n from 'i18next'
import TrendChart from './TrendChart'

interface AxisStubProps {
  readonly yAxisId?: string
  readonly width?: number | string
  readonly tickFormatter?: (value: unknown) => string
  readonly label?: { readonly value?: string }
}

interface ChartStubProps {
  readonly children?: ReactNode
  readonly data?: ReadonlyArray<Readonly<Record<string, unknown>>>
}

vi.mock('recharts', () => {
  const passThrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const ComposedChart = ({ children, data }: ChartStubProps) => (
    <div data-testid="chart" data-days={data?.length} data-first={String(data?.at(0)?.date)} data-last={String(data?.at(-1)?.date)}>{children}</div>
  )
  const YAxis = ({ yAxisId, width, tickFormatter, label }: AxisStubProps) => (
    <div data-testid={`y-axis-${yAxisId ?? ''}`} data-width={width} data-sample={tickFormatter?.(10000)}
      data-score={tickFormatter?.(-0.5)} data-label={label?.value} />
  )
  const Line = ({ type }: { type?: string }) => <div data-testid="line" data-type={type} />
  return {
    ResponsiveContainer: passThrough, ComposedChart, CartesianGrid: () => null, Tooltip: () => null,
    Bar: () => null, Line, XAxis: () => null, YAxis,
  }
})

const TREND = [{ date: '2026-10-16', count: 9800, avg_sentiment: -0.4 }]
const draw = (trend = TREND, days = 30, onReadAll = vi.fn()) =>
  render(<TrendChart trend={trend} days={days} onDay={() => {}} onReadAll={onReadAll} />)

describe('Radar TrendChart', () => {
  it('formats the review counts compactly and lets the axis measure its ticks', () => {
    draw()
    const axis = screen.getByTestId('y-axis-count')
    expect([axis.dataset.sample, axis.dataset.width]).toStrictEqual(['10K', 'auto'])
  })

  it('writes the sentiment axis with the decimal mark of the app language (pl "-0,5")', async () => {
    await i18n.changeLanguage('pl')
    try {
      draw([{ date: '2026-10-16', count: 30, avg_sentiment: -0.4 }])
      expect(screen.getByTestId('y-axis-score').dataset.score).toBe('-0,5')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('labels both axes, shows a legend and draws straight lines', () => {
    draw()
    expect(screen.getByTestId('y-axis-count').dataset.label).toBe('Reviews')
    expect(screen.getByTestId('y-axis-score').dataset.label).toBe('Average sentiment')
    expect(screen.getByRole('list', { name: 'Legend' })).toHaveTextContent(/Reviews.*Average sentiment/)
    expect(screen.getByTestId('line').dataset.type).toBe('linear')
  })

  it('spans the whole window, one point a day ending today', () => {
    draw(TREND, 30)
    const chart = screen.getByTestId('chart')
    expect(chart.dataset.days).toBe('30')
    expect(chart.dataset.last).toBe(new Date().toISOString().slice(0, 10))
  })

  it('says there are too few reviews for a trend below 10, with a way to read them', async () => {
    const onReadAll = vi.fn()
    draw([{ date: '2026-10-16', count: 4, avg_sentiment: 0.1 }, { date: '2026-10-17', count: 2, avg_sentiment: 0.2 }], 90, onReadAll)
    expect(screen.queryByTestId('radar-trend-chart')).not.toBeInTheDocument()
    expect(screen.getByTestId('radar-trend-too-few')).toHaveTextContent('Only 6 reviews in this window: too few for a trend.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read them' }))
    expect(onReadAll).toHaveBeenCalledExactlyOnceWith()
  })

  it('says so when the window has no review at all', () => {
    draw([], 7)
    expect(screen.getByText('No reviews in this window yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('radar-trend-too-few')).not.toBeInTheDocument()
  })

  it('lists only the days with reviews, newest first, for the keyboard', async () => {
    const onDay = vi.fn()
    render(<TrendChart trend={[{ date: '2026-10-15', count: 6, avg_sentiment: 0 }, { date: '2026-10-16', count: 5, avg_sentiment: 0 }]}
      days={30} onDay={onDay} onReadAll={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByText("Read a day's reviews"))
    const days = screen.getAllByRole('button', { name: /reviews$/ }).map((button) => button.textContent)
    expect(days).toStrictEqual(['Oct 16, 2026: 5 reviews', 'Oct 15, 2026: 6 reviews'])
    await user.click(screen.getByRole('button', { name: 'Oct 15, 2026: 6 reviews' }))
    expect(onDay).toHaveBeenCalledWith('2026-10-15')
  })
})
