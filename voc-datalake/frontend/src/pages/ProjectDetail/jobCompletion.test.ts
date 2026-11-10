/**
 * @fileoverview When a finished job's output is refetched: a job that completed within the last ten
 * seconds, by its own `completed_at` (the project page and the company persona library share this).
 */
import { describe, it, expect } from 'vitest'
import { hasRecentlyCompletedJob, recentlyCompletedJobs } from './jobCompletion'
import type { ProjectJob } from '../../api/projectTypes'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

type Job = Pick<ProjectJob, 'job_id' | 'status' | 'completed_at'>

const JOBS: Job[] = [
  { job_id: 'fresh', status: 'completed', completed_at: at(3) },
  { job_id: 'old', status: 'completed', completed_at: at(11) },
  { job_id: 'running', status: 'running', completed_at: at(1) },
  { job_id: 'no-stamp', status: 'completed', completed_at: '' },
  { job_id: 'unstamped', status: 'completed' },
]

describe('recentlyCompletedJobs', () => {
  it('keeps only completed jobs stamped inside the ten-second window', () => {
    expect(recentlyCompletedJobs(JOBS, NOW).map((job) => job.job_id)).toStrictEqual(['fresh'])
  })

  it('finds nothing in an empty or all-old list', () => {
    expect(recentlyCompletedJobs([], NOW)).toStrictEqual([])
    expect(recentlyCompletedJobs(JOBS.slice(1, 2), NOW)).toStrictEqual([])
  })
})

describe('hasRecentlyCompletedJob', () => {
  it('answers whether any job is in the window', () => {
    expect(hasRecentlyCompletedJob(JOBS, NOW)).toBe(true)
    expect(hasRecentlyCompletedJob(JOBS.slice(1), NOW)).toBe(false)
  })
})
