/**
 * The board's pure helpers: money, sorting, filtering and the support form's validation.
 */
import { describe, it, expect } from 'vitest'
import {
  amountDigits, emptySupportDraft, filterRequests, formatUsd, sortRequests, supportValuesOf, validateSupport,
} from './boardFormat'
import type { FeatureRequest } from '../../api/featureRequestsApi'

function request(id: string, fields: Partial<Omit<FeatureRequest, 'totals'>> & { totals?: Partial<FeatureRequest['totals']> } = {}): FeatureRequest {
  const { totals, ...rest } = fields
  return {
    request_id: id, title: `Request ${id}`, description: '', status: 'new', reporter_email: 'dana@example.com',
    reporter_name: 'Dana', created_at: '2026-10-01T00:00:00Z', updated_at: '', project_id: undefined, list_id: undefined, board_id: undefined, fields: undefined,
    ...rest,
    totals: { supporters: 0, customers: 0, committed_usd: 0, at_risk_usd: 0, affected: undefined, avg_rating: undefined, ...totals },
  }
}

const REQUESTS = [
  request('a', { created_at: '2026-10-01T00:00:00Z', totals: { committed_usd: 500, at_risk_usd: 0, supporters: 3 } }),
  request('b', { created_at: '2026-10-03T00:00:00Z', totals: { committed_usd: 100, at_risk_usd: 900, supporters: 1 }, status: 'planned' }),
  request('c', { created_at: '2026-10-02T00:00:00Z', totals: { committed_usd: 500, at_risk_usd: 50, supporters: 2 }, title: 'SSO for Example Air' }),
]
const ids = (requests: readonly FeatureRequest[]) => requests.map((item) => item.request_id)

describe('sorting the board', () => {
  it.each([
    ['newest', ['b', 'c', 'a']],
    ['committed', ['c', 'a', 'b']],
    ['at_risk', ['b', 'c', 'a']],
    ['supporters', ['a', 'c', 'b']],
  ] as const)('by %s', (sort, expected) => {
    expect(ids(sortRequests(REQUESTS, sort))).toStrictEqual(expected)
  })

  it('leaves the given list untouched', () => {
    sortRequests(REQUESTS, 'committed')
    expect(ids(REQUESTS)).toStrictEqual(['a', 'b', 'c'])
  })
})

describe('filtering the board', () => {
  it('keeps only the chosen status', () => {
    expect(ids(filterRequests(REQUESTS, { status: 'planned', query: '' }))).toStrictEqual(['b'])
  })

  it('matches the search in the title, case-insensitively', () => {
    expect(ids(filterRequests(REQUESTS, { status: 'all', query: '  example AIR ' }))).toStrictEqual(['c'])
  })

  it('matches the reporter email too', () => {
    expect(filterRequests(REQUESTS, { status: 'all', query: 'dana@' })).toHaveLength(3)
  })
})

describe('money', () => {
  it('spells whole US dollars in the active locale', () => {
    expect(formatUsd(85000, 'en')).toBe('$85,000')
    expect(formatUsd(85000, 'de')).toMatch(/^85\.000\s\$$/)
  })

  it('keeps only the digits that were typed', () => {
    expect(amountDigits('$1,250,000')).toBe('1250000')
    expect(amountDigits('007')).toBe('7')
  })
})

describe('validating a support', () => {
  const valid = { ...emptySupportDraft('Dana'), customer: 'Acme', amount: '5000' }

  it('accepts a complete draft and sends whole dollars', () => {
    expect(validateSupport(valid)).toStrictEqual({})
    expect(supportValuesOf({ ...valid, deal: '  ', note: ' Renewal ', contactEmail: ' Ops@Acme.Example ' })).toStrictEqual({
      customer: 'Acme', impact: 'committed', amount_usd: 5000, contact_email: 'ops@acme.example', note: 'Renewal',
    })
  })

  it('asks for the customer, the name and an amount', () => {
    expect(validateSupport(emptySupportDraft(' '))).toStrictEqual({
      customer: 'featureRequests:form.errors.customerRequired',
      name: 'featureRequests:form.errors.nameRequired',
      amount: 'featureRequests:form.errors.amountRequired',
    })
  })

  it('needs no amount without a revenue impact, and sends 0', () => {
    const draft = { ...valid, impact: 'none' as const, amount: '' }
    expect(validateSupport(draft)).toStrictEqual({})
    expect(supportValuesOf(draft).amount_usd).toBe(0)
  })

  it('refuses an amount above the API maximum and a malformed contact email', () => {
    expect(validateSupport({ ...valid, amount: '10000000001', contactEmail: 'ops@acme' })).toStrictEqual({
      amount: 'featureRequests:form.errors.amountTooLarge',
      contactEmail: 'featureRequests:form.errors.contactEmail',
    })
  })
})
