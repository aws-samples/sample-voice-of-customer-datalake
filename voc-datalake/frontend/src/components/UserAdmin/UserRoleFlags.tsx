/**
 * @fileoverview People → a person's editor: the role, the two per-user flags and platform admin, each saved the moment
 * it changes (useSheetSave.ts).
 *
 * - **Role**: User or Admin (`PUT /users/{username}/group`).
 * - **Fallback owner**: the admin who receives agent-created projects whose category has no owner. Admins only, and at
 *   most one: checking it on one person clears it on whoever had it (the server enforces the same rule). A non-admin
 *   who still holds it may clear it. **Memory reviewer**: may curate company memory (review, merge, imports).
 * - **Platform admin** (`platform-admins`, docs/multi-workspace.md → Control plane), shown to platform admins only:
 *   they alone may grant and revoke it (`PUT /users/{username}/platform-admin`). Only an administrator can be granted
 *   it (the server answers 400 otherwise); the last enabled platform admin cannot be revoked (409). Each refusal is
 *   said in words, and why a box is off is said beside it.
 *
 * @module components/UserAdmin/UserRoleFlags
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { readUserFlags, userFlagsApi } from '../../api/userFlagsApi'
import type { UserFlag, UserFlags } from '../../api/userFlagsApi'
import type { CognitoUser } from '../../api/types'
import { useIsPlatformAdmin } from '../../store/authStore'
import RefusalAlert from '../../workspace/RefusalAlert'
import { PLATFORM_ADMIN_REFUSALS } from '../../workspace/workspaceRefusals'
import SheetSection from './SheetSection'
import { isAdminUser } from './userFacts'
import type { UserGroup } from './userFacts'
import { useSheetSave } from './useSheetSave'

/** `PUT .../group` answers `{success: false}` for a refusal it explains; that is a failed save too. */
async function saveGroup(username: string, group: UserGroup): Promise<void> {
  const answer = await api.updateUserGroup(username, group)
  if (!answer.success) throw new Error(answer.message)
}

export function RoleSection({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  const selectId = useId()
  const save = useSheetSave((group: UserGroup) => saveGroup(user.username, group))
  const current: UserGroup = isAdminUser(user) ? 'admins' : 'users'
  return (
    <SheetSection title={t('userAdmin.editor.sections.role')} hint={t('userAdmin.editor.roleHint')}
      error={save.isError ? t('userAdmin.editor.roleFailed') : null}>
      <label htmlFor={selectId} className="sr-only">{t('userAdmin.roleLabel')}</label>
      <select id={selectId} value={current} disabled={save.isPending} className="select w-auto"
        onChange={(event) => {
          const next = event.target.value
          if ((next === 'admins' || next === 'users') && next !== current) save.mutate(next)
        }}>
        <option value="users">{t('userAdmin.userRole')}</option>
        <option value="admins">{t('userAdmin.adminRole')}</option>
      </select>
    </SheetSection>
  )
}

function FlagBox({ label, checked, disabled, reason, onChange }: Readonly<{
  label: string
  checked: boolean
  disabled: boolean
  /** Why the box is off, said beside it and as its description; null: it is not locked. */
  reason: string | null
  onChange: (checked: boolean) => void
}>) {
  const reasonId = useId()
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center gap-2 text-[13px] text-text">
        <input type="checkbox" className="accent-accent" checked={checked} disabled={disabled || reason !== null}
          aria-describedby={reason === null ? undefined : reasonId} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
      {reason === null ? null : <span id={reasonId} className="ps-6 text-xs text-muted">{reason}</span>}
    </div>
  )
}

export function FlagsSection({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  // Setting a fallback owner clears the previous one server-side: the users refetch after each save shows it.
  const save = useSheetSave((patch: Partial<UserFlags>) => userFlagsApi.save(user.username, patch))
  const flags = readUserFlags(user)
  const change = (flag: UserFlag, value: boolean) => { save.mutate({ [flag]: value }) }
  // A non-admin may not take it, but one who still holds it may clear it.
  const fallbackLocked = !isAdminUser(user) && !flags.fallback_owner
  return (
    <SheetSection title={t('userAdmin.editor.sections.flags')} hint={t('userAdmin.flags.description')}
      error={save.isError ? t('userAdmin.flags.saveFailed') : null}>
      <FlagBox label={t('userAdmin.flags.fallbackOwner')} checked={flags.fallback_owner} disabled={save.isPending}
        reason={fallbackLocked ? t('userAdmin.flags.fallbackAdminOnly') : null} onChange={(value) => change('fallback_owner', value)} />
      <FlagBox label={t('userAdmin.flags.memoryReviewer')} checked={flags.memory_reviewer} disabled={save.isPending}
        reason={null} onChange={(value) => change('memory_reviewer', value)} />
    </SheetSection>
  )
}

/** Shown to platform admins only (they alone may change it); nothing for anyone else. */
export function PlatformAdminSection({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation()
  const isPlatformAdmin = useIsPlatformAdmin()
  const save = useSheetSave((platformAdmin: boolean) => api.setPlatformAdmin(user.username, platformAdmin))
  if (!isPlatformAdmin) return null
  const granted = user.platform_admin === true
  // A grant needs an administrator; a platform admin who is one no longer can still be revoked.
  const locked = !isAdminUser(user) && !granted
  return (
    <SheetSection title={t('components:userAdmin.editor.sections.platformAdmin')} hint={t('workspaces.platformAdmins.description')}>
      <FlagBox label={t('workspaces.platformAdmins.label')} checked={granted} disabled={save.isPending}
        reason={locked ? t('workspaces.platformAdmins.adminsOnly') : null} onChange={(value) => save.mutate(value)} />
      {save.isError ? <RefusalAlert error={save.error} refusals={PLATFORM_ADMIN_REFUSALS} /> : null}
    </SheetSection>
  )
}
