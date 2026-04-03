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

import { useQuery } from '@tanstack/react-query'
import {
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
import {
  useState, useEffect, useRef, useCallback,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  Outlet, useNavigate, useLocation,
} from 'react-router-dom'
import { getDaysFromRange } from '../../api/baseUrl'
import { api } from '../../api/client'
import { isMenuItemEnabled } from '../../config/menuConfig'
import { authService } from '../../services/auth'
import {
  useAuthStore, useIsAdmin,
} from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import Breadcrumbs from '../Breadcrumbs'
import TimeRangeSelector from '../TimeRangeSelector'
import UserProfileModal from '../UserProfileModal'
import { Sidebar } from './SidebarComponents'
import type { NavItem } from './SidebarComponents'

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    icon: LayoutDashboard,
    labelKey: 'nav.dashboard',
    menuKey: 'dashboard',
  },
  {
    to: '/feedback',
    icon: MessageSquare,
    labelKey: 'nav.feedback',
    menuKey: 'feedback',
  },
  {
    to: '/categories',
    icon: FolderOpen,
    labelKey: 'nav.categories',
    menuKey: 'categories',
  },
  {
    to: '/problems',
    icon: SearchX,
    labelKey: 'nav.problemAnalysis',
    menuKey: 'problems',
  },
  {
    to: '/chat',
    icon: Bot,
    labelKey: 'nav.aiChat',
    menuKey: 'chat',
  },
  {
    to: '/projects',
    icon: Briefcase,
    labelKey: 'nav.projects',
    menuKey: 'projects',
  },
  {
    to: '/prioritization',
    icon: ListOrdered,
    labelKey: 'nav.prioritization',
    menuKey: 'prioritization',
  },
  {
    to: '/data-explorer',
    icon: Database,
    labelKey: 'nav.dataExplorer',
    menuKey: 'data-explorer',
  },
  {
    to: '/scrapers',
    icon: Globe,
    labelKey: 'nav.scrapers',
    menuKey: 'scrapers',
  },
  {
    to: '/feedback-forms',
    icon: FileText,
    labelKey: 'nav.feedbackForms',
    menuKey: 'feedback-forms',
  },
  {
    to: '/settings',
    icon: Settings,
    labelKey: 'nav.settings',
    menuKey: 'settings',
    adminOnly: true,
  },
]

// Main header component
function MainHeader({ onOpenMenu }: Readonly<{ onOpenMenu: () => void }>) {
  const { t } = useTranslation()
  return (
    <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex-shrink-0">
      <div className="flex items-center justify-between gap-4 mb-2 sm:mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onOpenMenu}
            className="p-2 -ml-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg lg:hidden"
            aria-label={t('sidebar.openMenu')}
          >
            <Menu size={24} />
          </button>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold text-gray-900 truncate">{t('appTagline')}</h2>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5 hidden sm:block">{t('appDescription')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <TimeRangeSelector />
        </div>
      </div>
      <Breadcrumbs />
    </header>
  )
}

// Custom hook for mobile menu management
function useMobileMenu(pathname: string) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const prevPathRef = useRef(pathname)

  const closeMenu = useCallback(() => setMobileMenuOpen(false), [])
  const openMenu = useCallback(() => setMobileMenuOpen(true), [])

  useEffect(() => {
    if (prevPathRef.current !== pathname) {
      prevPathRef.current = pathname
      if (mobileMenuOpen) {
        setTimeout(closeMenu, 0)
      }
    }
  }, [pathname, mobileMenuOpen, closeMenu])

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileMenuOpen])

  return {
    mobileMenuOpen,
    openMenu,
    closeMenu,
  }
}

function isNavItemVisible(item: NavItem, isAdmin: boolean): boolean {
  if (!isMenuItemEnabled(item.menuKey)) return false
  if (item.adminOnly === true && !isAdmin) return false
  return true
}

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    timeRange, config,
  } = useConfigStore()
  const {
    user, isAuthenticated,
  } = useAuthStore()
  const isAdminGroup = useIsAdmin()
  const isAdmin = isAdminGroup || (!authService.isConfigured() && import.meta.env.DEV)
  const days = getDaysFromRange(timeRange)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const {
    mobileMenuOpen, openMenu, closeMenu,
  } = useMobileMenu(location.pathname)

  const visibleNavItems = NAV_ITEMS.filter((item) => isNavItemVisible(item, isAdmin))

  const { data: urgentData } = useQuery({
    queryKey: ['urgent', days],
    queryFn: () => api.getUrgentFeedback({
      days,
      limit: 10,
    }),
    enabled: config.apiEndpoint.length > 0,
  })

  const handleLogout = useCallback(() => {
    authService.signOut()
    const result = navigate('/login')
    if (result instanceof Promise) {
      result.catch(() => {})
    }
  }, [navigate])

  const toggleSidebar = useCallback(() => setSidebarCollapsed((prev) => !prev), [])
  const showProfile = useCallback(() => setShowProfileModal(true), [])
  const hideProfile = useCallback(() => setShowProfileModal(false), [])

  const urgentCount = urgentData?.count ?? 0

  return (
    <div className="h-screen flex overflow-hidden">
      {mobileMenuOpen ? <div
        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
        onClick={closeMenu}
        aria-hidden="true"
      /> : null}

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
