/**
 * @fileoverview The one card shell of the Product tab: the form's sections, the
 * internal documents and the report all use it, so the tab has a single card look
 * (the `card` recipe, an icon + title + optional description header, an optional
 * aside on the right that wraps under the title on a narrow screen).
 *
 * @module pages/ProjectDetail/ProductCard
 */
import { useId } from 'react'
import type { ClipboardEventHandler, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export default function ProductCard({
  icon: Icon, title, description, aside, onPaste, children,
}: Readonly<{
  icon: LucideIcon
  title: string
  description?: string
  aside?: ReactNode
  /** The documents card takes pasted screenshots; only events inside the card reach it. */
  onPaste?: ClipboardEventHandler<HTMLElement>
  children: ReactNode
}>) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="card p-4 sm:p-5 min-w-0 space-y-4" onPaste={onPaste}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold tracking-tight text-text-strong">
            <Icon size={16} className="flex-shrink-0 text-accent" aria-hidden="true" />
            {title}
          </h3>
          {description !== undefined && <p className="text-[12px] text-muted">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}
