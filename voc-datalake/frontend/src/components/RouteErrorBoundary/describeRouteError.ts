/**
 * Split from the RouteErrorBoundary component so that file only exports a
 * component (react-refresh/only-export-components — mixed exports disable
 * Fast Refresh for the module).
 */
import { isRouteErrorResponse } from 'react-router-dom'

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
