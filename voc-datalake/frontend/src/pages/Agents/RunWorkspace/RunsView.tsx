/**
 * @fileoverview Agents → Runs (7.51.00; admins, with the engineering agents on): the deployment's engineering runs by
 * the month they started, newest first, a page at a time (`GET /agents/engineering/runs`), narrowed to one flow or one
 * status. The filters are the query (`/agents/runs?month=&flow=&status=`, runsFilters.ts); each run opens its workspace,
 * and a run restarted from another names its parent. Above them (7.53.00), the run requests a local assistant made
 * over MCP, waiting for an administrator's confirm (RunRequests.tsx).
 *
 * @module pages/Agents/RunWorkspace/RunsView
 */
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Hand, History } from 'lucide-react'
import CursorPagesList from '../../../components/CursorPagesList/CursorPagesList'
import { useCursorPages } from '../../../hooks/useCursorPages'
import { RUN_LIST_STATUSES, runWorkspaceApi, runWorkspaceKeys } from '../../../api/engineeringRunWorkspaceApi'
import { workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { formatCalendarMonth, formatDateTime } from '../../../utils/dateUtils'
import { monthsOffered } from '../spendView'
import { runWorkspacePath } from './runWorkspacePaths'
import { runsQueryOf } from './runsFilters'
import { RunRequests } from './RunRequests'
import Notice from '../../../components/Notice/Notice'
import { currentMonth } from '../../../api/engineeringSpendApi'
import { agentsPath } from '../agentsPaths'
import type { ListedRun, RunsQuery } from '../../../api/engineeringRunWorkspaceApi'

/** The engineering flows' names by id (the library's list, which the Workflows tab reads too). */
function useFlowNames(): ReadonlyMap<string, string> {
  const { data } = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, staleTime: 30_000 })
  return new Map((data ?? []).filter((flow) => flow.kind === 'engineering' && flow.name !== '').map((flow) => [flow.workflow_id, flow.name]))
}

