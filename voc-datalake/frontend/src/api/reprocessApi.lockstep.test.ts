/**
 * @fileoverview Keeps the SPA's reprocess cost ceiling in step with the backend
 * (`MAX_REPROCESS_ITEMS` in lambda/shared/reprocess_jobs.py), and checks the
 * lenient `stopped_at_ceiling` read.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_REPROCESS_ITEMS, normalizeJobEnvelope } from './reprocessApi'

const JOB = { job_id: 'rp_0123456789ab', status: 'completed' }

describe('MAX_REPROCESS_ITEMS', () => {
  it('equals the backend ceiling', () => {
    const source = readFileSync(join(__dirname, '../../../lambda/shared/reprocess_jobs.py'), 'utf8')
    const match = /^MAX_REPROCESS_ITEMS = (\d+)$/m.exec(source)
    expect(Number(match?.[1])).toBe(MAX_REPROCESS_ITEMS)
  })
})

describe('stopped_at_ceiling', () => {
  it('reads true only when the backend says so', () => {
    expect(normalizeJobEnvelope({ job: { ...JOB, stopped_at_ceiling: true } })?.stopped_at_ceiling).toBe(true)
    expect(normalizeJobEnvelope({ job: JOB })?.stopped_at_ceiling).toBe(false)
    expect(normalizeJobEnvelope({ job: { ...JOB, stopped_at_ceiling: 'yes' } })?.stopped_at_ceiling).toBe(false)
  })
})
