/**
 * @fileoverview The platform console's cost page: Administration → Workspaces → Costs, for platform admins only
 * (7.83.00; docs/multi-workspace.md "Cost per workspace"; the section is hidden from everyone else, and the route
 * answers them 403).
 *
 * - Said first: an estimate from list prices, not a bill, with the day the price list was read and a link to it.
 * - A period (UTC days): the last 30 days by default, this month, last month or the last 90 days; never more than the
 *   route's 92.
 * - One table: the calls outside any workspace (the deployment's own, the workspaces no longer active, the calls not
 *   attributed; the first page's), then each workspace, a page at a time (Show more). Each row: calls, input and
 *   output tokens, and the estimated cost; "Incomplete" when part of it is not priced (the models named), "Unpriced"
 *   when nothing of it is (never $0). When the period spans months, each row's months are summed from its days
 *   (platformCostsView.ts), the server's way.
 * - A 403 says platform admins only; a failed read says so with Try again, never as no cost.
 *
 * @module pages/Settings/PlatformCostsSection
 */
import { useId, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { InfiniteData, QueryKey } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleDollarSign, Info } from 'lucide-react'
import CursorPagesList from '../../components/CursorPagesList/CursorPagesList'
import Notice from '../../components/Notice/Notice'
import { apiErrorStatus, HTTP_FORBIDDEN } from '../../api/apiErrorStatus'
import { platformCostsApi, platformCostsKey } from '../../api/platformCostsApi'
import type { CostPage, CostRange, CostSum, CostSummary } from '../../api/platformCostsApi'
import RefusalAlert from '../../workspace/RefusalAlert'
import { PLATFORM_REFUSALS } from '../../workspace/workspaceRefusals'
import { formatCalendarDay, formatCalendarMonth } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import { SECTION_TITLE } from './sectionTitle'
import {
  COST_PERIODS, DEFAULT_COST_PERIOD, isCostPeriod, monthSubtotals, periodRange, spansMonths, toUsdNumber, utcToday,
} from './platformCostsView'
import type { CostPeriod } from './platformCostsView'

/** Each period's label (`settings:platformCosts.periods.*`), spelled out so the i18n audit sees every key. */
const PERIOD_KEYS: Readonly<Record<CostPeriod, string>> = {
  last30: 'platformCosts.periods.last30', thisMonth: 'platformCosts.periods.thisMonth',
  lastMonth: 'platformCosts.periods.lastMonth', last90: 'platformCosts.periods.last90',
}

