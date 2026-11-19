/**
 * @fileoverview The forms list's toolbar past six forms (UX §14.2): search by name, show All / Live / Off / Test link
 * on, sort by Newest / Name / Responses; and how many forms it shows, said politely when it changes.
 *
 * @module pages/FeedbackForms/FormsToolbar
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Search } from 'lucide-react'
import Segmented from './ui/Segmented'
import { SORTS, STATE_FILTERS } from './formsListFilter'
import type { FormsQuery, FormsSort, StateFilter } from './formsListFilter'

const isSort = (value: string): value is FormsSort => SORTS.some((sort) => sort === value)

/** The words of each filter and sort (literal keys, so the i18n audit sees them). */
function stateLabel(t: TFunction<'feedbackForms'>, state: StateFilter): string {
  switch (state) {
    case 'all': return t('list.states.all')
    case 'live': return t('list.states.live')
    case 'off': return t('list.states.off')
    case 'test': return t('list.states.test')
  }
}

function sortLabel(t: TFunction<'feedbackForms'>, sort: FormsSort): string {
  switch (sort) {
    case 'newest': return t('list.sorts.newest')
    case 'lastResponse': return t('list.sorts.lastResponse')
    case 'name': return t('list.sorts.name')
    case 'responses': return t('list.sorts.responses')
  }
}

export default function FormsToolbar({ query, onChange, shown, total }: Readonly<{
  query: FormsQuery
  onChange: (query: FormsQuery) => void
  shown: number
  total: number
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  return (
    <div className="space-y-2">
      <div role="search" aria-label={t('list.toolbarLabel')} className="flex flex-wrap items-center gap-3">
        <div className="relative w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-xs">
          <label htmlFor={`${id}-search`} className="sr-only">{t('list.search')}</label>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input id={`${id}-search`} type="search" className="input w-full pl-8" value={query.search} placeholder={t('list.searchPlaceholder')}
            onChange={(event) => onChange({ ...query, search: event.target.value })} />
        </div>
        <Segmented label={t('list.stateLabel')} value={query.state} onChange={(state) => onChange({ ...query, state })}
          choices={STATE_FILTERS.map((value) => ({ value, label: stateLabel(t, value) }))} />
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-sort`} className="text-[13px] font-medium text-text">{t('list.sortLabel')}</label>
          <select id={`${id}-sort`} className="select select-sm w-auto" value={query.sort}
            onChange={(event) => { if (isSort(event.target.value)) onChange({ ...query, sort: event.target.value }) }}>
            {SORTS.map((sort) => <option key={sort} value={sort}>{sortLabel(t, sort)}</option>)}
          </select>
        </div>
      </div>
      <p role="status" className="text-[12px] text-muted tabular-nums">{t('list.shown', { shown, count: total })}</p>
    </div>
  )
}
