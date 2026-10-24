/**
 * @fileoverview The Projects list toolbar: search, "Mine / Shared with me / All"
 * and the sort (recently updated / name). Pure presentation over `projectListFilter`.
 *
 * @module pages/Projects/ProjectListControls
 */
import clsx from 'clsx'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isProjectSort, PROJECT_SCOPES, PROJECT_SORTS } from './projectListFilter'
import type { ProjectListView, ProjectScope } from './projectListFilter'

export default function ProjectListControls({ view, onChange }: Readonly<{
  view: ProjectListView
  onChange: (view: ProjectListView) => void
}>) {
  const { t } = useTranslation('projects')
  const setScope = (scope: ProjectScope) => onChange({ ...view, scope })
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="relative flex-1">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input type="search" value={view.q} onChange={(e) => onChange({ ...view, q: e.target.value })}
          aria-label={t('list.search')} placeholder={t('list.search')} className="input pl-8" />
      </div>
      {/* `flex-wrap max-w-full`: "Mit mir geteilt" pushed the page to 405 px at 390 px / 200 % text. */}
      <div role="group" aria-label={t('list.scopeLabel')} className="inline-flex flex-wrap max-w-full rounded-lg border border-border p-0.5 self-start">
        {PROJECT_SCOPES.map((scope) => (
          <button key={scope} type="button" aria-pressed={view.scope === scope} onClick={() => setScope(scope)}
            className={clsx('px-3 py-1 text-sm rounded-md focus-ring', view.scope === scope ? 'bg-accent-subtle text-accent-text font-medium' : 'text-muted hover:text-text')}>
            {t(`list.scope.${scope}`)}
          </button>
        ))}
      </div>
      <select aria-label={t('list.sortLabel')} value={view.sort} className="select sm:w-48"
        onChange={(e) => { if (isProjectSort(e.target.value)) onChange({ ...view, sort: e.target.value }) }}>
        {PROJECT_SORTS.map((sort) => <option key={sort} value={sort}>{t(`list.sort.${sort}`)}</option>)}
      </select>
    </div>
  )
}
