/**
 * @fileoverview "Dismissed: <card>" with an Undo button, after a brief card is
 * dismissed. The live region (`role="status"`) is always mounted so the message
 * is announced when it appears. It closes itself after `UNDO_TIMEOUT_MS`, but the
 * clock stops while the pointer or keyboard focus is on it (WCAG 2.2.1: enough
 * time), and Escape closes it.
 *
 * @module pages/Home/brief/UndoNotice
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Undo2, X } from 'lucide-react'
import { noCleanup } from '../../../hooks/noCleanup'

export const UNDO_TIMEOUT_MS = 8000

export interface UndoTarget {
  /** Changes on every dismissal, so a second one starts a fresh notice and clock. */
  readonly key: string
  readonly title: string
}

interface NoticeActions {
  readonly onUndo: () => void
  readonly onClose: () => void
}

/** One dismissal's notice: its own clock, held while hovered or focused. */
function UndoCard({ title, onUndo, onClose }: Readonly<{ title: string } & NoticeActions>) {
  const { t } = useTranslation('briefing')
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return noCleanup
    const timer = window.setTimeout(onClose, UNDO_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [held, onClose])
  return (
    <div
      className="card flex items-center gap-3 px-4 py-2 shadow-lg"
      onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
    >
      <span className="text-sm text-text min-w-0 break-words">{t('cards.dismissed', { title })}</span>
      <button type="button" className="btn btn-secondary btn-sm flex items-center gap-1"
        aria-label={t('cards.undoLabel', { title })} onClick={onUndo}>
        <Undo2 size={14} aria-hidden /> {t('cards.undo')}
      </button>
      <button type="button" className="icon-btn" aria-label={t('cards.closeNotice')} title={t('cards.closeNotice')} onClick={onClose}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

export default function UndoNotice({ target, onUndo, onClose }: Readonly<{ target: UndoTarget | null } & NoticeActions>) {
  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-2rem)]">
      {target === null ? null : <UndoCard key={target.key} title={target.title} onUndo={onUndo} onClose={onClose} />}
    </div>
  )
}
