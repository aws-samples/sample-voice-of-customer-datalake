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
import { buildChatContext } from './chatContext'

/** Mirrors MAX_CONTEXT_LENGTH in lambda/stream/src/schema.ts. */
const SERVER_CONTEXT_CAP = 500

/** Longest plausible single filter value: a long category or source name. */
const LONG_VALUE = 'a'.repeat(120)

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

  it('stays well inside the server cap even with implausibly long filter values', () => {
    // Every filter set, each value far longer than any real category or source.
    const filters: ChatFilters = {
      source: LONG_VALUE, category: LONG_VALUE, sentiment: LONG_VALUE, useWebSearch: true,
    }
    const context = buildChatContext(365, filters)
    expect(context.length).toBeLessThan(SERVER_CONTEXT_CAP)
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
