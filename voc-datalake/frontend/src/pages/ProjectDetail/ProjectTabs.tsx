/**
 * ProjectTabs - Tab navigation for project detail page
 *
 * ARIA tabs (`tablist` / `tab` + `aria-selected`, the FeedbackForms precedent)
 * rather than a `<nav>`: these switch views inside one page, and a second
 * unlabelled navigation landmark next to the sidebar's tripped axe's
 * landmark-unique. Arrow keys / Home / End move between tabs (roving tabindex).
 *
 * ONE tab bar that WRAPS (the Settings section-switch precedent): at 390 px the six
 * tabs take two rows. It used to scroll sideways with a hidden scrollbar and an edge
 * fade, which a mouse or trackpad without horizontal scrolling could not reach. A
 * wrapped bar shows every tab to every input with no scrolling at all.
 */
import clsx from 'clsx'
import {
  Users, FileText, Sparkles, Package, Scale, Contact,
} from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Tab } from './types'

const TABS: readonly {
  id: Tab;
  labelKey: string;
  icon: typeof Sparkles
}[] = [
  {
    id: 'overview',
    labelKey: 'tabs.overview',
    icon: Sparkles,
  },
  {
    id: 'personas',
    labelKey: 'tabs.personas',
    icon: Users,
  },
  {
    id: 'product',
    labelKey: 'tabs.product',
    icon: Package,
  },
  {
    id: 'documents',
    labelKey: 'tabs.documents',
    icon: FileText,
  },
  {
    id: 'decisions',
    labelKey: 'decisions:tab',
    icon: Scale,
  },
  {
    id: 'participants',
    labelKey: 'participants:projectTab',
    icon: Contact,
  },
]

interface ProjectTabsProps {
  readonly activeTab: Tab
  readonly personasCount: number
  readonly documentsCount: number
  readonly onTabChange: (tab: Tab) => void
}

/** Index of the tab a navigation key moves to, or null for any other key. */
function targetIndex(key: string, current: number): number | null {
  const last = TABS.length - 1
  if (key === 'ArrowRight') return current === last ? 0 : current + 1
  if (key === 'ArrowLeft') return current === 0 ? last : current - 1
  if (key === 'Home') return 0
  if (key === 'End') return last
  return null
}

export default function ProjectTabs({
  activeTab, personasCount, documentsCount, onTabChange,
}: ProjectTabsProps) {
  const { t } = useTranslation(['projectDetail', 'decisions', 'participants'])
  const trackRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = targetIndex(e.key, index)
    if (next == null) return
    const tab = TABS.at(next)
    if (tab === undefined) return
    e.preventDefault()
    onTabChange(tab.id)
    trackRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="tabs-rail">
      <div ref={trackRef} className="tabs-track flex-wrap" role="tablist" aria-label={t('tabs.label')}>
        {TABS.map((tab, index) => {
          const selected = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={clsx('tab min-h-9 sm:min-h-0', selected && 'tab-active')}
            >
              <tab.icon size={14} aria-hidden />
              {t(tab.labelKey)}
              {tab.id === 'personas' && <span className="font-mono">({personasCount})</span>}
              {tab.id === 'documents' && <span className="font-mono">({documentsCount})</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
