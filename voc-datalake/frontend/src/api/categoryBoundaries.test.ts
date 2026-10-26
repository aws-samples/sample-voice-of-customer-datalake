/**
 * Boundary normalizers of the categories change set: caller scope, user
 * grants, reprocess jobs, category-change responses and partial-window flags.
 */
import { describe, expect, it } from 'vitest'
import { grantBody, normalizeCallerScope, normalizeUserGrant, scopeAdmits } from './categoryAccessApi'
import { isTerminalJob, normalizeJobEnvelope } from './reprocessApi'
import { categoryChangeErrorKey } from './feedbackCategoryApi'
import { normalizeFeedbackItem } from './feedbackSchema'
import { readPartialWindow } from './partialWindow'

describe('normalizeCallerScope', () => {
  it('accepts the source rule fields without changing the category half', () => {
    const body = { all: true, categories: [], sources_all: false, sources: [], source_rule: 'deny', sources_denied: ['support_tickets'] }
    expect(normalizeCallerScope(body)).toStrictEqual({ all: true, categories: [] })
    expect(normalizeCallerScope({ ...body, source_rule: 'maybe', sources_denied: 'x' })).toStrictEqual({ all: true, categories: [] })
  })

  it('reads a restricted scope', () => {
    expect(normalizeCallerScope({ all: false, categories: ['delivery', 7, ''] })).toStrictEqual({ all: false, categories: ['delivery'] })
  })

  it('treats a "*" entry as every category', () => {
    expect(normalizeCallerScope({ all: false, categories: ['*'] })).toStrictEqual({ all: true, categories: [] })
  })

  it('reads a malformed body as the narrower scope', () => {
    expect(normalizeCallerScope('nope')).toStrictEqual({ all: false, categories: [] })
  })
})

describe('normalizeUserGrant', () => {
  it('reads no stored row as all categories (non-breaking default)', () => {
    expect(normalizeUserGrant({ username: 'u' }))
      .toStrictEqual({ all: true, categories: [], sourceGrant: { mode: 'default', sources: [] } })
  })

  it("reads ['*'] as all categories", () => {
    expect(normalizeUserGrant({ categories: ['*'] }).all).toBe(true)
  })

  it('keeps a selected list and its audit fields', () => {
    expect(normalizeUserGrant({ categories: ['pricing'], updated_by: 'admin', updated_at: '2026-01-01' }))
      .toStrictEqual({
        all: false, categories: ['pricing'], sourceGrant: { mode: 'default', sources: [] },
        updatedBy: 'admin', updatedAt: '2026-01-01',
      })
  })

  it("reads the source grant: absent = default, ['*'] = all, else the listed ids", () => {
    expect(normalizeUserGrant({ categories: ['*'], sources: ['*'] }).sourceGrant).toStrictEqual({ mode: 'all', sources: [] })
    expect(normalizeUserGrant({ categories: ['*'], sources: ['sales_csv', 3] }).sourceGrant)
      .toStrictEqual({ mode: 'list', sources: ['sales_csv'] })
  })

  it('reads sources: null (what GET returns when nothing is stored) as the default rule', () => {
    expect(normalizeUserGrant({ categories: ['*'], sources: null }).sourceGrant).toStrictEqual({ mode: 'default', sources: [] })
  })
})


describe('scopeAdmits / grantBody', () => {
  it('admits everything while the scope is unknown or all', () => {
    expect(scopeAdmits(null, 'x')).toBe(true)
    expect(scopeAdmits({ all: true, categories: [] }, 'x')).toBe(true)
  })

  it('admits only listed names for a restricted scope', () => {
    expect(scopeAdmits({ all: false, categories: ['a'] }, 'a')).toBe(true)
    expect(scopeAdmits({ all: false, categories: ['a'] }, 'other')).toBe(false)
  })

  it("sends ['*'] for all and de-duplicated names otherwise", () => {
    expect(grantBody({ all: true, categories: ['a'] })).toStrictEqual({ categories: ['*'] })
    expect(grantBody({ all: false, categories: ['a', 'a', 'b'] })).toStrictEqual({ categories: ['a', 'b'] })
  })

  it('adds sources for an all or list grant, and omits them (unchanged) for the default rule', () => {
    const all = { all: true, categories: [] }
    expect(grantBody(all, { mode: 'all', sources: [] })).toStrictEqual({ categories: ['*'], sources: ['*'] })
    expect(grantBody(all, { mode: 'list', sources: ['a', 'a'] })).toStrictEqual({ categories: ['*'], sources: ['a'] })
    expect(grantBody(all, { mode: 'default', sources: [] })).toStrictEqual({ categories: ['*'], sources: null })
  })
})

