/**
 * @fileoverview Main application layout with sidebar navigation.
 *
 * Features:
 * - Collapsible sidebar with workflow-grouped navigation links
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
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  Home,
  LayoutDashboard,
  MessageSquare,
  FolderOpen,
  Settings,
  Bot,
  Globe,
  Briefcase,
  SearchX,
  ListOrdered,
  FileText,
  Database,
  Menu,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { useAuthStore, useIsAdmin } from '../../store/authStore'
import { authService } from '../../services/auth'
import TimeRangeSelector from '../TimeRangeSelector'
import Breadcrumbs from '../Breadcrumbs'
import UserProfileModal from '../UserProfileModal'
import { isMenuItemEnabled } from '../../config/menuConfig'
import { Sidebar, type NavItem } from './SidebarComponents'

/**
 * Navigation items. The two entry points — Home (the getting-started guide) and
 * Dashboard (the analytics overview) — sit at the top with no section header.
 * Everything below is grouped by the AI-PDLC workshop phase it maps to
 * (sources → signals → ideation → validation → settings), so the sidebar
 * mirrors the product-development lifecycle the app is built around. The order
 * here drives the sidebar order; the `section` field groups items under a header
 * so the flow is visible instead of a flat list. Section headers are rendered by
 * <Sidebar> and auto-hide when a whole section is filtered out by menu config or
 * admin gating. Items without a `section` (Home, Dashboard) render above the
 * first header.
 *
 * Phase mapping: Sources = load + inspect data (Phase 1) · Signals = analyze
 * feedback/themes (Phase 1) · Ideation = research → personas/PRD (Phase 2) ·
 * Validation = build survey + prioritize (Phase 3-4).
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: Home, labelKey: 'nav.home', menuKey: 'home' },
  { to: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard', menuKey: 'dashboard' },
  { to: '/scrapers', icon: Globe, labelKey: 'nav.scrapers', menuKey: 'scrapers', section: 'nav.section.sources' },
  { to: '/data-explorer', icon: Database, labelKey: 'nav.dataExplorer', menuKey: 'data-explorer', section: 'nav.section.sources' },
  { to: '/feedback', icon: MessageSquare, labelKey: 'nav.feedback', menuKey: 'feedback', section: 'nav.section.signals' },
  { to: '/categories', icon: FolderOpen, labelKey: 'nav.categories', menuKey: 'categories', section: 'nav.section.signals' },
  { to: '/problems', icon: SearchX, labelKey: 'nav.problemAnalysis', menuKey: 'problems', section: 'nav.section.signals' },
  { to: '/chat', icon: Bot, labelKey: 'nav.aiChat', menuKey: 'chat', section: 'nav.section.ideation' },
  { to: '/projects', icon: Briefcase, labelKey: 'nav.projects', menuKey: 'projects', section: 'nav.section.ideation' },
  { to: '/feedback-forms', icon: FileText, labelKey: 'nav.feedbackForms', menuKey: 'feedback-forms', section: 'nav.section.validation' },
  { to: '/prioritization', icon: ListOrdered, labelKey: 'nav.prioritization', menuKey: 'prioritization', section: 'nav.section.validation' },
  { to: '/settings', icon: Settings, labelKey: 'nav.settings', menuKey: 'settings', adminOnly: true, section: 'nav.section.settings' },
]

function isNavItemVisible(item: NavItem, isAdmin: boolean): boolean {
  // Check if menu item is enabled in config
  if (!isMenuItemEnabled(item.menuKey)) return false
  // Check admin-only restriction
  if (item.adminOnly === true && !isAdmin) return false
  return true
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
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const { user, isAuthenticated } = useAuthStore()
  const isAdmin = useIsAdmin()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const { mobileMenuOpen, openMenu, closeMenu } = useMobileMenu(location.pathname)

  // Filter nav items based on menu config and user role
  const visibleNavItems = NAV_ITEMS.filter(item => isNavItemVisible(item, isAdmin))

  const { data: urgentData } = useQuery({
    queryKey: ['urgent', dateParams],
    queryFn: () => api.getUrgentFeedback({ ...dateParams, limit: 10 }),
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
      <Sidebar
        sidebarCollapsed={sidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        brandName={config.brandName}
        visibleNavItems={visibleNavItems}
        urgentCount={urgentCount}
        isAuthenticated={isAuthenticated}
        user={user}
        onClose={closeMenu}
        onToggleCollapse={toggleSidebar}
        onShowProfile={showProfile}
        onLogout={handleLogout}
      />

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
