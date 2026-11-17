/**
 * @fileoverview The document page's large title, renamed in place (a research / custom document; a PRD / PR/FAQ's is
 * its series' own, and a viewer's is read only: a heading).
 *
 * It is always the field ("Document title"), drawn as the heading: a click (or Document → Rename) puts the caret in
 * it. Enter saves the new name and moves on to the text; leaving the field saves it too; Escape puts the saved name
 * back. An empty name is refused (Enter keeps the field and says why under it; leaving it puts the saved name back). The
 * save is the canvas's `rename`: one new version with the title alone, so text typed and not saved stays the draft.
 *
 * @module components/DocumentCanvas/page/InlineTitle
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ignoreRejection } from '../../../lib/rejections'
import { TITLE_INPUT_CLASS, TITLE_TEXT_CLASS } from '../../Document/pageStyles'
import { titleEditOf } from './titleEdit'
import type { KeyboardEvent, RefObject } from 'react'

interface InlineTitleProps {
  /** The name the canvas holds (saved, or being saved). */
  readonly title: string
  readonly editable: boolean
  /** Saves `title` (trimmed, changed, never empty). */
  readonly onRename: (title: string) => Promise<void>
  /** Enter: on to the text. */
  readonly onDone: () => void
  readonly inputRef: RefObject<HTMLInputElement | null>
  /** A document just created blank: the field takes focus with its name selected, to be typed over. */
  readonly selectOnOpen?: boolean
}

export default function InlineTitle({ title, editable, onRename, onDone, inputRef, selectOnOpen = false }: InlineTitleProps) {
  const { t } = useTranslation('projectDetail')
  const inputId = useId()
  const errorId = useId()
  // The name being typed; null while the field is not being edited (it shows the canvas's). The ref is read by the
  // handlers: Enter's save moves focus on, and the blur that follows must not save the same name twice.
  const [typed, setTypedState] = useState<string | null>(null)
  const typedRef = useRef<string | null>(null)
  const setTyped = (next: string | null) => {
    typedRef.current = next
    setTypedState(next)
  }
  const [refused, setRefused] = useState(false)
  useEffect(() => {
    if (!selectOnOpen) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inputRef, selectOnOpen])

  if (!editable) return <h2 className={TITLE_TEXT_CLASS}>{title}</h2>

  /** Save what was typed; `leaving`: the field lost focus (an empty name then goes back to the saved one). */
  const commit = (leaving: boolean): boolean => {
    const edit = titleEditOf(typedRef.current ?? title, title)
    if (edit.kind === 'empty') {
      // Enter keeps the field and says why; leaving it puts the saved name back.
      setRefused(!leaving)
      if (leaving) setTyped(null)
      return false
    }
    setTyped(null)
    setRefused(false)
    if (edit.kind === 'renamed') onRename(edit.title).catch(ignoreRejection)
    return true
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // The field's own: full screen stays.
      event.preventDefault()
      event.stopPropagation()
      setTyped(null)
      setRefused(false)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (commit(false)) onDone()
  }
  return (
    <>
      <label htmlFor={inputId} className="sr-only">{t('documents:page.titleLabel')}</label>
      <input ref={inputRef} id={inputId} type="text" value={typed ?? title} autoComplete="off" spellCheck
        title={t('documents:page.titleHint')} aria-invalid={refused ? true : undefined}
        aria-describedby={refused ? errorId : undefined}
        onChange={(event) => { setTyped(event.target.value); setRefused(false) }}
        onKeyDown={onKeyDown} onBlur={() => { if (typedRef.current !== null) commit(true) }}
        className={TITLE_INPUT_CLASS} />
      {/* Inserted when the name is refused: an alert that appears is read out. */}
      {refused ? <p id={errorId} role="alert" className="mt-1 text-sm text-danger">{t('documents:page.titleRequired')}</p> : null}
    </>
  )
}