describe('normalizeJobEnvelope', () => {
  const job = {
    job_id: 'rp_0123456789ab', status: 'running', mode: 'raw', days: 0, include_manual: false,
    scanned: 10, updated: 4, unchanged: 6, skipped_manual: 0, failed: 0,
    started_by: 'admin', created_at: 't0', updated_at: 't1',
  }

  it('parses a job', () => {
    expect(normalizeJobEnvelope({ job })).toMatchObject({ job_id: 'rp_0123456789ab', status: 'running', mode: 'raw', scanned: 10 })
  })

  it('reads {job: null} and garbage as no job', () => {
    expect(normalizeJobEnvelope({ job: null })).toBeNull()
    expect(normalizeJobEnvelope('x')).toBeNull()
  })

  it('reads an unknown status as failed so polling stops', () => {
    const parsed = normalizeJobEnvelope({ job: { ...job, status: 'exploded' } })
    expect(parsed?.status).toBe('failed')
    expect(parsed !== null && isTerminalJob(parsed)).toBe(true)
  })

  it('degrades bad counters to 0 instead of dropping the job', () => {
    expect(normalizeJobEnvelope({ job: { ...job, scanned: 'many' } })?.scanned).toBe(0)
  })
})

describe('feedback category fields', () => {
  it('keeps category_source and the override on a feedback item', () => {
    const item = normalizeFeedbackItem({
      feedback_id: '1', category: 'pricing', category_source: 'manual',
      category_override: { previous_category: 'delivery', by_username: 'ada', by_sub: 'sub-x', at: '2026-01-01T00:00:00Z' },
    })
    expect(item.category_source).toBe('manual')
    expect(item.category_override).toStrictEqual({ previous_category: 'delivery', by_username: 'ada', at: '2026-01-01T00:00:00Z' })
  })

  it('drops a malformed override instead of failing the item', () => {
    expect(normalizeFeedbackItem({ feedback_id: '1', category_override: 'x' }).category_override).toBeUndefined()
  })

  it.each([
    [400, 'components:categoryChange.errors.invalid'],
    [404, 'components:categoryChange.errors.notFound'],
    [409, 'components:categoryChange.errors.conflict'],
    [500, 'components:categoryChange.errors.generic'],
  ])('maps API Error: %i to its message', (status, key) => {
    expect(categoryChangeErrorKey(new Error(`API Error: ${status}`))).toBe(key)
  })
})

describe('readPartialWindow', () => {
  it('names the oldest day reached when the time budget stopped the walk', () => {
    expect(readPartialWindow({ is_partial: true, partial_reason: 'time_budget', scanned_through: '2025-03-01' }))
      .toStrictEqual({ isPartial: true, scannedThrough: '2025-03-01' })
  })

  it('gives no date for other partial reasons', () => {
    expect(readPartialWindow({ is_partial: true, partial_reason: 'scan_truncated', scanned_through: '2025-03-01' }))
      .toStrictEqual({ isPartial: true, scannedThrough: null })
  })

  it('reads absent or malformed flags as complete', () => {
    expect(readPartialWindow(undefined)).toStrictEqual({ isPartial: false, scannedThrough: null })
    expect(readPartialWindow({ is_partial: 'yes' })).toStrictEqual({ isPartial: false, scannedThrough: null })
  })
})
