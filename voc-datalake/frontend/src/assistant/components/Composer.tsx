/**
 * @fileoverview Message composer: textarea (Enter sends, Shift+Enter newline),
 * character counter against `LIMITS.maxUserMessageChars`, send / stop,
 * image and document attachments, the web-search toggle (only when the deployment
 * has the gateway) and, on a project page, `@persona` / `@all` / `#document` mentions
 * (assistant/mentions: a combobox menu, chips, the ids sent as `forwardedProps.mentions`). The unsent text is kept per conversation (store/composerDrafts):
 * it comes back when the user returns to that conversation and never shows in another.
 *
 * @module assistant/components/Composer
 */
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AtSign, Globe, Hash, Paperclip, Send, Square } from 'lucide-react'
import { LIMITS } from '../contract'
import MentionChips from '../mentions/MentionChips'
import RemovableChips from './RemovableChips'
import MentionMenu from '../mentions/MentionMenu'
import { optionId } from '../mentions/mentionModel'
import { useMentions } from '../mentions/useMentions'
import type { MentionsController } from '../mentions/useMentions'
import type { Mentions } from '../contract'
import { useAssistantUiStore } from '../store/assistantStore'
import { draftOf, useComposerDrafts } from '../store/composerDrafts'
import {
  ATTACHMENT_ACCEPT, MAX_ATTACHMENT_MB, attachmentRejection, buildUserContent, readFileAsBase64, resolveAttachmentMime,
} from './attachments'
import type { ContentPart } from '@ag-ui/core'
import type { AttachmentError, PendingAttachment } from './attachments'

interface ComposerProps {
  /** The conversation this composer writes to (its draft is kept under this id). */
  threadId: string
  streaming: boolean
  /** Why sending is blocked (e.g. approvals pending), or null. */
  blockedReason: string | null
  webSearchAvailable: boolean
  /** The project on screen: `@` mentions its personas, `#` tags its documents. Absent = off. */
  projectId?: string
  onSend: (content: string | ContentPart[], mentions?: Mentions) => void
  onStop: () => void
  /** Text injected from outside (suggested prompts); consumed once. */
  draft?: string
  /** Layout classes for the content inside the full-width bar (e.g. a centred reading column). */
  innerClassName?: string
}

async function toAttachment(file: File): Promise<PendingAttachment | AttachmentError> {
  const mimeType = resolveAttachmentMime(file)
  if (mimeType === null) return 'type'
  try {
    return { id: crypto.randomUUID(), name: file.name, mimeType, data: await readFileAsBase64(file) }
  } catch {
    return 'read'
  }
}

function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [error, setError] = useState<AttachmentError | null>(null)
  const add = async (files: readonly File[]) => {
    setError(null)
    const accepted = [...items]
    for (const file of files) {
      const result = await toAttachment(file)
      if (typeof result === 'string') {
        setError(result)
        continue
      }
      const rejection = attachmentRejection(accepted, result)
      if (rejection === null) accepted.push(result)
      else setError(rejection)
    }
    setItems(accepted)
  }
  const remove = (id: string) => setItems((list) => list.filter((a) => a.id !== id))
  const clear = () => {
    setItems([])
    setError(null)
  }
  return { items, error, add, remove, clear }
}

function WebSearchToggle() {
  const { t } = useTranslation('assistant')
  const on = useAssistantUiStore((s) => s.useWebSearch)
  const setOn = useAssistantUiStore((s) => s.setUseWebSearch)
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setOn(!on)}
      title={t('composer.webSearch')}
      className={clsx('icon-btn', on && 'bg-accent-subtle text-accent-text hover:bg-accent-subtle hover:text-accent-text')}
    >
      <Globe size={16} aria-hidden />
      <span className="sr-only">{t('composer.webSearch')}</span>
    </button>
  )
}

function AttachmentChips({ items, onRemove }: Readonly<{ items: readonly PendingAttachment[]; onRemove: (id: string) => void }>) {
  const { t } = useTranslation('assistant')
  if (items.length === 0) return null
  const chips = items.map((a) => ({
    key: a.id, icon: <Paperclip size={12} aria-hidden />, label: a.name, tooltip: a.name,
    removeLabel: t('composer.removeAttachment', { name: a.name }),
  }))
  return <RemovableChips items={chips} tone="muted" className="mb-1" onRemove={onRemove} />
}

/** The `@` / `#` buttons: the same menus without typing the character (touch keyboards). */
function MentionButtons({ mentions }: Readonly<{ mentions: MentionsController }>) {
  const { t } = useTranslation('assistant')
  if (!mentions.enabled) return null
  return (
    <>
      <button type="button" onClick={() => mentions.insertTrigger('@')} className="icon-btn" title={t('mentions.insertPersona')}>
        <AtSign size={16} aria-hidden />
        <span className="sr-only">{t('mentions.insertPersona')}</span>
      </button>
      <button type="button" onClick={() => mentions.insertTrigger('#')} className="icon-btn" title={t('mentions.insertDocument')}>
        <Hash size={16} aria-hidden />
        <span className="sr-only">{t('mentions.insertDocument')}</span>
      </button>
    </>
  )
}

