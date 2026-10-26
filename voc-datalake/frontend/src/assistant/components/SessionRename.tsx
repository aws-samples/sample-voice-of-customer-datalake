/**
 * @fileoverview Rename a conversation from the session list (`/chat` sidebar
 * and the panel's sessions drawer).
 *
 * The row menu's Rename item swaps its title for an input: Enter or leaving the
 * field saves, Escape cancels; after Enter/Escape focus goes back to the
 * row's menu button. Escape is stopped at the input (a native listener, which runs before
 * the drawer's own Escape-closes listener on its container), so cancelling a
 * rename never also closes the drawer. The new name shows at once (optimistic
 * cache update) and is persisted by `PUT /chat/conversations/{id}/title`; a
 * failure puts the list back and says why (409: a reply is still generating).
 *
 * @module assistant/components/SessionRename
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RefObject } from 'react'
import type { RenameFailure } from './useSessionRename'

/** chat_handler.MAX_TITLE_CHARS. */
const MAX_TITLE_CHARS = 120

function collapsed(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ')
}

/** The inline name field; `onSave` only fires for a changed, non-empty name. */
export function TitleEditor({ initial, onSave, onDone, returnFocusTo }: Readonly<{
  initial: string
  onSave: (title: string) => void
  onDone: () => void
  returnFocusTo: RefObject<HTMLButtonElement | null>
}>) {
  const { t } = useTranslation('assistant')
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  const finish = (save: boolean, refocus: boolean) => {
    if (finished.current) return
    finished.current = true
    const next = collapsed(value)
    if (save && next !== '' && next !== initial) onSave(next)
    if (refocus) returnFocusTo.current?.focus()
    onDone()
  }
  const latestFinish = useRef(finish)
  useEffect(() => { latestFinish.current = finish })

  useEffect(() => {
    const input = inputRef.current
    if (input === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      latestFinish.current(false, true)
    }
    input.addEventListener('keydown', onKeyDown)
    return () => input.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      maxLength={MAX_TITLE_CHARS}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        finish(true, true)
      }}
      onBlur={() => finish(true, false)}
      aria-label={t('sessions.renameInput')}
      className="input min-w-0 flex-1 rounded-sm px-2 py-1 text-[13px]"
      autoFocus
    />
  )
}

export function RenameFailureNotice({ failure }: Readonly<{ failure: RenameFailure | null }>) {
  const { t } = useTranslation('assistant')
  if (failure === null) return null
  return (
    <p className="p-2 text-[12px] text-danger" role="alert">
      {failure === 'busy' ? t('sessions.renameBusy') : t('sessions.renameFailed')}
    </p>
  )
}
