/**
 * @fileoverview A section whose heading is a disclosure button: a chevron that
 * turns when the section opens, and the title.
 *
 * Controlled: the caller owns `open` and hears every toggle through
 * `onOpenChange`, so it can persist a choice (Home's skipped sections) or open
 * the section from elsewhere (the brief header's Settings button). The region
 * stays in the DOM (the button's `aria-controls` target) but its content only
 * mounts while open, so a collapsed section reads nothing.
 *
 * `size="sm"` is the compact one for a section inside an editor (the forms builder's Logic and Advanced): a 14 px
 * title and tighter padding, so it never outranks the editor's own heading or reads bigger than its field labels.
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
  /** `md` (default): a page section, 18 px title; `sm`: a section inside an editor, 14 px title. */
  size?: 'md' | 'sm'
  children: ReactNode
}

const SIZES = {
  md: { header: 'px-4 py-3', title: 'text-lg', chevron: 18, body: 'px-4 pb-4' },
  sm: { header: 'px-3 py-2', title: 'text-sm', chevron: 16, body: 'px-3 pb-3' },
} as const

export default function CollapsibleSection({ title, open, onOpenChange, size = 'md', children }: Readonly<Props>) {
  const headingId = useId()
  const regionId = useId()
  const look = SIZES[size]
  return (
    <section aria-labelledby={headingId} className="scroll-mt-4 rounded-xl border border-border bg-card">
      <div className={clsx('flex items-center justify-between gap-3', look.header)}>
        <h2 id={headingId} className={clsx('min-w-0 flex-1 font-semibold tracking-tight text-text-strong', look.title)}>
          <button type="button" aria-expanded={open} aria-controls={regionId}
            className="flex w-full items-center gap-2 rounded-md text-left focus-ring"
            onClick={() => { onOpenChange(!open) }}>
            <ChevronDown size={look.chevron} aria-hidden="true"
              className={clsx('shrink-0 text-muted transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
            <span className="min-w-0">{title}</span>
          </button>
        </h2>
      </div>
      <div id={regionId} hidden={!open} className={look.body}>
        {open && children}
      </div>
    </section>
  )
}
