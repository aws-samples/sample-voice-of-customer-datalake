/**
 * @fileoverview Redirect for the retired `/feedback` list route.
 *
 * The standalone Feedback list page was consolidated into Categories (issue
 * #198). Old links and bookmarks still point at `/feedback`, so redirect there
 * with the query string preserved (`?category=`, `?q=`, `?source=` deep-links
 * land pre-filtered on Categories).
 *
 * Its own file so `routes.tsx` exports the route table and defines no component
 * — which is what lets fast refresh keep working for both.
 *
 * @module components/FeedbackRedirect
 */
import { Navigate, useLocation } from 'react-router-dom'

export default function FeedbackRedirect() {
  const location = useLocation()
  return <Navigate to={`/categories${location.search}`} replace />
}
