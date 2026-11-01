import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProblemAnalysisPDFContent, { type ProblemAnalysisPDFProps } from './ProblemAnalysisPDFContent'
import { problemsLine } from './problemGrouping'

function makeCategories(): ProblemAnalysisPDFProps['categories'] {
  return [
    {
      category: 'Delivery',
      totalItems: 5,
      urgentCount: 2,
      subcategories: [
        {
          subcategory: 'Late shipment',
          problemCount: 1,
          totalItems: 5,
          urgentCount: 2,
          problems: [
            {
              problem: 'Package arrived two weeks late',
              similarCount: 1,
              rootCause: 'Carrier capacity shortage',
              itemCount: 3,
              avgSentiment: -0.6,
              urgentCount: 2,
            },
          ],
        },
      ],
    },
  ]
}

describe('ProblemAnalysisPDFContent', () => {
  it('renders the category name', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={makeCategories()} timeRange="Last 7 days" />)
    expect(screen.getByText('Delivery')).toBeInTheDocument()
  })

  it('renders the subcategory name', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={makeCategories()} timeRange="Last 7 days" />)
    expect(screen.getByText('Late shipment')).toBeInTheDocument()
  })

  it('renders the problem statement', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={makeCategories()} timeRange="Last 7 days" />)
    expect(screen.getByText(/Package arrived two weeks late/)).toBeInTheDocument()
  })

  it('renders the root cause hypothesis', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={makeCategories()} timeRange="Last 7 days" />)
    expect(screen.getByText(/Carrier capacity shortage/)).toBeInTheDocument()
  })

  it('indicates similar problems count', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={makeCategories()} timeRange="Last 7 days" />)
    expect(screen.getByText(/\+1 similar/)).toBeInTheDocument()
  })
})

describe('the header subtitle', () => {
  it('names only the filters that are set, then the urgent-only switch', () => {
    render(
      <ProblemAnalysisPDFContent
        resolvedLabel="Resolved"
        categories={makeCategories()}
        timeRange="Last 7 days"
        filters={{ source: 'webscraper', category: '', subcategory: null, urgentOnly: true }}
      />,
    )
    expect(screen.getByText('Time range: Last 7 days • Source: webscraper • Urgent only')).toBeInTheDocument()
  })

  it('is the time range alone when no filter is set', () => {
    render(
      <ProblemAnalysisPDFContent
        resolvedLabel="Resolved"
        categories={makeCategories()}
        timeRange="Last 7 days"
        filters={{ source: null, urgentOnly: false }}
      />,
    )
    expect(screen.getByText('Time range: Last 7 days')).toBeInTheDocument()
  })
})

/** The server lists only the largest problems; the PDF must still report every one (sweep 16, 5.25.02). */
describe('a truncated tree', () => {
  function truncated(): ProblemAnalysisPDFProps['categories'] {
    const [category] = makeCategories()
    if (category === undefined) throw new Error('fixture')
    return [{ ...category, subcategories: category.subcategories.map((s) => ({ ...s, problemCount: 2083 })) }]
  }

  it('counts every problem in the header, not the listed ones, grouped in English', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={truncated()} timeRange="All time" />)
    expect(screen.getByText('2,083')).toBeInTheDocument()
  })

  it('says how many of the subcategory problems are listed', () => {
    render(<ProblemAnalysisPDFContent resolvedLabel="Resolved" categories={truncated()} timeRange="All time" />)
    expect(screen.getByText(/2,083 problems \(largest 1 listed\)/)).toBeInTheDocument()
  })

  it.each([
    [3, 3, '3 problems'],
    [471, 2083, '2,083 problems (largest 471 listed)'],
    [2, 0, '2 problems'],
  ])('%i listed of %i reads "%s"', (listed, total, text) => {
    const problems = makeCategories()[0]?.subcategories[0]?.problems ?? []
    const filler = Array.from({ length: listed }, () => problems[0]).filter((p) => p !== undefined)
    expect(problemsLine({ problemCount: total, problems: filler })).toBe(text)
  })
})
