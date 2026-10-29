/**
 * @fileoverview Settings → Users: the two per-user flags.
 *
 * - **Fallback owner**: the admin who receives agent-created projects whose
 *   category has no owner. Admins only, and at most one — checking it on one
 *   user clears it on whoever had it (the server enforces the same rule).
 * - **Memory reviewer**: may curate company memory (review, merge, imports).
 *
 * @module components/UserAdmin/UserFlagsPanel
 */
import { useTranslation } from 'react-i18next'
import { Flag } from 'lucide-react'
import { readUserFlags, userFlagsApi } from '../../api/userFlagsApi'
import type { UserFlag, UserFlags } from '../../api/userFlagsApi'
import type { CognitoUser } from '../../api/types'
import UserSettingsPanel from './UserSettingsPanel'

const saveFlags = (username: string, patch: Partial<UserFlags>) => userFlagsApi.save(username, patch)

export default function UserFlagsPanel({ users }: Readonly<{ users: readonly CognitoUser[] }>) {
  const { t } = useTranslation('components')
  // The panel refetches the users after each save: setting a fallback owner clears the previous one server-side.
  const copy = { title: t('userAdmin.flags.title'), description: t('userAdmin.flags.description'), saveFailed: t('userAdmin.flags.saveFailed') }
  return (
    <UserSettingsPanel icon={Flag} copy={copy} save={saveFlags} users={users}
      row={(user, edit) => (
        <UserFlagsRow key={user.username} user={user} flags={readUserFlags(user)} disabled={edit.disabled}
          onChange={(flag, value) => edit.change({ [flag]: value })} />
      )} />
  )
}

function UserFlagsRow({ user, flags, disabled, onChange }: Readonly<{
  user: CognitoUser
  flags: UserFlags
  disabled: boolean
  onChange: (flag: UserFlag, value: boolean) => void
}>) {
  const { t } = useTranslation('components')
  const isAdmin = user.groups.includes('admins')
  const who = user.email || user.username
  return (
    <li className="flex flex-col sm:flex-row sm:items-center gap-2 py-2">
      <span className="text-sm text-text flex-1 truncate">{who}</span>
      <label className="flex items-center gap-2 text-[13px] text-text" title={isAdmin ? undefined : t('userAdmin.flags.fallbackAdminOnly')}>
        <input
          type="checkbox"
          className="accent-accent"
          checked={flags.fallback_owner}
          disabled={disabled || (!isAdmin && !flags.fallback_owner)}
          onChange={(e) => onChange('fallback_owner', e.target.checked)}
          aria-label={t('userAdmin.flags.fallbackOwnerFor', { user: who })}
        />
        {t('userAdmin.flags.fallbackOwner')}
      </label>
      <label className="flex items-center gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          className="accent-accent"
          checked={flags.memory_reviewer}
          disabled={disabled}
          onChange={(e) => onChange('memory_reviewer', e.target.checked)}
          aria-label={t('userAdmin.flags.memoryReviewerFor', { user: who })}
        />
        {t('userAdmin.flags.memoryReviewer')}
      </label>
    </li>
  )
}
