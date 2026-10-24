/**
 * @fileoverview The "Current access" box at the top of Category access: the
 * stored category AND source rule in plain words, so a source list left over
 * from an earlier grant can never hide below the fold ("Sources: only Sales CSV").
 *
 * @module components/UserAdmin/AccessSummary
 */
import { useTranslation } from 'react-i18next'
import { Eye } from 'lucide-react'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { UserCategoryGrant } from '../../api/categoryAccessApi'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** "all" / "only A, B" / "none" for a list rule. */
function listValue(t: Translate, all: boolean, names: readonly string[]): string {
  if (all) return t('valueAll')
  return names.length === 0 ? t('valueNone') : t('valueOnly', { names: names.join(', ') })
}

/** The source rule in words; the default rule hides the restricted sources. */
function sourceValue(t: Translate, grant: UserCategoryGrant, label: (id: string) => string): string {
  if (grant.sourceGrant.mode === 'default') return t('sourcesDefault')
  return listValue(t, grant.sourceGrant.mode === 'all', grant.sourceGrant.sources.map(label))
}

export default function AccessSummary({ grant }: Readonly<{ grant: UserCategoryGrant }>) {
  const { t } = useTranslation('components', { keyPrefix: 'userAdmin.categoryAccess' })
  const labels = useDisplayLabels()
  return (
    <section aria-label={t('current')} className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm space-y-0.5">
      <p className="flex items-center gap-2 font-medium text-text-strong">
        <Eye size={14} aria-hidden="true" /> {t('current')}
      </p>
      <p className="text-text">{t('currentCategories', { value: listValue(t, grant.all, grant.categories.map(labels.category)) })}</p>
      <p className="text-text">{t('currentSources', { value: sourceValue(t, grant, labels.source) })}</p>
    </section>
  )
}
