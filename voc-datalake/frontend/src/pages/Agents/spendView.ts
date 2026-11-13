/**
 * @fileoverview The Spend tab's view options (`?tab=spend&month=&by=&workflow=`): read from the address as the
 * server checks them (a bad one is the default), and the months the picker offers.
 *
 * @module pages/Agents/spendView
 */
import { currentMonth, isSpendGrouping } from '../../api/engineeringSpendApi'
import type { SpendQuery } from '../../api/engineeringSpendApi'

/** How many months back the picker offers (the ledger keeps every month: an older one is reached by its address). */
const MONTHS_OFFERED = 24
/** A month the ledger keeps (spend.py `ledger_pk`: 2000-2099), so the server never refuses one taken here. */
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/
/** The longest workflow id the read takes (a run's flow is recorded up to 500 characters). */
const MAX_WORKFLOW_CHARS = 500

/** The last {@link MONTHS_OFFERED} months, newest first, and `month` too when it is older. */
export function monthsOffered(month: string, now: Date = new Date()): string[] {
  const months = Array.from({ length: MONTHS_OFFERED }, (_, back) =>
    currentMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))))
  return months.includes(month) ? months : [...months, month]
}

/** The view options in the address, each checked as the server would (a bad one is the default). */
export function spendQueryOf(params: URLSearchParams, now: Date = new Date()): SpendQuery {
  const month = params.get('month') ?? ''
  const by = params.get('by') ?? ''
  const workflow = params.get('workflow') ?? ''
  return {
    month: MONTH.test(month) ? month : currentMonth(now),
    by: isSpendGrouping(by) ? by : 'workflow',
    workflow: workflow.length <= MAX_WORKFLOW_CHARS && !workflow.includes('#') ? workflow : '',
  }
}
