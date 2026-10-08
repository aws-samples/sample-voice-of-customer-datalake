/**
 * @fileoverview Shared category queries: the category config, the caller's
 * category scope (GET /feedback/access), and their intersection — the
 * categories this user can see and pick.
 *
 * One module so every consumer resolves to the same cache entries (the config
 * editor, the "Change category" control, the Categories filters and the Home
 * onboarding step), and so normalization happens once at the query boundary.
 *
 * @module hooks/useCategories
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { callerCategoryScopeKey, categoryAccessApi, scopeAdmits } from '../api/categoryAccessApi'
import { normalizeCategories } from '../components/CategoriesManager/categoriesSchema'
import { useConfigStore } from '../store/configStore'
import type { CategoryScope } from '../api/categoryAccessApi'
import type { Category } from '../components/CategoriesManager/CategoriesManager'

/** A grant changes rarely and only by an admin; a minute of reuse spares every page mount a request. */
const SCOPE_STALE_MS = 60_000

/** Query key of the category config (Settings → Categories). */
export const categoriesConfigKey = () => ['categories-config'] as const

/** The configured categories, normalized (legacy rows get ids; issue #181). */
export function useCategoriesConfig() {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  return useQuery({
    queryKey: categoriesConfigKey(),
    queryFn: () => api.getCategoriesConfig(),
    // The real GET returns the DynamoDB item verbatim, so `categories` may be
    // absent; normalize once so every consumer can trust the Category type.
    select: (data) => {
      // Read as `unknown`: the declared type says the field is always there.
      const rawCategories: unknown = data.categories
      return { ...data, categories: normalizeCategories(Array.isArray(rawCategories) ? rawCategories : []) }
    },
    enabled: !!apiEndpoint,
  })
}

/**
 * The caller's scope, or null while unknown (loading, or a deployment without
 * the route). Null admits every category: the backend is the enforcement, so a
 * missing scope only means the SPA cannot pre-filter chips it would never be
 * served data for anyway.
 */
function useCallerCategoryScope(): CategoryScope | null {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  const { data } = useQuery({
    queryKey: callerCategoryScopeKey(),
    queryFn: () => categoryAccessApi.getCallerScope(),
    enabled: !!apiEndpoint,
    staleTime: SCOPE_STALE_MS,
    retry: false,
  })
  return data ?? null
}

/** `admits(name)` for the caller — the predicate filters apply to category names. */
export function useCategoryAdmits(): (category: string) => boolean {
  const scope = useCallerCategoryScope()
  return useMemo(() => (category: string) => scopeAdmits(scope, category), [scope])
}

/** Configured categories the caller may see — the options of a category picker. */
export function useVisibleCategories(): { categories: Category[]; isLoading: boolean } {
  const { data, isLoading } = useCategoriesConfig()
  const admits = useCategoryAdmits()
  const categories = useMemo(
    () => (data?.categories ?? []).filter((c) => admits(c.name)),
    [data, admits],
  )
  return { categories, isLoading }
}
