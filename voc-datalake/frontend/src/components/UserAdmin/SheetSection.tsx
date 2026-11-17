/**
 * @fileoverview One titled section of the People editor sheet: a heading (the sheet's title is its `h2`), an optional
 * hint under it, its controls, and its own failed save said in words (`role="alert"`).
 * @module components/UserAdmin/SheetSection
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

export default function SheetSection({ title, hint, error, children, labelId }: Readonly<{
  title: string
  hint?: string
  /** The section's failed save, already translated; null or absent: none. */
  error?: string | null
  children: ReactNode
  /** The heading's id, when a control inside is named by it (the ways of working radio group). */
  labelId?: string
}>) {
  const ownId = useId()
  const headingId = labelId ?? ownId
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <h3 id={headingId} className="text-sm font-semibold tracking-tight text-text-strong">{title}</h3>
        {hint === undefined ? null : <p className="text-[12px] text-muted mt-0.5">{hint}</p>}
      </div>
      {children}
      {error === null || error === undefined ? null : (
        <p role="alert" className="flex items-center gap-1 text-xs text-danger">
          <AlertCircle size={12} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  )
}
