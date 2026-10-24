/**
 * @fileoverview A section whose heading is a disclosure button: a chevron that
 * turns when the section opens, the title, and optional actions on the right.
 *
 * Controlled: the caller owns `open` and hears every toggle through
 * `onOpenChange`, so it can persist a choice (Home's skipped sections) or open
 * the section from elsewhere (the brief header's Settings button). The region
 * stays in the DOM (the button's `aria-controls` target) but its content only
 * mounts while open, so a collapsed section reads nothing.
 *
 * @module components/CollapsibleSection/CollapsibleSection
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  /** Heading text; also the section's accessible name. */
  title: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The section element's id (an anchor such as `#how-it-works`). */
  id?: string
  /** Shown on the heading row, outside the toggle. */
  actions?: ReactNode
  children: ReactNode
}

export default function CollapsibleSection({ title, open, onOpenChange, id, actions, children }: Readonly<Props>) {
  const headingId = useId()
  const regionId = useId()
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-4 rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 id={headingId} className="min-w-0 flex-1 text-lg font-semibold tracking-tight text-text-strong">
          <button type="button" aria-expanded={open} aria-controls={regionId}
            className="flex w-full items-center gap-2 rounded-md text-left focus-ring"
            onClick={() => { onOpenChange(!open) }}>
            <ChevronDown size={18} aria-hidden="true"
              className={clsx('shrink-0 text-muted transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
            <span className="min-w-0">{title}</span>
          </button>
        </h2>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div id={regionId} hidden={!open} className="px-4 pb-4">
        {open && children}
      </div>
    </section>
  )
}
