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

import { useState, useEffect, useRef, useCallback } from 'react'
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
import type { LucideIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { useAuthStore, useIsAdmin } from '../../store/authStore'
import { authService } from '../../services/auth'
import TimeRangeSelector from '../TimeRangeSelector'
import Breadcrumbs from '../Breadcrumbs'
import UserProfileModal from '../UserProfileModal'
import clsx from 'clsx'
import { isMenuItemEnabled } from '../../config/menuConfig'

interface NavItem {
  to: string
  icon: LucideIcon
  label: string
  menuKey: string
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', menuKey: 'dashboard' },
  { to: '/feedback', icon: MessageSquare, label: 'Feedback', menuKey: 'feedback' },
  { to: '/categories', icon: FolderOpen, label: 'Categories', menuKey: 'categories' },
  { to: '/problems', icon: SearchX, label: 'Problem Analysis', menuKey: 'problems' },
  { to: '/chat', icon: Bot, label: 'AI Chat', menuKey: 'chat' },
  { to: '/projects', icon: Briefcase, label: 'Projects', menuKey: 'projects' },
  { to: '/prioritization', icon: ListOrdered, label: 'Prioritization', menuKey: 'prioritization' },
  { to: '/data-explorer', icon: Database, label: 'Data Explorer', menuKey: 'data-explorer' },
  { to: '/artifact-builder', icon: Sparkles, label: 'Artifact Builder', menuKey: 'artifact-builder' },
  { to: '/scrapers', icon: Globe, label: 'Scrapers', menuKey: 'scrapers' },
  { to: '/feedback-forms', icon: FileText, label: 'Feedback Forms', menuKey: 'feedback-forms' },
  { to: '/settings', icon: Settings, label: 'Settings', menuKey: 'settings', adminOnly: true },
]

// Sidebar header component
function SidebarHeader({ 
  sidebarCollapsed, 
  mobileMenuOpen, 
  brandName,
  onClose,
  onToggleCollapse 
}: Readonly<{
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  brandName: string
  onClose: () => void
  onToggleCollapse: () => void
}>) {
  return (
    <div className={clsx(
      'p-4 flex items-center flex-shrink-0',
      sidebarCollapsed ? 'lg:justify-center justify-between' : 'justify-between'
    )}>
      {(!sidebarCollapsed || mobileMenuOpen) && (
        <div>
          <h1 className="text-lg font-bold">VoC Analytics</h1>
          <p className="text-gray-400 text-xs mt-0.5">{brandName || 'Configure brand'}</p>
        </div>
      )}
      <button
        onClick={onClose}
        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors lg:hidden"
        aria-label="Close menu"
      >
        <X size={20} />
      </button>
      <button
        onClick={onToggleCollapse}
        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors hidden lg:block"
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
      </button>
    </div>
  )
}


// Navigation item component
function NavItemLink({ 
  item, 
  sidebarCollapsed, 
  mobileMenuOpen, 
  urgentCount 
}: Readonly<{
  item: NavItem
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  urgentCount: number
}>) {
  const Icon = item.icon
  const showLabel = !sidebarCollapsed || mobileMenuOpen
  
  return (
    <NavLink
      to={item.to}
      title={sidebarCollapsed && !mobileMenuOpen ? item.label : undefined}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-3 py-2.5 rounded-lg mb-1 transition-colors',
          sidebarCollapsed && !mobileMenuOpen ? 'lg:justify-center lg:px-2 px-4' : 'px-4',
          isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'
        )
      }
    >
      <Icon size={20} className="flex-shrink-0" />
      {showLabel && (
        <>
          <span>{item.label}</span>
          {item.to === '/feedback' && urgentCount > 0 && (
            <span className="ml-auto bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
              {urgentCount}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

// User avatar component
function UserAvatar({ initial, size }: Readonly<{ initial: string; size: 'sm' | 'md' }>) {
  const sizeClasses = size === 'sm' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm'
  return (
    <div className={clsx(sizeClasses, 'rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold flex-shrink-0')}>
      {initial}
    </div>
  )
}

// Expanded user profile button
function ExpandedProfileButton({ user, userInitial, onShowProfile }: Readonly<{
  user: { email?: string; username?: string }
  userInitial: string
  onShowProfile: () => void
}>) {
  return (
    <button
      onClick={onShowProfile}
      className="flex items-center gap-2 mb-3 text-sm w-full text-left hover:bg-gray-800 rounded-lg px-2 py-1.5 -mx-2 transition-colors"
      title="View profile"
    >
      <UserAvatar initial={userInitial} size="sm" />
      <span className="text-gray-300 truncate">{user.email || user.username}</span>
    </button>
  )
}

// Collapsed user profile button
function CollapsedProfileButton({ userInitial, onShowProfile }: Readonly<{
  userInitial: string
  onShowProfile: () => void
}>) {
  return (
    <button
      onClick={onShowProfile}
      className="hidden lg:flex items-center justify-center w-full py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white transition-colors mb-2"
      title="View profile"
    >
      <UserAvatar initial={userInitial} size="md" />
    </button>
  )
}

// User section component
function UserSection({ 
  user, 
  sidebarCollapsed, 
  mobileMenuOpen, 
  onShowProfile, 
  onLogout 
}: Readonly<{
  user: { email?: string; username?: string }
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  onShowProfile: () => void
  onLogout: () => void
}>) {
  const showExpanded = !sidebarCollapsed || mobileMenuOpen
  const showCollapsed = sidebarCollapsed && !mobileMenuOpen
  const userInitial = user.email?.charAt(0).toUpperCase() || 'U'
  
  return (
    <div className={clsx('border-t border-gray-700 p-4 flex-shrink-0', showCollapsed && 'lg:px-2')}>
      {showExpanded && <ExpandedProfileButton user={user} userInitial={userInitial} onShowProfile={onShowProfile} />}
      {showCollapsed && <CollapsedProfileButton userInitial={userInitial} onShowProfile={onShowProfile} />}
      <button
        onClick={onLogout}
        title="Sign out"
        className={clsx(
          'flex items-center gap-2 w-full py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white transition-colors',
          sidebarCollapsed && !mobileMenuOpen ? 'lg:justify-center lg:px-2 px-4' : 'px-4'
        )}
      >
        <LogOut size={18} />
        {showExpanded && <span>Sign out</span>}
      </button>
    </div>
  )
}

// Main header component
function MainHeader({ onOpenMenu }: Readonly<{ onOpenMenu: () => void }>) {
  return (
    <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex-shrink-0">
      <div className="flex items-center justify-between gap-4 mb-2 sm:mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onOpenMenu}
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
  )
}

// Custom hook for mobile menu management
function useMobileMenu(pathname: string) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const prevPathRef = useRef(pathname)
  
  // Close menu on route change - using callback to avoid setState in effect
  const closeMenu = useCallback(() => setMobileMenuOpen(false), [])
  const openMenu = useCallback(() => setMobileMenuOpen(true), [])
  
  useEffect(() => {
    if (prevPathRef.current !== pathname) {
      prevPathRef.current = pathname
      // Use setTimeout to defer state update outside of effect
      if (mobileMenuOpen) {
        setTimeout(closeMenu, 0)
      }
    }
  }, [pathname, mobileMenuOpen, closeMenu])
  
  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mobileMenuOpen])
  
  return { mobileMenuOpen, openMenu, closeMenu }
}


export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { timeRange, config } = useConfigStore()
  const { user, isAuthenticated } = useAuthStore()
  const isAdmin = useIsAdmin()
  const days = getDaysFromRange(timeRange)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const { mobileMenuOpen, openMenu, closeMenu } = useMobileMenu(location.pathname)

  // Filter nav items based on user role and menu config
  const visibleNavItems = NAV_ITEMS.filter(item => {
    // Check if menu item is enabled in config
    if (!isMenuItemEnabled(item.menuKey)) return false
    // Check admin-only restriction
    if (item.adminOnly && !isAdmin) return false
    return true
  })

  const { data: urgentData } = useQuery({
    queryKey: ['urgent', days],
    queryFn: () => api.getUrgentFeedback({ days, limit: 10 }),
    enabled: !!config.apiEndpoint,
  })

  const handleLogout = useCallback(() => {
    authService.signOut()
    navigate('/login')
  }, [navigate])

  const toggleSidebar = useCallback(() => setSidebarCollapsed(prev => !prev), [])
  const showProfile = useCallback(() => setShowProfileModal(true), [])
  const hideProfile = useCallback(() => setShowProfileModal(false), [])

  const urgentCount = urgentData?.count ?? 0

  return (
    <div className="h-screen flex overflow-hidden">
      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={closeMenu}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'bg-gray-900 text-white flex flex-col flex-shrink-0 h-screen transition-all duration-200 z-50',
          'fixed lg:relative',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          sidebarCollapsed ? 'lg:w-16' : 'w-64'
        )}
      >
        <SidebarHeader
          sidebarCollapsed={sidebarCollapsed}
          mobileMenuOpen={mobileMenuOpen}
          brandName={config.brandName}
          onClose={closeMenu}
          onToggleCollapse={toggleSidebar}
        />

        <nav className={clsx('flex-1 overflow-y-auto', sidebarCollapsed && !mobileMenuOpen ? 'lg:px-2 px-4' : 'px-4')}>
          {visibleNavItems.map(item => (
            <NavItemLink
              key={item.to}
              item={item}
              sidebarCollapsed={sidebarCollapsed}
              mobileMenuOpen={mobileMenuOpen}
              urgentCount={urgentCount}
            />
          ))}
        </nav>

        {isAuthenticated && user && (
          <UserSection
            user={user}
            sidebarCollapsed={sidebarCollapsed}
            mobileMenuOpen={mobileMenuOpen}
            onShowProfile={showProfile}
            onLogout={handleLogout}
          />
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <MainHeader onOpenMenu={openMenu} />
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          <Outlet />
        </div>
      </main>

      <UserProfileModal isOpen={showProfileModal} onClose={hideProfile} />
    </div>
  )
}
