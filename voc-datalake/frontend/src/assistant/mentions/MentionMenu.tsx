/**
 * @fileoverview The `@` / `#` suggestion list above the composer: a listbox the textarea
 * controls (`aria-activedescendant`), so focus never leaves the text. Options are buttons-sized
 * rows for touch; a press picks without blurring the textarea. Documents are listed in the
 * project's sections (PRD, PR/FAQ, Documents), each a named group of options.
 *
 * @module assistant/mentions/MentionMenu
 */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { MENTION_LIMITS } from '@stream/assistant/contract'
import { optionId, sectionStartingAt, tokenOf } from './mentionModel'
import MentionIcon from './MentionIcon'
import type { MentionMenuState } from './useMentions'
import type { MentionOption } from './mentionModel'
import type { DocumentSectionId } from '../../api/documentSections'

function StatusRow({ menu }: Readonly<{ menu: MentionMenuState }>) {
  const { t } = useTranslation('assistant')
  const kind = menu.trigger.kind
  if (menu.limited) {
    const max = kind === 'persona' ? MENTION_LIMITS.maxPersonas : MENTION_LIMITS.maxDocuments
    return <p className="px-2 py-1.5 text-[12px] text-muted">{t(`mentions.limit.${kind}`, { max })}</p>
  }
  if (menu.loading) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted">
        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
        {t('mentions.loading')}
      </p>
    )
  }
  return <p className="px-2 py-1.5 text-[12px] text-muted">{t(`mentions.empty.${kind}`)}</p>
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
    </li>
  )
}

interface IndexedOption {
  option: MentionOption
  index: number
}

/** One run of options: a document section (a named group) or the personas (no group). */
interface OptionRun {
  section: DocumentSectionId | null
  items: IndexedOption[]
}

function runsOf(options: readonly MentionOption[]): OptionRun[] {
  const runs: OptionRun[] = []
  options.forEach((option, index) => {
    const section = sectionStartingAt(options, index)
    const last = runs.at(-1)
    if (last === undefined || section !== null) runs.push({ section, items: [{ option, index }] })
    else last.items.push({ option, index })
  })
  return runs
}

/** The document sections' names, as literal keys (a key built at runtime is invisible to the extractor). */
function useSectionNames(): Readonly<Record<DocumentSectionId, string>> {
  const { t } = useTranslation('assistant')
  return {
    prd: t('mentions.sections.prd'),
    prfaq: t('mentions.sections.prfaq'),
    prototypes: t('mentions.sections.prototypes'),
    documents: t('mentions.sections.documents'),
  }
}

export default function MentionMenu({ listId, menu, onChoose }: Readonly<{
  listId: string
  /** Null = no mention is being typed (nothing is rendered). */
  menu: MentionMenuState | null
  onChoose: (option: MentionOption) => void
}>) {
  const { t } = useTranslation('assistant')
  const sectionNames = useSectionNames()
  if (menu === null) return null
  const heading = t(`mentions.heading.${menu.trigger.kind}`)
  const row = ({ option, index }: IndexedOption) => (
    <OptionRow key={option.key} listId={listId} option={option} index={index} selected={index === menu.active} onChoose={onChoose} />
  )
  return (
    <div className="mb-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-md animate-rise">
      <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted" aria-hidden>{heading}</p>
      {menu.options.length === 0
        ? <StatusRow menu={menu} />
        : (
          <ul id={listId} role="listbox" aria-label={heading}>
            {runsOf(menu.options).map((run) => {
              if (run.section === null) return <Fragment key="options">{run.items.map(row)}</Fragment>
              const groupId = `${listId}-section-${run.section}`
              return (
                <li key={groupId} role="group" aria-labelledby={groupId}>
                  <p id={groupId} className="px-2 pb-0.5 pt-1.5 text-[12px] font-medium text-muted" aria-hidden>
                    {sectionNames[run.section]}
                  </p>
                  <ul role="none">{run.items.map(row)}</ul>
                </li>
              )
            })}
          </ul>
        )}
      <p className="sr-only" role="status">{t('mentions.count', { count: menu.options.length })}</p>
    </div>
  )
}
