/**
 * The run row's `reads` (how a web_reviews run read each page): read leniently at the boundary, the card's entry
 * picked by its page's id, and the chain a sentence is built of.
 */
import { describe, expect, it } from 'vitest'
import { parseRunRecord } from './sourceRunStatus'
import { readChain, readOfPage, readsExcerpts } from './reviewReads'
import type { TargetRead } from './reviewReads'

const BLOCKED = { method: 'browser', outcome: 'blocked', vendor: 'Cloudflare', reviews: 0 } as const
const BEDROCK = { method: 'bedrock_web_search', outcome: 'readable', reviews: 11 } as const
const READ: TargetRead = {
  target: 'Reviews - Acme', target_id: 'p1', method: 'auto', method_used: 'bedrock_web_search', reviews: 11,
  plan: 'cascade', known_method: null, learned_at: null, excerpt: false, steps: [BLOCKED, BEDROCK],
}
const run = (reads: unknown) => parseRunRecord({ status: 'completed', items_found: 11, reads })

describe('the run row', () => {
  it('reads its entries as they are', () => {
    expect(run([READ])?.reads).toStrictEqual([READ])
  })

  it('never refuses the record for its reads: a malformed list reads as none', () => {
    expect(run('everything')).toStrictEqual({ status: 'completed', items_found: 11, reads: undefined })
  })

  it('leaves out an entry it cannot read, and a step it cannot read; a bad field takes its empty value', () => {
    const odd = { ...READ, method_used: 'curl', plan: 'sometimes', steps: [BLOCKED, { method: 'fax', outcome: 'readable' }] }
    expect(run(['junk', odd])?.reads).toStrictEqual([{ ...READ, method_used: null, plan: null, steps: [BLOCKED] }])
  })

  it('reads a step without reviews as 0 and a blank vendor as none', () => {
    const steps = [{ method: 'browser', outcome: 'blocked', vendor: '' }]
    expect(run([{ ...READ, steps }])?.reads?.[0]?.steps).toStrictEqual([{ method: 'browser', outcome: 'blocked', vendor: undefined,
      reviews: 0 }])
  })
})

describe('the card\'s entry', () => {
  it('is the one naming its page', () => {
    const other = { ...READ, target_id: 'p2' }
    expect(readOfPage([other, READ], 'p1')).toBe(READ)
  })

  it("is the run's only entry when none names it (a page saved without an id)", () => {
    expect(readOfPage([{ ...READ, target_id: '' }], 'p1')).toStrictEqual({ ...READ, target_id: '' })
  })

  it('is none among several entries that do not name it, or without reads', () => {
    expect(readOfPage([{ ...READ, target_id: 'p2' }, { ...READ, target_id: 'p3' }], 'p1')).toBeUndefined()
    expect(readOfPage(undefined, 'p1')).toBeUndefined()
  })
})

describe('the chain', () => {
  it('is the steps that failed before the one that read the page, and that one', () => {
    expect(readChain(READ)).toStrictEqual({ failed: [BLOCKED], success: BEDROCK })
  })

  it('is every failed step when none read it', () => {
    const steps = [BLOCKED, { method: 'bedrock_web_search', outcome: 'error', reviews: 0 } as const]
    expect(readChain({ ...READ, method_used: null, steps })).toStrictEqual({ failed: steps, success: undefined })
  })
})

describe('excerpts', () => {
  it('are the AgentCore web search step\'s reviews, or a read the row marks as excerpts', () => {
    expect(readsExcerpts({ ...READ, method_used: 'agentcore_web_search' })).toBe(true)
    expect(readsExcerpts({ ...READ, excerpt: true })).toBe(true)
    expect(readsExcerpts(READ)).toBe(false)
  })
})
