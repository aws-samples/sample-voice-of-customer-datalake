/**
 * @fileoverview Sidebar sub-components extracted from Layout.
 * @module components/Layout/SidebarComponents
 */

import clsx from 'clsx'
import {
  PanelLeftClose, PanelLeft, LogOut, X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  icon: LucideIcon
  labelKey: string
  menuKey: string
  adminOnly?: boolean
}

// Sidebar header component
export function SidebarHeader({
  sidebarCollapsed,
  mobileMenuOpen,
  brandName,
  onClose,
  onToggleCollapse,
}: Readonly<{
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  brandName: string
  onClose: () => void
  onToggleCollapse: () => void
}>) {
  const { t } = useTranslation()
  return (
    <div className={clsx(
      'p-4 flex items-center flex-shrink-0',
      sidebarCollapsed ? 'lg:justify-center justify-between' : 'justify-between',
    )}>
      {(!sidebarCollapsed || mobileMenuOpen) ? <div>
        <h1 className="text-lg font-bold">{t('appName')}</h1>
        <p className="text-gray-400 text-xs mt-0.5">{brandName === '' ? t('configureBrand') : brandName}</p>
      </div> : null}
      <button
        onClick={onClose}
        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors lg:hidden"
        aria-label={t('sidebar.closeMenu')}
      >
        <X size={20} />
      </button>
      <button
        onClick={onToggleCollapse}
        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors hidden lg:block"
        title={sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
      >
        {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
      </button>
    </div>
  )
}

// Navigation item component
export function NavItemLink({
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
          'flex items-center gap-3 py-2.5 rounded-lg mb-1 transition-colors',
          sidebarCollapsed && !mobileMenuOpen ? 'lg:justify-center lg:px-2 px-4' : 'px-4',
          isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800',
        )
      }
    >
      <Icon size={20} className="flex-shrink-0" />
      {showLabel ? <>
        <span>{label}</span>
        {item.to === '/feedback' && urgentCount > 0 && (
          <span className="ml-auto bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
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
  return (
    <div className={clsx(sizeClasses, 'rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold flex-shrink-0')}>
      {initial}
    </div>
  )
}

function getUserInitial(email?: string): string {
  const initial = email?.charAt(0).toUpperCase()
  return initial != null && initial !== '' ? initial : 'U'
}

// Profile button - renders expanded or collapsed variant
function ProfileButton({
  user,
  userInitial,
  expanded,
  onShowProfile,
}: Readonly<{
  user: {
    email?: string;
    username?: string
  }
  userInitial: string
  expanded: boolean
  onShowProfile: () => void
}>) {
  if (expanded) {
    return (
      <button
        onClick={onShowProfile}
        className="flex items-center gap-2 mb-3 text-sm w-full text-left hover:bg-gray-800 rounded-lg px-2 py-1.5 -mx-2 transition-colors"
        title="View profile"
      >
        <UserAvatar initial={userInitial} size="sm" />
        <span className="text-gray-300 truncate">{user.email != null && user.email !== '' || user.username}</span>
      </button>
    )
  }
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
export function UserSection({
  user,
  sidebarCollapsed,
  mobileMenuOpen,
  onShowProfile,
  onLogout,
}: Readonly<{
  user: {
    email?: string;
    username?: string
  }
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  onShowProfile: () => void
  onLogout: () => void
}>) {
  const { t } = useTranslation()
  const showExpanded = !sidebarCollapsed || mobileMenuOpen
  const showCollapsed = sidebarCollapsed && !mobileMenuOpen
  const userInitial = getUserInitial(user.email)

  return (
    <div className={clsx('border-t border-gray-700 p-4 flex-shrink-0', showCollapsed && 'lg:px-2')}>
      <ProfileButton
        user={user}
        userInitial={userInitial}
        expanded={showExpanded}
        onShowProfile={onShowProfile}
      />
      <button
        onClick={onLogout}
        title={t('sidebar.signOut')}
        className={clsx(
          'flex items-center gap-2 w-full py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white transition-colors',
          showCollapsed ? 'lg:justify-center lg:px-2 px-4' : 'px-4',
        )}
      >
        <LogOut size={18} />
        {showExpanded ? <span>{t('sidebar.signOut')}</span> : null}
      </button>
    </div>
  )
}

// Full sidebar component
export function Sidebar({
  sidebarCollapsed,
  mobileMenuOpen,
  brandName,
  visibleNavItems,
  urgentCount,
  isAuthenticated,
  user,
  onClose,
  onToggleCollapse,
  onShowProfile,
  onLogout,
}: Readonly<{
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  brandName: string
  visibleNavItems: NavItem[]
  urgentCount: number
  isAuthenticated: boolean
  user: {
    email?: string;
    username?: string
  } | null
  onClose: () => void
  onToggleCollapse: () => void
  onShowProfile: () => void
  onLogout: () => void
}>) {
  return (
    <aside
      className={clsx(
        'bg-gray-900 text-white flex flex-col flex-shrink-0 h-screen transition-all duration-200 z-50',
        'fixed lg:relative',
        mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        sidebarCollapsed ? 'lg:w-16' : 'w-64',
      )}
    >
      <SidebarHeader
        sidebarCollapsed={sidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        brandName={brandName}
        onClose={onClose}
        onToggleCollapse={onToggleCollapse}
      />

      <nav className={clsx('flex-1 overflow-y-auto', sidebarCollapsed && !mobileMenuOpen ? 'lg:px-2 px-4' : 'px-4')}>
        {visibleNavItems.map((item) => (
          <NavItemLink
            key={item.to}
            item={item}
            sidebarCollapsed={sidebarCollapsed}
            mobileMenuOpen={mobileMenuOpen}
            urgentCount={urgentCount}
          />
        ))}
      </nav>

      {isAuthenticated && user ? <UserSection
        user={user}
        sidebarCollapsed={sidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        onShowProfile={onShowProfile}
        onLogout={onLogout}
      /> : null}
    </aside>
  )
}
