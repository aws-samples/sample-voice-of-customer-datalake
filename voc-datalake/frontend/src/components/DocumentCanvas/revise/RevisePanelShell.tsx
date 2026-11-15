/**
 * @fileoverview The frame of each outcome of "Revise from comments" above the canvas (recommendations, the proposed
 * changes, the applied version): a labelled region whose heading takes the focus when it opens (the button is in the
 * rail, after the text), a polite status line, its actions, and Close.
 *
 * @module components/DocumentCanvas/revise/RevisePanelShell
 */
import { Sparkles, X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

interface RevisePanelShellProps {
  readonly title: string
  /** Read out as it changes (aria-live polite). */
  readonly status: ReactNode
  readonly actions?: ReactNode
  readonly onClose: () => void
  readonly children?: ReactNode
  readonly testId: string
}

export default function RevisePanelShell({ title, status, actions, onClose, children, testId }: RevisePanelShellProps) {
  const { t } = useTranslation('projectDetail')
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return (
    <section aria-labelledby={headingId} data-testid={testId}
      className="mb-4 space-y-3 rounded-lg border border-accent/30 bg-bg-accent p-3 min-w-0">
      {/* Close keeps the top right corner; the icon and the title share a line that takes the room left, and the
          actions wrap under them on a phone (never the icon, the title and Close each on a line of their own). */}
      <div data-testid="revise-panel-header" className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 basis-48 items-start gap-2">
            <Sparkles size={16} className="mt-0.5 text-accent shrink-0" aria-hidden />
            <h3 id={headingId} ref={heading} tabIndex={-1}
              className="min-w-0 break-words text-sm font-medium text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {title}
            </h3>
          </div>
          {actions}
        </div>
        <button type="button" className="icon-btn p-1 shrink-0" onClick={onClose} aria-label={t('canvas.revise.close')} title={t('canvas.revise.close')}>
          <X size={14} aria-hidden />
        </button>
      </div>
      <p role="status" className="text-[13px] text-text">{status}</p>
      {children}
    </section>
  )
}
