/**
 * @fileoverview The Library list's toolbar: search (title, short name, source, file name and tags), a tag, a
 * project and the sort.
 *
 * @module pages/Library/LibraryToolbar
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Search } from 'lucide-react'
import { LIBRARY_SORTS } from '../../api/libraryApi'
import type { LibrarySort } from '../../api/libraryApi'
import type { LibraryFilters, ProjectOption } from './libraryFilters'

const isLibrarySort = (value: string): value is LibrarySort => LIBRARY_SORTS.some((sort) => sort === value)

function librarySortLabel(t: TFunction<'library'>, sort: LibrarySort): string {
  switch (sort) {
    case 'newest': return t('toolbar.sorts.newest')
    case 'oldest': return t('toolbar.sorts.oldest')
    case 'title': return t('toolbar.sorts.title')
    case 'doc_date': return t('toolbar.sorts.docDate')
  }
}

export default function LibraryToolbar({ filters, onChange, tags, projects }: Readonly<{
  filters: LibraryFilters
  onChange: (filters: LibraryFilters) => void
  tags: readonly string[]
  /** The projects to filter by; null: no project filter. */
  projects: readonly ProjectOption[] | null
}>) {
  const { t } = useTranslation('library')
  const id = useId()
  return (
    <div role="search" aria-label={t('toolbar.label')} className="flex flex-wrap items-end gap-3">
      <div className="relative w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-sm">
        <label htmlFor={`${id}-search`} className="sr-only">{t('toolbar.search')}</label>
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input id={`${id}-search`} type="search" className="input w-full pl-8" value={filters.search}
          placeholder={t('toolbar.searchPlaceholder')} onChange={(event) => onChange({ ...filters, search: event.target.value })} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-tag`} className="text-[12px] font-medium text-muted">{t('toolbar.tag')}</label>
        <select id={`${id}-tag`} className="select select-sm w-auto max-w-[12rem]" value={filters.tag}
          onChange={(event) => onChange({ ...filters, tag: event.target.value })}>
          <option value="">{t('toolbar.anyTag')}</option>
          {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </div>
      {projects === null ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-project`} className="text-[12px] font-medium text-muted">{t('toolbar.project')}</label>
          <select id={`${id}-project`} className="select select-sm w-auto max-w-[14rem]" value={filters.projectId}
            onChange={(event) => onChange({ ...filters, projectId: event.target.value })}>
            <option value="">{t('toolbar.anyProject')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-sort`} className="text-[12px] font-medium text-muted">{t('toolbar.sort')}</label>
        <select id={`${id}-sort`} className="select select-sm w-auto" value={filters.sort}
          onChange={(event) => { if (isLibrarySort(event.target.value)) onChange({ ...filters, sort: event.target.value }) }}>
          {LIBRARY_SORTS.map((sort) => <option key={sort} value={sort}>{librarySortLabel(t, sort)}</option>)}
        </select>
      </div>
    </div>
  )
}
