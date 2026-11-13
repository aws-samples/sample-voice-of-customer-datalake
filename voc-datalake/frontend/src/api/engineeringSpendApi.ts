/**
 * @fileoverview The engineering agents' spend for a month (`GET /agents/engineering/spend`, administrators only;
 * `lambda/engineering/spend.py`, docs/autonomous-engineering.md "The spend ledger"): the month's total and its
 * groups, by workflow, repository, run, agent (`<run>/<agent>`), model or day, biggest first. A bad group costs
 * itself and a missing number reads as 0, but an answer with no readable total or groups is an error, never an empty
 * month ("nothing spent" would be a false statement about money).
 *
 * @module api/engineeringSpendApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { parseEach } from './lenientFields'
import { isRecord } from '../lib/typeGuards'

/** The groupings the read takes (`spend.py` `_ATTRIBUTE`), in the order the picker shows them. */
export const SPEND_GROUPINGS = ['workflow', 'repo', 'run', 'agent', 'model', 'day'] as const
export type SpendGrouping = (typeof SPEND_GROUPINGS)[number]
export const isSpendGrouping = (value: string): value is SpendGrouping => SPEND_GROUPINGS.some((by) => by === value)
/** The key of a group whose value was not recorded (and of the models past a session's first 8). */
export const SPEND_NONE = '-'
/** The model the ledger records MicroVM time on. */
export const SPEND_MICROVM = 'microvm'

const amount = z.number().nonnegative().catch(0)
const UsageSchema = z.object({ usd: amount, tokens_in: amount, tokens_out: amount, microvm_seconds: amount })
const GroupSchema = UsageSchema.extend({ key: z.string() })

export type SpendUsage = z.output<typeof UsageSchema>
export type SpendGroup = z.output<typeof GroupSchema>

export interface MonthSpend {
  month: string
  by: SpendGrouping
  total: SpendUsage
  groups: SpendGroup[]
  /** The read stopped at its row limit: the totals are a lower bound. */
  truncated: boolean
}

export interface SpendQuery {
  /** YYYY-MM (UTC). */
  month: string
  by: SpendGrouping
  /** Only this workflow's spend; '' for every workflow. */
  workflow: string
}

/** The answer, read against what was asked (the server echoes both; a missing echo is the query's). */
export function parseMonthSpend(raw: unknown, query: SpendQuery): MonthSpend {
  const record = isRecord(raw) ? raw : {}
  const total = UsageSchema.safeParse(record.total)
  if (!isRecord(record.total) || !total.success || !Array.isArray(record.groups)) {
    throw new Error('The spend answer was unreadable')
  }
  return {
    month: typeof record.month === 'string' ? record.month : query.month,
    by: query.by,
    total: total.data,
    groups: parseEach(GroupSchema, record.groups),
    truncated: record.truncated === true,
  }
}

/** This month, as the server names it (UTC). */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7)
}

export const engineeringSpendKeys = {
  month: ({ month, by, workflow }: SpendQuery) => ['engineering-spend', month, by, workflow] as const,
}

export const engineeringSpendApi = {
  month: async (query: SpendQuery): Promise<MonthSpend> => {
    const params = new URLSearchParams({ month: query.month, by: query.by })
    if (query.workflow !== '') params.set('workflow', query.workflow)
    return parseMonthSpend(await fetchApi<unknown>(`/agents/engineering/spend?${params.toString()}`), query)
  },
}
