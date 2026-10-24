/**
 * @fileoverview "Page not found" state for unknown URLs.
 *
 * Mounted two ways: as the layout's catch-all (`path: '*'` in routes.tsx), so a
 * mistyped or stale link keeps the sidebar and header and lands inside `<main>`;
 * and by RouteErrorBoundary for any 404 route-error response that still reaches
 * it. Before the catch-all existed, an unknown path fell through to the root
 * error boundary and showed "Something went wrong" with a Reload button — a
 * reload of a URL that cannot exist is a dead end.
 *
 * @module components/RouteErrorBoundary/NotFound
 */
import { ArrowLeft, Compass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import GoHomeLink from './GoHomeLink'

/**
 * Whether there is an in-app entry to go back to. A deep link opened in a fresh
 * tab has none; React Router's browser history stores its index as `idx`, 0 for
 * the first entry of the session. `history.state` is untyped, hence the guard.
 */
function hasInAppHistory(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'idx' in state
    && typeof state.idx === 'number' && state.idx > 0
}

export default function NotFound() {
  const { t } = useTranslation('components')
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const canGoBack = hasInAppHistory(window.history.state)

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent-subtle mb-4">
          <Compass size={24} className="text-accent" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('errorBoundary.notFoundTitle')}</h1>
        <p className="text-sm text-muted mt-1">{t('errorBoundary.notFoundDescription')}</p>
        <p
          className="text-sm font-mono text-muted bg-bg-accent border border-border rounded-lg px-3 py-2 mt-4 mb-6 truncate"
          title={pathname}
        >
          {pathname}
        </p>
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-center gap-3">
          {canGoBack && (
            <button type="button" onClick={() => navigate(-1)} className="btn btn-secondary gap-2">
              <ArrowLeft size={16} aria-hidden="true" />
              {t('errorBoundary.goBack')}
            </button>
          )}
          <GoHomeLink variant="primary" />
        </div>
      </div>
    </div>
  )
}
