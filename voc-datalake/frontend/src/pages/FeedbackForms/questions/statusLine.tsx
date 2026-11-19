/**
 * @fileoverview The Questions tab's polite status line (UX §3.3, §13.2): a move announced ("Moved '…' to position 2
 * of 5"), a delete or a helper with its Undo for 10 s, the new default ending. One line for the tab; its parts write
 * to it through `useAnnounce` (statusLineContext.ts).
 *
 * @module pages/FeedbackForms/questions/statusLine
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Undo2 } from 'lucide-react'
import { noCleanup } from '../../../hooks/noCleanup'
import { AnnounceContext } from './statusLineContext'
import type { Announce, Announcement } from './statusLineContext'

const UNDO_MS = 10_000

/** Provides `useAnnounce` to its children and renders the line itself. */
export default function StatusLineProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useTranslation('feedbackForms')
  const [current, setCurrent] = useState<(Announcement & { readonly at: number }) | null>(null)
  const announce = useCallback<Announce>((announcement) => setCurrent({ ...announcement, at: Date.now() }), [])
  useEffect(() => {
    if (current?.undo === undefined) return noCleanup
    const timer = window.setTimeout(() => setCurrent((shown) => (shown?.at === current.at ? { message: shown.message, at: shown.at } : shown)), UNDO_MS)
    return () => window.clearTimeout(timer)
  }, [current])
  const undo = current?.undo
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" className="min-h-[1.5rem] text-[13px] text-text">
        {current !== null && (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{current.message}</span>
            {undo !== undefined && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { undo(); setCurrent(null) }}>
                <Undo2 size={14} aria-hidden="true" />{t('questionList.undo')}
              </button>
            )}
          </span>
        )}
      </div>
    </AnnounceContext.Provider>
  )
}
