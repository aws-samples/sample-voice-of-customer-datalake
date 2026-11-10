/**
 * @fileoverview A small, calm note beside totals for a person whose view is
 * narrowed: "Showing Technical support only — the category you have access to."
 * Renders nothing for an unrestricted viewer, or while the scope is unknown.
 *
 * Used where totals appear: the Dashboard and Categories headers and the Home
 * metric tiles.
 *
 * @module components/ScopeNotice/ScopeNotice
 */
import clsx from 'clsx'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useScopeCategories, useViewerScope } from './useViewerScope'
import type { ViewerScope } from './viewerScope'

type RestrictedScope = Exclude<ViewerScope, { kind: 'all' }>

function useNoticeText(scope: RestrictedScope): string {
  const { t } = useTranslation('components')
  const { categories, list } = useScopeCategories(scope)
  if (scope.kind === 'sources') return t('scopeNotice.sources')
  if (categories.length === 0) return t('scopeNotice.none')
  return t('scopeNotice.categories', { count: categories.length, list })
}

function Notice({ scope, className }: Readonly<{ scope: RestrictedScope; className?: string }>) {
  const text = useNoticeText(scope)
  return (
    <p role="note" data-testid="scope-notice"
      className={clsx('inline-flex max-w-full items-start gap-2 rounded-lg border border-border bg-bg-accent px-3 py-2 text-sm text-text', className)}>
      <Lock size={14} className="mt-0.5 flex-shrink-0 text-muted" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

export default function ScopeNotice({ className }: Readonly<{ className?: string }>) {
  const { scope } = useViewerScope()
  if (scope === null || scope.kind === 'all') return null
  return <Notice scope={scope} className={className} />
}
