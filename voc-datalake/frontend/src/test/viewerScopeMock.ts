/**
 * @fileoverview A switchable double for `components/ScopeNotice/useViewerScope`
 * (the caller's `GET /feedback/access` scope) in page specs whose `api/client`
 * mock has no `fetchApi`.
 *
 * Wire it like `@test/fetchApiRoutes`: the factory imports this module, and the
 * spec imports the same instance statically to set the scope per test.
 *
 * ```ts
 * vi.mock('../../components/ScopeNotice/useViewerScope', (importOriginal) =>
 *   import('@test/viewerScopeMock').then((m) => m.viewerScopeModule(importOriginal)))
 * import { viewerScope, resetViewerScope } from '@test/viewerScopeMock'
 * ```
 *
 * `useScopeCategories` stays real, so names go through the page's display labels.
 */
import { isRestricted } from '../components/ScopeNotice/viewerScope'
import type { ViewerScope } from '../components/ScopeNotice/viewerScope'

/** What the doubles answer: an unrestricted administrator unless a test narrows it. */
export const viewerScope: { scope: ViewerScope; isAdmin: boolean } = { scope: { kind: 'all' }, isAdmin: true }

export function resetViewerScope(): void {
  viewerScope.scope = { kind: 'all' }
  viewerScope.isAdmin = true
}

/** The real module with `useViewerScope` / `useCanSetUp` reading {@link viewerScope}. */
export async function viewerScopeModule(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import('../components/ScopeNotice/useViewerScope')>()
  return {
    ...actual,
    useViewerScope: () => ({ scope: viewerScope.scope, isLoading: false }),
    useCanSetUp: () => viewerScope.isAdmin && !isRestricted(viewerScope.scope),
  }
}
