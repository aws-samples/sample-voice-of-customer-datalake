/**
 * @fileoverview `invalidateFeedbackData` marks exactly the feedback family stale
 * (Radar included, config and live data untouched), the `radar` scope stays in
 * Radar, `afterIngest` repeats the refresh, and the category/dimension helpers
 * delegate to it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppQueryClient } from './queryPolicies'
import { INGEST_FOLLOW_UPS_MS, invalidateFeedbackData } from './invalidateFeedbackData'
import { invalidateAfterCategoryChange } from './feedbackCategoryApi'
import { invalidateAfterDimensionsChange } from './dimensionsApi'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

const FEEDBACK_KEYS: readonly QueryKey[] = [
  ['summary', { days: 7 }], ['feedback', 'f1'], ['categories-feedback', 'all'], ['radar', 'overview'],
  ['dimension-metrics', { key: 'plan' }], ['data-explorer-feedback'],
]
const OTHER_KEYS: readonly QueryKey[] = [
  ['brand-settings'], ['radar', 'brands'], ['projects'], ['assistant', 'sessions'],
]

function seeded(): QueryClient {
  const client = createAppQueryClient()
  for (const key of [...FEEDBACK_KEYS, ...OTHER_KEYS]) client.setQueryData(key, { seeded: true })
  return client
}

const invalidated = (client: QueryClient, key: QueryKey) => client.getQueryState(key)?.isInvalidated === true

afterEach(() => { vi.useRealTimers() })

describe('invalidateFeedbackData', () => {
  it('invalidates the whole feedback family', async () => {
    const client = seeded()
    await invalidateFeedbackData(client)
    expect(FEEDBACK_KEYS.filter((key) => !invalidated(client, key))).toStrictEqual([])
  })

  it('leaves configuration, projects and live data alone', async () => {
    const client = seeded()
    await invalidateFeedbackData(client)
    expect(OTHER_KEYS.filter((key) => invalidated(client, key))).toStrictEqual([])
  })

  it('the radar scope refreshes Radar data only, not its brand list', async () => {
    const client = seeded()
    await invalidateFeedbackData(client, { scope: 'radar' })
    expect(invalidated(client, ['radar', 'overview'])).toBe(true)
    expect(invalidated(client, ['radar', 'brands'])).toBe(false)
    expect(invalidated(client, ['summary', { days: 7 }])).toBe(false)
  })

  it('afterIngest refreshes again while the imported reviews land', async () => {
    vi.useFakeTimers()
    const client = seeded()
    await invalidateFeedbackData(client, { afterIngest: true })
    // A fresh answer arrives (no longer invalidated) before the reviews have landed …
    client.setQueryData(['summary', { days: 7 }], { seeded: 'refetched' })
    expect(invalidated(client, ['summary', { days: 7 }])).toBe(false)
    // … and the follow-up marks it stale again.
    await vi.advanceTimersByTimeAsync(Math.max(...INGEST_FOLLOW_UPS_MS))
    expect(invalidated(client, ['summary', { days: 7 }])).toBe(true)
  })
})

describe('the category and dimension helpers delegate', () => {
  it('a category change invalidates the family', async () => {
    const client = seeded()
    await invalidateAfterCategoryChange(client)
    expect(invalidated(client, ['radar', 'overview'])).toBe(true)
    expect(invalidated(client, ['brand-settings'])).toBe(false)
  })

  it('a dimension change invalidates the family, dimension metrics included', async () => {
    const client = seeded()
    await invalidateAfterDimensionsChange(client)
    expect(invalidated(client, ['dimension-metrics', { key: 'plan' }])).toBe(true)
    expect(invalidated(client, ['projects'])).toBe(false)
  })
})
