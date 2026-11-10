/**
 * @fileoverview A request's totals in its board's template figures — sales: supporters, customers,
 * committed and at-risk revenue; service: people affected; beta: supporters and average rating;
 * blank: supporters — and the same figures summed over a board (`BoardSummary`).
 *
 * @module pages/FeatureRequests/RequestTotals
 */
import { useTranslation } from 'react-i18next'
import { TEMPLATE_DEFAULTS } from '../../api/boardFields'
import { formatCount } from '../../utils/numberFormat'
import { useCurrentBoard } from './boardContext'
import { averageRating, formatUsd, peopleAffected } from './boardFormat'
import type { TotalKey } from '../../api/boardFields'
import type { FeatureRequest } from '../../api/featureRequestsApi'

const TONE: Readonly<Record<TotalKey, string>> = {
  supporters: 'text-text', customers: 'text-text', committed_usd: 'text-ok', at_risk_usd: 'text-danger',
  affected: 'text-text', avg_rating: 'text-text',
}

/** Data-held, so the i18n audit sees every key. */
const TOTAL_LABELS: Readonly<Record<TotalKey, { labelKey: string }>> = {
  supporters: { labelKey: 'featureRequests:totals.supporters' },
  customers: { labelKey: 'featureRequests:totals.customers' },
  committed_usd: { labelKey: 'featureRequests:totals.committed' },
  at_risk_usd: { labelKey: 'featureRequests:totals.atRisk' },
  affected: { labelKey: 'featureRequests:totals.peopleAffected' },
  avg_rating: { labelKey: 'featureRequests:totals.avgRating' },
}

/** One figure of one request (undefined: nothing to show, e.g. nobody rated yet). */
function figureOf(request: FeatureRequest, key: TotalKey): number | undefined {
  if (key === 'affected') return peopleAffected(request)
  if (key === 'avg_rating') return averageRating(request)
  return request.totals[key]
}

/** The figure in words: money in USD, a rating out of five, else a count. */
function useFigureText(): (key: TotalKey, value: number | undefined) => string {
  const { t, i18n } = useTranslation('featureRequests')
  return (key, value) => {
    if (value === undefined) return t('totals.notRated')
    if (key === 'committed_usd' || key === 'at_risk_usd') return formatUsd(value, i18n.language)
    if (key === 'avg_rating') return t('totals.rating', { value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value) })
    return formatCount(value, i18n.language)
  }
}

function useTotalKeys(): readonly TotalKey[] {
  return TEMPLATE_DEFAULTS[useCurrentBoard().template].totals
}

function Figures({ figures }: Readonly<{ figures: ReadonlyArray<readonly [TotalKey, number | undefined]> }>) {
  const { t } = useTranslation('featureRequests')
  const text = useFigureText()
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
      {figures.map(([key, value]) => (
        <div key={key}>
          <dt className="text-muted">{t(TOTAL_LABELS[key].labelKey)}</dt>
          <dd className={`font-medium ${TONE[key]}`}>{text(key, value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A request's figures on its board; shared by the list and the detail dialog. */
export function RequestTotals({ request }: Readonly<{ request: FeatureRequest }>) {
  return <Figures figures={useTotalKeys().map((key) => [key, figureOf(request, key)] as const)} />
}

/** Sum (counts, money, people) or mean (rating) of one figure over the requests. */
function boardFigure(requests: readonly FeatureRequest[], key: TotalKey): number | undefined {
  if (key !== 'avg_rating') return requests.reduce((total, request) => total + (figureOf(request, key) ?? 0), 0)
  const rated = requests.flatMap((request) => averageRating(request) ?? [])
  return rated.length === 0 ? undefined : rated.reduce((total, value) => total + value, 0) / rated.length
}

/** The board's figures over every request listed (the shown filter does not change them). */
export function BoardSummary({ requests }: Readonly<{ requests: readonly FeatureRequest[] }>) {
  const { t } = useTranslation('featureRequests')
  // Supporters / customers count people per request; their board sum would double-count a person.
  const keys = useTotalKeys().filter((key) => key !== 'supporters' && key !== 'customers')
  if (keys.length === 0 || requests.length === 0) return null
  return (
    <section className="card p-4 space-y-2" aria-label={t('totals.boardSummary')}>
      <h2 className="text-sm font-medium text-text-strong">{t('totals.boardSummary')}</h2>
      <Figures figures={keys.map((key) => [key, boardFigure(requests, key)] as const)} />
    </section>
  )
}