function useCostPages(range: CostRange) {
  return useInfiniteQuery<CostPage, Error, InfiniteData<CostPage>, QueryKey, string | null>({
    queryKey: platformCostsKey(range),
    queryFn: ({ pageParam }) => platformCostsApi.page(range, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}

/** The cost column's one precision: a ten-thousandth of the currency unit, so small figures stay comparable. */
const MONEY_DIGITS = 4
const MONEY_STEP = 10 ** -MONEY_DIGITS

function useFormats(currency: string) {
  const { t, i18n } = useTranslation('settings')
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency', currency, minimumFractionDigits: MONEY_DIGITS, maximumFractionDigits: MONEY_DIGITS,
  })
  return {
    /** A figure; one above zero that would round to zero says "< $0.0001", never the known zero's "$0.0000". */
    money: (usd: string | null) => {
      const value = toUsdNumber(usd)
      if (value === null) return null
      return value > 0 && value < MONEY_STEP / 2
        ? t('platformCosts.belowPrecision', { smallest: money.format(MONEY_STEP) })
        : money.format(value)
    },
    count: (value: number) => formatCount(value, i18n.language),
    day: (day: string) => formatCalendarDay(day, i18n.language),
    month: (month: string) => formatCalendarMonth(month, i18n.language),
  }
}
type Formats = ReturnType<typeof useFormats>

/** What part of a sum is not priced, in words (the models named; or an imported model's estimate). */
function NotPriced({ sum }: Readonly<{ sum: CostSum }>) {
  const { t } = useTranslation('settings')
  if (sum.complete) return null
  return (
    <span className="block text-[12px] text-muted break-words">
      {sum.unpriced_models.length > 0
        ? t('platformCosts.notPriced', { models: sum.unpriced_models.join(', ') })
        : t('platformCosts.partlyEstimate')}
    </span>
  )
}

/** A sum's estimated cost: the figure (marked Incomplete when part is not priced), or Unpriced, never $0. */
function CostCell({ sum, format }: Readonly<{ sum: CostSum; format: Formats }>) {
  const { t } = useTranslation('settings')
  const figure = format.money(sum.estimated_usd)
  return (
    <>
      {figure === null
        ? <span className="badge badge-muted">{t('platformCosts.unpriced')}</span>
        : (
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            {sum.complete ? null : <span className="badge badge-warn">{t('platformCosts.incomplete')}</span>}
            <span className="font-mono">{figure}</span>
          </span>
        )}
      <NotPriced sum={sum} />
    </>
  )
}

/** Each month's subtotal of an entity's days, under its total. */
function Months({ summary, format }: Readonly<{ summary: CostSummary; format: Formats }>) {
  const { t } = useTranslation('settings')
  const months = monthSubtotals(summary.days)
  if (months.length === 0) return null
  return (
    <ul className="mt-1 space-y-0.5 text-[12px] text-muted" aria-label={t('platformCosts.byMonth')}>
      {months.map((month) => {
        const cost = format.money(month.estimated_usd) ?? t('platformCosts.unpriced')
        const words = { month: format.month(month.month), cost }
        return (
          <li key={month.month}>
            {month.complete ? t('platformCosts.monthTotal', words) : t('platformCosts.monthIncomplete', words)}
          </li>
        )
      })}
    </ul>
  )
}

const TH = 'px-3 py-2 text-left text-[12px] font-semibold text-muted'
const TH_NUM = 'px-3 py-2 text-right text-[12px] font-semibold text-muted'
const TD_NUM = 'px-3 py-2 text-right align-top text-sm font-mono whitespace-nowrap'

interface RowProps {
  readonly name: string
  readonly sum: CostSum
  readonly format: Formats
  /** The days to sum by month (none for a part the server sends only as a total). */
  readonly summary?: CostSummary
  readonly byMonth: boolean
  readonly status?: string
}

function CostRow({ name, sum, format, summary, byMonth, status = '' }: RowProps) {
  return (
    <tr>
      <th scope="row" className="px-3 py-2 text-left align-top text-sm font-normal text-text-strong break-words">
        {name}
        {status === '' ? null : <span className="badge badge-muted ml-2">{status}</span>}
      </th>
      <td className={TD_NUM}>{format.count(sum.calls)}</td>
      <td className={TD_NUM}>{format.count(sum.input_tokens)}</td>
      <td className={TD_NUM}>{format.count(sum.output_tokens)}</td>
      <td className="px-3 py-2 text-right align-top text-sm">
        <CostCell sum={sum} format={format} />
        {byMonth && summary !== undefined ? <Months summary={summary} format={format} /> : null}
      </td>
    </tr>
  )
}

function GroupRow({ label }: Readonly<{ label: string }>) {
  return (
    <tr className="bg-bg-accent">
      <th scope="rowgroup" colSpan={5} className="px-3 py-1.5 text-left text-[12px] font-semibold text-muted">{label}</th>
    </tr>
  )
}

function CostTable({ pages, format }: Readonly<{ pages: readonly CostPage[]; format: Formats }>) {
  const { t } = useTranslation(['settings', 'common'])
  const [first] = pages
  if (first === undefined) return null
  const { meta, deployment, unattributed } = first
  const byMonth = spansMonths(meta)
  const workspaces = pages.flatMap((page) => page.rows)
  const unreadable = pages.reduce((total, page) => total + page.unreadable, 0)
  const statusOf = (status: string) => {
    if (status === 'active' || status === '') return ''
    return status === 'deleting' ? t('common:workspaces.platform.status.deleting') : status
  }
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[40rem]">
          <caption className="sr-only">
            {t('platformCosts.caption', { from: format.day(meta.from), to: format.day(meta.to) })}
          </caption>
          <thead className="bg-bg-accent border-b border-border">
            <tr>
              <th scope="col" className={TH}>{t('platformCosts.columns.name')}</th>
              <th scope="col" className={TH_NUM}>{t('platformCosts.columns.calls')}</th>
              <th scope="col" className={TH_NUM}>{t('platformCosts.columns.input')}</th>
              <th scope="col" className={TH_NUM}>{t('platformCosts.columns.output')}</th>
              <th scope="col" className={TH_NUM}>{t('platformCosts.columns.cost')}</th>
            </tr>
          </thead>
          {deployment === null && unattributed === null ? null : (
            <tbody className="divide-y divide-border border-b border-border">
              <GroupRow label={t('platformCosts.outside')} />
              {deployment === null ? null : (
                <>
                  <CostRow name={t('platformCosts.deployment')} sum={deployment.total} summary={deployment} byMonth={byMonth} format={format} />
                  <CostRow name={t('platformCosts.deleted')} sum={deployment.deleted_workspaces} byMonth={false} format={format} />

                </>
              )}
              {unattributed === null ? null : (
                <CostRow name={t('platformCosts.unattributed')} sum={unattributed.total} summary={unattributed} byMonth={byMonth} format={format} />
              )}
            </tbody>
          )}
          <tbody className="divide-y divide-border">
            <GroupRow label={t('platformCosts.workspaces')} />
            {workspaces.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-2 text-sm text-muted">{t('platformCosts.noWorkspaces')}</td></tr>
            ) : workspaces.map((workspace) => (
              <CostRow key={workspace.id} name={workspace.name} sum={workspace.total} summary={workspace} byMonth={byMonth}
                status={statusOf(workspace.status)} format={format} />
            ))}
          </tbody>
        </table>
      </div>
      {unreadable > 0 ? <p className="mt-2 text-sm text-warn">{t('platformCosts.unreadable', { count: unreadable })}</p> : null}
    </>
  )
}

