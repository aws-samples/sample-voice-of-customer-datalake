/**
 * @fileoverview A page's WAI-ARIA tab row with an icon per tab (agents, agent detail, company,
 * feedback boards, participants): `role="tablist"` in the scrolling `tabs-rail`, one
 * `role="tab"` button per id with `aria-selected`. The page keeps its own tab ids, icons, labels
 * and state; `onWarm` (hover / focus) lets a page prefetch what a tab will show.
 *
 * @module components/IconTabs
 */
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export interface IconTabsProps<T extends string> {
  /** The tabs, in display order. */
  readonly tabs: readonly T[]
  readonly active: T
  readonly icons: Readonly<Record<T, LucideIcon>>
  /** The tablist's accessible name. */
  readonly label: string
  readonly labelOf: (id: T) => ReactNode
  readonly onSelect: (id: T) => void
  /** Called when a tab is hovered or focused (a prefetch); absent = nothing. */
  readonly onWarm?: (id: T) => void
}

export function IconTabs<T extends string>({ tabs, active, icons, label, labelOf, onSelect, onWarm }: IconTabsProps<T>) {
  return (
    <div className="tabs-rail overflow-x-auto">
      <div className="tabs-track" role="tablist" aria-label={label}>
        {tabs.map((id) => {
          const Icon: LucideIcon = icons[id]
          const warm = onWarm === undefined ? undefined : () => onWarm(id)
          return (
            <button key={id} type="button" role="tab" aria-selected={active === id}
              className={clsx('tab', active === id && 'tab-active')} onClick={() => onSelect(id)}
              onMouseEnter={warm} onFocus={warm}>
              <Icon size={14} aria-hidden="true" />
              {labelOf(id)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
