/**
 * @fileoverview Message composer: textarea (Enter sends, Shift+Enter newline),
 * character counter against `LIMITS.maxUserMessageChars`, send / stop,
 * image/PDF attachments and the web-search toggle (only when the deployment
 * has the gateway).
 *
 * @module assistant/components/Composer
 */
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Globe, Paperclip, Send, Square, X } from 'lucide-react'
import { LIMITS } from '../contract'
import { useAssistantUiStore } from '../store/assistantStore'
import {
  ATTACHMENT_ACCEPT, attachmentRejection, buildUserContent, isAttachmentMime, readFileAsBase64,
} from './attachments'
import type { ContentPart } from '@ag-ui/core'
import type { AttachmentError, PendingAttachment } from './attachments'

interface ComposerProps {
  streaming: boolean
  /** Why sending is blocked (e.g. approvals pending), or null. */
  blockedReason: string | null
  webSearchAvailable: boolean
  onSend: (content: string | ContentPart[]) => void
  onStop: () => void
  /** Text injected from outside (suggested prompts); consumed once. */
  draft?: string
  /** Layout classes for the content inside the full-width bar (e.g. a centred reading column). */
  innerClassName?: string
}

async function toAttachment(file: File): Promise<PendingAttachment | AttachmentError> {
  if (!isAttachmentMime(file.type)) return 'type'
  try {
    return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, data: await readFileAsBase64(file) }
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
  return (
    <ul className="mb-1 flex flex-wrap gap-1">
      {items.map((a) => (
        <li key={a.id} className="badge badge-muted">
          <Paperclip size={12} aria-hidden />
          <span className="max-w-[10rem] truncate">{a.name}</span>
          <button type="button" onClick={() => onRemove(a.id)} className="rounded-full transition-colors hover:text-text" aria-label={t('composer.removeAttachment', { name: a.name })} title={t('composer.removeAttachment', { name: a.name })}>
            <X size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
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
  streaming, blockedReason, webSearchAvailable, onSend, onStop, draft, innerClassName,
}: Readonly<ComposerProps>) {
  const { t } = useTranslation('assistant')
  const inputId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [lastDraft, setLastDraft] = useState<string | undefined>(undefined)
  const attachments = useAttachments()

  // Adopt a new suggested prompt (render-time sync, not an effect).
  if (draft !== undefined && draft !== lastDraft) {
    setLastDraft(draft)
    setText(draft.slice(0, LIMITS.maxUserMessageChars))
  }

  const tooLong = text.length > LIMITS.maxUserMessageChars
  const empty = text.trim() === '' && attachments.items.length === 0
  const canSend = !streaming && blockedReason === null && !empty && !tooLong

  const submit = () => {
    if (!canSend) return
    onSend(buildUserContent(text, attachments.items))
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
        {attachments.error !== null && <p className="mb-1 px-1 text-[12px] text-danger" role="alert">{t(`composer.attachmentError.${attachments.error}`, { max: LIMITS.maxAttachments })}</p>}
        <label htmlFor={inputId} className="sr-only">{t('composer.label')}</label>
        <textarea
          id={inputId}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={t('composer.placeholder')}
          className="input resize-none"
          aria-describedby={`${inputId}-count`}
        />
        <div className="mt-1 flex items-center gap-1">
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
