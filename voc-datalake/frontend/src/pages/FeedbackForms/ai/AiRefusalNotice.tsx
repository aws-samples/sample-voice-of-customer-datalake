/**
 * @fileoverview Why the AI could not draft, in words, with the one thing to do about it (UX §12.4): each refusal its
 * own message; an administrator also gets the link to the setting that fixes it. Nothing is greyed out without words.
 *
 * @module pages/FeedbackForms/ai/AiRefusalNotice
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, CircleX, GraduationCap, Info, MessageCircleQuestionMark, RotateCcw } from 'lucide-react'
import Notice from '../../../components/Notice/Notice'
import { openAssistant } from '../../../assistant/store/openAssistant'
import { useAuthStore, useIsAdmin } from '../../../store/authStore'
import { adminPath } from '../../Settings/adminPaths'
import type { AiRefusal } from './aiRefusal'

const AI_MODELS_PATH = adminPath({ tab: 'ai', section: null })

function AdminLink({ to, label }: Readonly<{ to: string; label: string }>) {
  return <Link to={to} className="link text-[13px]">{label}</Link>
}

function AiModeNote() {
  const { t } = useTranslation('feedbackForms')
  const isAdmin = useIsAdmin()
  const username = useAuthStore((state) => state.user?.username ?? '')
  return (
    <div role="note" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-accent px-3 py-2 text-[13px] text-text">
      <GraduationCap size={16} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="mr-auto">{t('ai.refusal.aiMode')}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openAssistant({ prompt: t('ai.refusal.coachPrompt') })}>
        <MessageCircleQuestionMark size={14} aria-hidden="true" />{t('ai.refusal.coachMe')}
      </button>
      {isAdmin
        ? <AdminLink to={adminPath({ tab: 'people', section: null }, username === '' ? null : username)} label={t('ai.refusal.changeInPeople')} />
        : <span className="text-muted">{t('ai.refusal.askAdminMode')}</span>}
    </div>
  )
}

function NoModelNote() {
  const { t } = useTranslation('feedbackForms')
  const isAdmin = useIsAdmin()
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info-subtle px-3 py-2 text-[13px] text-text">
      <Info size={16} className="shrink-0 text-info" aria-hidden="true" />
      <span className="mr-auto">{t('ai.refusal.noModel')}</span>
      {isAdmin ? <AdminLink to={AI_MODELS_PATH} label={t('ai.refusal.openAiModels')} /> : <span>{t('ai.refusal.askAdminModel')}</span>}
    </div>
  )
}

function SpendCapNote() {
  const { t } = useTranslation('feedbackForms')
  const isAdmin = useIsAdmin()
  return (
    <Notice variant="banner" tone="warn" role="status" icon={AlertTriangle} text={t('ai.refusal.spendCap')}
      action={isAdmin ? { label: t('ai.refusal.openAiModels'), to: AI_MODELS_PATH } : undefined} />
  )
}

function InvalidAlert({ errors, onRetry }: Readonly<{ errors: readonly string[]; onRetry: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div role="alert" className="space-y-2 rounded-md border border-danger/30 bg-danger-subtle p-3 text-[13px] text-text">
      <p className="flex items-center gap-1.5 font-medium text-danger"><CircleX size={14} aria-hidden="true" />{t('ai.refusal.invalid')}</p>
      <p>{t('ai.refusal.invalidHint')}</p>
      {errors.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[12px] font-medium text-muted">{t('ai.refusal.details')}</summary>
          <ul className="mt-1 list-disc pl-4">{errors.map((error) => <li key={error}>{error}</li>)}</ul>
        </details>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
        <RotateCcw size={14} aria-hidden="true" />{t('ai.refusal.tryAgain')}
      </button>
    </div>
  )
}

function FailedAlert({ text, onRetry }: Readonly<{ text: string; onRetry?: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <Notice variant="banner" tone="danger" role="alert" icon={CircleX} text={text}
      action={onRetry === undefined ? undefined : { label: t('ai.refusal.tryAgain'), icon: RotateCcw, onClick: onRetry }} />
  )
}

export default function AiRefusalNotice({ refusal, waitMinutes, onRetry }: Readonly<{
  refusal: AiRefusal
  /** Minutes left of a rate limit (0: it is over). */
  waitMinutes: number
  onRetry: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  switch (refusal.kind) {
    case 'role': return <p role="note" className="rounded-lg border border-border bg-bg-accent px-3 py-2 text-[13px] text-text">{t('ai.refusal.role')}</p>
    case 'aiMode': return <AiModeNote />
    case 'noModel': return <NoModelNote />
    case 'spendCap': return <SpendCapNote />
    case 'rateLimited':
      return (
        <Notice variant="banner" tone="warn" role="status" icon={AlertTriangle}
          text={waitMinutes > 0 ? t('ai.refusal.rateLimited', { minutes: waitMinutes }) : t('ai.refusal.rateLimitOver')} />
      )
    case 'invalid': return <InvalidAlert errors={refusal.errors} onRetry={onRetry} />
    case 'noAnswer': return <FailedAlert text={t('ai.refusal.noAnswer')} onRetry={onRetry} />
    case 'other': return <FailedAlert text={t('ai.refusal.other', { message: refusal.message })} />
  }
}
