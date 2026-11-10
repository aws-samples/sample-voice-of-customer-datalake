/**
 * A request's enrichment as chips (list card and detail): category and sentiment when enriched, the
 * problem summary in the detail, nothing for a request not enriched yet or whose enrichment failed.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import EnrichmentChips, { ProblemSummary } from './EnrichmentChips'
import type { RequestEnrichment } from '../../api/featureRequestInsightsSchema'

const ENRICHED: RequestEnrichment = {
  status: 'ok', category: 'account_access', subcategory: null, sentiment: 'negative',
  problem_summary: 'Admins cannot sign in with their own identity provider.', enriched_at: '2026-10-01T00:00:00Z',
}

describe('EnrichmentChips', () => {
  it('shows the category in words and the sentiment', () => {
    render(<EnrichmentChips enrichment={ENRICHED} />)
    expect(screen.getByTestId('fr-enrichment')).toHaveTextContent('Account access')
    expect(screen.getByText('Negative')).toBeInTheDocument()
  })

  it('shows the sentiment alone when no category was filed', () => {
    render(<EnrichmentChips enrichment={{ ...ENRICHED, category: null, sentiment: 'mixed' }} />)
    expect(screen.getByTestId('fr-enrichment')).toHaveTextContent('Mixed')
  })

  it.each([
    ['not enriched', undefined],
    ['failed', { ...ENRICHED, status: 'failed' as const }],
    ['empty', { ...ENRICHED, category: null, sentiment: null }],
  ])('shows nothing for a request %s', (_name, enrichment) => {
    render(<EnrichmentChips enrichment={enrichment} />)
    expect(screen.queryByTestId('fr-enrichment')).not.toBeInTheDocument()
  })
})

describe('ProblemSummary', () => {
  it('says the problem in one sentence', () => {
    render(<ProblemSummary enrichment={ENRICHED} />)
    expect(screen.getByTestId('fr-problem-summary')).toHaveTextContent('In one sentence: Admins cannot sign in')
  })

  it('shows nothing without a summary', () => {
    render(<ProblemSummary enrichment={{ ...ENRICHED, problem_summary: null }} />)
    expect(screen.queryByTestId('fr-problem-summary')).not.toBeInTheDocument()
  })
})
