/**
 * @fileoverview Category access — which categories of reviews a user may see.
 *
 * Two surfaces, both normalized through lenient Zod schemas at this boundary:
 *
 * - `GET /feedback/access` (any signed-in user) — the CALLER's scope, used to
 *   hide categories they cannot see from filters and pickers. The backend is the
 *   enforcement (every metrics route filters by the same scope); the SPA only
 *   keeps its chips honest.
 * - `GET|PUT /users/{username}/category-access` (admins) — one user's stored
 *   grant. `['*']` means every category. **No stored row also means every
 *   category**, which is how the feature ships non-breaking: nobody loses access
 *   on deploy until an admin narrows them.
 *
 * Admins always see everything, and a category's product owners see it even if
 * it is not listed — both resolved server-side, so the caller scope already says
 * `all: true` / includes owned categories.
 *
 * @module api/categoryAccessApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { nonBlankStringList } from './lenientFields'

/** The stored wildcard for "every category". */
const ALL_CATEGORIES = '*'

/** A resolved scope: every category, or exactly the listed names. */
export interface CategoryScope {
  all: boolean
  categories: string[]
}

/**
 * A user's SOURCE grant, next to the category one (an item is visible only
 * when both admit it):
 * - `default` — no `sources` stored: every source whose profile is not restricted;
 * - `all` — `['*']`: every source, restricted ones included;
 * - `list` — exactly `sources`.
 */
export type SourceGrantMode = 'default' | 'all' | 'list'

export interface SourceGrant {
  mode: SourceGrantMode
  sources: string[]
}

const nameList = nonBlankStringList

/**
 * The caller's scope. `all` falls back to FALSE on a malformed value — the
 * narrower reading — and `categories` keeps only usable names.
 *
 * The body also carries the SOURCE rule (`sources_all`, `sources`, `source_rule:
 * 'all'|'allow'|'deny'`, `sources_denied`). They are accepted leniently and
 * read narrow (`sources_all` false on a malformed value); the SPA does not apply
 * them itself — every list and count it shows is already filtered server-side —
 * so `normalizeCallerScope` returns the category half only.
 */
const CallerScopeSchema = z.object({
  all: z.boolean().catch(false),
  categories: nameList,
  sources_all: z.boolean().catch(false),
  sources: nameList,
  source_rule: z.enum(['all', 'allow', 'deny']).optional().catch(undefined),
  sources_denied: nameList,
}).catch({ all: false, categories: [], sources_all: false, sources: [], sources_denied: [] })


/**
 * One user's stored grant. Absent `categories` (no row) and a `'*'` entry both
 * read as every category; an explicit `all: true` does too.
 */
const UserGrantSchema = z.looseObject({
  all: z.boolean().optional().catch(undefined),
  categories: z.array(z.unknown()).optional().catch(undefined),
  // null (nothing stored) and absent both read as the default rule.
  sources: z.array(z.unknown()).nullish().catch(undefined),
  updated_by: z.string().optional().catch(undefined),
  updated_at: z.string().optional().catch(undefined),
})

export interface UserCategoryGrant extends CategoryScope {
  sourceGrant: SourceGrant
  updatedBy?: string
  updatedAt?: string
}

/** A stored `sources` list as a grant: absent / null = default, `'*'` = all, else the ids. */
function sourceGrantOf(stored: readonly unknown[] | null | undefined): SourceGrant {
  if (stored == null) return { mode: 'default', sources: [] }
  const ids = nameList.parse(stored)
  return ids.includes(ALL_CATEGORIES) ? { mode: 'all', sources: [] } : { mode: 'list', sources: ids }
}

export function normalizeCallerScope(raw: unknown): CategoryScope {
  const { all, categories } = CallerScopeSchema.parse(raw)
  const named = categories.filter((c) => c !== ALL_CATEGORIES)
  return { all: all || named.length !== categories.length, categories: named }
}

export function normalizeUserGrant(raw: unknown): UserCategoryGrant {
  const parsed = UserGrantSchema.safeParse(raw)
  if (!parsed.success) return { all: true, categories: [], sourceGrant: sourceGrantOf(undefined) }
  const { all, categories, sources, updated_by: updatedBy, updated_at: updatedAt } = parsed.data
  const names = nameList.parse(categories ?? [])
  const isAll = all === true || categories === undefined || names.includes(ALL_CATEGORIES)
  return {
    all: isAll,
    categories: isAll ? [] : names,
    sourceGrant: sourceGrantOf(sources),
    ...(updatedBy === undefined ? {} : { updatedBy }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** True when `scope` lets its holder see `category`. A null scope (not loaded / route absent) admits all. */
export function scopeAdmits(scope: CategoryScope | null | undefined, category: string): boolean {
  if (scope == null || scope.all) return true
  return scope.categories.includes(category)
}

/**
 * The wire body for a grant: `['*']` for every category, else the names; with a
 * source grant, `sources` too — `null` for the default mode, which clears a
 * stored list back to the default rule. Without a source grant, `sources` is
 * omitted (= unchanged).
 */
export function grantBody(grant: CategoryScope, sourceGrant?: SourceGrant): { categories: string[]; sources?: string[] | null } {
  const categories = grant.all ? [ALL_CATEGORIES] : [...new Set(grant.categories)]
  if (sourceGrant === undefined) return { categories }
  if (sourceGrant.mode === 'default') return { categories, sources: null }
  return { categories, sources: sourceGrant.mode === 'all' ? [ALL_CATEGORIES] : [...new Set(sourceGrant.sources)] }
}

/** Query key of the caller's own scope (shared by every consumer). */
export const callerCategoryScopeKey = () => ['feedback-access'] as const
/** Query key of one user's stored grant (Settings → Users). */
export const userCategoryAccessKey = (username: string) => ['user-category-access', username] as const

export const categoryAccessApi = {
  getCallerScope: async (): Promise<CategoryScope> =>
    normalizeCallerScope(await fetchApi<unknown>('/feedback/access')),

  getUserGrant: async (username: string): Promise<UserCategoryGrant> =>
    normalizeUserGrant(await fetchApi<unknown>(`/users/${encodeURIComponent(username)}/category-access`)),

  saveUserGrant: async (username: string, grant: CategoryScope, sourceGrant?: SourceGrant): Promise<UserCategoryGrant> =>
    normalizeUserGrant(await fetchApi<unknown>(`/users/${encodeURIComponent(username)}/category-access`, {
      method: 'PUT',
      body: JSON.stringify(grantBody(grant, sourceGrant)),
    })),
}
