/**
 * @fileoverview The section switch under the Administration tab bar: a
 * WAI-ARIA tabs row (role="tablist", automatic activation) on the
 * design-system tabs track. Arrow keys move to the previous / next section
 * (wrapping), Home / End to the first / last; only the selected tab is in the
 * tab order. Not rendered for fewer than two sections.
 * @module pages/Settings/SectionSwitch
 */
import clsx from 'clsx'
import type { KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { SECTION_PANEL_ID, sectionTabId } from './adminTabLabels'

export interface SectionItem<T extends string> {
  readonly id: T
  readonly label: string
  readonly icon: LucideIcon
}

const STEP: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }

/** The index a key moves to from `current` among `count` tabs, or null for any other key. */
function nextSectionIndex(key: string, current: number, count: number): number | null {
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const step = STEP[key]
  return step === undefined ? null : (current + step + count) % count
}

export function SectionSwitch<T extends string>({ sections, active, onSelect, label }: Readonly<{
  sections: readonly SectionItem<T>[]
  active: T
  onSelect: (id: T) => void
  /** The accessible name of the tablist (the open tab's label). */
  label: string
}>) {
  if (sections.length < 2) return null
  const current = Math.max(0, sections.findIndex((section) => section.id === active))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSectionIndex(event.key, current, sections.length)
    const target = next === null ? undefined : sections[next]
    if (target === undefined) return
    event.preventDefault()
    onSelect(target.id)
    event.currentTarget.querySelector<HTMLButtonElement>(`#${sectionTabId(target.id)}`)?.focus()
  }

  return (
    // Wraps instead of scrolling (live finding: at 390 px the strip clipped "Radar"
    // with no sign there was more): at most four short sections, so two rows read fine.
    <div className="tabs-track mb-4 flex-wrap" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {sections.map((section) => {
        const selected = section.id === active
        return (
          <button
            key={section.id}
            id={sectionTabId(section.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={SECTION_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(section.id)}
            className={clsx('tab', selected && 'tab-active')}
          >
            <section.icon size={14} aria-hidden="true" />
            {section.label}
          </button>
        )
      })}
    </div>
  )
}
