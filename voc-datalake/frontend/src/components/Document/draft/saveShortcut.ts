/**
 * @fileoverview ⌘/Ctrl+S saves the draft, unless a dialog has the focus (its own form owns the keys). The browser's
 * own "Save page" is never what a writer means there.
 *
 * @module components/Document/draft/saveShortcut
 */
import { useEffect } from 'react'
import { noCleanup } from '../../../hooks/noCleanup'
import { ignoreRejection } from '../../../lib/rejections'

function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
  const focused = globalThis.document.activeElement
  return focused?.closest('[role="dialog"], [role="alertdialog"]') == null
}

export function useSaveShortcut(active: boolean, save: () => Promise<void>): void {
  useEffect(() => {
    if (!active) return noCleanup
    const handler = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return
      event.preventDefault()
      save().catch(ignoreRejection)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, save])
}
