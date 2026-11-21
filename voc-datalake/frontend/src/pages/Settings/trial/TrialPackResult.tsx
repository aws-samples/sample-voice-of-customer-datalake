/**
 * @fileoverview What Create a trial did (7.71.00): each starter-pack step, done or refused with the server's reason
 * (the trial exists either way; its admin can finish a refused step by hand), and the way into the new workspace's
 * import wizard (`/scrapers/import`), where its feedback and the workshop's survey come in.
 *
 * @module pages/Settings/trial/TrialPackResult
 */
import { useTranslation } from 'react-i18next'
import { CheckCircle2, LogIn, XCircle } from 'lucide-react'
import type { PackStep } from './trialPack'

/** Each step's line, done and refused. */
const STEP_TEXT: Readonly<Record<PackStep['kind'], { readonly okKey: string; readonly failedKey: string }>> = {
  member: { okKey: 'common:workspaces.trial.done.member', failedKey: 'common:workspaces.trial.done.memberFailed' },
  form: { okKey: 'common:workspaces.trial.done.form', failedKey: 'common:workspaces.trial.done.formFailed' },
  categories: { okKey: 'common:workspaces.trial.done.categories', failedKey: 'common:workspaces.trial.done.categoriesFailed' },
}

function stepText(t: (key: string, options?: Record<string, unknown>) => string, step: PackStep): string {
  const reason = step.reason ?? t('workspaces.trial.done.unknownReason')
  return t(step.ok ? STEP_TEXT[step.kind].okKey : STEP_TEXT[step.kind].failedKey, { subject: step.subject, reason })
}

export default function TrialPackResult({ name, steps, onOpenImport }: Readonly<{
  name: string
  steps: readonly PackStep[]
  onOpenImport: () => void
}>) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3" role="status">
      <p className="text-sm font-semibold text-text-strong">{t('workspaces.trial.done.title', { name })}</p>
      {steps.length === 0 ? null : (
        <ul className="space-y-1 text-sm" aria-label={t('workspaces.trial.done.stepsLabel')}>
          {steps.map((step) => (
            // One step per person (the invite list holds each address once), per form and for the categories.
            <li key={`${step.kind}:${step.subject}`} className="flex items-start gap-2">
              {step.ok
                ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-ok" aria-hidden="true" />
                : <XCircle size={16} className="mt-0.5 flex-shrink-0 text-danger" aria-hidden="true" />}
              <span className={step.ok ? 'text-text' : 'text-danger'}>{stepText(t, step)}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-primary gap-1.5" onClick={onOpenImport}>
        <LogIn size={16} aria-hidden="true" />{t('workspaces.trial.done.openImport', { name })}
      </button>
    </div>
  )
}
