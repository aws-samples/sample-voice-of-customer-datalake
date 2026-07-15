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
import { AlertTriangle, Home, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom'

/** Human-readable summary of whatever useRouteError() delivered (unknown). */
export function describeRouteError(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    const base = `${error.status} ${error.statusText}`.trim()
    // Loader-thrown Responses often carry the actionable message in data.
    return typeof error.data === 'string' && error.data ? `${base} — ${error.data}` : base
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export default function RouteErrorBoundary() {
  const error = useRouteError()
  const { t } = useTranslation('components')

  // Graceful catching must not swallow observability: report the FULL error
  // object (stack included) so production render crashes stay diagnosable —
  // console.error feeds CloudWatch RUM / browser monitoring when configured.
  useEffect(() => {
    console.error('Route render error caught by RouteErrorBoundary:', error)
  }, [error])

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6" role="alert">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4">
          <AlertTriangle size={24} className="text-red-600" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">{t('errorBoundary.title')}</h1>
        <p className="text-gray-600 mb-4">{t('errorBoundary.description')}</p>
        {import.meta.env.DEV && (
          // Technical detail is dev-only: raw messages leak implementation
          // internals to end users; production keeps them in the log path.
          <p className="text-sm font-mono text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-6 break-words">
            {describeRouteError(error)}
          </p>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <RotateCcw size={16} />
            {t('errorBoundary.reload')}
          </button>
          <Link
            to="/"
            className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Home size={16} />
            {t('errorBoundary.goHome')}
          </Link>
        </div>
      </div>
    </div>
  )
}
