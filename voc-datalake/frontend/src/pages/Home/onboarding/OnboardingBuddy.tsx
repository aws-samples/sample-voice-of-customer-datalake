/**
 * @fileoverview The onboarding buddy: Home's setup checklist.
 *
 * Every step ticks itself from real state (`useOnboardingSteps`) and links to
 * where it is done. Progress is a labelled progressbar. Before the end, Skip is
 * always offered; once every step is done the card turns into "You're ready"
 * with Hide for now (a server-side one-day snooze) and Don't show again. All
 * three choices are stored per user on the server (`onChoose`), and the
 * checklist comes back from the Account page.
 *
 * @module pages/Home/onboarding/OnboardingBuddy
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Circle, Loader2, PartyPopper } from 'lucide-react'
import clsx from 'clsx'
import { useIsAdmin } from '../../../store/authStore'
import { progressOf } from './onboardingSteps'
import { useOnboardingSteps } from './useOnboardingSteps'
import type { OnboardingPreference, OnboardingState } from '../../../api/onboardingApi'
import type { OnboardingStep, Progress, StepStatus } from './onboardingSteps'

interface Props {
  signals: OnboardingPreference['signals']
  onChoose: (state: OnboardingState) => void
  isSaving: boolean
  saveFailed: boolean
}

const STATUS_KEY: Record<StepStatus, string> = {
  done: 'home.buddy.statusDone',
  todo: 'home.buddy.statusTodo',
  pending: 'home.buddy.statusPending',
}

/** i18n keys per step: the categories step keeps the strings of the card it replaces. */
const STEP_TEXT: Record<OnboardingStep['id'], { title: string; desc: string; cta: string }> = {
  categories: { title: 'home.categoriesTitle', desc: 'home.categoriesDesc', cta: 'home.categoriesCta' },
  source: { title: 'home.buddy.sourceTitle', desc: 'home.buddy.sourceDesc', cta: 'home.buddy.sourceCta' },
  feedback: { title: 'home.buddy.feedbackTitle', desc: 'home.buddy.feedbackDesc', cta: 'home.buddy.feedbackCta' },
  assistant: { title: 'home.buddy.assistantTitle', desc: 'home.buddy.assistantDesc', cta: 'home.buddy.assistantCta' },
  project: { title: 'home.buddy.projectTitle', desc: 'home.buddy.projectDesc', cta: 'home.buddy.projectCta' },
}

function StatusIcon({ status }: Readonly<{ status: StepStatus }>) {
  if (status === 'done') return <CheckCircle2 size={20} className="text-ok" aria-hidden="true" />
  if (status === 'pending') return <Loader2 size={20} className="animate-spin text-muted" aria-hidden="true" />
  return <Circle size={20} className="text-muted" aria-hidden="true" />
}

function StepLink({ step, isAdmin }: Readonly<{ step: OnboardingStep; isAdmin: boolean }>) {
  const { t } = useTranslation('dashboard')
  // Settings is admin-only: everyone else is told who sets categories up and
  // can still browse them.
  const label = step.id === 'categories' && !isAdmin ? t('common:nav.categories') : t(STEP_TEXT[step.id].cta)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Link to={step.to} className={clsx('btn btn-sm', step.status === 'done' ? 'btn-secondary' : 'btn-primary')}>
        {label}
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
      {step.id === 'source' && (
        <Link to="/feedback-forms" className="btn btn-sm btn-secondary">{t('home.buddy.sourceAltCta')}</Link>
      )}
    </div>
  )
}

function StepItem({ step, isAdmin }: Readonly<{ step: OnboardingStep; isAdmin: boolean }>) {
  const { t } = useTranslation('dashboard')
  const text = STEP_TEXT[step.id]
  return (
    <li data-step={step.id} data-status={step.status} className="flex gap-3 py-3">
      <span className="mt-0.5 flex-shrink-0"><StatusIcon status={step.status} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={clsx('text-sm font-semibold tracking-tight', step.status === 'done' ? 'text-muted line-through' : 'text-text-strong')}>
            {t(text.title)}
          </h3>
          <span className={clsx('badge', step.status === 'done' ? 'badge-ok' : 'badge-muted')}>{t(STATUS_KEY[step.status])}</span>
        </div>
        <p className="mt-1 text-sm text-muted">{t(text.desc)}</p>
        {step.id === 'categories' && !isAdmin && step.status !== 'done' && (
          <p className="mt-1 text-xs text-text">{t('home.categoriesAskAdmin')}</p>
        )}
        <StepLink step={step} isAdmin={isAdmin} />
      </div>
    </li>
  )
}

function ProgressBar({ progress }: Readonly<{ progress: Progress }>) {
  const { t } = useTranslation('dashboard')
  const text = t('home.buddy.progress', { done: progress.done, total: progress.total })
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-medium text-text" aria-hidden="true">{text}</p>
      <div
        role="progressbar"
        aria-label={t('home.buddy.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-valuetext={text}
        className="h-2 w-full overflow-hidden rounded-full bg-bg-accent"
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function Actions({ ready, onChoose, isSaving }: Readonly<{ ready: boolean; onChoose: Props['onChoose']; isSaving: boolean }>) {
  const { t } = useTranslation('dashboard')
  if (!ready) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn btn-ghost btn-sm" disabled={isSaving} onClick={() => onChoose('skipped')}>
          {t('home.buddy.skip')}
        </button>
      </div>
    )
  }
  return (
    <div role="status" className="rounded-lg border border-ok/40 bg-ok-subtle p-4">
      <div className="flex items-start gap-3">
        <PartyPopper size={20} className="mt-0.5 flex-shrink-0 text-ok" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('home.buddy.readyTitle')}</h3>
          <p className="mt-1 text-sm text-text">{t('home.buddy.readyDesc')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={isSaving} onClick={() => onChoose('hidden')}>
              {t('home.buddy.hide')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={isSaving} onClick={() => onChoose('dismissed')}>
              {t('home.buddy.dontShowAgain')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function OnboardingBuddy({ signals, onChoose, isSaving, saveFailed }: Readonly<Props>) {
  const { t } = useTranslation('dashboard')
  const isAdmin = useIsAdmin()
  const steps = useOnboardingSteps(signals)
  const progress = progressOf(steps)
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="card space-y-2" data-testid="onboarding-buddy">
      <div>
        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-text-strong">{t('home.buddy.title')}</h2>
        <ProgressBar progress={progress} />
      </div>
      <ol className="divide-y divide-border">
        {steps.map((step) => <StepItem key={step.id} step={step} isAdmin={isAdmin} />)}
      </ol>
      {saveFailed && <p role="alert" className="text-sm text-danger">{t('home.buddy.saveFailed')}</p>}
      <Actions ready={progress.ready} onChoose={onChoose} isSaving={isSaving} />
    </section>
  )
}
