/**
 * The empty state of a persona list (a project's, or the company library's, 5.60):
 * an icon tile, a title, what goes here, and an optional action or hint below.
 */
import clsx from 'clsx'
import { Users } from 'lucide-react'
import type { ReactNode } from 'react'

interface PersonasEmptyCardProps {
  readonly title: string
  readonly body: string
  /** A call to action or a hint; absent = the card ends with the body. */
  readonly children?: ReactNode
}

export default function PersonasEmptyCard({ title, body, children }: PersonasEmptyCardProps) {
  return (
    <div className="card text-center py-12 sm:py-16">
      <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-accent-subtle flex items-center justify-center">
        <Users size={20} className="text-accent-text" aria-hidden />
      </div>
      <h2 className="text-base font-semibold tracking-tight text-text-strong mb-1">{title}</h2>
      <p className={clsx('text-sm text-muted max-w-prose mx-auto', children != null && 'mb-5')}>{body}</p>
      {children}
    </div>
  )
}
