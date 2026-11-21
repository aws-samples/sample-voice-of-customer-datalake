/**
 * @fileoverview Create a trial (7.71.00; docs/multi-workspace.md "Trial workspaces"), for platform admins at the end
 * of a workshop: a name, an address and a length (14, 30 or 60 days, 30 by default), the people to add (email, role
 * and a suggested role playbook), and a starter pack (forms from the workshop and in-app feedback templates, Off, and
 * the sample categories). One step: `POST /platform/workspaces` with `trial` (its schedule first, so the trial is never
 * left without its end), then the pack as ordinary creates in the new workspace with the admin's own credentials
 * (trialPack.ts), then the way into its import wizard.
 *
 * It says plainly what the end does: the trial PAUSES (plugins and live forms stop, nothing is deleted, reads and the
 * export keep working) until a platform admin extends or converts it; it never deletes itself.
 *
 * @module pages/Settings/trial/CreateTrialDialog
 */
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CirclePause, Hourglass, Loader2 } from 'lucide-react'
import ModalShell from '../../../components/ModalShell/ModalShell'
import Notice from '../../../components/Notice/Notice'
import {
  DEFAULT_TRIAL_DAYS, platformWorkspacesApi, toTrialDays, TRIAL_DAYS, WORKSPACE_NAME_MAX,
} from '../../../api/platformWorkspacesApi'
import type { CreatedWorkspace, TrialDays } from '../../../api/platformWorkspacesApi'
import { SLUG_MAX_LENGTH } from '../../../workspace/workspacePath'
import RefusalAlert from '../../../workspace/RefusalAlert'
import { PLATFORM_REFUSALS } from '../../../workspace/workspaceRefusals'
import { appFormLanguage, useCreateInCopy } from '../../FeedbackForms/picker/useCreateInCopy'
import { workspaceDraftProblems } from '../workspaceDraft'
import InviteList from './InviteList'
import { isInviteEmail } from './invites'
import type { InviteDraft } from './invites'
import TrialPackResult from './TrialPackResult'
import { applyStarterPack, STARTER_CATEGORIES, STARTER_TEMPLATES } from './trialPack'
import type { PackStep } from './trialPack'

interface Created { readonly workspace: CreatedWorkspace; readonly steps: readonly PackStep[] }

/** The invite list as the member add takes it: trimmed, each address once (the first row wins). */
function invitees(drafts: readonly InviteDraft[]) {
  const seen = new Set<string>()
  return drafts.flatMap(({ email, role, playbook }) => {
    const address = email.trim()
    if (seen.has(address.toLowerCase())) return []
    seen.add(address.toLowerCase())
    return [{ email: address, role, playbook }]
  })
}

function PackChoices({ forms, categories, disabled, onForms, onCategories }: Readonly<{
  forms: readonly string[]; categories: boolean; disabled: boolean
  onForms: (next: string[]) => void; onCategories: (next: boolean) => void
}>) {
  const { t } = useTranslation()
  const { t: tf } = useTranslation('feedbackForms')
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-text-strong">{t('workspaces.trial.pack.title')}</legend>
      <p className="text-xs text-muted">{t('workspaces.trial.pack.hint')}</p>
      {STARTER_TEMPLATES.map((flow) => (
        <label key={flow.id} className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="accent-accent" checked={forms.includes(flow.id)} disabled={disabled}
            onChange={(event) => onForms(event.target.checked ? [...forms, flow.id] : forms.filter((id) => id !== flow.id))} />
          {t('workspaces.trial.pack.form', { name: tf(`templates.${flow.id}.name`) })}
        </label>
      ))}
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" checked={categories} disabled={disabled}
          onChange={(event) => onCategories(event.target.checked)} />
        {t('workspaces.trial.pack.categories', { n: STARTER_CATEGORIES.length })}
      </label>
    </fieldset>
  )
}

