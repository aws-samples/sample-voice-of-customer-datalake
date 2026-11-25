/**
 * @fileoverview A library item's details as a list: its source and date, tags, project, file, pages, how the
 * assistant reads it (the file itself, or passages of its text), and who added and last changed it.
 *
 * @module pages/Library/ItemDetails
 */
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { formatCalendarDay, formatDateTime } from '../../utils/dateUtils'
import { formatFileSize } from '../../utils/file'
import { formatCount } from '../../utils/numberFormat'
import type { LibraryItem } from '../../api/librarySchema'

function Entry({ term, children }: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-muted">{term}</dt>
      <dd className="break-words text-sm text-text">{children}</dd>
    </div>
  )
}

function Person({ person, at }: Readonly<{ person: LibraryItem['created_by']; at: string }>) {
  const { t, i18n } = useTranslation('library')
  const when = formatDateTime(at, i18n.language)
  const name = person?.name ?? ''
  return <>{name === '' ? when : t('details.byOn', { name, date: when })}</>
}

export default function ItemDetails({ item, projectName }: Readonly<{ item: LibraryItem; projectName: string | null }>) {
  const { t, i18n } = useTranslation('library')
  const lang = i18n.language
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Entry term={t('fields.source')}>{item.source === '' ? t('details.none') : item.source}</Entry>
      <Entry term={t('fields.docDate')}>{item.doc_date === '' ? t('details.none') : formatCalendarDay(item.doc_date, lang)}</Entry>
      <Entry term={t('fields.tags')}>
        {item.tags.length === 0 ? t('details.none') : (
          <span className="flex flex-wrap gap-1">{item.tags.map((tag) => <span key={tag} className="badge badge-muted">{tag}</span>)}</span>
        )}
      </Entry>
      {projectName === null ? null : <Entry term={t('fields.project')}>{projectName}</Entry>}
      <Entry term={t('details.file')}>
        <span className="break-all">{item.filename}</span>
        <span className="text-muted"> · {item.format.toUpperCase()} · {formatFileSize(item.bytes, lang)}</span>
      </Entry>
      {item.pages === undefined ? null : <Entry term={t('details.pages')}>{formatCount(item.pages, lang)}</Entry>}
      <Entry term={t('details.assistant')}>{item.native ? t('details.native') : t('details.passages')}</Entry>
      <Entry term={t('details.added')}><Person person={item.created_by} at={item.created_at} /></Entry>
      <Entry term={t('details.changed')}><Person person={item.updated_by} at={item.updated_at} /></Entry>
    </dl>
  )
}
