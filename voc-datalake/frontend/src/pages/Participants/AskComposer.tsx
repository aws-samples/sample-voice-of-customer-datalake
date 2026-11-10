/**
 * @fileoverview "New ask": email the chosen lists and/or people a subject, a message and
 * one link (a feedback form or an https page). The server de-duplicates, skips unsubscribed
 * people, enforces the daily cap (429) and refuses when email sending is not configured
 * (409) — the composer says each of those in a sentence. When the settings already say
 * email is off, Send is disabled with the reason beside it.
 * @module pages/Participants/AskComposer
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { CheckCircle2, Loader2, Send } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import { MAX_MESSAGE_CHARS, MAX_SUBJECT_CHARS, participantsApi, participantsKeys } from '../../api/participantsApi'
import type { Ask, Person } from '../../api/participantsSchema'
import AskLinkField from './AskLinkField'
import AskRecipientsPicker from './AskRecipientsPicker'
import { useRecipientCount } from './useRecipientCount'
import { draftIssues, emptyDraft, toAskInput } from './askDraft'
import type { AskDraft, DraftIssue } from './askDraft'
import { participantErrorMessage } from './participantErrors'

type Translate = (key: string) => string

function issueText(issue: DraftIssue, t: Translate): string {
  switch (issue) {
    case 'noRecipients': return t('composer.issues.noRecipients')
    case 'tooManyRecipients': return t('composer.issues.tooManyRecipients')
    case 'subjectMissing': return t('composer.issues.subjectMissing')
    case 'subjectTooLong': return t('composer.issues.subjectTooLong')
    case 'messageMissing': return t('composer.issues.messageMissing')
    case 'messageTooLong': return t('composer.issues.messageTooLong')
    case 'formMissing': return t('composer.issues.formMissing')
    case 'urlNotHttps': return t('composer.issues.urlNotHttps')
  }
}

function CharCount({ length, max }: Readonly<{ length: number; max: number }>) {
  return <span className={clsx('block text-right text-xs font-mono', length > max ? 'text-danger' : 'text-muted')}>{length}/{max}</span>
}

function MessageFields({ draft, onChange }: Readonly<{ draft: AskDraft; onChange: (patch: Partial<AskDraft>) => void }>) {
  const { t } = useTranslation('participants')
  return (
    <>
      <label className="block">
        <span className="block text-sm font-medium text-text mb-1">{t('composer.subject')}</span>
        <input value={draft.subject} onChange={(e) => onChange({ subject: e.target.value })} className="input w-full" />
        <CharCount length={draft.subject.length} max={MAX_SUBJECT_CHARS} />
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-text mb-1">{t('composer.message')}</span>
        <textarea value={draft.message} rows={6} onChange={(e) => onChange({ message: e.target.value })} className="input" />
        <CharCount length={draft.message.length} max={MAX_MESSAGE_CHARS} />
      </label>
    </>
  )
}

function Sent({ ask, onClose }: Readonly<{ ask: Ask; onClose: () => void }>) {
  const { t } = useTranslation('participants')
  return (
    <>
      <div className="dialog-body">
        <div role="status" className="flex items-start gap-3 rounded-lg border border-ok/30 bg-ok-subtle p-4">
          <CheckCircle2 size={20} className="text-ok shrink-0" aria-hidden />
          <p className="text-sm text-text">{t('composer.sent', { count: ask.counts.recipients })}</p>
        </div>
      </div>
      <div className="dialog-footer">
        <button type="button" onClick={onClose} className="btn btn-primary">{t('actions.done')}</button>
      </div>
    </>
  )
}

/** What stops the send: the draft's own problems (after a first try) and the server's refusal. */
function ComposerProblems({ issues, error }: Readonly<{ issues: readonly DraftIssue[]; error: unknown }>) {
  const { t } = useTranslation('participants')
  return (
    <>
      {issues.length === 0 ? null : (
        <ul role="alert" className="list-disc pl-5 text-sm text-danger">
          {issues.map((issue) => <li key={issue}>{issueText(issue, t)}</li>)}
        </ul>
      )}
      {error === null ? null : <p role="alert" className="text-sm text-danger">{participantErrorMessage(error, t)}</p>}
    </>
  )
}

export interface AskComposerProps {
  readonly projectId?: string
  readonly initialListIds?: readonly string[]
  readonly initialPersonIds?: readonly string[]
  /** People already on screen (a project's), so a preselected person shows by name. */
  readonly knownPeople?: readonly Person[]
  readonly onClose: () => void
}

export default function AskComposer({ projectId = '', initialListIds = [], initialPersonIds = [], knownPeople = [], onClose }: AskComposerProps) {
  const { t } = useTranslation('participants')
  const titleId = useId()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<AskDraft>(() => emptyDraft(initialListIds, initialPersonIds))
  const [known, setKnown] = useState<readonly Person[]>(knownPeople)
  const [tried, setTried] = useState(false)
  const settings = useQuery({ queryKey: participantsKeys.settings(), queryFn: participantsApi.getSettings })
  const recipientCount = useRecipientCount(draft.listIds, draft.personIds)
  const send = useMutation({
    mutationFn: () => participantsApi.createAsk(toAskInput(draft, projectId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: participantsKeys.all() }),
  })
  const patch = (next: Partial<AskDraft>) => setDraft((current) => ({ ...current, ...next }))
  const issues = draftIssues(draft, recipientCount)
  const emailOff = settings.data?.email_enabled === false
  const submit = () => {
    setTried(true)
    if (issues.length === 0 && !emailOff) send.mutate()
  }

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-2xl max-h-[90vh]" dismissable={!send.isPending}>
      <div className="dialog-header justify-between">
        <h2 id={titleId} className="dialog-title">{t('composer.title')}</h2>
        <DialogClose onClick={onClose} disabled={send.isPending} />
      </div>
      {send.data === undefined ? (
        <form className="contents" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <div className="dialog-body space-y-4 overflow-y-auto">
            {emailOff ? <p role="alert" className="rounded-md border border-warn/30 bg-warn-subtle p-2 text-sm text-warn">{t('composer.emailOff')}</p> : null}
            <AskRecipientsPicker listIds={draft.listIds} personIds={draft.personIds} known={known} recipientCount={recipientCount}
              onLists={(listIds) => patch({ listIds })}
              onPeople={(personIds, picked) => { patch({ personIds }); if (picked !== null) setKnown((k) => [...k, picked]) }} />
            <MessageFields draft={draft} onChange={patch} />
            <AskLinkField draft={draft} onChange={patch} />
            <ComposerProblems issues={tried ? issues : []} error={send.isError ? send.error : null} />
          </div>
          <div className="dialog-footer">
            <button type="button" onClick={onClose} disabled={send.isPending} className="btn btn-secondary">{t('actions.cancel')}</button>
            <button type="submit" disabled={send.isPending || emailOff} className="btn btn-primary">
              {send.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
              {t('composer.send')}
            </button>
          </div>
        </form>
      ) : <Sent ask={send.data} onClose={onClose} />}
    </ModalShell>
  )
}
