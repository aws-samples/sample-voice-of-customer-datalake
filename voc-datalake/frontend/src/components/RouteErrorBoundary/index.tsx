/**
 * Route-level error boundary (issue #173).
 *
 * Three crashes (#159 ProjectDetail, #167 Scrapers, #171 Feedback Forms)
 * shared the same amplifier: with no errorElement on the routes, a render
 * error in one card unmounted the whole app. Mounted as errorElement on
 * each child route, this fallback replaces only the failing route content —
 * the layout and sidebar stay interactive.
 */
import { useEffect } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { describeRouteError } from './describeRouteError'
import GoHomeLink from './GoHomeLink'
import NotFound from './NotFound'

export default function RouteErrorBoundary() {
  const error = useRouteError()
  const { t } = useTranslation('components')

  // Graceful catching must not swallow observability: report the FULL error
  // object (stack included) so production render crashes stay diagnosable —
  // console.error feeds CloudWatch RUM / browser monitoring when configured.
  useEffect(() => {
    console.error('Route render error caught by RouteErrorBoundary:', error)
  }, [error])

  // A 404 is not a crash: "Reload page" on a URL that cannot exist is a dead
  // end, so say what actually happened and offer a way out.
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFound />
  }

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6" role="alert">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-danger-subtle mb-4">
          <AlertTriangle size={24} className="text-danger" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-text-strong mb-2">{t('errorBoundary.title')}</h1>
        <p className="text-text mb-4">{t('errorBoundary.description')}</p>
        {import.meta.env.DEV && (
          // Technical detail is dev-only: raw messages leak implementation
          // internals to end users; production keeps them in the log path.
          <p className="text-sm font-mono text-muted bg-bg-accent border border-border rounded-lg px-3 py-2 mb-6 break-words">
            {describeRouteError(error)}
          </p>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-primary gap-2"
          >
            <RotateCcw size={16} aria-hidden="true" />
            {t('errorBoundary.reload')}
          </button>
          <GoHomeLink variant="secondary" />
        </div>
      </div>
    </div>
  )
}
