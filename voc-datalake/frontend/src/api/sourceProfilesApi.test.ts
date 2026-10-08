import { describe, expect, it } from 'vitest'
import {
  defaultSourceProfile, isLiveErasure, normalizeErasureJob, normalizeErasureJobs, normalizeSourceProfiles,
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
})
