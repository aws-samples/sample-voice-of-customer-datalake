/**
 * @fileoverview Redirect for a route that moved (todofeatures §6.1 navigation):
 * `/settings` → `/admin` (Administration). Old links, bookmarks and the
 * assistant's navigation suggestions still point at the old path, so the query
 * string is preserved (`?tab=categories` keeps deep-linking the tab).
 *
 * Its own file so `routes.tsx` defines no component (fast refresh), like
 * `FeedbackRedirect`.
 *
 * @module components/MovedRouteRedirect
 */
import { Navigate, useLocation } from 'react-router-dom'

export default function MovedRouteRedirect({ to }: Readonly<{ to: string }>) {
  const location = useLocation()
  return <Navigate to={`${to}${location.search}${location.hash}`} replace />
}
