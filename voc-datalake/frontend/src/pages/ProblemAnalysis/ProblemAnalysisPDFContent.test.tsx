import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProblemAnalysisPDFContent, { type ProblemAnalysisPDFProps } from './ProblemAnalysisPDFContent'

function makeCategories(): ProblemAnalysisPDFProps['categories'] {
  return [
    {
      category: 'Delivery',
      totalItems: 5,
      urgentCount: 2,
      subcategories: [
        {
          subcategory: 'Late shipment',
          totalItems: 5,
          urgentCount: 2,
          problems: [
            {
              problem: 'Package arrived two weeks late',
              similarProblems: ['Shipment delayed'],
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
