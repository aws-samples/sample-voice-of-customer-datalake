/**
 * @fileoverview Agents → Spend (admins, when the engineering agents are on): what the engineering agents spent in a
 * month, from the spend ledger (api/engineeringSpendApi.ts): the month's cost, tokens and MicroVM time, then its
 * groups by workflow, repository, run, agent, model or day, biggest first. The month, the grouping and a workflow
 * filter are view options in the address (`?tab=spend&month=&by=&workflow=`); a workflow's row narrows the view to
 * its runs, and a run's (or an agent's) row opens its run monitor.
 *
 * @module pages/Agents/EngineeringSpend
 */
import { useId } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowDownToLine, ArrowUpFromLine, CircleDollarSign, Timer, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import MetricCard from '../../components/MetricCard/MetricCard'
import { failedReads } from '../../utils/failedReads'
import { formatCalendarDay, formatCalendarMonth } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import {
  SPEND_GROUPINGS, SPEND_MICROVM, SPEND_NONE, currentMonth, engineeringSpendApi, engineeringSpendKeys, isSpendGrouping,
} from '../../api/engineeringSpendApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { useConfigStore } from '../../store/configStore'
import { budgetShare, monthsOffered, shareTone, spendQueryOf } from './spendView'
import type { LucideIcon } from 'lucide-react'
import type { MonthSpend, SpendGroup, SpendGrouping, SpendQuery, SpendUsage } from '../../api/engineeringSpendApi'

const runPath = (runId: string) => `/agents/engineering/${encodeURIComponent(runId)}`

function useMonthSpend(query: SpendQuery) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({
    queryKey: engineeringSpendKeys.month(query),
    queryFn: () => engineeringSpendApi.month(query),
    enabled: configured,
    // The previous view stays on screen while the next month or grouping is read.
    placeholderData: keepPreviousData,
  })
}

interface Library {
  names: ReadonlyMap<string, string>
  /** Each engineering flow's monthly budget as it is now (this month's column). */
  budgets: ReadonlyMap<string, number>
}

/** The workflows' names and budgets by id (the library's list, which the Workflows tab reads too). */
function useLibrary(): Library {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const { data } = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, enabled: configured, staleTime: 30_000 })
  const flows = data ?? []
  return {
    names: new Map(flows.filter((flow) => flow.name !== '').map((flow) => [flow.workflow_id, flow.name])),
    // (the list's entries are the server's as sent, only checked against the schema, not parsed by it: so the value
    // is checked here, a budget being a positive number, else none)
    budgets: new Map(flows.flatMap((flow) => {
      const budget: unknown = flow.monthly_budget_usd
      return typeof budget === 'number' && budget > 0 ? [[flow.workflow_id, budget] as const] : []
    })),
  }
}

function useFormats() {
  const { i18n } = useTranslation()
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
  const hours = new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'hour', unitDisplay: 'short', maximumFractionDigits: 1 })
  const minutes = new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 0 })
  const seconds = new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 0 })
  return {
    usd: (value: number) => usd.format(value),
    count: (value: number) => formatCount(value, i18n.language),
    /** MicroVM time in its largest sensible unit. */
    time: (value: number) => {
      if (value >= 3600) return hours.format(value / 3600)
      return value >= 60 ? minutes.format(value / 60) : seconds.format(value)
    },
    month: (month: string) => formatCalendarMonth(month, i18n.language),
    day: (month: string, day: string) => formatCalendarDay(`${month}-${day}`, i18n.language, 'short'),
  }
}

/** The month's totals; a read cut at its limit shows each as a lower bound ("~"). */
function Totals({ total, approximate }: Readonly<{ total: SpendUsage; approximate: boolean }>) {
  const { t } = useTranslation('agents')
  const format = useFormats()
  const icon = (Icon: LucideIcon) => <Icon size={18} aria-hidden="true" />
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard title={t('spend.cost')} value={format.usd(total.usd)} icon={icon(CircleDollarSign)} approximate={approximate} />
      <MetricCard title={t('spend.tokensIn')} value={total.tokens_in} icon={icon(ArrowDownToLine)} approximate={approximate} />
      <MetricCard title={t('spend.tokensOut')} value={total.tokens_out} icon={icon(ArrowUpFromLine)} approximate={approximate} />
      <MetricCard title={t('spend.microvm')} value={format.time(total.microvm_seconds)} icon={icon(Timer)} approximate={approximate} />
    </div>
  )
}

