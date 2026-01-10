/**
 * @fileoverview Breadcrumb navigation component.
 *
 * Displays hierarchical navigation path based on current route.
 * Hidden on home page.
 * Mobile-responsive with truncation and horizontal scroll.
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
  'data-explorer': 'Data Explorer',
  'projects': 'Projects',
  'prioritization': 'Prioritization',
  'problems': 'Problem Analysis',
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
