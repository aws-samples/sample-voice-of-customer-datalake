/**
 * @fileoverview A scroll button beside a strip of tabs that scrolls sideways (`.tab-strip`, components/TabStrip/tabStrip).
 *
 * Both show while the strip overflows, so the strip never moves under the pointer as one comes or goes; the one whose
 * side is not cut is off (`aria-disabled`; its name is also its `title`). The keyboard needs none: a tab in focus is
 * scrolled into view (`tabIndex={-1}`).
 *
 * @module components/TabStrip/StripScrollButton
 */
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function StripScrollButton({ side, label, cut, onPress }: Readonly<{
  side: 'start' | 'end'; label: string; cut: boolean; onPress: () => void
}>) {
  const Icon = side === 'start' ? ChevronLeft : ChevronRight
  return (
    <button title={label} type="button" className="icon-btn shrink-0" aria-label={label} aria-disabled={!cut}
      tabIndex={-1} onClick={() => { if (cut) onPress() }}>
      <Icon size={16} aria-hidden="true" />
    </button>
  )
}