function Filters({ query, flows, onChange }: Readonly<{
  query: RunsQuery; flows: ReadonlyMap<string, string>; onChange: (next: Partial<RunsQuery>) => void
}>) {
  const { t, i18n } = useTranslation('agents')
  const id = useId()
  const flowIds = query.flow === '' || flows.has(query.flow) ? [...flows.keys()] : [...flows.keys(), query.flow]
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={`${id}-month`} className="block text-[12px] font-semibold text-muted">{t('runWorkspace.runs.month')}</label>
        <select id={`${id}-month`} className="select w-auto" value={query.month} onChange={(event) => onChange({ month: event.target.value })}>
          {monthsOffered(query.month).map((month) => <option key={month} value={month}>{formatCalendarMonth(month, i18n.language)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-flow`} className="block text-[12px] font-semibold text-muted">{t('runWorkspace.runs.flow')}</label>
        <select id={`${id}-flow`} className="select w-auto" value={query.flow} onChange={(event) => onChange({ flow: event.target.value })}>
          <option value="">{t('runWorkspace.runs.allFlows')}</option>
          {flowIds.map((flow) => <option key={flow} value={flow}>{flows.get(flow) ?? flow}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-status`} className="block text-[12px] font-semibold text-muted">{t('runWorkspace.runs.status')}</label>
        <select id={`${id}-status`} className="select w-auto" value={query.status} onChange={(event) => onChange({ status: event.target.value })}>
          <option value="">{t('runWorkspace.runs.allStatuses')}</option>
          {RUN_LIST_STATUSES.map((status) => <option key={status} value={status}>{t(`runWorkspace.runs.statuses.${status}`)}</option>)}
        </select>
      </div>
    </div>
  )
}

function RunRow({ run, flows }: Readonly<{ run: ListedRun; flows: ReadonlyMap<string, string> }>) {
  const { t, i18n } = useTranslation('agents')
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' })
  return (
    <li>
      <Link to={runWorkspacePath(run.run_id)} className="card flex flex-wrap items-center gap-3 p-3 hover:border-border-strong transition-colors">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-text-strong break-words">{run.goal || t('engineeringRun.untitled')}</span>
          <span className="block text-[12px] text-muted break-words">
            {flows.get(run.flow) ?? run.flow}
            {' · '}{t('engineeringRun.started', { when: formatDateTime(run.started_at, i18n.language, '—') })}
            {run.ended_at !== null && ` · ${t('engineeringRun.ended', { when: formatDateTime(run.ended_at, i18n.language, '—') })}`}
          </span>
          {run.parent !== null && (
            <span className="block text-[12px] text-muted">
              {t(`runWorkspace.header.parent.${run.parent.mode === 'restart' ? 'restart' : 'resume'}`)} <span className="font-mono">{run.parent.run_id}</span>
            </span>
          )}
        </span>
        {run.cost_usd !== null && <span className="text-[12px] text-muted tabular-nums">{usd.format(run.cost_usd)}</span>}
        <span className="badge badge-muted">{t(`runWorkspace.runs.statuses.${run.status}`, { defaultValue: run.status })}</span>
      </Link>
    </li>
  )
}

export function RunsView() {
  const { t } = useTranslation('agents')
  const [searchParams, setSearchParams] = useSearchParams()
  const query = runsQueryOf(searchParams)
  const flows = useFlowNames()
  const { query: pages, rows } = useCursorPages<ListedRun>(runWorkspaceKeys.runs(query), (cursor) => runWorkspaceApi.runs(query, cursor))
  const change = (next: Partial<RunsQuery>) => setSearchParams((params) => {
    for (const [name, value] of Object.entries(next)) {
      if (value === '') params.delete(name)
      else params.set(name, value)
    }
    return params
  }, { replace: true })
  const copy = {
    loading: t('runWorkspace.loading'), loadFailed: t('runWorkspace.runs.loadFailed'), more: t('runWorkspace.runs.more'),
    moreFailed: t('runWorkspace.runs.moreFailed'), refreshFailed: t('runWorkspace.runs.loadFailed'),
  }
  const empty = pages.isSuccess && rows.length === 0
  return (
    <section className="space-y-4" aria-label={t('shell.tabs.runs')}>
      <p className="text-sm text-muted max-w-prose">{t('runWorkspace.runs.hint')}</p>
      <RunRequests />
      <Filters query={query} flows={flows} onChange={change} />
      {empty
        ? <RunsEmpty query={query} onShowAll={() => change({ status: '', flow: '' })} />
        : (
            <CursorPagesList query={pages} count={rows.length} copy={copy}>
              <ul className="space-y-2">{rows.map((run) => <RunRow key={run.run_id} run={run} flows={flows} />)}</ul>
            </CursorPagesList>
          )}
    </section>
  )
}

/**
 * Nothing listed (7.52.00 C1, ux-agents-redesign part 4 §4.5): "Nothing needs you" under the Needs-a-person filter
 * (Show all runs), "No runs match" under another filter or month (the list's copy of before), else "No runs yet"
 * with the way to the automations that start them.
 */
function RunsEmpty({ query, onShowAll }: Readonly<{ query: RunsQuery; onShowAll: () => void }>) {
  const { t } = useTranslation('agents')
  if (query.status === 'needs_human') {
    return <Notice variant="empty" icon={Hand} title={t('shell.empty.runsNeedsYou')} text={t('shell.empty.runsNeedsYouHint')} action={{ label: t('shell.empty.showAllRuns'), onClick: onShowAll }} />
  }
  if (query.status !== '' || query.flow !== '' || query.month !== currentMonth()) {
    return <p className="text-sm text-muted">{t('runWorkspace.runs.empty')}</p>
  }
  return (
    <Notice variant="empty" icon={History} title={t('shell.empty.runsTitle')} text={t('shell.empty.runsHint')}
      action={{ label: t('shell.empty.goToAutomations'), to: agentsPath({ view: 'agents' }) }} />
  )
}
