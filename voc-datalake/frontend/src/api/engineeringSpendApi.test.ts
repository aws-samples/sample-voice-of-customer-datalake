/**
 * @fileoverview The spend read's wire: the request it makes (month, grouping, a workflow only when given) and its
 * parse (a bad group costs itself, a missing number is 0, a missing echo is the query's; an answer with no readable
 * total or groups is an error, never an empty month).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { currentMonth, engineeringSpendApi, parseMonthSpend } = await import('./engineeringSpendApi')

const QUERY = { month: '2026-11', by: 'run', workflow: '' } as const
const ZERO = { usd: 0, tokens_in: 0, tokens_out: 0, microvm_seconds: 0 }
const EMPTY = { month: '2026-11', total: ZERO, groups: [] }

beforeEach(() => { resetFetchApi() })

describe('engineeringSpendApi.month', () => {
  it('asks for the month and grouping, and the workflow only when one is given', async () => {
    routeFetchApi({
      'GET /agents/engineering/spend?month=2026-11&by=run': () => EMPTY,
      'GET /agents/engineering/spend?month=2026-11&by=run&workflow=wf+1%2F2': () => EMPTY,
    }, { missStatus: 500 })
    await engineeringSpendApi.month(QUERY)
    await engineeringSpendApi.month({ ...QUERY, workflow: 'wf 1/2' })
    expect(fetchApi.mock.calls.map(([path]) => path)).toStrictEqual([
      '/agents/engineering/spend?month=2026-11&by=run',
      '/agents/engineering/spend?month=2026-11&by=run&workflow=wf+1%2F2',
    ])
  })
})

describe('parseMonthSpend', () => {
  it('keeps the readable groups, a missing number as 0, and the truncation', () => {
    const spend = parseMonthSpend({
      month: '2026-11', by: 'run', truncated: true,
      total: { usd: 1.5, tokens_in: 10, tokens_out: 2, microvm_seconds: 60 },
      groups: [{ key: 'RUN1', usd: 1.5, tokens_in: 10 }, { usd: 3 }, 'junk', { key: 'RUN2', usd: -1 }],
    }, QUERY)
    expect(spend).toStrictEqual({
      month: '2026-11', by: 'run', truncated: true,
      total: { usd: 1.5, tokens_in: 10, tokens_out: 2, microvm_seconds: 60 },
      groups: [
        { key: 'RUN1', usd: 1.5, tokens_in: 10, tokens_out: 0, microvm_seconds: 0 },
        { key: 'RUN2', usd: 0, tokens_in: 0, tokens_out: 0, microvm_seconds: 0 },
      ],
    })
  })

  it('reads an empty month, its echo missing, as the query\'s', () => {
    expect(parseMonthSpend({ total: {}, groups: [] }, QUERY)).toStrictEqual({ month: '2026-11', by: 'run', truncated: false, groups: [], total: ZERO })
  })

  it.each([
    ['not an object', 'nope'],
    ['no total', { groups: [] }],
    ['a total that is not an object', { total: 3, groups: [] }],
    ['groups that are not a list', { total: ZERO, groups: {} }],
  ])('refuses an answer with %s (an error, never "nothing spent")', (_, raw) => {
    expect(() => parseMonthSpend(raw, QUERY)).toThrow('The spend answer was unreadable')
  })

  it('names this month in UTC', () => {
    expect(currentMonth(new Date('2026-11-30T23:30:00-05:00'))).toBe('2026-12')
  })
})
