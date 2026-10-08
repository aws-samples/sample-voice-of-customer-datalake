/**
 * @fileoverview Main application layout with sidebar navigation.
 *
 * Features:
 * - Collapsible sidebar with workflow-grouped navigation links
 * - Mobile-responsive hamburger menu
 * - Time range selector in header
 * - Breadcrumb navigation
 * - User menu with logout (when authenticated)
 * - Urgent feedback count badge
 *
 * @module components/Layout
 */

import { useState, useEffect, useRef, useCallback, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation } from 'react-router-dom'
import {
  Home,
  LayoutDashboard,
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
  Brain,
  Compass,
  Workflow,
  Plug,
} from 'lucide-react'
import { getDateRangeParams } from '../../api/client'
import { useBrandName } from '../../hooks/useBrandSettings'
import { useSummaryQuery } from '../../hooks/useSummaryQuery'
import { useConfigStore } from '../../store/configStore'
import { useAuthStore, useIsAdmin } from '../../store/authStore'
import { useSignOut } from '../../hooks/useSignOut'
import TimeRangeSelector from '../TimeRangeSelector/TimeRangeSelector'
import ThemeToggle from '../ThemeToggle/ThemeToggle'
import Breadcrumbs from '../Breadcrumbs/Breadcrumbs'
import AssistantRoot from '../../assistant/components/AssistantRoot'
import { isMenuItemEnabled } from '../../config/menuConfig'
import { useOverlayFocus } from '../../hooks/useOverlayFocus'
import { Sidebar, type NavItem } from './SidebarComponents'

/**
 * Navigation items (todofeatures §6.1, decided 2026-10-04). Home and Dashboard
 * sit at the top with no section header; the rest follow the VoC loop
 * **Listen → Understand → Build → Validate**, then **Knowledge** (shared context
 * everyone reads), **Connect** (external tools) and the admin-only
 * **Administration** (was Settings). What a user configures for themselves —
 * profile, language, their objectives & KPIs — is in Account, in the user menu
 * at the bottom of the rail, not here.
 *
 * The order here drives the sidebar order; `section` groups items under a header
 * rendered by <Sidebar>, which auto-hides when a whole section is filtered out by
 * menu config or admin gating.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: Home, labelKey: 'nav.home', menuKey: 'home' },
  { to: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard', menuKey: 'dashboard' },
  { to: '/scrapers', icon: Globe, labelKey: 'nav.scrapers', menuKey: 'scrapers', section: 'nav.section.listen' },
  { to: '/data-explorer', icon: Database, labelKey: 'nav.dataExplorer', menuKey: 'data-explorer', adminOnly: true, section: 'nav.section.listen' },
  { to: '/categories', icon: FolderOpen, labelKey: 'nav.categories', menuKey: 'categories', section: 'nav.section.understand' },
  { to: '/problems', icon: SearchX, labelKey: 'nav.problemAnalysis', menuKey: 'problems', section: 'nav.section.understand' },
  { to: '/chat', icon: Bot, labelKey: 'nav.aiChat', menuKey: 'chat', section: 'nav.section.build' },
  { to: '/projects', icon: Briefcase, labelKey: 'nav.projects', menuKey: 'projects', section: 'nav.section.build' },
  { to: '/agents', icon: Workflow, labelKey: 'agents:nav.label', menuKey: 'agents', section: 'nav.section.build' },
  { to: '/feedback-forms', icon: FileText, labelKey: 'nav.feedbackForms', menuKey: 'feedback-forms', section: 'nav.section.validate' },
  { to: '/prioritization', icon: ListOrdered, labelKey: 'nav.prioritization', menuKey: 'prioritization', section: 'nav.section.validate' },
  { to: '/company', icon: Compass, labelKey: 'nav.company', menuKey: 'company', section: 'nav.section.knowledge' },
  { to: '/memory', icon: Brain, labelKey: 'nav.memory', menuKey: 'memory', section: 'nav.section.knowledge' },
  { to: '/connect', icon: Plug, labelKey: 'nav.connect', menuKey: 'connect', section: 'nav.section.connect' },
  // menuKey stays `settings` so existing cdk.context.json menuStatus files keep working.
  { to: '/admin', icon: Settings, labelKey: 'nav.admin', menuKey: 'settings', adminOnly: true, section: 'nav.section.admin' },
]

function isNavItemVisible(item: NavItem, isAdmin: boolean): boolean {
  // Check if menu item is enabled in config
  if (!isMenuItemEnabled(item.menuKey)) return false
  // Check admin-only restriction
  if (item.adminOnly === true && !isAdmin) return false
  return true
}

/**
 * Routes whose data is scoped by the global time range. The header picker is
 * shown only there: on Home, Projects, Settings, etc. it changed nothing and
 * read as a broken control.
 */
