/**
 * @fileoverview A section's card on its tab's page (7.54.00): the target a path naming the section
 * (`/admin/<tab>/<section>`, a search result) scrolls into view and focuses, so a keyboard
 * or screen reader user lands on it, not at the top of the page (useAdminLocation.ts `useSectionFocus`).
 * @module pages/Settings/SectionAnchor
 */
import type { ReactNode } from 'react'
import type { AdminSectionId } from './adminTabs'
import { sectionAnchorId } from './adminTabLabels'

export function SectionAnchor({ section, children }: Readonly<{ section: AdminSectionId; children: ReactNode }>) {
  // tabIndex -1: focusable by script only, never a tab stop of its own.
  return <div id={sectionAnchorId(section)} tabIndex={-1} className="scroll-mt-4 rounded-xl focus:outline-none">{children}</div>
}
