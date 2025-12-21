/**
 * @fileoverview Breadcrumb navigation component.
 *
 * Displays hierarchical navigation path based on current route.
 * Hidden on home page.
 *
 * @module components/Breadcrumbs
 */

import { Link, useLocation } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'
import clsx from 'clsx'

const routeLabels: Record<string, string> = {
  '': 'Dashboard',
  'feedback': 'Feedback',
  'categories': 'Categories',
  'chat': 'AI Chat',
  'scrapers': 'Web Scrapers',
  'feedback-forms': 'Feedback Forms',
  'settings': 'Settings',
}

export default function Breadcrumbs() {
  const location = useLocation()
  const pathSegments = location.pathname.split('/').filter(Boolean)

  // Don't show breadcrumbs on home page
  if (pathSegments.length === 0) {
    return null
  }

  const breadcrumbs = [
    { label: 'Home', path: '/', isHome: true },
    ...pathSegments.map((segment, index) => {
      const path = '/' + pathSegments.slice(0, index + 1).join('/')
      const label = routeLabels[segment] || segment
      return { label, path, isHome: false }
    })
  ]

  return (
    <nav className="flex items-center gap-2 text-sm text-gray-600">
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1
        
        return (
          <div key={crumb.path} className="flex items-center gap-2">
            {index > 0 && <ChevronRight size={14} className="text-gray-400" />}
            
            {isLast ? (
              <span className="text-gray-900 font-medium flex items-center gap-1.5">
                {crumb.isHome && <Home size={14} />}
                {crumb.label}
              </span>
            ) : (
              <Link
                to={crumb.path}
                className={clsx(
                  'hover:text-blue-600 transition-colors flex items-center gap-1.5',
                  crumb.isHome && 'text-gray-500'
                )}
              >
                {crumb.isHome && <Home size={14} />}
                {crumb.label}
              </Link>
            )}
          </div>
        )
      })}
    </nav>
  )
}
