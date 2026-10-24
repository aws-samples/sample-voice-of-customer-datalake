/**
 * @fileoverview What the signed-in person may see, reduced to what the UI has
 * to say about it (owner rule 2026-10-21: a restricted caller sees only their
 * categories' reviews, counts and names).
 *
 * Pure: `viewerScopeOf` turns the caller's access (`GET /feedback/access`,
 * normalised by `api/categoryAccessApi`) into one of three cases. The backend
 * is the enforcement — every list and count is already filtered server-side —
 * so this only decides which notice or empty state to show.
 *
 * @module components/ScopeNotice/viewerScope
 */
import type { CallerAccess } from '../../api/categoryAccessApi'

/**
 * - `all` — every category and every source (admins, and anyone with no rule);
 * - `categories` — only the listed categories (possibly none at all);
 * - `sources` — every category, but only some sources.
 */
export type ViewerScope =
  | { kind: 'all' }
  | { kind: 'categories'; categories: readonly string[] }
  | { kind: 'sources' }

/** True when a source rule hides anything: an allow list, or a deny rule that names a source. */
function sourcesLimited(sources: CallerAccess['sources']): boolean {
  if (sources.rule === 'allow') return true
  return sources.rule === 'deny' && sources.denied.length > 0
}

export function viewerScopeOf(access: CallerAccess): ViewerScope {
  if (!access.categories.all) return { kind: 'categories', categories: access.categories.categories }
  return sourcesLimited(access.sources) ? { kind: 'sources' } : { kind: 'all' }
}

export function isRestricted(scope: ViewerScope | null): boolean {
  return scope !== null && scope.kind !== 'all'
}
