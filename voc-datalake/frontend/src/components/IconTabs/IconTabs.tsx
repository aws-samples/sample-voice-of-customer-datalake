/**
 * @fileoverview A page's WAI-ARIA tab row with an icon per tab (agents, agent detail, company,
 * feedback boards, participants): `role="tablist"` in the scrolling `tabs-rail`, one
 * `role="tab"` button per id with `aria-selected`. The page keeps its own tab ids, icons, labels
 * and state; `onWarm` (hover / focus) lets a page prefetch what a tab will show.
 *
 * @module components/IconTabs
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { StripScrollButton } from '../TabStrip/StripScrollButton'
import { revealInStrip, scrollStrip, useStripCut } from '../TabStrip/tabStrip'

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
  /** (7.04.00) The tabs scroll as a `.tab-strip` that shows it does (the form builder's eight tabs on a phone): the
   * cut side fades, the two scroll buttons named here show while it overflows, and the active tab is brought into
   * view clear of the fade. Absent: the plain scrolling rail. */
  readonly scrollLabels?: { readonly start: string; readonly end: string }
}

/** The tabs' rail as a `.tab-strip`: a fade on the cut side and scroll buttons while it overflows. */
function ScrollingRail({ active, labels, children }: Readonly<{
  active: string; labels: NonNullable<IconTabsProps<string>['scrollLabels']>; children: ReactNode
}>) {
  const [strip, setStrip] = useState<HTMLDivElement | null>(null)
  const cut = useStripCut(strip)
  const overflowing = cut.start || cut.end
  // (the active tab in view: one opened from the address may be past the cut)
  useEffect(() => {
    revealInStrip(strip, strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? undefined)
  }, [active, strip])
  return (
    <div className="tabs-rail flex min-w-0 items-center gap-1">
      {overflowing && <StripScrollButton side="start" label={labels.start} cut={cut.start} onPress={() => scrollStrip(strip, -1)} />}
      <div ref={setStrip} data-cut-start={cut.start} data-cut-end={cut.end} className="tab-strip min-w-0 flex-1">
        {children}
      </div>
      {overflowing && <StripScrollButton side="end" label={labels.end} cut={cut.end} onPress={() => scrollStrip(strip, 1)} />}
    </div>
  )
}

export function IconTabs<T extends string>({ tabs, active, icons, label, labelOf, onSelect, onWarm, scrollLabels }: IconTabsProps<T>) {
  const list = (
    <div className={clsx('tabs-track', scrollLabels !== undefined && 'w-max max-w-none overflow-visible')}
      role="tablist" aria-label={label}>
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
  )
  if (scrollLabels !== undefined) return <ScrollingRail active={active} labels={scrollLabels}>{list}</ScrollingRail>
  return <div className="tabs-rail overflow-x-auto">{list}</div>
}
