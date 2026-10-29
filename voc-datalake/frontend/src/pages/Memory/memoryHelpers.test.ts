import { describe, it, expect } from 'vitest'
import { detailsToHide, wasRedacted } from './privacyPreview'
import { applyOverlay, matchesFilters } from './memoryOverlay'
import { labelKnownIds } from '../../utils/labelKnownIds'
import type { IdLabellers } from '../../utils/labelKnownIds'
import type { MemoryItem } from '../../api/memoryApi'

const item = (id: string, statement: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  memory_id: id, scope: 'company', status: 'active', kind: 'product', statement, categories: [], confidence: undefined,
  source_kind: 'extracted', supporters: 0, sources: [], created_at: '', last_reinforced_at: undefined, retention: 'decay',
  expires_at: undefined, conflicts_with: [], tombstoned: false, ...extra,
})
const NO_FILTERS = { q: '', status: '', kind: '' } as const

describe('detailsToHide (mirrors memory_policy.redact_personal_data)', () => {
  // Assembled at run time: a credential-shaped literal in the source would (rightly) trip gitleaks.
  const fakeKey = ['AKIA', 'EXAMPLE', 'EXAMPLE00'].join('')

  it('names emails, phone numbers and credential-shaped tokens', () => {
    expect(detailsToHide(`Mail ana@example.com or call +34 600 123 456, key ${fakeKey}`))
      .toStrictEqual(['ana@example.com', fakeKey, '+34 600 123 456'])
  })

  it('leaves dates, versions and short amounts alone', () => {
    expect(detailsToHide('Since 2026-10-08 12:30, version 4.2.1, 1 200 users')).toStrictEqual([])
  })

  it('keeps a 13-digit timestamp or order id, as the server does, but names a card number', () => {
    expect(detailsToHide('Export job 1729856000008 failed; order 9900000000002 too')).toStrictEqual([])
    expect(detailsToHide('Card 4111111111111111 was pasted')).toStrictEqual(['4111111111111111'])
    expect(detailsToHide('Ref 40000000000002 only')).toStrictEqual([])
  })

  it('knows a stored statement that had something hidden', () => {
    expect([wasRedacted('Call [redacted]'), wasRedacted('Call us')]).toStrictEqual([true, false])
  })
})

describe('memory overlay', () => {
  it('shows a new memory first until the server lists it, then the listed copy', () => {
    const overlay = { latest: new Map([['n', item('n', 'New')]]), created: ['n'] }
    expect(applyOverlay([item('a', 'Old')], overlay, NO_FILTERS).map((m) => m.memory_id)).toStrictEqual(['n', 'a'])
    expect(applyOverlay([item('n', 'New'), item('a', 'Old')], overlay, NO_FILTERS).map((m) => m.memory_id)).toStrictEqual(['n', 'a'])
  })

  it('lays the answered copy over the listed one and drops what no longer matches', () => {
    const overlay = { latest: new Map([['a', item('a', 'Old', { status: 'archived' })]]), created: [] }
    expect(applyOverlay([item('a', 'Old')], overlay, NO_FILTERS)).toStrictEqual([])
  })

  it('matches filters the way the server does (no status = active, text case-insensitive)', () => {
    expect(matchesFilters(item('a', 'Fast Delivery'), { q: 'delivery', status: '', kind: 'product' })).toBe(true)
    expect(matchesFilters(item('a', 'Fast', { status: 'proposed' }), NO_FILTERS)).toBe(false)
  })
})

describe('labelKnownIds', () => {
  const labellers: IdLabellers = {
    category: (id) => (id === 'pricing_licensing' ? 'Pricing & Licensing' : id),
    isCategory: (id) => id === 'pricing_licensing',
    source: (id) => (id === 'web_www_trustpilot_com' ? 'trustpilot.com' : id.replace(/_/g, ' ')),
    project: (id) => (id === 'proj_1a2b' ? 'Checkout revamp' : undefined),
    unknownProject: 'a project',
  }

  it('reads category, source and project ids as their names', () => {
    expect(labelKnownIds('pricing_licensing on web_www_trustpilot_com for proj_1a2b and proj_zz', labellers))
      .toBe('Pricing & Licensing on trustpilot.com for Checkout revamp and a project')
  })

  it('leaves links, inline code, emails and plain words as written', () => {
    const text = 'See https://x.io/a_b and `raw_id`, mail a_b@x.io — plain words stay'
    expect(labelKnownIds(text, labellers)).toBe(text)
  })
})
