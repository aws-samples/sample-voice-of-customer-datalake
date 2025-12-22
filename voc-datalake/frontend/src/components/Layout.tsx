/**
 * @fileoverview Main application layout with sidebar navigation.
 *
 * Features:
 * - Collapsible sidebar with navigation links
 * - Mobile-responsive hamburger menu
 * - Time range selector in header
 * - Breadcrumb navigation
 * - User menu with logout (when authenticated)
 * - User profile modal
 * - Urgent feedback count badge
 *
 * @module components/Layout
 */

import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  MessageSquare,
  FolderOpen,
  Settings,
  Bot,
  Globe,
  PanelLeftClose,
  PanelLeft,
  Briefcase,
  SearchX,
  ListOrdered,
  FileText,
  LogOut,
  Database,
  Menu,
  X,
  Sparkles,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { useAuthStore } from '../store/authStore'
import { authService } from '../services/auth'
import TimeRangeSelector from './TimeRangeSelector'
import Breadcrumbs from './Breadcrumbs'
import UserProfileModal from './UserProfileModal'
import clsx from 'clsx'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/feedback', icon: MessageSquare, label: 'Feedback' },
  { to: '/categories', icon: FolderOpen, label: 'Categories' },
  { to: '/problems', icon: SearchX, label: 'Problem Analysis' },
  { to: '/chat', icon: Bot, label: 'AI Chat' },
  { to: '/projects', icon: Briefcase, label: 'Projects' },
  { to: '/prioritization', icon: ListOrdered, label: 'Prioritization' },
  { to: '/data-explorer', icon: Database, label: 'Data Explorer' },
  { to: '/artifact-builder', icon: Sparkles, label: 'Artifact Builder' },
  { to: '/scrapers', icon: Globe, label: 'Scrapers' },
  { to: '/feedback-forms', icon: FileText, label: 'Feedback Forms' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { timeRange, config } = useConfigStore()
  const { user, isAuthenticated } = useAuthStore()
  const days = getDaysFromRange(timeRange)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)

  const { data: urgentData } = useQuery({
    queryKey: ['urgent', days],
    queryFn: () => api.getUrgentFeedback({ days, limit: 10 }),
    enabled: !!config.apiEndpoint,
  })

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileMenuOpen])

  const handleLogout = () => {
    authService.signOut()
    navigate('/login')
  }

  return (
    <div className="h-screen flex overflow-hidden">
      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar - hidden on mobile, shown on lg+ */}
      <aside
        className={clsx(
          'bg-gray-900 text-white flex flex-col flex-shrink-0 h-screen transition-all duration-200 z-50',
          // Mobile: fixed overlay
          'fixed lg:relative',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          // Desktop: collapsible width
          sidebarCollapsed ? 'lg:w-16' : 'w-64'
        )}
      >
        {/* Header - fixed at top */}
        <div
          className={clsx(
            'p-4 flex items-center flex-shrink-0',
            sidebarCollapsed ? 'lg:justify-center justify-between' : 'justify-between'
          )}
        >
          {(!sidebarCollapsed || mobileMenuOpen) && (
            <div>
              <h1 className="text-lg font-bold">VoC Analytics</h1>
              <p className="text-gray-400 text-xs mt-0.5">{config.brandName || 'Configure brand'}</p>
            </div>
          )}
          {/* Close button on mobile */}
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors lg:hidden"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
          {/* Collapse button on desktop */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors hidden lg:block"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>

        {/* Navigation - scrollable if needed */}
        <nav className={clsx('flex-1 overflow-y-auto', sidebarCollapsed && !mobileMenuOpen ? 'lg:px-2 px-4' : 'px-4')}>
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              title={sidebarCollapsed && !mobileMenuOpen ? label : undefined}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 py-2.5 rounded-lg mb-1 transition-colors',
                  sidebarCollapsed && !mobileMenuOpen ? 'lg:justify-center lg:px-2 px-4' : 'px-4',
                  isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'
                )
              }
            >
              <Icon size={20} className="flex-shrink-0" />
              {(!sidebarCollapsed || mobileMenuOpen) && (
                <>
                  <span>{label}</span>
                  {to === '/feedback' && urgentData && urgentData.count > 0 && (
                    <span className="ml-auto bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
                      {urgentData.count}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User info and logout - sticky at bottom */}
        {isAuthenticated && user && (
          <div className={clsx('border-t border-gray-700 p-4 flex-shrink-0', sidebarCollapsed && !mobileMenuOpen && 'lg:px-2')}>
            {(!sidebarCollapsed || mobileMenuOpen) && (
              <button
                onClick={() => setShowProfileModal(true)}
                className="flex items-center gap-2 mb-3 text-sm w-full text-left hover:bg-gray-800 rounded-lg px-2 py-1.5 -mx-2 transition-colors"
                title="View profile"
              >
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                  {user.email?.charAt(0).toUpperCase() || 'U'}
                </div>
                <span className="text-gray-300 truncate">{user.email || user.username}</span>
              </button>
            )}
            {sidebarCollapsed && !mobileMenuOpen && (
              <button
                onClick={() => setShowProfileModal(true)}
                className="hidden lg:flex items-center justify-center w-full py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white transition-colors mb-2"
                title="View profile"
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold">
                  {user.email?.charAt(0).toUpperCase() || 'U'}
                </div>
              </button>
            )}
            <button
              onClick={handleLogout}
              title="Sign out"
              className={clsx(
                'flex items-center gap-2 w-full py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white transition-colors',
                sidebarCollapsed && !mobileMenuOpen ? 'lg:justify-center lg:px-2 px-4' : 'px-4'
              )}
            >
              <LogOut size={18} />
              {(!sidebarCollapsed || mobileMenuOpen) && <span>Sign out</span>}
            </button>
          </div>
        )}
      </aside>

      {/* Main content - scrollable */}
      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex-shrink-0">
          <div className="flex items-center justify-between gap-4 mb-2 sm:mb-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* Mobile hamburger menu */}
              <button
                onClick={() => setMobileMenuOpen(true)}
                className="p-2 -ml-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg lg:hidden"
                aria-label="Open menu"
              >
                <Menu size={24} />
              </button>
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900 truncate">Voice of the Customer</h2>
                <p className="text-xs sm:text-sm text-gray-500 mt-0.5 hidden sm:block">Unified customer feedback intelligence platform</p>
              </div>
            </div>
            <TimeRangeSelector />
          </div>
          <Breadcrumbs />
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          <Outlet />
        </div>
      </main>

      {/* User Profile Modal */}
      <UserProfileModal isOpen={showProfileModal} onClose={() => setShowProfileModal(false)} />
    </div>
  )
}
