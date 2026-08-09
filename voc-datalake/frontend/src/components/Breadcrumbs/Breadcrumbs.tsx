/**
 * @fileoverview Breadcrumb navigation component.
 *
 * Displays hierarchical navigation path based on current route.
 * Hidden on home page.
 * Mobile-responsive with truncation and horizontal scroll.
 *
 * Labels come from the shipped `common:breadcrumbs` catalogue via
 * ./routeCrumbs — this file holds no English of its own, and no path segment
 * reaches the DOM unlabelled.
 *
 * @module components/Breadcrumbs
 */

import { Link, useLocation } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import clsx from 'clsx'
import { buildCrumbs } from './routeCrumbs'

/**
 * The one field a crumb needs off the `['project', id]` cache entry. Lenient by
 * construction: a failed parse (nothing cached yet, an error state, a record
 * saved before `name` existed) leaves the generic label in place rather than
 * throwing inside the page header.
 */
const ProjectNameSchema = z.object({
  project: z.object({ name: z.string().trim().min(1) }),
})

/**
 * The display name for the record the current route addresses, if the page has
 * already loaded it. At most one record route is active at a time, so a single
 * name covers them all.
 *
 * Projects are the only record with a name to show: a feedback item has no title
 * field (see FeedbackItem), so `/feedback/:id` keeps its generic label.
 *
 * The `['project', id]` entry — ProjectDetail's, via useProjectData — is observed
 * with `skipToken`, i.e. read-only: the header must not issue a request of its
 * own, nor race that page for one. The subscription is live either way, so the
 * crumb fills in the moment the page's own query resolves.
 */
function useRecordName(pathSegments: readonly string[]): string | undefined {
  const projectId = pathSegments[0] === 'projects' ? pathSegments[1] : undefined
  const { data } = useQuery({ queryKey: ['project', projectId], queryFn: skipToken })
  return ProjectNameSchema.safeParse(data).data?.project.name
}

export default function Breadcrumbs() {
  const location = useLocation()
  const { t } = useTranslation()
  const pathSegments = location.pathname.split('/').filter(Boolean)
  const recordName = useRecordName(pathSegments)

  // Don't show breadcrumbs on home page
  if (pathSegments.length === 0) {
    return null
  }

  const breadcrumbs = buildCrumbs(pathSegments, t, recordName)

  return (
    <nav 
      className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-gray-600 overflow-x-auto scrollbar-hide"
      aria-label="Breadcrumb"
    >
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1
        
        return (
          <div key={crumb.path} className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            {index > 0 && (
              <ChevronRight 
                size={14} 
                className="text-gray-400 flex-shrink-0" 
                aria-hidden="true" 
              />
            )}
            
            {isLast ? (
              <span 
                className="text-gray-900 font-medium flex items-center gap-1 sm:gap-1.5 max-w-[120px] sm:max-w-none truncate"
                aria-current="page"
              >
                {crumb.isHome && <Home size={14} className="flex-shrink-0" aria-hidden="true" />}
                <span className="truncate">{crumb.label}</span>
              </span>
            ) : (
              <Link
                to={crumb.path}
                // The label is hidden below `sm`, where an intermediate crumb has
                // no icon either — without this the link has no accessible name
                // at all on a phone.
                aria-label={crumb.label}
                className={clsx(
                  'hover:text-blue-600 active:text-blue-700 transition-colors flex items-center gap-1 sm:gap-1.5 py-1',
                  crumb.isHome && 'text-gray-500'
                )}
              >
                {crumb.isHome && <Home size={14} className="flex-shrink-0" aria-hidden="true" />}
                <span className="hidden sm:inline">{crumb.label}</span>
              </Link>
            )}
          </div>
        )
      })}
    </nav>
  )
}
