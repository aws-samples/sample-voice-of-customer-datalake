import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CategoriesPDFContent, { type CategoriesPDFProps } from './CategoriesPDFContent'

function makeProps(overrides: Partial<CategoriesPDFProps> = {}): CategoriesPDFProps {
  return {
    categoryData: [{ name: 'delivery', value: 12, color: '#ff0000' }],
    sentimentData: [{ name: 'positive', value: 8, percentage: 67, color: '#00ff00' }],
    wordCloudData: [{ word: 'refund', count: 5 }],
    totalIssues: 20,
    avgSentiment: 15,
    timeRange: 'Last 7 days',
    selectedSource: null,
    ...overrides,
  }
}

describe('CategoriesPDFContent', () => {
  it('renders category names from categoryData', () => {
    render(<CategoriesPDFContent {...makeProps()} />)
    expect(screen.getByText('delivery')).toBeInTheDocument()
  })

  it('renders keyword cloud words', () => {
    render(<CategoriesPDFContent {...makeProps({ wordCloudData: [{ word: 'shipping', count: 9 }] })} />)
    expect(screen.getByText(/shipping/)).toBeInTheDocument()
  })

  it('renders the total issues count', () => {
    render(<CategoriesPDFContent {...makeProps({ totalIssues: 99 })} />)
    expect(screen.getByText('99')).toBeInTheDocument()
  })

  it('renders the selected source label when provided', () => {
    render(<CategoriesPDFContent {...makeProps({ selectedSource: 'webscraper' })} />)
    expect(screen.getByText(/webscraper/)).toBeInTheDocument()
  })
})
