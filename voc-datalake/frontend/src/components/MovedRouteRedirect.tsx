/**
 * @fileoverview Redirect for a route that moved: `/settings` → `/admin`
 * (Administration). The assistant's navigation suggestions still name the old
 * path (lambda/stream/src/assistant/tools/server/core.ts), so it stays an alias,
 * its query string preserved. A query on `to` is the target's own: it wins over
 * the same parameter of the old URL. (No `?tab=` names a place any longer: a tab
 * is a path, `/admin/<tab>/<section>`.)
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
