import { describe, expect, it } from 'vitest'
import {
  defaultSourceProfile, erasureEnded, isLiveErasure, normalizeErasableSources, normalizeErasureJob, normalizeErasureJobs,
  normalizeErasureList, normalizeSourceProfiles,
} from './sourceProfilesApi'

describe('normalizeSourceProfiles', () => {
  it('reads a full admin row as-is', () => {
    const row = {
      id: 'support_tickets', label: 'Support tickets', pii: 'redact', retention_days: 365,
      restricted: true, dimension_defaults: { user_type: 'customer' }, tags: ['support'],
    }
    expect(normalizeSourceProfiles({ sources: [row] })).toStrictEqual([row])
  })

  it('fills the contract defaults on the non-admin view', () => {
    expect(normalizeSourceProfiles({ sources: [{ id: 'sales_csv', restricted: false }] }))
      .toStrictEqual([defaultSourceProfile('sales_csv')])
  })

  it('reads junk policy and retention as allow / keep forever, and drops rows without an id', () => {
    const [profile, ...rest] = normalizeSourceProfiles({ sources: [{ id: 'x', pii: 'maybe', retention_days: 'soon' }, { label: 'no id' }] })
    expect(profile?.pii).toBe('allow')
    expect(profile?.retention_days).toBeNull()
    expect(rest).toStrictEqual([])
  })
})

describe('erasure jobs', () => {
  const job = { job_id: 'er_0123456789ab', status: 'running', field: 'email', value_hash: 'abc', deleted_items: 2 }

  it('normalizes the job list and reads an unknown status as failed', () => {
    const jobs = normalizeErasureJobs({ jobs: [job, { ...job, job_id: 'er_2', status: 'weird' }, { nope: true }] })
    expect(jobs.map((j) => j.status)).toStrictEqual(['running', 'failed'])
    expect(jobs[0]?.deleted_objects).toBe(0)
  })

  it('reads a 202 envelope, and null when it carries no job', () => {
    expect(normalizeErasureJob({ job })?.job_id).toBe('er_0123456789ab')
    expect(normalizeErasureJob({})).toBeNull()
  })

  it('treats queued and running as live', () => {
    expect(isLiveErasure({ status: 'queued' })).toBe(true)
    expect(isLiveErasure({ status: 'completed' })).toBe(false)
  })
  it('reads a whole-source job with its phase, and an unknown phase as absent', () => {
    const [whole, odd] = normalizeErasureJobs({ jobs: [
      { ...job, field: 'source', source: 'web_x', phase: 'raw' },
      { ...job, job_id: 'er_2', field: 'source', phase: 'later' },
    ] })
    expect([whole?.field, whole?.phase]).toStrictEqual(['source', 'raw'])
    expect(odd?.phase).toBeUndefined()
  })

  it('keeps only valid source ids in the erasable list', () => {
    expect(normalizeErasableSources({ jobs: [], sources: ['web_x', 'Bad Id', 7, 'manual_import'] }))
      .toStrictEqual(['web_x', 'manual_import'])
    expect(normalizeErasableSources({ jobs: [] })).toStrictEqual([])
  })

  it('reads jobs and sources from one envelope, each half falling back on its own', () => {
    expect(normalizeErasureList({ jobs: [job], sources: ['web_x'] })).toMatchObject({ jobs: [{ job_id: job.job_id }], sources: ['web_x'] })
    expect(normalizeErasureList({ jobs: 'junk', sources: ['web_x'] })).toStrictEqual({ jobs: [], sources: ['web_x'] })
  })

  const live = normalizeErasureJobs({ jobs: [job] })
  const done = normalizeErasureJobs({ jobs: [{ ...job, status: 'completed' }] })
  const failed = normalizeErasureJobs({ jobs: [{ ...job, status: 'failed' }] })

  it('sees an erasure end when a job it saw live has completed or failed', () => {
    expect([live, done, failed].map((jobs) => jobs.length)).toStrictEqual([1, 1, 1])
    expect(erasureEnded(live, done)).toBe(true)
    expect(erasureEnded(live, failed)).toBe(true)
  })

  it('sees no end while the job runs or when it finished before it was first seen', () => {
    expect(erasureEnded(live, live)).toBe(false)
    expect(erasureEnded([], done)).toBe(false)
    expect(erasureEnded(done, done)).toBe(false)
  })
})
