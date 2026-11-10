/**
 * @fileoverview "Nothing to show" for someone who cannot set the workspace up.
 *
 * The first-run welcome ("Your workspace is empty… bring in customer feedback")
 * is for an administrator of an empty install. Everyone else gets a plain
 * statement of what they can see, with no import or setup action they could
 * not take:
 *
 * - restricted to categories → "You can see reviews in: Billing and Delivery. None have arrived yet."
 * - restricted to no category at all → "Your access doesn't include any reviews yet — ask an administrator."
 * - restricted by source → "You can see reviews from the sources you have access to. None have arrived yet."
 * - not restricted, not an admin → "Customer feedback appears here once an administrator connects a source."
 *
 * @module components/ScopeNotice/ScopedEmptyState
 */
import { Inbox, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useScopeCategories } from './useViewerScope'
import type { ViewerScope } from './viewerScope'

function useBody(scope: ViewerScope): string {
  const { t } = useTranslation('components')
  const { categories, list } = useScopeCategories(scope)
  if (scope.kind === 'all') return t('scopedEmpty.waiting')
  if (scope.kind === 'sources') return t('scopedEmpty.sources')
  if (categories.length === 0) return t('scopedEmpty.noAccess')
  return t('scopedEmpty.inCategories', { count: categories.length, list })
}

export default function ScopedEmptyState({ scope }: Readonly<{ scope: ViewerScope }>) {
  const { t } = useTranslation('components')
  const body = useBody(scope)
  const Icon = scope.kind === 'all' ? Inbox : Lock
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <section className="max-w-md text-center" aria-labelledby="scoped-empty-title" data-testid="scoped-empty">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-hover text-muted">
          <Icon size={24} aria-hidden="true" />
        </div>
        <h2 id="scoped-empty-title" className="mb-2 text-xl font-bold tracking-tight text-text-strong">
          {t('scopedEmpty.heading')}
        </h2>
        <p className="text-muted">{body}</p>
      </section>
    </div>
  )
}
