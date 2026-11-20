/**
 * @fileoverview The section switch under the Administration tab row (main's, 7.59.00 again): a WAI-ARIA tabs row
 * (IconTabs with its `panel`: automatic activation) on the design-system tabs track, without the tab row's rail.
 * Arrow keys move to the previous / next section (wrapping), Home / End to the first / last; only the selected tab is
 * in the tab order. It wraps onto a
 * second row instead of scrolling (live finding: at 390 px the strip clipped "Radar" with no sign there was more; at
 * most four short sections, so two rows read fine). Not rendered for fewer than two sections.
 * @module pages/Settings/SectionSwitch
 */
import type { LucideIcon } from 'lucide-react'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import { SECTION_PANEL_ID } from './adminTabLabels'

export function SectionSwitch<T extends string>({ sections, icons, labelOf, active, onSelect, label, tabId }: Readonly<{
  /** The sections, in order. */
  sections: readonly T[]
  icons: Readonly<Record<T, LucideIcon>>
  labelOf: (id: T) => string
  active: T
  onSelect: (id: T) => void
  /** The accessible name of the tablist (the open tab's label). */
  label: string
  /** A section's tab's element id (its panel is labelled by it). */
  tabId: (id: T) => string
}>) {
  if (sections.length < 2) return null
  return (
    <div className="mb-4 sm:mb-6">
      <IconTabs tabs={sections} active={active} icons={icons} label={label} labelOf={labelOf} onSelect={onSelect} wrap
        rail={false} panel={{ id: SECTION_PANEL_ID, tabId }} />
    </div>
  )
}
