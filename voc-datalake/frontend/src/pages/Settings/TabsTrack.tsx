/**
 * @fileoverview A row of icon + label tab buttons on the design-system tabs
 * track; the selected tab is announced with `aria-pressed`.
 * @module pages/Settings/TabsTrack
 */

import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'

interface TabItem<T extends string> {
  readonly id: T
  readonly label: string
  readonly icon: LucideIcon
}

export function TabsTrack<T extends string>({
  tabs, active, onSelect, className,
}: Readonly<{
  tabs: readonly TabItem<T>[]
  active: T
  onSelect: (id: T) => void
  className?: string
}>) {
  return (
    <div className={clsx('tabs-track', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={clsx('tab', active === tab.id && 'tab-active')}
        >
          <tab.icon size={14} />
          {tab.label}
        </button>
      ))}
    </div>
  )
}