/**
 * List-autocomplete attributes of the textarea while mentions are on. It keeps the textbox role
 * (a multi-line combobox is poorly supported by screen readers): the open list is named by
 * `aria-controls`, its active option by `aria-activedescendant`, its size by the list's status.
 */
function autocompleteProps(mentions: MentionsController, listId: string) {
  if (!mentions.enabled) return {}
  const menu = mentions.menu
  const listed = menu !== null && menu.options.length > 0
  return {
    'aria-autocomplete': 'list' as const,
    ...(listed ? { 'aria-controls': listId, 'aria-activedescendant': optionId(listId, menu.active) } : {}),
  }
}

/** The open mention list takes its keys first; otherwise Enter sends (Shift+Enter is a newline). */
function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>, mentions: MentionsController, submit: () => void): void {
  if (mentions.onKeyDown(event)) return
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault()
    submit()
  }
}

function SendOrStop({ streaming, canSend, onStop }: Readonly<{ streaming: boolean; canSend: boolean; onStop: () => void }>) {
  const { t } = useTranslation('assistant')
  if (streaming) {
    return (
      <button type="button" onClick={onStop} className="btn btn-secondary btn-sm">
        <Square size={14} aria-hidden />
        {t('composer.stop')}
      </button>
    )
  }
  return (
    <button type="submit" disabled={!canSend} className="btn btn-primary btn-sm">
      <Send size={14} aria-hidden />
      {t('composer.send')}
    </button>
  )
}

export default function Composer({
  threadId, streaming, blockedReason, webSearchAvailable, projectId, onSend, onStop, draft, innerClassName,
}: Readonly<ComposerProps>) {
  const { t } = useTranslation('assistant')
  const inputId = useId()
  const listId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveDraft = useComposerDrafts((s) => s.setDraft)
  const [text, setTextState] = useState(() => draftOf(threadId))
  const setText = (next: string) => {
    setTextState(next)
    saveDraft(threadId, next)
  }
  const [lastDraft, setLastDraft] = useState<string | undefined>(undefined)
  const attachments = useAttachments()
  const mentions = useMentions({ projectId, text, setText, textareaRef })

  // Adopt a new suggested prompt (render-time sync, not an effect).
  if (draft !== undefined && draft !== lastDraft) {
    setLastDraft(draft)
    // Local state only (no store write during render); the panel keeps the suggestion for this conversation.
    setTextState(draft.slice(0, LIMITS.maxUserMessageChars))
  }

  const tooLong = text.length > LIMITS.maxUserMessageChars
  const empty = text.trim() === '' && attachments.items.length === 0
  const canSend = !streaming && blockedReason === null && !empty && !tooLong

  const submit = () => {
    if (!canSend) return
    onSend(buildUserContent(text, attachments.items), mentions.takeMentions())
    setText('')
    attachments.clear()
  }

  return (
    <form
      className="flex-shrink-0 border-t border-border bg-card p-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className={innerClassName}>
        {blockedReason !== null && <p className="mb-1 px-1 text-[12px] text-warn">{blockedReason}</p>}
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        {attachments.error !== null && <p className="mb-1 px-1 text-[12px] text-danger" role="alert">{t(`composer.attachmentError.${attachments.error}`, { max: LIMITS.maxAttachments, mb: MAX_ATTACHMENT_MB })}</p>}
        <MentionMenu listId={listId} menu={mentions.menu} onChoose={mentions.choose} />
        <label htmlFor={inputId} className="sr-only">{t('composer.label')}</label>
        <textarea
          id={inputId}
          ref={textareaRef}
          value={text}
          rows={2}
          {...autocompleteProps(mentions, listId)}
          onChange={(e) => {
            setText(e.target.value)
            mentions.onCaretMove()
          }}
          onSelect={mentions.onCaretMove}
          onKeyDown={(e) => handleComposerKey(e, mentions, submit)}
          placeholder={t(mentions.placeholderKey)}
          className="input resize-none"
          // The browser must not refill it from another conversation (form restore / autofill).
          autoComplete="off"
          aria-describedby={`${inputId}-count`}
        />
        <MentionChips picks={mentions.picks} personaNames={mentions.personaNames} onRemove={mentions.remove} />
        {/* Wraps at 200 % zoom / narrow sheets, so Send is never squeezed and cut (wave 4). */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? [...e.target.files] : []
              e.target.value = ''
              void attachments.add(files)
            }}
          />
          <button type="button" onClick={() => fileRef.current?.click()} className="icon-btn" title={t('composer.attach')}>
            <Paperclip size={16} aria-hidden />
            <span className="sr-only">{t('composer.attach')}</span>
          </button>
          <MentionButtons mentions={mentions} />
          {webSearchAvailable && <WebSearchToggle />}
          <span id={`${inputId}-count`} className={clsx('ml-auto font-mono text-[12px]', tooLong ? 'text-danger' : 'text-muted')}>
            {t('composer.counter', { length: text.length, max: LIMITS.maxUserMessageChars })}
          </span>
          <SendOrStop streaming={streaming} canSend={canSend} onStop={onStop} />
        </div>
      </div>
    </form>
  )
}
