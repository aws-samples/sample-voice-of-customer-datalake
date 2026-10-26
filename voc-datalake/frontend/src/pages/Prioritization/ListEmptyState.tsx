/**
 * @fileoverview The prioritization list's empty state, per the design system's
 * recipe (icon tile, title, one-line hint). Its own module so `Prioritization.tsx`
 * stays under the repo's `max-lines` ceiling.
 *
 * @module pages/Prioritization/ListEmptyState
 */
import { FileText } from 'lucide-react'
import type { ReactElement } from 'react'

export default function ListEmptyState({
  title, description,
}: {
  readonly title: string
  readonly description: string
}): ReactElement {
  return (
    <div className="card text-center py-12">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-bg-hover flex items-center justify-center">
        <FileText size={20} className="text-muted" aria-hidden="true" />
      </div>
      {/* h2: the list sits directly under the page's h1 (the framework banner is an
          h2 sibling), so an h3 here skipped a level. */}
      <h2 className="text-base font-semibold tracking-tight text-text-strong">{title}</h2>
      <p className="text-sm text-muted mt-1 max-w-md mx-auto">{description}</p>
    </div>
  )
}
