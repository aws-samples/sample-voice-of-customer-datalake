/**
 * @fileoverview Pins the invariant the schema's `context` policy rests on.
 *
 * `context` is capped at 500 chars server-side and REJECTS rather than clamps,
 * justified in the stream schema header by "code-authored and bounded by
 * construction". Nothing enforced that bound, so this asserts the worst case the
 * current filter model can produce. If a multi-select or free-text search is ever
 * added to ChatFilters, this fails — which is the signal to give `context` a
 * client-side mirror and an i18n message, or to switch it to clamping.
 *
 * @module pages/Chat/chatContext.test
 */
import { describe, expect, it } from 'vitest'
import type { ChatFilters } from '../../store/chatStore'
import { MAX_CHAT_CONTEXT_LENGTH } from '../../api/streamLimits'
import { buildChatContext, MAX_FILTER_VALUE_LENGTH } from './chatContext'




/**
 * Pathological, not merely long. `category` comes from the tenant's configured
 * category list and nothing validates its length, so the bound has to hold for a
 * value of any size — that was the hole in the previous version of this test,
 * which assumed 120 chars was a worst case.
 */
const ABSURD_VALUE = 'a'.repeat(10_000)

describe('buildChatContext', () => {
  it('includes the time range with no filters set', () => {
    expect(buildChatContext(7, {})).toBe('Time range: last 7 days')
  })

  it('appends each filter that is set', () => {
    const filters: ChatFilters = {
      source: 'webscraper', category: 'delivery', sentiment: 'negative',
    }
    expect(buildChatContext(30, filters)).toBe(
      'Time range: last 30 days. Source: webscraper. Category: delivery. Sentiment: negative',
    )
  })

  it('skips filters that are absent or empty rather than emitting empty clauses', () => {
    const filters: ChatFilters = {
      source: '', category: undefined, sentiment: 'positive',
    }
    expect(buildChatContext(7, filters)).toBe('Time range: last 7 days. Sentiment: positive')
  })

  it('stays inside the server cap for filter values of ANY length', () => {
    // Every filter set to a value orders of magnitude beyond anything real. The
    // bound must come from the code, not from an assumption about the data: a
    // tenant can configure a category name of any length.
    const filters: ChatFilters = {
      source: ABSURD_VALUE, category: ABSURD_VALUE, sentiment: ABSURD_VALUE, useWebSearch: true,
    }
    const context = buildChatContext(365, filters)
    expect(context.length).toBeLessThan(MAX_CHAT_CONTEXT_LENGTH)
  })

  it('leaves realistic filter values untouched', () => {
    // Truncation must be invisible in practice — it only exists for absurd values.
    const filters: ChatFilters = {
      source: 'webscraper',
      category: 'delivery and fulfilment experience',
      sentiment: 'negative',
    }
    expect(buildChatContext(7, filters)).toContain('Category: delivery and fulfilment experience')
  })

  // Asserting the boundary rather than the absence of an ellipsis: clause() cuts
  // with a bare slice and appends no marker, so "does not contain ..." would pass
  // for a truncated value too — vacuous.
  it('passes a value at the per-value cap through whole', () => {
    const atCap = 'c'.repeat(MAX_FILTER_VALUE_LENGTH)
    expect(buildChatContext(7, { category: atCap })).toBe(
      `Time range: last 7 days. Category: ${atCap}`,
    )
  })

  it('cuts a value one character over the cap to exactly the cap', () => {
    const overCap = 'c'.repeat(MAX_FILTER_VALUE_LENGTH + 1)
    const context = buildChatContext(7, { category: overCap })
    expect(context).toBe(`Time range: last 7 days. Category: ${'c'.repeat(MAX_FILTER_VALUE_LENGTH)}`)
    expect(context).not.toContain(overCap)
  })

  it('emits one clause per filter, so the length cannot grow without a schema change', () => {
    // The bound holds because each filter contributes exactly one clause. A
    // multi-select would break this, and that is what should fail here.
    const filters: ChatFilters = {
      source: 'a', category: 'b', sentiment: 'c',
    }
    expect(buildChatContext(7, filters).split('. ')).toHaveLength(4)
  })
})
