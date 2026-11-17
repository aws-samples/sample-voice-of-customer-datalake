/**
 * @fileoverview The Runs list's filters (7.51.00, `/agents/runs?month=&flow=&status=`): filters of the query, as the
 * server checks them (a bad one reads as none: this month, every flow, every status). A flow's page links its runs
 * here (workflowPaths.ts `flowRunsPath`).
 *
 * @module pages/Agents/RunWorkspace/runsFilters
 */
import { RUN_LIST_STATUSES } from '../../../api/engineeringRunWorkspaceApi'
import { monthOf } from '../spendView'
import type { RunsQuery } from '../../../api/engineeringRunWorkspaceApi'

/** A workflow's id (engineering/workspace/layout.py ID). */
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const isListStatus = (value: string) => RUN_LIST_STATUSES.some((status) => status === value)

/** The filters in the address, each checked as the server would (a bad one is none). */
export function runsQueryOf(params: URLSearchParams, now: Date = new Date()): RunsQuery {
  const flow = params.get('flow') ?? ''
  const status = params.get('status') ?? ''
  return { month: monthOf(params, now), flow: FLOW_ID.test(flow) ? flow : '', status: isListStatus(status) ? status : '' }
}
