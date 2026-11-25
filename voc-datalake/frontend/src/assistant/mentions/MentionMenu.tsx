/**
 * @fileoverview The `@` / `#` suggestion list above the composer: a listbox the textarea
 * controls (`aria-activedescendant`), so focus never leaves the text. Options are buttons-sized
 * rows for touch; a press picks without blurring the textarea. The Documents Library's items come after the
 * project's documents, under a "Library" heading, each showing the `#slug` it puts in the text.
 *
 * @module assistant/mentions/MentionMenu
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { MENTION_LIMITS } from '@stream/assistant/contract'
import { libraryStart, optionId, tokenOf } from './mentionModel'
import MentionIcon from './MentionIcon'
import type { MentionMenuState } from './useMentions'
import type { MentionOption } from './mentionModel'

function StatusRow({ menu }: Readonly<{ menu: MentionMenuState }>) {
  const { t } = useTranslation('assistant')
  const kind = menu.trigger.kind
  if (menu.limited) {
    const max = kind === 'persona' ? MENTION_LIMITS.maxPersonas : MENTION_LIMITS.maxDocuments
    const line = menu.libraryOnly ? t('mentions.limit.library', { max: MENTION_LIMITS.maxLibraryItems })
      : t(`mentions.limit.${kind}`, { max })
    return <p className="px-2 py-1.5 text-[12px] text-muted">{line}</p>
  }
  if (menu.loading) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted">
        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
        {menu.libraryOnly ? t('mentions.loadingLibrary') : t('mentions.loading')}
      </p>
    )
  }
  return (
    <p className="px-2 py-1.5 text-[12px] text-muted">
      {menu.libraryOnly ? t('mentions.empty.library') : t(`mentions.empty.${kind}`)}
    </p>
  )
}

function OptionRow({ listId, option, index, selected, onChoose }: Readonly<{
  listId: string
  option: MentionOption
  index: number
  selected: boolean
  onChoose: (option: MentionOption) => void
}>) {
  const { t } = useTranslation('assistant')
  return (
    <li
      id={optionId(listId, index)}
      role="option"
      aria-selected={selected}
      // Keep focus (and the caret) in the textarea; the click below picks.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChoose(option)}
      className={clsx(
        'flex min-h-[2.25rem] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text',
        selected ? 'bg-accent-subtle text-accent-text' : 'hover:bg-bg-hover',
      )}
    >
      <MentionIcon kind={option.kind} size={14} />
      <span className="min-w-0 truncate" title={option.label}>
        {option.kind === 'all' ? tokenOf(option) : option.label}
      </span>
      {option.kind === 'all' && <span className="ml-auto text-[12px] text-muted">{t('mentions.allHint')}</span>}
      {option.kind === 'library' && <span className="ml-auto shrink-0 text-[12px] text-muted">{tokenOf(option)}</span>}
    </li>
  )
}

export default function MentionMenu({ listId, menu, onChoose }: Readonly<{
  listId: string
  /** Null = no mention is being typed (nothing is rendered). */
  menu: MentionMenuState | null
  onChoose: (option: MentionOption) => void
}>) {
  const { t } = useTranslation('assistant')
  if (menu === null) return null
  const heading = t(`mentions.heading.${menu.trigger.kind}`)
  const split = libraryStart(menu.options)
  const firstLibrary = split === -1 ? menu.options.length : split
  const row = (option: MentionOption, index: number) => (
    <OptionRow key={option.key} listId={listId} option={option} index={index} selected={index === menu.active} onChoose={onChoose} />
  )
  const groupId = `${listId}-section-library`
  return (
    <div className="mb-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-md animate-rise">
      <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted" aria-hidden>{heading}</p>
      {menu.options.length === 0
        ? <StatusRow menu={menu} />
        : (
          <ul id={listId} role="listbox" aria-label={heading}>
            {menu.options.slice(0, firstLibrary).map((option, index) => row(option, index))}
            {firstLibrary < menu.options.length && (
              <li role="group" aria-labelledby={groupId}>
                <p id={groupId} className="px-2 pb-0.5 pt-1.5 text-[12px] font-medium text-muted" aria-hidden>
                  {t('mentions.sections.library')}
                </p>
                <ul role="none">
                  {menu.options.slice(firstLibrary).map((option, offset) => row(option, firstLibrary + offset))}
                </ul>
              </li>
            )}
          </ul>
        )}
      <p className="sr-only" role="status">{t('mentions.count', { count: menu.options.length })}</p>
    </div>
  )
}