const TIME_SCOPED_ROUTES = ['/dashboard', '/categories', '/problems', '/chat', '/data-explorer']

function isTimeScoped(pathname: string): boolean {
  return TIME_SCOPED_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

// Main header component. The title is site chrome, not a section heading: the
// page's own <h1> (PageTitle) must be the first heading (design audit D-STRUCT).
function MainHeader({ onOpenMenu, menuButtonRef, showTimeRange }: Readonly<{
  onOpenMenu: () => void
  menuButtonRef: RefObject<HTMLButtonElement | null>
  showTimeRange: boolean
}>) {
  const { t } = useTranslation()
  const title = t('common:header.title')
  return (
    <header className="chrome-glass relative z-10 border-b border-border px-4 sm:px-6 py-3 flex-shrink-0">
      <div className="flex items-center justify-between gap-4 mb-2 sm:mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={onOpenMenu}
            className="icon-btn -ml-2 lg:hidden"
            aria-label={t('common:sidebar.openMenu')}
            title={t('common:sidebar.openMenu')}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <p className="text-base sm:text-lg font-semibold tracking-tight text-text-strong truncate" title={title}>{title}</p>
            <p className="text-xs sm:text-[13px] text-muted mt-0.5 hidden sm:block">{t('common:header.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showTimeRange ? <TimeRangeSelector /> : null}
          <ThemeToggle />
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
  const location = useLocation()
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const { user, isAuthenticated } = useAuthStore()
  const isAdmin = useIsAdmin()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { mobileMenuOpen, openMenu, closeMenu } = useMobileMenu(location.pathname)
  // Mobile drawer keyboard contract: focus moves into it, Escape closes it, Tab
  // leaving it closes it (it covers the page), and focus returns to the menu
  // button (design audit D-NAV).
  const sidebarRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  useOverlayFocus(sidebarRef, mobileMenuOpen, { onClose: closeMenu, returnFocusTo: menuButtonRef, closeOnFocusOut: true })
  // Loaded by the shell for every page (E2E F12: only /admin used to load it,
  // so the subtitle said "Configure brand" until that page had been visited).
  const brand = useBrandName(config.apiEndpoint)

  // Filter nav items based on menu config and user role
  const visibleNavItems = NAV_ITEMS.filter(item => isNavItemVisible(item, isAdmin))

  // Badge count comes from /metrics/summary (exact: it sums the precomputed
  // METRIC#urgent daily aggregates), NOT from /feedback/urgent whose `count`
  // is one page's length and is therefore clamped by `limit`.
  //
  // Shared with Dashboard through useSummaryQuery so both observers provably
  // resolve to one cache entry — see that module for why this is a hook rather
  // than a repeated inline useQuery.
  //
  // COST NOTE: get_summary in metrics_handler.py walks the window day by day
  // three times over (daily_total, daily_sentiment_avg and urgent each get their
  // own sequential get_item loop), so a 90-day window costs ~270 round-trips
  // against ~1 query for the old list call, now on pages that never needed a
  // summary. Request *count* is unchanged (one per staleTime window per
  // dateParams, shared with Dashboard); the single request is heavier.
  // The fix belongs in the handler, which already shows the right shape in its
  // sources/personas/entities blocks: build the date set, then one query
  // filtered in memory. Tracked separately as the per-day fan-out work.
  const { data: summaryData } = useSummaryQuery(dateParams, config.apiEndpoint)

  const handleLogout = useSignOut()

  const toggleSidebar = useCallback(() => setSidebarCollapsed(prev => !prev), [])

  const urgentCount = summaryData?.urgent_count ?? 0

  return (
    <div className="app-ambient h-screen flex overflow-hidden bg-bg text-text">
      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-overlay backdrop-blur-sm z-40 lg:hidden"
          onClick={closeMenu}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <Sidebar
        panelRef={sidebarRef}
        sidebarCollapsed={sidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        brandName={brand.brandName}
        brandLoading={brand.isLoading}
        visibleNavItems={visibleNavItems}
        urgentCount={urgentCount}
        isAuthenticated={isAuthenticated}
        user={user}
        onClose={closeMenu}
        onToggleCollapse={toggleSidebar}
        onLogout={handleLogout}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <MainHeader onOpenMenu={openMenu} menuButtonRef={menuButtonRef} showTimeRange={isTimeScoped(location.pathname)} />
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          <Outlet />
        </div>
      </main>

      <AssistantRoot />
    </div>
  )
}
