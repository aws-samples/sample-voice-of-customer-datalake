/**
 * @fileoverview A page's primary-action row (Save / Discard / Submit …), pinned
 * to the bottom of the scrolling content and registered as a `lift` keep-clear
 * zone (actionBarRegistry), so the floating assistant launcher lifts above it instead of covering
 * Save (E2E F5; 3.00.00 R3). EVERY page or editor whose primary save / submit
 * row ends a form uses it — `actionBars.audit.test.ts` fails on one that does
 * not; dialogs do not need it (ModalShell already paints over the launcher).
 *
 * Variants:
 * - `bar` (default): the floating save bar of an editor page (border, shadow).
 * - `inline`: a form's own button row inside a card — sticky and registered
 *   the same way, but only a background so it reads as part of the card; the
 *   caller's `className` gives the row its layout.
 * - `footer` (7.59.00, Administration's and the workspace settings' cards): the
 *   card's own button row in the flow AFTER its fields, registered the same way
 *   but never sticky, so no field of a card taller than the screen scrolls under
 *   it (the brand card's URLs did); the caller's `className` gives its layout.
 *
 * @module components/StickyActionBar/StickyActionBar
 */
import { useRef } from 'react'
import clsx from 'clsx'
import { useRegisterActionBar } from './actionBarRegistry'
import type { ReactNode } from 'react'

interface StickyActionBarProps {
  readonly children: ReactNode
  readonly className?: string
  readonly variant?: 'bar' | 'inline' | 'footer'
}

// An opaque card, never a backdrop blur: a backdrop filter makes the bar the containing block of every `fixed`
// descendant, so a confirmation its buttons open (ConfirmModal, which is not portalled) rendered inside the bar's
// box instead of over the page (7.55.01: the form builder's Update live form on a phone).
const VARIANT_CLASSES: Readonly<Record<NonNullable<StickyActionBarProps['variant']>, string>> = {
  bar: 'sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm',
  inline: 'sticky bottom-0 z-10 bg-card',
  footer: '',
}

export default function StickyActionBar({ children, className, variant = 'bar' }: StickyActionBarProps) {
  const ref = useRef<HTMLDivElement>(null)
  useRegisterActionBar(ref)
  return (
    <div ref={ref} data-action-bar="" className={clsx(VARIANT_CLASSES[variant], className)}>
      {children}
    </div>
  )
}
