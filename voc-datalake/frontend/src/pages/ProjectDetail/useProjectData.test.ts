/**
 * When the Background Jobs panel stops polling.
 *
 * The panel's whole reliability rests on this decision. Polling that stops too
 * early is the defect the U9 handover exists to fix: a job started outside a
 * wizard is invisible until something else happens to refetch.
 *
 * The interesting cases are all about elapsed time, so they are asserted on the
 * pure function rather than by driving a component through 30 seconds of timers.
 * Fake timers here leaked across files and broke unrelated suites.
 */
import { describe, it, expect } from 'vitest'
import { jobsPollInterval, JOB_START_POLL_WINDOW_MS } from './useProjectData'
import type { ProjectJob } from '../../api/types'

type JobStatuses = ReadonlyArray<Pick<ProjectJob, 'status'>>

const NOW = 1_700_000_000_000
const running: JobStatuses = [{ status: 'running' }]
const pending: JobStatuses = [{ status: 'pending' }]
const finished: JobStatuses = [{ status: 'completed' }, { status: 'failed' }]

describe('jobsPollInterval', () => {
  it('polls while a job is running', () => {
    expect(jobsPollInterval(running, null, NOW)).toBeGreaterThan(0)
  })

  it('polls while a job is pending', () => {
    expect(jobsPollInterval(pending, null, NOW)).toBeGreaterThan(0)
  })

  it('stops when every job has finished and nothing was just started', () => {
    expect(jobsPollInterval(finished, null, NOW)).toBe(0)
  })

  it('stops on an empty list with no recent start', () => {
    expect(jobsPollInterval([], null, NOW)).toBe(0)
  })

  /**
   * The invalidation on kick-off buys exactly one refetch, and the jobs list is
   * read from DynamoDB without ConsistentRead while the handler returns `job_id`
   * as soon as it has written the row — so that refetch can legitimately come
   * back empty. If polling stopped there, the panel would be blind again.
   */
  it('keeps polling on an empty list just after a job was started', () => {
    expect(jobsPollInterval([], NOW - 1000, NOW)).toBeGreaterThan(0)
  })

  it('keeps polling at the last moment inside the start window', () => {
    expect(jobsPollInterval([], NOW - (JOB_START_POLL_WINDOW_MS - 1), NOW)).toBeGreaterThan(0)
  })

  it('gives up once the start window has elapsed, so a lost job cannot poll forever', () => {
    expect(jobsPollInterval([], NOW - JOB_START_POLL_WINDOW_MS, NOW)).toBe(0)
  })

  it('keeps polling inside the window even when the visible jobs have all finished', () => {
    // Deliberate: inside the window, what is currently visible proves nothing.
    // A project whose earlier jobs are done is exactly where a just-started job
    // is missing because its row is not readable yet — stopping here would
    // reinstate the blindness. The window's own expiry is what bounds this.
    expect(jobsPollInterval(finished, NOW - 1000, NOW)).toBeGreaterThan(0)
  })
})
