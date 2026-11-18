/**
 * @fileoverview The type picker (UX §3.3): "+ Add question" opens a menu of the ten types in three groups (Ask,
 * Measure, Other), each with its hint. A menu button (APG: arrow keys, Home/End, Escape back to the trigger).
 * Contact info is offered once per form: a second is `aria-disabled` "Already in this form".
 *
 * @module pages/FeedbackForms/questions/TypePicker
 */
import { createElement, useId } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Plus } from 'lucide-react'
import { useMenuButton } from '../../../components/ProfileMenu/useMenuButton'
import type { QuestionType } from '../model/formsV2'
import { TYPE_ICONS } from '../ui/typeIcons'

const GROUPS: readonly { readonly key: 'ask' | 'measure' | 'other'; readonly types: readonly QuestionType[] }[] = [
  { key: 'ask', types: ['single_select', 'multi_select', 'open_text'] },
  { key: 'measure', types: ['rating', 'nps', 'csat', 'ces'] },
  { key: 'other', types: ['statement', 'consent', 'contact_info'] },
]

export default function TypePicker({ label, variant = 'secondary', hasContact, disabled = false, onPick, className }: Readonly<{
  /** The trigger's text ("Add question", "Add question here"). */
  label: string
  variant?: 'secondary' | 'ghost'
  /** The form already has a contact-info question. */
  hasContact: boolean
  /** The form holds 30 questions: the trigger is off (the caller says why in visible text). */
  disabled?: boolean
  onPick: (type: QuestionType) => void
  className?: string
}>) {
  const { t } = useTranslation('feedbackForms')
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown } = useMenuButton()
  const menuId = useId()
  const pick = (type: QuestionType) => {
    if (type === 'contact_info' && hasContact) return
    close(true)
    onPick(type)
  }
  return (
    <div className={clsx('relative', className)}>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} aria-disabled={disabled ? true : undefined}
        className={clsx('btn btn-sm', variant === 'ghost' ? 'btn-ghost' : 'btn-secondary', disabled && 'opacity-50')}
        onClick={disabled ? undefined : toggle} onKeyDown={disabled ? undefined : onButtonKeyDown}>
        <Plus size={14} aria-hidden="true" />{label}
      </button>
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label={t('questionList.typeMenu')} aria-orientation="vertical"
          onKeyDown={onMenuKeyDown} className="menu absolute left-0 top-full z-30 mt-1 w-72 animate-scale-in">
          {GROUPS.map((group) => (
            <div key={group.key} role="group" aria-label={t(`types.groups.${group.key}`)}>
              <p className="menu-label" aria-hidden="true">{t(`types.groups.${group.key}`)}</p>
              {group.types.map((type) => {
                const off = type === 'contact_info' && hasContact
                return (
                  <button key={type} type="button" role="menuitem" tabIndex={-1} aria-disabled={off ? true : undefined}
                    className={clsx('menu-item flex w-full items-start gap-2 text-left', off && 'opacity-60')} onClick={() => pick(type)}>
                    {createElement(TYPE_ICONS[type], { size: 14, className: 'mt-0.5 shrink-0 text-muted', 'aria-hidden': true })}
                    <span className="min-w-0">
                      <span className="block text-text-strong">{t(`types.${type}.name`)}</span>
                      <span className="block text-[12px] text-muted">{off ? t('questionList.contactOnce') : t(`types.${type}.hint`)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
