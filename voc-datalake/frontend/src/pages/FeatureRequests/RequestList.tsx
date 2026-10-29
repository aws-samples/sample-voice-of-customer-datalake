/**
 * @fileoverview A board's request list: search, status filter (the board's statuses) and sort
 * (the board's template figures) above the request cards, each opening the request's detail. The
 * three controls live in the URL (`useBoardControls`), so a filtered board is a link.
 *
 * @module pages/FeatureRequests/RequestList
 */
import { Search, Users } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { TEMPLATE_DEFAULTS } from '../../api/boardFields'
import { displayName, filterRequests, sortRequests, sortsFor } from './boardFormat'
import { isRequestSort, useBoardControls } from './useBoardControls'
import type { BoardControls as Controls } from './useBoardControls'
import StatusBadge from './StatusBadge'
import StatusSelect from './StatusSelect'
import RequestFieldValues from './RequestFieldValues'
import { RequestTotals } from './RequestTotals'
import { useCurrentBoard } from './boardContext'
import { boardStatusOf } from './boardStatuses'
import type { FeatureRequest } from '../../api/featureRequestsApi'
import type { RequestSort } from './boardFormat'
import { SORT_LABELS } from './boardLabels'

function Toolbar({ controls, sorts, onChange }: Readonly<{
  controls: Controls; sorts: readonly RequestSort[]; onChange: (change: Partial<Controls>) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const searchId = useId()
  const sortId = useId()
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-48">
        <label htmlFor={searchId} className="block text-xs font-medium text-text mb-1">{t('list.search')}</label>
        <div className="relative">
          <Search size={14} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input id={searchId} type="search" className="input w-full pl-8" value={controls.query}
            placeholder={t('list.searchPlaceholder')} onChange={(e) => onChange({ query: e.target.value })} />
        </div>
      </div>
      <StatusSelect label={t('list.statusFilter')} allLabel={t('list.allStatuses')} value={controls.status}
        onChange={(status) => onChange({ status })} />
      <div>
        <label htmlFor={sortId} className="block text-xs font-medium text-text mb-1">{t('list.sortBy')}</label>
        <select id={sortId} className="select w-auto" value={controls.sort}
          onChange={(e) => onChange({ sort: isRequestSort(e.target.value) ? e.target.value : 'newest' })}>
          {sorts.map((sort) => <option key={sort} value={sort}>{t(SORT_LABELS[sort].labelKey)}</option>)}
        </select>
      </div>
    </div>
  )
}

function RequestCard({ request, onOpen }: Readonly<{ request: FeatureRequest; onOpen: (id: string) => void }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <li className="card p-4 space-y-3" data-testid={`fr-card-${request.request_id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button type="button" className="text-left font-medium text-text hover:text-accent-text break-words min-w-0"
          onClick={() => onOpen(request.request_id)}>
          {request.title}
        </button>
        <StatusBadge status={request.status} />
      </div>
      <p className="text-xs text-muted flex items-center gap-1 break-words">
        <Users size={12} aria-hidden="true" />
        {t('list.reportedBy', { name: displayName(request.reporter_name, request.reporter_email) })}
      </p>
      <RequestFieldValues request={request} compact />
      <RequestTotals request={request} />
    </li>
  )
}

/** The list of `requests` under its own controls; `onOpen` opens one request's detail. */
export default function RequestList({ requests, onOpen }: Readonly<{
  requests: readonly FeatureRequest[]
  onOpen: (requestId: string) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const board = useCurrentBoard()
  const [urlControls, setControls] = useBoardControls()
  const sorts = sortsFor(TEMPLATE_DEFAULTS[board.template].totals)
  // A status or sort this board does not have (a link from another board) reads as the default.
  const controls: Controls = {
    ...urlControls,
    status: board.statuses.some((status) => status.key === urlControls.status) ? urlControls.status : 'all',
    sort: sorts.includes(urlControls.sort) ? urlControls.sort : 'newest',
  }
  const statusOf = (request: FeatureRequest) => boardStatusOf(board, request.status).key
  const shown = sortRequests(filterRequests(requests, controls, statusOf), controls.sort)
  return (
    <section className="space-y-4" aria-label={t('list.label')}>
      <Toolbar controls={controls} sorts={sorts} onChange={setControls} />
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{requests.length === 0 ? t('list.empty') : t('list.noMatch')}</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((request) => <RequestCard key={request.request_id} request={request} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  )
}
