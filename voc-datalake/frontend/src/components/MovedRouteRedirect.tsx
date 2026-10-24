/**
 * @fileoverview Redirect for a route that moved:
 * `/settings` → `/admin` (Administration), and `/agents/workflows` →
 * `/agents?tab=workflows` (the workflow library's tab). Old links, bookmarks and the
 * assistant's navigation suggestions still point at the old path, so the query
 * string is preserved (`?tab=categories` keeps deep-linking the tab). A query on
 * `to` is the target's own: it wins over the same parameter of the old URL.
 *
 * Its own file so `routes.tsx` defines no component (fast refresh), like
 * `FeedbackRedirect`.
 *
 * @module components/MovedRouteRedirect
 */
import { Navigate, useLocation } from 'react-router-dom'

export default function MovedRouteRedirect({ to }: Readonly<{ to: string }>) {
  const location = useLocation()
  const [pathname, own = ''] = to.split('?')
  const search = new URLSearchParams(location.search)
  new URLSearchParams(own).forEach((value, key) => search.set(key, value))
  const encoded = search.toString()
  const query = encoded === '' ? '' : '?' + encoded
  return <Navigate to={`${pathname}${query}${location.hash}`} replace />
}
