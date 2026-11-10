/**
 * @fileoverview The caller's scope for notices and empty states, and whether
 * they can act on setup prompts.
 *
 * Reads `GET /feedback/access` under the same cache entry Account → My access
 * uses (`callerAccessKey`), so a page that shows a notice costs no extra
 * request once either has loaded it.
 *
 * @module components/ScopeNotice/useViewerScope
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { callerAccessKey, categoryAccessApi } from '../../api/categoryAccessApi'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { isRestricted, viewerScopeOf } from './viewerScope'
import type { ViewerScope } from './viewerScope'

interface ViewerScopeResult {
  /** Null while unknown: loading, or a deployment without the route (then nothing is said). */
  scope: ViewerScope | null
  isLoading: boolean
}

export function useViewerScope(): ViewerScopeResult {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  const { data, isLoading } = useQuery({
    queryKey: callerAccessKey(),
    queryFn: () => categoryAccessApi.getCallerAccess(),
    enabled: !!apiEndpoint,
    retry: false,
    // A stable module function: TanStack memoises the derived scope per response.
    select: viewerScopeOf,
  })
  return { scope: data ?? null, isLoading: !!apiEndpoint && isLoading }
}

/**
 * Whether setup prompts (import feedback, connect a source, set up categories)
 * are the caller's to act on: an administrator whose view is not narrowed. A
 * restricted caller is never an administrator server-side; checking both also
 * keeps the local dev bypass (every mock user is an admin) honest when the dev
 * mock serves a restricted scope.
 */
export function useCanSetUp(): boolean {
  const isAdmin = useIsAdmin()
  const { scope } = useViewerScope()
  return isAdmin && !isRestricted(scope)
}

/** Stable, so a scope without a category list never invalidates the memo below. */
const NO_CATEGORIES: readonly string[] = []

/**
 * A scope's allowed categories and their display names as one locale-formatted
 * list ("Billing and Delivery"); an empty list for a non-category scope.
 */
export function useScopeCategories(scope: ViewerScope): { categories: readonly string[]; list: string } {
  const categories = scope.kind === 'categories' ? scope.categories : NO_CATEGORIES
  const labels = useDisplayLabels()
  const { i18n } = useTranslation()
  const list = useMemo(() => {
    const names = categories.map((id) => labels.category(id)).sort((a, b) => a.localeCompare(b, i18n.language))
    return new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(names)
  }, [categories, labels, i18n.language])
  return { categories, list }
}
