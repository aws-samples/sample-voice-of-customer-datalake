/**
 * @fileoverview The minimal page shell of the pages OUTSIDE the app's protected layout (`/board`,
 * `/review/:shareId`): a title bar with the signed-in email and a sign-out button, then the page.
 *
 * @module components/StandaloneShell
 */
import { LogOut } from 'lucide-react'
import type { ReactNode } from 'react'

/** Content widths (literal classes, so Tailwind keeps them). */
const WIDTH = { default: 'max-w-5xl', wide: 'max-w-6xl' } as const

interface StandaloneShellProps {
  readonly title: string
  /** The signed-in email; null hides the email and the sign-out button. */
  readonly email: string | null
  readonly signOutLabel: string
  readonly onSignOut?: () => void
  readonly width?: keyof typeof WIDTH
  readonly children: ReactNode
}

export default function StandaloneShell({
  title, email, signOutLabel, onSignOut, width = 'default', children,
}: Readonly<StandaloneShellProps>) {
  const widthClass = WIDTH[width]
  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-border bg-panel">
        <div className={`${widthClass} mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3`}>
          <p className="font-semibold text-text-strong break-words">{title}</p>
          {email === null ? null : (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
              <span className="break-all">{email}</span>
              {onSignOut ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
                  <LogOut size={14} aria-hidden="true" />{signOutLabel}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </header>
      <main className={`${widthClass} mx-auto px-4 py-6`}>{children}</main>
    </div>
  )
}
