/**
 * @fileoverview Sidebar sub-components extracted from Layout.
 * @module components/Layout/SidebarComponents
 */

import clsx from 'clsx'
import type { Ref } from 'react'
import {
  PanelLeftClose, PanelLeft, LogOut, X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import KiroGhost from '../KiroGhost/KiroGhost'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  icon: LucideIcon
  labelKey: string
  menuKey: string
  adminOnly?: boolean
  /**
   * Section this item belongs to (todofeatures §6.1: listen → understand →
   * build → validate → knowledge → connect → admin). Items are grouped under a
   * section header in the sidebar so the loop is visible instead of a flat list.
   */
  section?: string
}

/**
 * The sidebar subtitle: the brand, or the "Configure brand" prompt only once the
 * brand is KNOWN to be unset — never as a placeholder that flips to the real
 * name a moment later (E2E F12). A non-breaking space holds the line's height.
 */
function brandSubtitle(brandName: string, brandLoading: boolean, configurePrompt: string): string {
  if (brandName !== '') return brandName
  return brandLoading ? '\u00a0' : configurePrompt
}

// Sidebar header component
function SidebarHeader({
  sidebarCollapsed,
  mobileMenuOpen,
  brandName,
  brandLoading,
  onClose,
  onToggleCollapse,
}: Readonly<{
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  brandName: string
  /** While the brand is being fetched an empty name is not yet "unconfigured". */
  brandLoading: boolean
  onClose: () => void
  onToggleCollapse: () => void
}>) {
  const { t } = useTranslation()
  return (
    <div className={clsx(
      'px-4 pt-4 pb-3 flex items-center gap-2.5 flex-shrink-0',
      sidebarCollapsed ? 'lg:justify-center justify-between lg:px-2' : 'justify-between',
    )}>
      {(!sidebarCollapsed || mobileMenuOpen) ? <div className="flex items-center gap-2.5 min-w-0">
        <KiroGhost className="w-7 h-7 text-accent-text flex-shrink-0" />
        <div className="min-w-0">
          {/* Brand wordmark, not a heading: the page's own <h1> is the only one (D-STRUCT). */}
          <p className="text-[13px] font-bold tracking-[.14em] uppercase text-text-strong truncate">{t('appName')}</p>
          <p className="text-muted text-[12px] mt-0.5 truncate" aria-busy={brandName === '' && brandLoading}>
            {brandSubtitle(brandName, brandLoading, t('configureBrand'))}
          </p>
        </div>
      </div> : null}
      <button
        onClick={onClose}
        className="icon-btn lg:hidden"
        aria-label={t('sidebar.closeMenu')}
      >
        <X size={18} />
      </button>
      <button
        type="button"
        onClick={onToggleCollapse}
        className="icon-btn hidden lg:inline-flex"
        aria-label={sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
        title={sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
      >
        {sidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
      </button>
    </div>
  )
}

// Section header shown above a group of nav items (e.g. "Sources", "Signals").
function SectionHeader({ labelKey, first }: Readonly<{ labelKey: string; first: boolean }>) {
  const { t } = useTranslation()
  return (
    <div className={clsx(
      'px-3 pb-1 text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong',
      first ? 'pt-1' : 'pt-4',
    )}>
      {t(labelKey)}
    </div>
  )
}

// Navigation item component
function NavItemLink({
  item,
  sidebarCollapsed,
  mobileMenuOpen,
  urgentCount,
}: Readonly<{
  item: NavItem
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  urgentCount: number
}>) {
  const { t } = useTranslation()
  const Icon = item.icon
  const showLabel = !sidebarCollapsed || mobileMenuOpen
  const label = t(item.labelKey)

  return (
    <NavLink
      to={item.to}
      title={sidebarCollapsed && !mobileMenuOpen ? label : undefined}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 py-2 rounded-md mb-0.5 text-sm font-medium border border-transparent transition-colors duration-200',
          sidebarCollapsed && !mobileMenuOpen ? 'lg:justify-center lg:px-2 px-3' : 'px-3',
          isActive ? 'nav-active' : 'text-muted hover:text-text hover:bg-bg-hover',
        )
      }
    >
      <Icon size={16} className="flex-shrink-0" />
      {showLabel ? <>
        <span className="truncate">{label}</span>
        {item.to === '/categories' && urgentCount > 0 && (
          <span className="ml-auto bg-danger text-danger-fg font-mono text-[11px] font-semibold px-1.5 py-px rounded-full">
            {urgentCount}
          </span>
        )}
      </> : null}
    </NavLink>
  )
}

// User avatar component
function UserAvatar({
  initial, size,
}: Readonly<{
  initial: string;
  size: 'sm' | 'md'
}>) {
  const sizeClasses = size === 'sm' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm'
  // Opaque card fill, not bg-accent-subtle: the tint over the selected
  // (nav-active) account row put the initial at 4.1:1 (design audit D-CONTRAST).
  return (
    <div className={clsx(sizeClasses, 'rounded-full bg-card text-accent-text ring-1 ring-accent/30 flex items-center justify-center font-bold flex-shrink-0')}>
      {initial}
    </div>
  )
}

function getUserInitial(user?: {
  name?: string
  email?: string
}): string {
  const source = user?.name ?? user?.email
  const initial = source?.charAt(0).toUpperCase()
  return initial != null && initial !== '' ? initial : 'U'
}

// Resolve the best display label for the user
function getUserDisplayName(user: {
  name?: string
  email?: string
  username?: string
}): string {
  if (user.name != null && user.name !== '') return user.name
  if (user.email != null && user.email !== '') return user.email
  return user.username ?? ''
}

/**
 * The user chip (avatar initial + display name) — the one way into the Account
 * page. A link, not a dialog trigger: profile, password, preferences, objectives
 * and sign out all live on /account. The collapsed rail shows the avatar only,
 * so the accessible name always carries the user's name plus "account".
 */
function AccountChip({
  user,
  expanded,
}: Readonly<{
  user: {
    name?: string;
    email?: string;
    username?: string
  }
  expanded: boolean
}>) {
  const { t } = useTranslation()
  const name = getUserDisplayName(user)
  const label = t('sidebar.accountFor', { name })
  return (
    <NavLink
      to="/account"
      aria-label={label}
      title={label}
      className={({ isActive }) => clsx(
        'flex items-center gap-2 mb-2 w-full rounded-md text-sm transition-colors',
        isActive ? 'nav-active' : 'text-text hover:bg-bg-hover',
        expanded ? 'px-2 py-1.5' : 'lg:justify-center py-2 px-2',
      )}
    >
      <UserAvatar initial={getUserInitial(user)} size={expanded ? 'sm' : 'md'} />
      {expanded ? <span className="truncate">{name}</span> : null}
    </NavLink>
  )
}

// User section component
function UserSection({
  user,
  sidebarCollapsed,
  mobileMenuOpen,
  onLogout,
}: Readonly<{
  user: {
    name?: string;
    email?: string;
    username?: string
  }
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  onLogout: () => void
}>) {
  const { t } = useTranslation()
  const showExpanded = !sidebarCollapsed || mobileMenuOpen
  const showCollapsed = sidebarCollapsed && !mobileMenuOpen

  return (
    <div className={clsx('border-t border-border p-3 flex-shrink-0', showCollapsed && 'lg:px-2')}>
      <AccountChip user={user} expanded={showExpanded} />
      <button
        onClick={onLogout}
        title={t('sidebar.signOut')}
        className={clsx(
          'flex items-center gap-2 w-full py-2 rounded-md text-sm text-muted hover:bg-bg-hover hover:text-text transition-colors',
          showCollapsed ? 'lg:justify-center lg:px-2 px-3' : 'px-3',
        )}
      >
        <LogOut size={16} />
        {showExpanded ? <span>{t('sidebar.signOut')}</span> : null}
      </button>
    </div>
  )
}

// Full sidebar component
export function Sidebar({
  panelRef,
  sidebarCollapsed,
  mobileMenuOpen,
  brandName,
  brandLoading,
  visibleNavItems,
  urgentCount,
  isAuthenticated,
  user,
  onClose,
  onToggleCollapse,
  onLogout,
}: Readonly<{
  /** The drawer element (mobile focus management in Layout). */
  panelRef?: Ref<HTMLElement>
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  brandName: string
  brandLoading: boolean
  visibleNavItems: NavItem[]
  urgentCount: number
  isAuthenticated: boolean
  user: {
    name?: string;
    email?: string;
    username?: string
  } | null
  onClose: () => void
  onToggleCollapse: () => void
  onLogout: () => void
}>) {
  const { t } = useTranslation()
  return (
    <aside
      ref={panelRef}
      // Named: pages render their own <aside>s (the workflow editor has two), and
      // unnamed complementary landmarks side by side fail axe landmark-unique (E2E F9).
      aria-label={t('common:sidebar.label')}
      className={clsx(
        'bg-panel text-text border-r border-border flex flex-col flex-shrink-0 h-screen transition-all duration-150 z-50',
        'fixed lg:relative',
        // Closed on a phone it is off-canvas: `invisible` takes it out of the Tab
        // order and the accessibility tree, so focus never lands on links nobody
        // can see (design audit D-NAV; visibility is transitioned, so the slide-out
        // still plays).
        mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0 max-lg:invisible',
        sidebarCollapsed ? 'lg:w-[74px] w-[236px]' : 'w-[236px]',
      )}
    >
      <SidebarHeader
        sidebarCollapsed={sidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        brandName={brandName}
        brandLoading={brandLoading}
        onClose={onClose}
        onToggleCollapse={onToggleCollapse}
      />

      <nav className={clsx('flex-1 overflow-y-auto', sidebarCollapsed && !mobileMenuOpen ? 'lg:px-2 px-3' : 'px-3')}>
        {visibleNavItems.map((item, i) => {
          const showLabels = !sidebarCollapsed || mobileMenuOpen
          // Render a section header when this item starts a new section.
          const prevSection = i > 0 ? visibleNavItems[i - 1]?.section : undefined
          const isNewSection = item.section && item.section !== prevSection
          return (
            <div key={item.to}>
              {isNewSection && showLabels ? (
                <SectionHeader labelKey={item.section ?? ''} first={i === 0} />
              ) : null}
              {isNewSection && !showLabels && i > 0 ? (
                <div className="border-t border-border my-2" aria-hidden />
              ) : null}
              <NavItemLink
                item={item}
                sidebarCollapsed={sidebarCollapsed}
                mobileMenuOpen={mobileMenuOpen}
                urgentCount={urgentCount}
              />
            </div>
          )
        })}
      </nav>

      {isAuthenticated && user ? <UserSection
        user={user}
        sidebarCollapsed={sidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        onLogout={onLogout}
      /> : null}
    </aside>
  )
}
