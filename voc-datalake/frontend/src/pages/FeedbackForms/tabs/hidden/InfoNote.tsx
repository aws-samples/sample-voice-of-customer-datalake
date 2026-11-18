/**
 * @fileoverview An informational note inside a builder tab (an `info` state, R15): an icon, the words and at most one
 * action. The shared `Notice` banner has only the warn and danger tones.
 *
 * @module pages/FeedbackForms/tabs/hidden/InfoNote
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export default function InfoNote({ icon: Icon, children, action }: Readonly<{
  icon: LucideIcon
  children: ReactNode
  action?: { readonly label: string; readonly onClick: () => void }
}>) {
  return (
    <div role="note" className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info-subtle p-3 text-sm text-text sm:flex-row sm:items-center">
      <span className="flex flex-1 items-start gap-2">
        <Icon size={16} className="mt-0.5 shrink-0 text-info" aria-hidden="true" />
        <span>{children}</span>
      </span>
      {action !== undefined && (
        <button type="button" className="btn btn-secondary btn-sm self-start sm:self-auto" onClick={action.onClick}>{action.label}</button>
      )}
    </div>
  )
}
