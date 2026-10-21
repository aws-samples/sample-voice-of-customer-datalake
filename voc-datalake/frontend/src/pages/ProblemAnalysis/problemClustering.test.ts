/**
 * @fileoverview Tests for problemClustering — the client half of the problem
 * clustering, including the TS↔Python PARITY check against the shared fixture.
 *
 * The fixture lives with the backend
 * (lambda/shared/test/fixtures/problem_clustering_cases.json) and is read at
 * runtime so there is exactly ONE oracle: a drift between this module and
 * shared/problem_clustering.py fails here or in test_problem_clustering.py.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  normalizeText,
  extractKeywords,
  jaccardSimilarity,
  mergeLeaves,
  type ProblemLeaf,
} from './problemClustering'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(
  here,
  '../../../../lambda/shared/test/fixtures/problem_clustering_cases.json',
)
const CASES = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  normalize: { input: string; expected: string }[]
  keywords: { input: string; expected: string[] }[]
  jaccard: { a: string; b: string; expected: number }[]
}

describe('normalizeText (parity with shared/problem_clustering.py)', () => {
  it.each(CASES.normalize)('normalizes $input', ({ input, expected }) => {
    expect(normalizeText(input)).toBe(expected)
  })
})

describe('extractKeywords (parity)', () => {
  it.each(CASES.keywords)('extracts from $input', ({ input, expected }) => {
    expect([...extractKeywords(input)].sort()).toEqual(expected)
  })

  it('drops short words and stopwords', () => {
    expect([...extractKeywords('is a no ok problem')]).toEqual(['problem'])
  })
})

describe('jaccardSimilarity (parity)', () => {
  it.each(CASES.jaccard)('scores $a vs $b', ({ a, b, expected }) => {
    expect(jaccardSimilarity(extractKeywords(a), extractKeywords(b))).toBeCloseTo(expected, 9)
  })

  it('treats two empty sets as identical and one empty as disjoint', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1)
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0)
  })
})

function leaf(partial: Partial<ProblemLeaf> & { problem: string }): ProblemLeaf {
  return {
    category: 'c',
    subcategory: 's',
    keywords: [...extractKeywords(partial.problem)],
    count: 1,
    urgent_count: 0,
    avg_sentiment: 0,
    root_cause: null,
    ...partial,
  }
}

describe('mergeLeaves', () => {
  it('returns empty for no leaves', () => {
    expect(mergeLeaves([], 0.4)).toEqual([])
  })

  it('keeps dissimilar problems separate', () => {
    const result = mergeLeaves(
      [leaf({ problem: 'delivery was late' }), leaf({ problem: 'pricing too expensive' })],
      0.4,
    )
    expect(result).toHaveLength(2)
  })

  it('merges similar problems above the threshold and sums counts', () => {
    const result = mergeLeaves(
      [
        leaf({ problem: 'order arrived late', count: 5 }),
        leaf({ problem: 'order delivered late', count: 3 }),
      ],
      0.3,
    )
    expect(result).toHaveLength(1)
    expect(result[0].count).toBe(8)
    // The bigger leaf is the representative (leaves arrive biggest-first).
    expect(result[0].problem).toBe('order arrived late')
    expect(result[0].similarProblems).toEqual(['order delivered late'])
  })

  it('a higher threshold splits what a lower one merged', () => {
    const leaves = [
      leaf({ problem: 'order arrived late', count: 5 }),
      leaf({ problem: 'order delivered late', count: 3 }),
    ]
    expect(mergeLeaves(leaves, 0.3)).toHaveLength(1)
    expect(mergeLeaves(leaves, 0.95)).toHaveLength(2)
  })

  it('count-weights the merged sentiment', () => {
    const result = mergeLeaves(
      [
        leaf({ problem: 'login fails', count: 3, avg_sentiment: -0.9 }),
        leaf({ problem: 'login broken', count: 1, avg_sentiment: -0.1 }),
      ],
      0.2,
    )
    // (3*-0.9 + 1*-0.1) / 4 = -0.7
    expect(result[0].avgSentiment).toBeCloseTo(-0.7, 9)
  })

  it('takes the first non-null root cause', () => {
    const result = mergeLeaves(
      [
        leaf({ problem: 'app crashes', count: 5, root_cause: null }),
        leaf({ problem: 'app crashing', count: 3, root_cause: 'memory leak' }),
      ],
      0.3,
    )
    expect(result[0].rootCause).toBe('memory leak')
  })

  it('sorts merged problems biggest-first', () => {
    const result = mergeLeaves(
      [leaf({ problem: 'small issue', count: 1 }), leaf({ problem: 'huge outage', count: 50 })],
      0.4,
    )
    expect(result.map((r) => r.count)).toEqual([50, 1])
  })
})