/** The estimate said as such: the label, the price list's day and a link to it. */
function EstimateNotice({ page, format }: Readonly<{ page: CostPage | undefined; format: Formats }>) {
  const { t } = useTranslation('settings')
  const asOf = page?.meta.priceAsOf ?? ''
  const source = page?.meta.priceSource ?? ''
  const text = (
    <>
      {t('platformCosts.estimate')}
      {asOf === '' ? null : <> {t('platformCosts.pricesAsOf', { date: format.day(asOf) })}</>}
      {source.startsWith('https://') ? (
        <> <a href={source} target="_blank" rel="noopener noreferrer" className="link">
          {t('platformCosts.priceSource')}<span className="sr-only"> {t('platformCosts.newTab')}</span>
        </a></>
      ) : null}
    </>
  )
  return <Notice variant="banner" tone="warn" role="note" icon={Info} text={text} />
}

export default function PlatformCostsSection() {
  const { t } = useTranslation('settings')
  const periodId = useId()
  const [period, setPeriod] = useState<CostPeriod>(DEFAULT_COST_PERIOD)
  const range = periodRange(period, utcToday())
  const query = useCostPages(range)
  const pages = query.data?.pages ?? []
  const format = useFormats(pages[0]?.meta.currency ?? 'USD')
  const count = pages.length === 0 ? 0 : pages.reduce((total, page) => total + page.rows.length, 0) + 1
  const refused = apiErrorStatus(query.error) === HTTP_FORBIDDEN
  const copy = {
    loading: t('platformCosts.loading'), loadFailed: t('platformCosts.loadFailed'), more: t('platformCosts.more'),
    moreFailed: t('platformCosts.moreFailed'), refreshFailed: t('platformCosts.refreshFailed'),
  }
  return (
    <div className="card space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <CircleDollarSign className="text-accent" size={16} aria-hidden="true" />
          <h2 className={SECTION_TITLE}>{t('platformCosts.title')}</h2>
        </div>
        <p className="text-sm text-muted">{t('platformCosts.description')}</p>
      </div>
      <EstimateNotice page={pages[0]} format={format} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={periodId} className="block text-[12px] font-semibold text-muted">{t('platformCosts.period')}</label>
          <select id={periodId} className="select w-auto" value={period}
            onChange={(event) => { if (isCostPeriod(event.target.value)) setPeriod(event.target.value) }}>
            {COST_PERIODS.map((option) => <option key={option} value={option}>{t(PERIOD_KEYS[option])}</option>)}
          </select>
        </div>
        <p className="pb-2 text-sm text-muted">{t('platformCosts.range', { from: format.day(range.from), to: format.day(range.to) })}</p>
      </div>
      <section aria-label={t('platformCosts.title')} aria-busy={query.isFetching}>
        <CursorPagesList query={query} count={count} copy={copy}
          failure={refused ? <RefusalAlert error={query.error} refusals={PLATFORM_REFUSALS} /> : null}>
          <CostTable pages={pages} format={format} />
        </CursorPagesList>
      </section>
    </div>
  )
}