/** An agent's group (`<run>/<agent>`): the agent, linking to its run; a part not recorded says so (and a run not
 * recorded links nowhere). */
function AgentName({ value }: Readonly<{ value: string }>) {
  const { t } = useTranslation('agents')
  const cut = value.indexOf('/')
  const run = value.slice(0, cut)
  const agent = value.slice(cut + 1)
  const agentText = agent === SPEND_NONE ? t('spend.none') : agent
  if (cut < 0) return <span className="font-mono break-all">{value}</span>
  if (run === SPEND_NONE) return <span className="text-muted">{agentText}</span>
  return (
    <Link to={runPath(run)} className="link break-all">
      <span className="font-mono">{agentText}</span>{' '}
      <span className="text-[12px] text-muted font-mono">{t('spend.inRun', { run })}</span>
    </Link>
  )
}

/** A group's name: a workflow's from the library, a run's and an agent's linking to the run, a model's or a day's. */
function GroupName({ group, by, month, names, onWorkflow }: Readonly<{
  group: SpendGroup; by: SpendGrouping; month: string; names: ReadonlyMap<string, string>; onWorkflow: (id: string) => void
}>) {
  const { t } = useTranslation('agents')
  const format = useFormats()
  const { key } = group
  if (key === SPEND_NONE || key === '') return <span className="text-muted">{t(by === 'model' ? 'spend.otherModels' : 'spend.none')}</span>
  if (by === 'model' && key === SPEND_MICROVM) return <span>{t('spend.microvm')}</span>
  const name = names.get(key) ?? key
  switch (by) {
    case 'workflow':
      return (
        <button type="button" className="link text-left break-all" onClick={() => onWorkflow(key)}
          aria-label={t('spend.workflowRuns', { name })}>{name}</button>
      )
    case 'run': return <Link to={runPath(key)} className="link font-mono break-all">{key}</Link>
    case 'agent': return <AgentName value={key} />
    case 'day': return <span>{format.day(month, key)}</span>
    default: return <span className="font-mono break-all">{key}</span>
  }
}

const TH = 'px-3 py-2 text-left text-[12px] font-semibold text-muted'
const TH_NUM = 'px-3 py-2 text-right text-[12px] font-semibold text-muted'
const TD_NUM = 'px-3 py-2 text-right text-sm font-mono whitespace-nowrap'

/** A workflow's spend against its monthly budget: the share, marked from 80% (the first alert's level). */
function BudgetCell({ usd, budget }: Readonly<{ usd: number; budget: number | undefined }>) {
  const { t } = useTranslation('agents')
  const format = useFormats()
  if (budget === undefined) return <span className="text-muted">{t('spend.noBudget')}</span>
  const percent = budgetShare(usd, budget)
  const tone = shareTone(percent)
  return (
    <span>
      {format.usd(budget)} · <span className={tone}>{t('spend.budgetShare', { percent })}</span>
      {percent >= 100 && <span className="sr-only"> {t('spend.overBudget')}</span>}
    </span>
  )
}

