/**
 * @fileoverview The role playbook in Home's onboarding buddy (7.66.00, docs/playbooks.md): the person picks their role
 * (Product, Scrum master, QA, Engineering) and gets that role's first week, five steps, each linking to its
 * screen and saying why it matters. A step ticks itself from real state (the onboarding GET's signals, what Home
 * already reads: playbookSteps.ts); the person may tick any other one by hand, and untick it. "Ask the assistant to
 * walk me through it" opens a new conversation with the playbook prefilled (nothing is sent until they press send).
 *
 * Content only: a role grants nothing and changes no workspace role. The choice and the ticks are the person's own
 * (`PUT /settings/my-onboarding {playbook, playbook_done}`). Namespace: `playbooks`.
 *
 * @module pages/Home/playbooks/RolePlaybook
 */
import { ArrowRight, MessageCircleQuestionMark } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { openAssistant } from '../../../assistant/store/openAssistant'
import { useSuggestedPlaybook } from '../../../workspace/currentTrial'
import ChecklistProgress, { StatusIcon } from '../ChecklistProgress'
import { ROLE_TEXT, ROLES, STEP_TEXT } from './playbookCatalogue'
import { derivePlaybook, toggledTicks } from './playbookSteps'
import { usePlaybookFacts } from './usePlaybookFacts'
import type { OnboardingPreference, PlaybookRole } from '../../../api/onboardingApi'
import type { PlaybookStep } from './playbookSteps'

interface Props {
  readonly preference: Pick<OnboardingPreference, 'playbook' | 'playbook_done' | 'signals'>
  readonly onChooseRole: (role: PlaybookRole | null) => void
  readonly onTicks: (steps: readonly string[]) => void
  readonly isSaving: boolean
}

/** The roles in the picker's order: the one the admin who added the person suggested first (7.71.00), then the rest. */
function pickerOrder(suggested: PlaybookRole | null): readonly PlaybookRole[] {
  return suggested === null ? ROLES : [suggested, ...ROLES.filter((role) => role !== suggested)]
}

function RolePicker({ onChooseRole, isSaving }: Readonly<Pick<Props, 'onChooseRole' | 'isSaving'>>) {
  const { t } = useTranslation('playbooks')
  // The role playbook suggested when the person was added to the workspace (a trial's invite list), if any.
  const suggested = useSuggestedPlaybook()
  return (
    <div className="space-y-2">
      <p id="playbook-pick" className="text-sm text-muted">{t('pick')}</p>
      <ul aria-labelledby="playbook-pick" className="grid gap-2 sm:grid-cols-2">
        {pickerOrder(suggested).map((role) => (
          <li key={role}>
            <button type="button" disabled={isSaving} onClick={() => onChooseRole(role)}
              className={clsx('h-full w-full rounded-lg border p-3 text-left hover:bg-bg-hover focus-ring',
                role === suggested ? 'border-accent' : 'border-border')}>
              <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-strong">
                {t(ROLE_TEXT[role].name)}
                {role === suggested ? <span className="badge badge-accent">{t('suggested')}</span> : null}
              </span>
              <span className="mt-1 block text-xs text-muted">{t(ROLE_TEXT[role].desc)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StepRow({ step, onTick, isSaving }: Readonly<{ step: PlaybookStep; onTick: (done: boolean) => void; isSaving: boolean }>) {
  const { t } = useTranslation('playbooks')
  const text = STEP_TEXT[step.id]
  const done = step.status === 'done'
  // A step its evidence ticked is done for good; one the person ticked they may untick; the rest they may tick.
  const byEvidence = done && !step.ticked
  return (
    <li data-step={step.id} data-status={step.status} className="flex gap-3 py-3">
      <span className="mt-0.5 flex-shrink-0"><StatusIcon status={step.status} /></span>
      <div className="min-w-0 flex-1">
        <h4 className={clsx('text-sm font-semibold tracking-tight', done ? 'text-muted line-through' : 'text-text-strong')}>
          {t(text.title)}
        </h4>
        <p className="mt-1 text-sm text-muted">{t(text.why)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Link to={step.path} className={clsx('btn btn-sm', done ? 'btn-secondary' : 'btn-primary')}>
            {t(text.cta)}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
          {byEvidence ? <span className="badge badge-ok">{t('doneByEvidence')}</span> : (
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" className="rounded-sm accent-accent" checked={step.ticked} disabled={isSaving}
                onChange={(event) => onTick(event.target.checked)} />
              {t('markDone')}
            </label>
          )}
        </div>
      </div>
    </li>
  )
}

function AskAssistant({ role, steps }: Readonly<{ role: PlaybookRole; steps: readonly PlaybookStep[] }>) {
  const { t } = useTranslation('playbooks')
  const list = steps.map((step, index) => `${index + 1}. ${t(STEP_TEXT[step.id].title)}`).join('\n')
  return (
    <button type="button" className="btn btn-secondary btn-sm"
      onClick={() => openAssistant({ prompt: t('askPrompt', { role: t(ROLE_TEXT[role].name), stepList: list }) })}>
      <MessageCircleQuestionMark size={14} aria-hidden="true" />
      {t('askAssistant')}
    </button>
  )
}

function PlaybookChecklist({ role, preference, onChooseRole, onTicks, isSaving }: Readonly<Props & { role: PlaybookRole }>) {
  const { t } = useTranslation('playbooks')
  const steps = derivePlaybook(role, preference, usePlaybookFacts(role))
  const done = steps.filter((step) => step.status === 'done').length
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text">{t('yourRole', { role: t(ROLE_TEXT[role].name) })}</p>
        <button type="button" className="btn btn-ghost btn-sm" disabled={isSaving} onClick={() => onChooseRole(null)}>
          {t('changeRole')}
        </button>
      </div>
      <ChecklistProgress done={done} total={steps.length} label={t('progressLabel')}
        text={t('progress', { done, total: steps.length })} />
      <ol className="divide-y divide-border">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} isSaving={isSaving}
            onTick={(ticked) => onTicks(toggledTicks(preference.playbook_done, step.id, ticked))} />
        ))}
      </ol>
      <AskAssistant role={role} steps={steps} />
    </div>
  )
}

export default function RolePlaybook(props: Readonly<Props>) {
  const { t } = useTranslation('playbooks')
  const role = props.preference.playbook
  return (
    <section aria-labelledby="role-playbook-title" data-testid="role-playbook" className="space-y-3 border-t border-border pt-4">
      <h3 id="role-playbook-title" className="text-sm font-semibold tracking-tight text-text-strong">{t('title')}</h3>
      {role === null
        ? <RolePicker onChooseRole={props.onChooseRole} isSaving={props.isSaving} />
        : <PlaybookChecklist {...props} role={role} />}
    </section>
  )
}
