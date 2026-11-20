/**
 * @fileoverview A card a link may name (7.59.00, `#<card>`: `/admin/general#theme`, a search result): the target the
 * page scrolls into view and focuses, so a keyboard or screen reader user lands on it, not at the top of the page
 * (useAdminLocation.ts `useCardFocus`).
 * @module pages/Settings/CardAnchor
 */
import type { ReactNode } from 'react'
import type { AdminCardId } from './adminTabs'
import { cardAnchorId } from './adminTabLabels'

export function CardAnchor({ card, children }: Readonly<{ card: AdminCardId; children: ReactNode }>) {
  // tabIndex -1: focusable by script only, never a tab stop of its own.
  return <div id={cardAnchorId(card)} tabIndex={-1} className="scroll-mt-4 rounded-xl focus:outline-none">{children}</div>
}
