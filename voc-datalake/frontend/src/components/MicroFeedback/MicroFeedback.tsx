/**
 * @fileoverview In-app micro-feedback (7.66.00, docs/micro-feedback.md): a small inline "Was this useful?" after a key
 * action (personas, research, a PR/FAQ, a PRD, a prototype, a form's AI draft, an import, an engineering run). A thumb
 * up or down, then "What's missing?" (optional, at most 500 characters) and Send; or Not now. Asked at most once per
 * action instance (answeredInstances.ts), in two seconds, without leaving the page.
 *
 * Shown only while an administrator turned it on for this action and its form takes answers (`GET
 * /settings/app-feedback` `active`, read once and cached). The response goes to that form's public submit route with
 * no credentials (api/appFeedbackApi.ts): the forms' own validation and throttles apply, and the form tags it
 * `voc_app`, which the dashboards leave out. It carries ids only (microFeedbackPayload.ts).
 *
 * Keyboard and screen readers: native buttons with names, the chosen thumb `aria-pressed`, the text box focused once a
 * thumb is chosen and named by its question, the outcome announced (`role="status"`, an error `role="alert"`).
 * Namespace: `components` (`microFeedback.*`).
 *
 * @module components/MicroFeedback/MicroFeedback
 */
import { ThumbsDown, ThumbsUp, X } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { appFeedbackApi } from '../../api/appFeedbackApi'
import type { AppFeedbackAction } from '../../api/appFeedbackApi'
import { BUILD_INFO } from '../../pages/Settings/buildInfo'
import { useAuthStore } from '../../store/authStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { appPathname } from '../../workspace/workspacePath'
import { rememberAnswered, wasAnswered } from './answeredInstances'
import { MAX_MISSING_CHARS, microFeedbackResponse } from './microFeedbackPayload'
import { useAppFeedbackConfig } from './useAppFeedbackConfig'
import type { Verdict } from './microFeedbackPayload'

interface Props {
  readonly action: AppFeedbackAction
  /** The action's instance (a job, document, persona or run id): asked once per instance. */
  readonly instance: string
  readonly className?: string
}

type Phase = 'ask' | 'missing' | 'sending' | 'thanks' | 'failed' | 'closed'

function Thumbs({ verdict, onChoose, onClose, labelId }: Readonly<{
  verdict: Verdict | null
  onChoose: (verdict: Verdict) => void
  onClose: () => void
  labelId: string
}>) {
  const { t } = useTranslation('components')
  const thumb = (value: Verdict) => clsx('btn btn-ghost btn-sm', verdict === value && 'nav-active')
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1">
      <span id={labelId} className="mr-1 text-sm text-text">{t('microFeedback.question')}</span>
      <button type="button" className={thumb('up')} aria-pressed={verdict === 'up'} aria-label={t('microFeedback.up')}
        onClick={() => onChoose('up')}>
        <ThumbsUp size={14} aria-hidden="true" />
      </button>
      <button type="button" className={thumb('down')} aria-pressed={verdict === 'down'} aria-label={t('microFeedback.down')}
        onClick={() => onChoose('down')}>
        <ThumbsDown size={14} aria-hidden="true" />
      </button>
      {verdict === null && (
        <button type="button" className="btn btn-ghost btn-sm" aria-label={t('microFeedback.notNow')} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function Missing({ value, onChange, onSend, sending }: Readonly<{
  value: string
  onChange: (value: string) => void
  onSend: () => void
  sending: boolean
}>) {
  const { t } = useTranslation('components')
  const id = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { box.current?.focus() }, [])
  return (
    <div className="mt-2 space-y-2">
      <label htmlFor={id} className="block text-sm text-text">{t('microFeedback.missing')}</label>
      <textarea id={id} ref={box} rows={2} maxLength={MAX_MISSING_CHARS} value={value} disabled={sending}
        onChange={(event) => onChange(event.target.value)} className="input w-full text-sm"
        aria-describedby={`${id}-count`} />
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-count`} className="text-xs text-muted tabular-nums">
          {t('microFeedback.count', { length: value.length, max: MAX_MISSING_CHARS })}
        </span>
        <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={onSend}>
          {t('microFeedback.send')}
        </button>
      </div>
    </div>
  )
}

function Thanks() {
  const { t } = useTranslation('components')
  return <p role="status" className="text-sm text-muted">{t('microFeedback.thanks')}</p>
}

/** The send's failure, with a retry (nothing while it is not failed). */
function Failure({ phase, onRetry }: Readonly<{ phase: Phase; onRetry: () => void }>) {
  const { t } = useTranslation('components')
  if (phase !== 'failed') return null
  return (
    <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-danger">
      {t('microFeedback.failed')}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t('microFeedback.retry')}</button>
    </p>
  )
}

export default function MicroFeedback({ action, instance, className }: Readonly<Props>) {
  const { i18n } = useTranslation('components')
  const config = useAppFeedbackConfig()
  const sub = useAuthStore().user?.sub
  const role = useCurrentWorkspace()?.role ?? null
  const labelId = useId()
  const [phase, setPhase] = useState<Phase>(() => (wasAnswered(sub, action, instance) ? 'closed' : 'ask'))
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [missing, setMissing] = useState('')
  const formId = config.form_id
  if (!config.active || formId === null || !config.actions.includes(action) || phase === 'closed') return null
  if (phase === 'thanks') return <div className={className}><Thanks /></div>

  const close = () => { rememberAnswered(sub, action, instance); setPhase('closed') }
  const send = () => {
    if (verdict === null) return
    setPhase('sending')
    const response = microFeedbackResponse({
      verdict, missing, action, pathname: appPathname(), appVersion: BUILD_INFO.version, workspaceRole: role,
      uiLanguage: i18n.language, formLanguages: config.form?.languages ?? [],
    })
    appFeedbackApi.submit(formId, response).then((ok) => {
      if (ok) rememberAnswered(sub, action, instance)
      setPhase(ok ? 'thanks' : 'failed')
    }, () => setPhase('failed'))
  }
  return (
    <div className={clsx('rounded-lg border border-border bg-bg-accent p-3', className)} data-testid="micro-feedback"
      data-action={action}>
      <Thumbs verdict={verdict} labelId={labelId} onClose={close}
        onChoose={(value) => { setVerdict(value); if (phase === 'ask') setPhase('missing') }} />
      {verdict !== null && <Missing value={missing} onChange={setMissing} onSend={send} sending={phase === 'sending'} />}
      <Failure phase={phase} onRetry={send} />
    </div>
  )
}