export default function CreateTrialDialog({ onClose, onOpenImport }: Readonly<{
  onClose: () => void
  /** Enter the new workspace's import wizard (a full page load). */
  onOpenImport: (workspace: CreatedWorkspace) => void
}>) {
  const { t, i18n } = useTranslation()
  const ids = { title: useId(), name: useId(), slug: useId(), days: useId() }
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [days, setDays] = useState<TrialDays>(DEFAULT_TRIAL_DAYS)
  const [drafts, setDrafts] = useState<InviteDraft[]>([{ key: 1, email: '', role: 'admin', playbook: null }])
  const [forms, setForms] = useState<string[]>(STARTER_TEMPLATES.map((flow) => flow.id))
  const [categories, setCategories] = useState(true)
  const [tried, setTried] = useState(false)
  const copy = useCreateInCopy(appFormLanguage(i18n.language))
  const create = useMutation({
    mutationFn: async (): Promise<Created> => {
      const workspace = await platformWorkspacesApi.createTrial(name.trim(), slug.trim(), days,
        { forms, categories, playbooks: drafts.some((draft) => draft.playbook !== null) })
      const steps = await applyStarterPack(workspace.id, { invitees: invitees(drafts), forms, categories }, copy.formOf)
      return { workspace, steps }
    },
  })
  const problems = workspaceDraftProblems(name, slug.trim())
  const ready = problems.length === 0 && drafts.every((draft) => isInviteEmail(draft.email)) && copy.ready
  const busy = create.isPending
  const done = create.data
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={ids.title} dismissable={!busy} panelClassName="w-full max-w-2xl max-h-[90vh]">
      <div className="dialog-header">
        <Hourglass className="text-accent" size={18} aria-hidden="true" />
        <h2 id={ids.title} className="dialog-title">{t('workspaces.trial.dialogTitle')}</h2>
      </div>
      {done === undefined ? (
        <form className="contents" noValidate onSubmit={(event) => {
          event.preventDefault()
          setTried(true)
          if (ready && !busy) create.mutate()
        }}>
          <div className="dialog-body space-y-4">
            <Notice variant="banner" tone="warn" role="note" icon={CirclePause} text={t('workspaces.trial.pausesNotice')} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]">
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label htmlFor={ids.name}>{t('workspaces.platform.name')}</label>
                <input id={ids.name} className="input" value={name} maxLength={WORKSPACE_NAME_MAX} autoComplete="off" disabled={busy}
                  aria-invalid={tried && problems.includes('name')} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label htmlFor={ids.slug}>{t('workspaces.platform.slug')}</label>
                <input id={ids.slug} className="input font-mono" value={slug} maxLength={SLUG_MAX_LENGTH} autoComplete="off"
                  spellCheck={false} autoCapitalize="none" disabled={busy} aria-invalid={tried && problems.includes('slug')}
                  onChange={(event) => setSlug(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={ids.days}>{t('workspaces.trial.days')}</label>
                <select id={ids.days} className="input" value={days} disabled={busy} onChange={(event) => setDays(toTrialDays(event.target.value))}>
                  {TRIAL_DAYS.map((option) => <option key={option} value={option}>{t('workspaces.trial.daysOption', { days: option })}</option>)}
                </select>
              </div>
            </div>
            {tried && problems.length > 0 ? <p className="text-xs text-danger" role="alert">{t('workspaces.trial.fixNameSlug')}</p> : null}
            <InviteList drafts={drafts} showErrors={tried} disabled={busy} onChange={setDrafts} />
            <PackChoices forms={forms} categories={categories} disabled={busy} onForms={setForms} onCategories={setCategories} />
            <RefusalAlert error={create.error} refusals={PLATFORM_REFUSALS} />
          </div>
          <div className="dialog-footer flex-col-reverse sm:flex-row sm:gap-3">
            <button type="button" className="btn btn-secondary w-full sm:w-auto" disabled={busy} onClick={onClose}>{t('common:cancel')}</button>
            <button type="submit" className="btn btn-primary gap-2 w-full sm:w-auto" disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
              {busy ? t('workspaces.trial.creating') : t('workspaces.trial.submit')}
            </button>
          </div>
        </form>
      ) : (
        <div className="dialog-body">
          <TrialPackResult name={done.workspace.name} steps={done.steps} onOpenImport={() => onOpenImport(done.workspace)} />
        </div>
      )}
    </ModalShell>
  )
}
