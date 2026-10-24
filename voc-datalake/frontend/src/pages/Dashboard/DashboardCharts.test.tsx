/**
 * The Dashboard charts' axes (prod 5.10.00 at 390 px): "Feedback by Source"
 * rotated its labels out of the card, and the trend chart cut "10000" to
 * "0000". Recharts is stubbed to expose the props each axis gets; the layout
 * is the same at every viewport (horizontal bars, sized axes), so asserting
 * the props covers 390 and 1440 px alike.
 */
import { describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { at } from '@test/defined'
import type { ReactNode } from 'react'
import { CategoryChart, SourceChart, TrendChart } from './DashboardCharts'

vi.mock('../../hooks/useDisplayLabels', () => ({
  useDisplayLabels: () => ({ category: (id: string) => `cat:${id}`, source: (id: string) => `src:${id}` }),
}))

interface AxisStubProps {
  readonly width?: number | string
  readonly type?: string
  readonly angle?: number
  readonly tickFormatter?: (value: unknown) => string
}

/** An axis that shows the props under test as data attributes. */
function axisStub(testId: string) {
  return function AxisStub({ width, type, angle, tickFormatter }: AxisStubProps) {
    return (
      <div
        data-testid={testId}
        data-width={width}
        data-type={type}
        data-angle={angle}
        data-sample={tickFormatter?.(10000)}
      />
    )
  }
}

vi.mock('recharts', () => {
  const passThrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const chart = ({ children, layout }: { children?: ReactNode; layout?: string }) => <div data-testid="chart" data-layout={layout}>{children}</div>
  return {
    ResponsiveContainer: passThrough,
    LineChart: chart,
    ComposedChart: chart,
    BarChart: chart,
    CartesianGrid: () => null,
    Tooltip: ({ formatter }: { formatter?: (value: unknown, name: unknown) => unknown }) =>
      formatter === undefined ? null : <div data-testid="tooltip-sample">{String(formatter(-0.78, 'Average sentiment'))}</div>,
    Line: ({ name }: { name?: string }) => <div data-testid="series">{name}</div>,
    Bar: ({ name }: { name?: string }) => (name === undefined ? null : <div data-testid="series">{name}</div>),
    XAxis: axisStub('x-axis'),
    YAxis: axisStub('y-axis'),
  }
})

/** The charts link to Categories, so they render inside a router. */
const render = (ui: ReactNode) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)

const attrs = (el: HTMLElement, ...names: string[]) => names.map((name) => el.getAttribute(`data-${name}`))

describe('TrendChart', () => {
  it('draws what its title says: reviews as bars and average sentiment as a line, named in words', () => {
    render(<TrendChart summary={{ daily_totals: [{ date: '2026-10-01', count: 4 }], daily_sentiment: [{ date: '2026-10-01', avg_sentiment: -0.78, count: 4 }] }} />)
    expect(screen.getAllByTestId('series').map((el) => el.textContent)).toStrictEqual(['Reviews', 'Average sentiment'])
    expect(screen.getByTestId('tooltip-sample')).toHaveTextContent('Mostly negative (\u22120.78),Average sentiment')
  })

  it('formats 5-digit counts compactly and lets the Y axis measure its ticks', () => {
    render(<TrendChart summary={{ daily_totals: [{ date: '2026-10-02', count: 9800 }, { date: '2026-10-01', count: 120 }], daily_sentiment: [] }} />)
    expect(attrs(at(screen.getAllByTestId('y-axis'), 0), 'sample', 'width')).toStrictEqual(['10K', 'auto'])
  })
})

describe('SourceChart', () => {
  const sources = { period_days: 0, sources: { web_www_trustpilot_com: 40, 'Acme Android_android': 12 } }

  it('lays sources out as horizontal bars: names on a sized category axis, never rotated', () => {
    render(<SourceChart sources={sources} />)
    const [chart, yAxis] = [screen.getByTestId('chart'), screen.getByTestId('y-axis')]
    expect([...attrs(chart, 'layout'), ...attrs(yAxis, 'type', 'angle', 'width')])
      .toStrictEqual(['vertical', 'category', null, '128'])
  })

  it('formats the count axis compactly', () => {
    render(<SourceChart sources={sources} />)
    expect(attrs(screen.getByTestId('x-axis'), 'type', 'sample')).toStrictEqual(['number', '10K'])
  })
})

describe('CategoryChart', () => {
  it('sizes the category axis to its longest label', () => {
    render(<CategoryChart categories={{ period_days: 7, categories: { delivery: 3 } }} />)
    expect(attrs(screen.getByTestId('y-axis'), 'type', 'width')).toStrictEqual(['category', '90'])
  })
})

describe('CategoryChart "Other" bar', () => {
  const categories = { period_days: 0, categories: { other: 900, delivery: 300, app: 100 } }

  it('lists Other last even when it is the largest, and opens its filtered list', () => {
    render(<CategoryChart categories={categories} />)
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs).toStrictEqual(['/categories?category=delivery', '/categories?category=app', '/categories?category=other'])
  })
})
