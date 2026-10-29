/**
 * @fileoverview Sidebar sub-components extracted from Layout.
 * @module components/Layout/SidebarComponents
 */

import clsx from 'clsx'
import type { Ref } from 'react'
import {
  PanelLeftClose, PanelLeft, X,
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
   * Section this item belongs to (listen → understand →
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
          <p className="text-[0.8125rem] font-bold tracking-[.14em] uppercase text-text-strong break-words">{t('appName')}</p>
          <p className="text-muted text-[0.75rem] mt-0.5 break-words" aria-busy={brandName === '' && brandLoading}>
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
      'px-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-[.08em] text-muted-strong',
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
  decisionCount = 0,
}: Readonly<{
  item: NavItem
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  urgentCount: number
  /** Agents whose last run needs a person (count on "Autonomous agents"). */
  decisionCount?: number
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
        {/* Wraps instead of truncating (WCAG 1.4.4): "Autonomous agents" beside its
            count, and every label in de/fr/pt or at 200 % text size, were cut. */}
        <span className="min-w-0 flex-1 break-words">{label}</span>
        {item.to === '/categories' && <NavCount count={urgentCount} tone="danger" />}
        {item.to === '/agents' && (
          <NavCount count={decisionCount} tone="warn" label={t('agents:nav.needsDecision', { count: decisionCount })} />
        )}
      </> : null}
    </NavLink>
  )
}

const NAV_COUNT_TONE = { danger: 'bg-danger text-danger-fg', warn: 'bg-warn text-warn-fg' } as const

/** A count pill at the end of a nav row (nothing at zero); `label` names it for screen readers. */
function NavCount({ count, tone, label }: Readonly<{ count: number; tone: keyof typeof NAV_COUNT_TONE; label?: string }>) {
  if (count <= 0) return null
  return (
    <span className={clsx('ml-auto flex-shrink-0 font-mono text-[0.6875rem] font-semibold px-1.5 py-px rounded-full', NAV_COUNT_TONE[tone])} title={label}>
      {count}
      {label !== undefined && <span className="sr-only"> {label}</span>}
    </span>
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
  decisionCount = 0,
  onClose,
  onToggleCollapse,
}: Readonly<{
  /** The drawer element (mobile focus management in Layout). */
  panelRef?: Ref<HTMLElement>
  sidebarCollapsed: boolean
  mobileMenuOpen: boolean
  brandName: string
  brandLoading: boolean
  visibleNavItems: NavItem[]
  urgentCount: number
  decisionCount?: number
  onClose: () => void
  onToggleCollapse: () => void
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
        // rem, not px: the rail grows with the text size, so labels at 200 % still fit (WCAG 1.4.4).
        sidebarCollapsed ? 'lg:w-[74px] w-[14.75rem]' : 'w-[14.75rem]',
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

      <nav aria-label={t('common:sidebar.mainNav')} className={clsx('flex-1 overflow-y-auto', sidebarCollapsed && !mobileMenuOpen ? 'lg:px-2 px-3' : 'px-3')}>
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
                decisionCount={decisionCount}
              />
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
