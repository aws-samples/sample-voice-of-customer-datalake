/**
 * @fileoverview "Describe your form" (UX §12.1), the picker's first option: a description (2,000 characters), the
 * "Try" examples, where it runs, Draft it, and the form's language ("in English · change": the page's "Create in" is
 * its one control). The draft opens in the builder unsaved; nothing is saved until the person saves it. While it
 * drafts, Stop (asked first) ends it and drops the draft, and Runs waits (`aria-disabled`, dimmed). What the AI can't
 * do is said in words (§12.4): a viewer is told before pressing; a refusal after it.
 *
 * @module pages/FeedbackForms/picker/DescribePanel
 */
import { useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Sparkles } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import { useCurrentWorkspace } from '../../../workspace/currentWorkspace'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import type { Channel, FormLanguage } from '../model/formsV2'
import { CHANNELS, LIMITS } from '../model/formsV2'
import Segmented from '../ui/Segmented'
import AiRefusalNotice from '../ai/AiRefusalNotice'
import StopDraftButton from '../ai/StopDraftButton'
import type { AiDraftRequest } from '../ai/useAiDraftRequest'
import DescribeExamples from './DescribeExamples'
import type { DescribeExample } from './DescribeExamples'

const MIN_DESCRIPTION = 10

export interface DescribeSubmit {
  readonly description: string
  readonly channel: Channel
}

function DraftButton({ busy, waitMinutes, onDraft }: Readonly<{ busy: boolean; waitMinutes: number; onDraft: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const waiting = waitMinutes > 0
  return (
    <Tooltip kind="description" content={waiting ? t('describe.waitReason', { minutes: waitMinutes }) : undefined}>
      <button type="button" className="btn btn-primary" aria-busy={busy} aria-disabled={busy || waiting ? true : undefined}
        onClick={() => { if (!busy && !waiting) onDraft() }}>
        {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
        {busy ? t('describe.draftingButton') : t('describe.draft')}
      </button>
    </Tooltip>
  )
}

export default function DescribePanel({ language, onLanguage, onChangeLanguage, request, initialDescription, onSubmit, textareaRef }: Readonly<{
  /** The page's "Create in" (the one language control): Describe says it, and an example may set it. */
  language: FormLanguage
  onLanguage: (language: FormLanguage) => void
  /** "change": go to "Create in". */
  onChangeLanguage: () => void
  request: AiDraftRequest
  initialDescription: string
  onSubmit: (submit: DescribeSubmit) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const viewer = useCurrentWorkspace()?.role === 'viewer'
  const [description, setDescription] = useState(initialDescription)
  const [channel, setChannel] = useState<Channel>('link')
  const [tooShort, setTooShort] = useState(false)
  const lastSubmit = useRef<DescribeSubmit | null>(null)

  const submit = () => {
    if (description.trim().length < MIN_DESCRIPTION) {
      setTooShort(true)
      textareaRef.current?.focus()
      return
    }
    lastSubmit.current = { description: description.trim(), channel }
    onSubmit(lastSubmit.current)
  }
  const useExample = (example: DescribeExample) => {
    setDescription(example.text)
    setTooShort(false)
    request.clear()
    if (example.language !== undefined) onLanguage(example.language)
    if (example.channel !== undefined) setChannel(example.channel)
  }
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <section aria-labelledby={`${id}-title`} className="card space-y-3 border-aim/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-aim">
          <Sparkles size={12} aria-hidden="true" />{t('describe.kicker')}
        </p>
        <p className="text-[12px] text-muted">{t('describe.nothingSaved')}</p>
      </div>
      <h2 id={`${id}-title`} className="sr-only">{t('describe.title')}</h2>
      {viewer ? <p role="note" className="rounded-lg border border-border bg-bg-accent px-3 py-2 text-[13px] text-text">{t('ai.refusal.role')}</p> : (
        <>
          <div className="space-y-1">
            <label htmlFor={`${id}-text`} className="block text-sm font-medium text-text">{t('describe.title')}</label>
            <textarea ref={textareaRef} id={`${id}-text`} className="input min-h-[4.5rem] max-h-48 resize-y" rows={3}
              value={description} maxLength={LIMITS.describeChars} readOnly={request.busy}
              aria-invalid={tooShort} aria-describedby={tooShort ? `${errorId} ${hintId}` : hintId}
              onChange={(event) => { setDescription(event.target.value); setTooShort(false); request.clear() }} />
            {tooShort && <p id={errorId} className="text-[12px] text-danger">{t('describe.tooShort')}</p>}
            <p id={hintId} className="flex flex-wrap justify-between gap-2 text-[12px] text-muted">
              <span>{t('describe.hint')}</span>
              <span className="tabular-nums">{t('describe.count', { n: description.length, max: LIMITS.describeChars })}</span>
            </p>
          </div>
          <DescribeExamples current={description} disabled={request.busy} onUse={useExample} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <p className="text-[12px] font-medium text-muted">{t('describe.runs')}</p>
              <Segmented label={t('describe.runs')} value={channel} onChange={setChannel}
                choices={CHANNELS.map((value) => ({ value, label: t(`picker.runs.${value}`), disabledReason: request.busy ? t('describe.busyReason') : undefined }))} />
              <p className="text-[12px] text-muted">{t(`describe.runsHint.${channel}`)}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {request.busy && <StopDraftButton onStop={request.cancel} />}
              <DraftButton busy={request.busy} waitMinutes={request.waitMinutes} onDraft={submit} />
            </div>
          </div>
          {/* (while it drafts, the button and the preview card say so: a third "Drafting…" here only repeated them) */}
          <p className="text-[12px] text-muted">
            {t('describe.inLanguage', { language: languageNames[language] })}{' · '}
            <button type="button" className="link" onClick={onChangeLanguage}>{t('describe.changeLanguage')}</button>
          </p>
          <p className="text-[12px] text-muted">{t('describe.privacy')}</p>
          {request.refusal !== null && (
            <AiRefusalNotice refusal={request.refusal} waitMinutes={request.waitMinutes}
              onRetry={() => { if (lastSubmit.current !== null) onSubmit(lastSubmit.current) }} />
          )}
        </>
      )}
    </section>
  )
}
