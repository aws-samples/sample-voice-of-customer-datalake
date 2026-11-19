/**
 * @fileoverview The type picker (UX §3.3): "+ Add question" opens a menu of the ten types in three groups (Ask,
 * Measure, Other), each with its hint. A menu button (APG): the arrows, Home/End and type-ahead (typing a type's first
 * letters moves to it) move between the types, Escape goes back to the trigger, Tab on to the control after it.
 * Contact info is offered once per form: a second is `aria-disabled` "Already in this form".
 *
 * The menu is fixed and in a portal (utils/fixedMenu.ts, as the builder's ⋯ menus), so the scrolling list pane never clips
 * it: it opens under the trigger, flipped above when there is no room, and closes when a scroll moves the trigger or
 * the window resizes. The `insert` trigger is the 24 px round "+" of the insertion line between two cards; `handle` lets the
 * card's ⋯ › Add question below open the picker without its trigger being pressed.
 *
 * @module pages/FeedbackForms/questions/TypePicker
 */
import { createElement, useId, useImperativeHandle, useRef } from 'react'
import type { KeyboardEvent, Ref } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Plus } from 'lucide-react'
import type { QuestionType } from '../model/formsV2'
import { TYPE_ICONS } from '../ui/typeIcons'
import { useFixedMenu } from '../ui/useFixedMenu'

const GROUPS: readonly { readonly key: 'ask' | 'measure' | 'other'; readonly types: readonly QuestionType[] }[] = [
  { key: 'ask', types: ['single_select', 'multi_select', 'open_text'] },
  { key: 'measure', types: ['rating', 'nps', 'csat', 'ces'] },
  { key: 'other', types: ['statement', 'consent', 'contact_info'] },
]

/** Keys typed within this long of each other make one type-ahead search ("cs" → CSAT, not Consent then Statement). */
const TYPE_AHEAD_MS = 500

/** What a caller can do with a picker besides pressing its trigger. */
export interface TypePickerHandle {
  /** Open the menu with the first type focused (a no-op when it is open). */
  readonly open: () => void
}

/**
 * Type-ahead (APG menu): a printable key moves focus to the next item whose name starts with what was typed in the
 * last half second, from the item after the focused one, wrapping. Returns whether it handled the key.
 */
function useTypeAhead() {
  const typed = useRef({ text: '', at: 0 })
  return (event: KeyboardEvent<HTMLDivElement>, menu: HTMLElement | null): boolean => {
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || menu === null) return false
    if (event.key === ' ' && typed.current.text === '') return false
    const now = Date.now()
    const text = (now - typed.current.at > TYPE_AHEAD_MS ? '' : typed.current.text) + event.key.toLocaleLowerCase()
    typed.current = { text, at: now }
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const current = items.findIndex((item) => item === document.activeElement)
    // (one letter, or the same letter again and again, steps through the items starting with it; a longer prefix
    // may stay on the current item)
    const first = text.charAt(0)
    const search = text.replaceAll(first, '') === '' ? first : text
    const start = search.length === 1 ? current + 1 : Math.max(current, 0)
    const ordered = [...items.slice(start), ...items.slice(0, start)]
    const match = ordered.find((item) => (item.dataset.name ?? '').toLocaleLowerCase().startsWith(search))
    if (match === undefined) return true
    event.preventDefault()
    match.focus()
    return true
  }
}

type Variant = 'secondary' | 'ghost' | 'insert'

const INSERT_TRIGGER = 'flex size-6 items-center justify-center rounded-full border border-accent bg-card text-accent-text shadow-sm transition-colors hover:bg-bg-hover focus-ring'

function triggerClass(variant: Variant, disabled: boolean): string {
  if (variant === 'insert') return INSERT_TRIGGER
  return clsx('btn btn-sm', variant === 'ghost' ? 'btn-ghost' : 'btn-secondary', disabled && 'opacity-50')
}

export default function TypePicker({ label, variant = 'secondary', hasContact, disabled = false, onPick, className, handle }: Readonly<{
  /** The trigger's text ("Add question"), or the "+"'s name and Tooltip ("Add question after question 2"). */
  label: string
  /** `insert`: the insertion line's 24 px round "+" (icon only, `label` its name). */
  variant?: Variant
  /** The form already has a contact-info question. */
  hasContact: boolean
  /** The form holds 30 questions: the trigger is off (the caller says why in visible text). */
  disabled?: boolean
  onPick: (type: QuestionType) => void
  className?: string
  handle?: Ref<TypePickerHandle>
}>) {
  const { t } = useTranslation('feedbackForms')
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown, leaveOnTab } = useFixedMenu('start')
  const menuId = useId()
  const typeAhead = useTypeAhead()
  useImperativeHandle(handle, () => ({ open: () => { if (!open && !disabled) toggle() } }), [open, disabled, toggle])
  const pick = (type: QuestionType) => {
    if (type === 'contact_info' && hasContact) return
    close(true)
    onPick(type)
  }
  // (the menu sits at the end of the page: Tab goes on from the trigger, as if the menu were still beside it)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (leaveOnTab(event) || typeAhead(event, menuRef.current)) return
    onMenuKeyDown(event)
  }
  const iconOnly = variant === 'insert'
  const trigger = (
    <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} aria-disabled={disabled || undefined}
      aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} className={triggerClass(variant, disabled)}
      onClick={disabled ? undefined : toggle} onKeyDown={disabled ? undefined : onButtonKeyDown}>
      <Plus size={14} aria-hidden="true" />{!iconOnly && label}
    </button>
  )
  return (
    <div className={clsx('relative', className)}>
      {trigger}
      {open && createPortal(
        <div ref={menuRef} id={menuId} role="menu" aria-label={t('questionList.typeMenu')} aria-orientation="vertical"
          onKeyDown={onKeyDown} className="menu fixed z-[75] w-72 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)]">
          {GROUPS.map((group) => (
            <div key={group.key} role="group" aria-label={t(`types.groups.${group.key}`)}>
              <p className="menu-label" aria-hidden="true">{t(`types.groups.${group.key}`)}</p>
              {group.types.map((type) => {
                const off = type === 'contact_info' && hasContact
                const name = t(`types.${type}.name`)
                return (
                  <button key={type} type="button" role="menuitem" tabIndex={-1} aria-disabled={off ? true : undefined} data-name={name}
                    className={clsx('menu-item flex w-full items-start gap-2 text-left', off && 'opacity-60')} onClick={() => pick(type)}>
                    {createElement(TYPE_ICONS[type], { size: 14, className: 'mt-0.5 shrink-0 text-muted', 'aria-hidden': true })}
                    <span className="min-w-0">
                      <span className="block text-text-strong">{name}</span>
                      <span className="block text-[12px] text-muted">{off ? t('questionList.contactOnce') : t(`types.${type}.hint`)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
