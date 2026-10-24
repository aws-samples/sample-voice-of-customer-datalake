/**
 * @fileoverview The `GET /feedback/problems` boundary: lenient parse and query string.
 */
import { describe, expect, it } from 'vitest'
import { parseProblemTree, problemTreeSearch } from './problemsApi'

const WIRE = {
  period_days: 30,
  is_partial: true,
  partial_reason: 'time_budget',
  scanned_through: '2026-03-14',
  feedback_count: 3,
  problem_count: 2,
  problems_truncated: false,
  subcategories: ['shipping'],
  categories: [{
    category: 'delivery', total_items: 3, urgent_count: 1,
    subcategories: [{
      subcategory: 'shipping', total_items: 3, urgent_count: 1, problem_count: 2,
      problems: [
        {
          problem: 'Slow delivery times', similar_problems: ['Delivery too slow'], similar_count: 4,
          root_cause: 'Carrier backlog', count: 2, urgent_count: 1, avg_sentiment: -0.5,
          sentiment_counts: { negative: 2 }, sample_ids: ['d1', 'd2'],
        },
        { problem: '', count: 1 },
      ],
    }],
  }],
}

describe('parseProblemTree', () => {
  it('maps the wire shape to the page tree', () => {
    const tree = parseProblemTree(WIRE)
    expect(tree).toMatchObject({ feedbackCount: 3, problemCount: 2, isPartial: true, scannedThrough: '2026-03-14' })
    const sub = tree.categories[0]?.subcategories[0]
    expect(sub?.problemCount).toBe(2)
    expect(sub?.problems).toStrictEqual([{
      problem: 'Slow delivery times', similarProblems: ['Delivery too slow'], similarCount: 4,
      rootCause: 'Carrier backlog', count: 2, avgSentiment: -0.5, urgentCount: 1,
      sentimentCounts: { negative: 2 }, sampleIds: ['d1', 'd2'],
    }])
  })

  it('degrades a malformed body to an empty tree instead of throwing', () => {
    expect(parseProblemTree('nope')).toStrictEqual({
      categories: [], subcategories: [], feedbackCount: 0, problemCount: 0,
      problemsTruncated: false, isPartial: false, scannedThrough: null,
    })
  })

  it('never reports fewer similar wordings or problems than it lists', () => {
    const tree = parseProblemTree({
      categories: [{ category: 'x', subcategories: [{ subcategory: 'y', problems: [{ problem: 'p', similar_problems: ['q', 'r'] }] }] }],
    })
    const sub = tree.categories[0]?.subcategories[0]
    expect([sub?.problemCount, sub?.problems[0]?.similarCount]).toStrictEqual([1, 2])
  })
})

describe('problemTreeSearch', () => {
  it('sends the set filters and leaves out the defaults', () => {
    expect(problemTreeSearch({ days: 30, source: null, category: 'delivery', subcategory: null, urgentOnly: false, similarity: 'med' }))
      .toBe('days=30&category=delivery')
    expect(problemTreeSearch({ days: 7, date_basis: 'review', source: 'web', subcategory: 'shipping', urgentOnly: true, similarity: 'off' }))
      .toBe('days=7&date_basis=review&source=web&subcategory=shipping&urgent=1&similarity=off')
  })
})