function GroupTable({ spend, library, onWorkflow }: Readonly<{
  spend: MonthSpend; library: Library; onWorkflow: (id: string) => void
}>) {
  const { t } = useTranslation('agents')
  const format = useFormats()
  const { names, budgets } = library
  // (by workflow, this month only: each one's spend against its budget as it is now; a past month ran under the
  // budgets its runs kept, which the alerts measured, not today's)
  const withBudget = spend.by === 'workflow' && spend.month === currentMonth() && budgets.size > 0
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[36rem]">
        <caption className="sr-only">{t('spend.tableCaption', { by: t(`spend.by.${spend.by}`), month: format.month(spend.month) })}</caption>
        <thead className="bg-bg-accent border-b border-border">
          <tr>
            <th scope="col" className={TH}>{t(`spend.by.${spend.by}`)}</th>
            <th scope="col" className={TH_NUM}>{t('spend.cost')}</th>
            <th scope="col" className={TH_NUM}>{t('spend.tokensIn')}</th>
            <th scope="col" className={TH_NUM}>{t('spend.tokensOut')}</th>
            <th scope="col" className={TH_NUM}>{t('spend.microvm')}</th>
            {withBudget && <th scope="col" className={TH_NUM}>{t('spend.budget')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {spend.groups.map((group) => (
            <tr key={group.key}>
              <th scope="row" className="px-3 py-2 text-left text-sm font-normal text-text-strong">
                <GroupName group={group} by={spend.by} month={spend.month} names={names} onWorkflow={onWorkflow} />
              </th>
              <td className={TD_NUM}>{format.usd(group.usd)}</td>
              <td className={TD_NUM}>{format.count(group.tokens_in)}</td>
              <td className={TD_NUM}>{format.count(group.tokens_out)}</td>
              <td className={TD_NUM}>{format.time(group.microvm_seconds)}</td>
              {withBudget && <td className={TD_NUM}><BudgetCell usd={group.usd} budget={budgets.get(group.key)} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {withBudget && <p className="px-3 py-2 text-[12px] text-muted">{t('spend.budgetHint')}</p>}
    </div>
  )
}

function Controls({ query, names, onChange }: Readonly<{
  query: SpendQuery; names: ReadonlyMap<string, string>; onChange: (next: Partial<SpendQuery>) => void
}>) {
  const { t } = useTranslation('agents')
  const format = useFormats()
  const monthId = useId()
  const byId = useId()
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={monthId} className="block text-[12px] font-semibold text-muted">{t('spend.month')}</label>
        <select id={monthId} className="select w-auto" value={query.month} onChange={(e) => onChange({ month: e.target.value })}>
          {monthsOffered(query.month).map((month) => <option key={month} value={month}>{format.month(month)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={byId} className="block text-[12px] font-semibold text-muted">{t('spend.groupBy')}</label>
        <select id={byId} className="select w-auto" value={query.by} onChange={(e) => { if (isSpendGrouping(e.target.value)) onChange({ by: e.target.value }) }}>
          {SPEND_GROUPINGS.map((by) => <option key={by} value={by}>{t(`spend.by.${by}`)}</option>)}
        </select>
      </div>
      {query.workflow !== '' && (
        <p className="flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm">
          <span className="break-all">{t('spend.onlyWorkflow', { name: names.get(query.workflow) ?? query.workflow })}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ workflow: '' })}
            aria-label={t('spend.allWorkflows')} title={t('spend.allWorkflows')}>
            <X size={14} aria-hidden="true" />
          </button>
        </p>
      )}
    </div>
  )
}

export function EngineeringSpend() {
  const { t } = useTranslation('agents')
  const format = useFormats()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = spendQueryOf(searchParams)
  const read = useMonthSpend(query)
  const library = useLibrary()
  const { names } = library
  const failure = failedReads([read])
  const change = (next: Partial<SpendQuery>) => setSearchParams((params) => {
    for (const [name, value] of Object.entries(next)) {
      if (value === '') params.delete(name)
      else params.set(name, value)
    }
    return params
  }, { replace: true })
  const spend = read.data
  return (
    <section className="space-y-4" aria-busy={read.isFetching}>
      <p className="text-sm text-muted max-w-prose">{t('spend.hint')}</p>
      <Controls query={query} names={names} onChange={change} />
      {read.isLoading && <div className="skeleton h-24" />}
      {failure.loadFailed && <LoadFailed message={t('spend.loadFailed')} onRetry={failure.retry} retrying={failure.retrying} />}
      {spend !== undefined && (
        <>
          <Totals total={spend.total} approximate={spend.truncated} />
          {spend.truncated && <p className="text-sm text-warn">{t('spend.truncated')}</p>}
          {spend.groups.length === 0
            ? <p className="card p-6 text-center text-sm text-muted">{t('spend.empty', { month: format.month(spend.month) })}</p>
            : <GroupTable spend={spend} library={library} onWorkflow={(workflow) => change({ workflow, by: 'run' })} />}
        </>
      )}
    </section>
  )
}
