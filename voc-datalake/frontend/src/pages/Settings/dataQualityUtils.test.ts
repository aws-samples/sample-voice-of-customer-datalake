import { describe, it, expect } from 'vitest'
import type { DataQualityJob } from '../../api/dataQualityApi'
import {
  isEnrichRunning,
  isProfileRunning,
  jobProgressPercent,
  orderedCounts,
  percentOf,
  RATING_BUCKETS,
} from './dataQualityUtils'

function job(overrides: Partial<DataQualityJob>): DataQualityJob {
  return {
    job_id: 'dq_1', kind: 'enrich', source: 'Trustpilot', field: 'usefulness', mode: 'missing',
    status: 'running', created_at: null, updated_at: null, completed_at: null, error: null,
    total: 0, processed: 0, updated: 0, skipped: 0, failed: 0, planned: false,
    ...overrides,
  }
}

describe('orderedCounts', () => {
  it('zero-fills expected buckets in order, then appends unexpected ones sorted', () => {
    expect(orderedCounts({ 5: 3, none: 1, zzz: 2, aaa: 4 }, RATING_BUCKETS)).toEqual([
      { key: '1', value: 0 }, { key: '2', value: 0 }, { key: '3', value: 0 }, { key: '4', value: 0 },
      { key: '5', value: 3 }, { key: 'none', value: 1 }, { key: 'aaa', value: 4 }, { key: 'zzz', value: 2 },
    ])
  })
})

describe('percentOf', () => {
  it('rounds to a whole percent and treats an empty total as 0', () => {
    expect(percentOf(1, 3)).toBe(33)
    expect(percentOf(5, 0)).toBe(0)
  })
})

describe('jobProgressPercent', () => {
  it('has no fraction for a profile job until it completes', () => {
    expect(jobProgressPercent(job({ kind: 'profile', processed: 500 }))).toBeNull()
    expect(jobProgressPercent(job({ kind: 'profile', status: 'failed', processed: 500 }))).toBeNull()
    expect(jobProgressPercent(job({ kind: 'profile', status: 'completed', total: 500, processed: 500 }))).toBe(100)
  })

  it('reports processed/total for an enrich job, capped at 100', () => {
    expect(jobProgressPercent(job({ total: 0 }))).toBeNull()
    expect(jobProgressPercent(job({ total: 200, processed: 50 }))).toBe(25)
    expect(jobProgressPercent(job({ total: 10, processed: 12 }))).toBe(100)
  })
})

describe('running-job predicates', () => {
  const jobs = [
    job({ source: 'Trustpilot', field: 'usefulness' }),
    job({ job_id: 'dq_2', kind: 'profile', status: 'completed', source: null, field: null }),
  ]

  it('matches an enrich job only on the same source and field', () => {
    expect(isEnrichRunning(jobs, 'Trustpilot', 'usefulness')).toBe(true)
    expect(isEnrichRunning(jobs, 'Reddit', 'usefulness')).toBe(false)
  })

  it('ignores a profile job that is no longer running', () => {
    expect(isProfileRunning(jobs)).toBe(false)
    expect(isProfileRunning([...jobs, job({ job_id: 'dq_3', kind: 'profile' })])).toBe(true)
  })
})
