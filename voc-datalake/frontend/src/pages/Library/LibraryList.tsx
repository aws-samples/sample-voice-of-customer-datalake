/**
 * @fileoverview The Library's items: one card per item (its title and `#slug`, format, size, dates, who added it,
 * its tags and status; a failed one says why), opening the preview drawer; the loading, failed, empty and
 * nothing-matches states; and "Load more" while the list has a next page.
 *
 * @module pages/Library/LibraryList
 */
import { useTranslation } from 'react-i18next'
import { Library as LibraryIcon, Loader2, Upload } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import Notice from '../../components/Notice/Notice'
import { formatCalendarDay, formatDate } from '../../utils/dateUtils'
import { formatFileSize } from '../../utils/file'
import type { LibraryItem } from '../../api/librarySchema'
import StatusBadge from './StatusBadge'

function Meta({ item }: Readonly<{ item: LibraryItem }>) {
  const { t, i18n } = useTranslation('library')
  const lang = i18n.language
  const by = item.created_by?.name ?? ''
  const added = formatDate(item.created_at, lang)
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
      <span className="font-mono uppercase">{item.format}</span>
      <span className="tabular-nums">{formatFileSize(item.bytes, lang)}</span>
      {item.doc_date === '' ? null : <span>{t('row.dated', { date: formatCalendarDay(item.doc_date, lang) })}</span>}
      <span>{by === '' ? t('row.added', { date: added }) : t('row.addedBy', { date: added, name: by })}</span>
    </span>
  )
}

function Row({ item, onOpen }: Readonly<{ item: LibraryItem; onOpen: (itemId: string) => void }>) {
  return (
    <li className="min-w-0">
      <button type="button" onClick={() => onOpen(item.item_id)}
        className="card flex w-full min-w-0 flex-col gap-2 p-3 text-left hover:bg-bg-hover focus-ring sm:p-4">
        <span className="flex w-full min-w-0 flex-wrap items-start justify-between gap-2">
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold text-text-strong">{item.title}</span>
            <span className="block break-all font-mono text-[12px] text-accent-text">#{item.slug}</span>
          </span>
          <StatusBadge status={item.status} />
        </span>
        <Meta item={item} />
        {item.tags.length === 0 ? null : (
          <span className="flex flex-wrap gap-1">
            {item.tags.map((tag) => <span key={tag} className="badge badge-muted">{tag}</span>)}
          </span>
        )}
        {item.status === 'failed' && item.error !== undefined && item.error !== ''
          ? <span className="break-words text-[12px] text-danger">{item.error}</span>
          : null}
      </button>
    </li>
  )
}

export interface ListState {
  readonly items: readonly LibraryItem[]
  readonly isLoading: boolean
  readonly loadFailed: { readonly retry: () => void; readonly retrying: boolean } | null
  readonly filtered: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly onLoadMore: () => void
}

export default function LibraryList({ state, canWrite, onOpen, onUpload }: Readonly<{
  state: ListState
  canWrite: boolean
  onOpen: (itemId: string) => void
  onUpload: () => void
}>) {
  const { t } = useTranslation('library')
  if (state.loadFailed !== null && state.items.length === 0) {
    return <LoadFailed onRetry={state.loadFailed.retry} retrying={state.loadFailed.retrying} message={t('list.loadFailed')} />
  }
  if (state.isLoading) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('list.loading')}
      </p>
    )
  }
  if (state.items.length === 0 && state.filtered) {
    return <p className="card text-center text-sm text-muted">{t('list.noMatch')}</p>
  }
  if (state.items.length === 0) {
    return (
      <Notice variant="empty" icon={LibraryIcon} title={t('empty.title')} text={canWrite ? t('empty.text') : t('empty.textReadOnly')}
        action={canWrite ? { label: t('upload.open'), icon: Upload, onClick: onUpload, emphasis: 'primary' } : undefined} />
    )
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-3" aria-label={t('list.label')}>
        {state.items.map((item) => <Row key={item.item_id} item={item} onOpen={onOpen} />)}
      </ul>
      {state.hasMore ? (
        <button type="button" onClick={state.onLoadMore} disabled={state.loadingMore} className="btn btn-secondary w-full">
          {state.loadingMore ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
          {t('list.loadMore')}
        </button>
      ) : null}
    </div>
  )
}
