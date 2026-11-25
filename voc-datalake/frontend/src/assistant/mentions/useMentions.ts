/**
 * @fileoverview Composer state for `@persona`, `@all`, `#document` and `#slug` (a library item): the trigger at the caret,
 * the menu (options, active option, keyboard), the picks and what a send carries.
 *
 * Keyboard (list autocomplete on the textbox): ArrowDown / ArrowUp move, Enter or Tab picks,
 * Escape closes the menu (and only the menu: the panel stays open). Focus stays in the textarea;
 * the active option is `aria-activedescendant`.
 *
 * @module assistant/mentions/useMentions
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LIBRARY_TRIGGERS, atLimit, documentMentionOptions, documentsFull, findTrigger, insertToken, libraryFull,
  libraryMentionOptions, livePicks, mentionsForSend, personaMentionOptions, tokenOf,
} from './mentionModel'
import { useLibrarySuggestions, useMentionSources } from './useMentionSources'
import type { LibrarySuggestions, MentionSources } from './useMentionSources'
import type { KeyboardEvent, RefObject } from 'react'
import type { Mentions } from '@stream/assistant/contract'
import type { MentionOption, MentionPick, MentionTrigger } from './mentionModel'

export interface MentionMenuState {
  trigger: MentionTrigger
  options: MentionOption[]
  active: number
  limited: boolean
  loading: boolean
  /** Off a project page `#` offers the library alone (its own empty and limit lines). */
  libraryOnly: boolean
}

interface UseMentionsInput {
  /** The project on screen; undefined = no persona or project document to mention (any other page). */
  projectId: string | undefined
  /** `#slug` of a Documents Library item, on every page (off when the Library is not in the menu). */
  libraryEnabled?: boolean
  text: string
  setText: (text: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

function caretOf(ref: RefObject<HTMLTextAreaElement | null>, fallback: number): number {
  return ref.current?.selectionStart ?? fallback
}

/** The options for the trigger at the caret; none once the per-message limit is reached. `#` lists the project's
 *  documents (on its page), then the library's items, each group until its own limit. */
function optionsFor(trigger: MentionTrigger, sources: MentionSources, library: LibrarySuggestions,
  live: readonly MentionPick[], allLabel: string): MentionOption[] {
  if (trigger.kind === 'persona') {
    return atLimit('persona', live) ? [] : personaMentionOptions(sources.personas, trigger.query, live, allLabel)
  }
  const documents = documentsFull(live) ? [] : documentMentionOptions(sources.documents, trigger.query, live)
  const items = libraryFull(live) ? [] : libraryMentionOptions(library.items, trigger.query, live)
  return [...documents, ...items]
}

function placeholderKeyOf(onProject: boolean, libraryEnabled: boolean): string {
  if (onProject) return 'mentions.placeholder'
  return libraryEnabled ? 'mentions.placeholderLibrary' : 'composer.placeholder'
}

/** Keys the open menu handles; anything else goes to the textarea. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'])

export function useMentions({ projectId, libraryEnabled = false, text, setText, textareaRef }: UseMentionsInput) {
  const { t } = useTranslation('assistant')
  const sources = useMentionSources(projectId)
  const [caret, setCaret] = useState(text.length)
  const [picks, setPicks] = useState<MentionPick[]>([])
  const [active, setActive] = useState(0)
  /** The trigger start the user closed with Escape (the menu stays shut until a new trigger). */
  const [dismissed, setDismissed] = useState<number | null>(null)
  const pendingCaret = useRef<number | null>(null)

  // Put the caret after an inserted token once React has written the new text.
  useLayoutEffect(() => {
    const target = pendingCaret.current
    const area = textareaRef.current
    if (target === null || area === null) return
    pendingCaret.current = null
    area.setSelectionRange(target, target)
  })

  const onProject = projectId !== undefined
  const enabled = onProject || libraryEnabled
  const allowedTriggers = onProject ? undefined : LIBRARY_TRIGGERS
  const trigger = enabled ? findTrigger(text, caret, allowedTriggers) : null
  const open = trigger !== null && trigger.start !== dismissed
  const library = useLibrarySuggestions(open && libraryEnabled && trigger.kind === 'document' ? trigger.query : null)
  const live = livePicks(picks, text)
  const menu: MentionMenuState | null = open
    ? {
      trigger,
      options: optionsFor(trigger, sources, library, live, t('mentions.allLabel')),
      active,
      limited: atLimit(trigger.kind, live, onProject),
      loading: sources.loading || library.loading,
      libraryOnly: !onProject,
    }
    : null

  const syncCaret = () => {
    setCaret(caretOf(textareaRef, text.length))
    setActive(0)
  }

  const choose = (option: MentionOption) => {
    if (menu === null) return
    const token = tokenOf(option)
    const next = insertToken(text, menu.trigger, caret, token)
    setPicks([...live, { ...option, token }])
    pendingCaret.current = next.caret
    setCaret(next.caret)
    setActive(0)
    setText(next.text)
  }

  /** True when the key was the menu's (the caller must not also act on it). */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (menu === null || !MENU_KEYS.has(event.key)) return false
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      setDismissed(menu.trigger.start)
      return true
    }
    const count = menu.options.length
    if (count === 0) return false
    event.preventDefault()
    if (event.key === 'ArrowDown') setActive((menu.active + 1) % count)
    else if (event.key === 'ArrowUp') setActive((menu.active - 1 + count) % count)
    else {
      const option = menu.options[Math.min(menu.active, count - 1)]
      if (option !== undefined) choose(option)
    }
    return true
  }

  /** Type a trigger at the caret (the @ / # buttons, for touch keyboards). */
  const insertTrigger = (char: '@' | '#') => {
    const at = caretOf(textareaRef, text.length)
    const spacer = at > 0 && !/\s/.test(text.charAt(at - 1)) ? ' ' : ''
    const head = `${text.slice(0, at)}${spacer}${char}`
    pendingCaret.current = head.length
    setCaret(head.length)
    setDismissed(null)
    setText(`${head}${text.slice(at)}`)
    textareaRef.current?.focus()
  }

  return {
    enabled,
    /** `@` (personas) is a project page's only. */
    personasEnabled: onProject,
    /** The composer placeholder: it says how to mention what this page can mention. */
    placeholderKey: placeholderKeyOf(onProject, libraryEnabled),
    menu,
    picks: live,
    personaCount: sources.personas.length,
    personaNames: sources.personas.map((persona) => persona.name),
    onKeyDown,
    onCaretMove: syncCaret,
    choose,
    insertTrigger,
    remove: (key: string) => setPicks(live.filter((pick) => pick.key !== key)),
    /** What the message carries, then forget the picks (the text is cleared by the composer). */
    takeMentions: (): Mentions | undefined => {
      const mentions = enabled ? mentionsForSend(picks, text) : undefined
      setPicks([])
      setDismissed(null)
      return mentions
    },
  }
}

export type MentionsController = ReturnType<typeof useMentions>
