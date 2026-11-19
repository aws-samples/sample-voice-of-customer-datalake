/**
 * The Results filters as the address holds them (UX §10.1): `range` (30 days when absent), `lang`, `ending` and one
 * `hf.<id>=<value>` per hidden field, so a view can be shared; "Include test responses" is never among them.
 */
import { describe, expect, it } from 'vitest'
import { CLEAR_FILTERS, apiFilters, hidesFunnel, narrows, readFilters, writeFilters } from './resultFilters'

const NARROW = { range: '7', language: 'pl', ending: 'end_thanks', hidden: { app_version: '2.1', user_id: 'qa-17' } } as const

describe('readFilters', () => {
  it('reads the range, the language, the ending and every hidden field value', () => {
    const params = new URLSearchParams('range=7&lang=pl&ending=end_thanks&hf.app_version=2.1&hf.user_id=qa-17&tab=summary')
    expect(readFilters(params)).toStrictEqual(NARROW)
  })

  it('reads the last 30 days for a missing or unknown range, and skips an empty or nameless hidden field', () => {
    expect(readFilters(new URLSearchParams(''))).toStrictEqual(CLEAR_FILTERS)
    expect(readFilters(new URLSearchParams('range=365&hf.=x&hf.user_id='))).toStrictEqual(CLEAR_FILTERS)
  })
})

describe('writeFilters', () => {
  it('writes the filters over the old ones and keeps the other parameters', () => {
    const params = new URLSearchParams('view=responses&range=90&hf.old=1')
    expect(writeFilters(params, NARROW).toString()).toBe('view=responses&range=7&lang=pl&ending=end_thanks&hf.app_version=2.1&hf.user_id=qa-17')
  })

  it('leaves the defaults out of the address', () => {
    expect(writeFilters(new URLSearchParams('range=7&lang=pl'), CLEAR_FILTERS).toString()).toBe('')
  })

  it('reads back what it wrote', () => {
    expect(readFilters(writeFilters(new URLSearchParams(), NARROW))).toStrictEqual(NARROW)
  })
})

describe('narrows', () => {
  it('is false for the default view, true for any filter', () => {
    expect(narrows(CLEAR_FILTERS)).toBe(false)
    expect(narrows({ ...CLEAR_FILTERS, range: 'all' })).toBe(true)
    expect(narrows({ ...CLEAR_FILTERS, ending: 'end_thanks' })).toBe(true)
    expect(narrows({ ...CLEAR_FILTERS, hidden: { user_id: 'qa-17' } })).toBe(true)
  })
})

describe('hidesFunnel', () => {
  it('is true under a language, an ending or a hidden value (the counters know none), never for dates alone', () => {
    expect([
      hidesFunnel(CLEAR_FILTERS), hidesFunnel({ ...CLEAR_FILTERS, range: '7' }), hidesFunnel({ ...CLEAR_FILTERS, language: 'pl' }),
      hidesFunnel({ ...CLEAR_FILTERS, ending: 'end_a' }), hidesFunnel({ ...CLEAR_FILTERS, hidden: { plan: 'pro' } }),
    ]).toStrictEqual([false, false, true, true, true])
  })
})

describe('apiFilters', () => {
  it('asks for the range in days, all time as no limit, with or without test responses', () => {
    expect(apiFilters(NARROW, true)).toStrictEqual({ days: 7, language: 'pl', ending: 'end_thanks', hidden: NARROW.hidden, includeTest: true })
    expect(apiFilters({ ...CLEAR_FILTERS, range: 'all' }, false)).toStrictEqual({ days: null, language: '', ending: '', hidden: {}, includeTest: false })
  })
})
