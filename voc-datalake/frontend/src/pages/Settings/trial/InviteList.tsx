/**
 * @fileoverview The invite list of Create a trial (7.71.00): one row per person, their email, their role in the trial
 * workspace and the role playbook to suggest to them (offered first on their Home). They are added through the
 * existing member add once the trial exists; someone with no account gets one, and Cognito emails them a temporary
 * password (said above the list).
 *
 * @module pages/Settings/trial/InviteList
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { PLAYBOOK_ROLES } from '../../../api/onboardingApi'
import type { PlaybookRole } from '../../../api/onboardingApi'
import { WORKSPACE_ROLES } from '../../../api/workspacesApi'
import type { WorkspaceRole } from '../../../api/workspacesApi'
import { ROLE_TEXT } from '../../Home/playbooks/playbookCatalogue'
import { isInviteEmail } from './invites'
import type { InviteDraft } from './invites'

const asRole = (value: string): WorkspaceRole => WORKSPACE_ROLES.find((role) => role === value) ?? 'editor'
const asPlaybook = (value: string): PlaybookRole | null => PLAYBOOK_ROLES.find((role) => role === value) ?? null

function InviteRow({ draft, invalid, disabled, onChange, onRemove }: Readonly<{
  draft: InviteDraft; invalid: boolean; disabled: boolean
  onChange: (next: InviteDraft) => void; onRemove: () => void
}>) {
  const { t } = useTranslation()
  const { t: tp } = useTranslation('playbooks')
  const ids = { email: useId(), role: useId(), playbook: useId(), error: useId() }
  return (
    <li className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_11rem_auto] sm:items-end">
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <label htmlFor={ids.email}>{t('workspaces.trial.invites.email')}</label>
        <input id={ids.email} type="email" className="input" value={draft.email} disabled={disabled} autoComplete="off"
          aria-invalid={invalid} aria-describedby={invalid ? ids.error : undefined}
          onChange={(event) => onChange({ ...draft, email: event.target.value })} />
        {invalid ? <span id={ids.error} className="text-xs text-danger">{t('workspaces.trial.invites.emailInvalid')}</span> : null}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={ids.role}>{t('workspaces.trial.invites.role')}</label>
        <select id={ids.role} className="input" value={draft.role} disabled={disabled}
          onChange={(event) => onChange({ ...draft, role: asRole(event.target.value) })}>
          {WORKSPACE_ROLES.map((role) => <option key={role} value={role}>{t(`workspaces.role.${role}`)}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={ids.playbook}>{t('workspaces.trial.invites.playbook')}</label>
        <select id={ids.playbook} className="input" value={draft.playbook ?? ''} disabled={disabled}
          onChange={(event) => onChange({ ...draft, playbook: asPlaybook(event.target.value) })}>
          <option value="">{t('workspaces.trial.invites.noPlaybook')}</option>
          {PLAYBOOK_ROLES.map((role) => <option key={role} value={role}>{tp(ROLE_TEXT[role].name)}</option>)}
        </select>
      </div>
      <button type="button" className="btn btn-ghost btn-sm self-end" disabled={disabled} onClick={onRemove}
        aria-label={draft.email.trim() === '' ? t('workspaces.trial.invites.removeUnnamed')
          : t('workspaces.trial.invites.remove', { email: draft.email.trim() })}>
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  )
}

export default function InviteList({ drafts, showErrors, disabled, onChange }: Readonly<{
  drafts: readonly InviteDraft[]
  /** Say which rows hold an address that cannot be one (after a submit). */
  showErrors: boolean
  disabled: boolean
  onChange: (next: InviteDraft[]) => void
}>) {
  const { t } = useTranslation()
  const nextKey = Math.max(0, ...drafts.map((draft) => draft.key)) + 1
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-text-strong">{t('workspaces.trial.invites.title')}</legend>
      <p className="text-xs text-muted">{t('workspaces.trial.invites.hint')}</p>
      <ul className="space-y-2">
        {drafts.map((draft) => (
          <InviteRow key={draft.key} draft={draft} disabled={disabled} invalid={showErrors && !isInviteEmail(draft.email)}
            onChange={(next) => onChange(drafts.map((row) => (row.key === draft.key ? next : row)))}
            onRemove={() => onChange(drafts.filter((row) => row.key !== draft.key))} />
        ))}
      </ul>
      <button type="button" className="btn btn-secondary btn-sm gap-1.5" disabled={disabled}
        onClick={() => onChange([...drafts, { key: nextKey, email: '', role: 'editor', playbook: null }])}>
        <Plus size={14} aria-hidden="true" />{t('workspaces.trial.invites.add')}
      </button>
    </fieldset>
  )
}
