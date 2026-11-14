/**
 * @fileoverview Settings → Users: who is a platform admin (`platform-admins`; docs/multi-workspace.md → Control
 * plane), shown to platform admins only: they alone may grant and revoke it (`PUT /users/{username}/platform-admin`).
 *
 * Only an administrator can be granted it (a plain user's box is off, and the server answers 400); the last enabled
 * platform admin cannot be revoked, the caller included (409). Each refusal is said in words. A grant or a revoke
 * reaches the person's own session at its next token refresh.
 *
 * @module components/UserAdmin/PlatformAdminPanel
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2 } from 'lucide-react'
import { api } from '../../api/client'
import type { CognitoUser } from '../../api/types'
import { useIsPlatformAdmin } from '../../store/authStore'
import { PLATFORM_ADMIN_REFUSALS } from '../../workspace/workspaceRefusals'
import UserSettingsPanel from './UserSettingsPanel'

const savePlatformAdmin = (username: string, platformAdmin: boolean) => api.setPlatformAdmin(username, platformAdmin)

export default function PlatformAdminPanel({ users }: Readonly<{ users: readonly CognitoUser[] }>) {
  const { t } = useTranslation()
  const isPlatformAdmin = useIsPlatformAdmin()
  if (!isPlatformAdmin) return null
  const copy = {
    title: t('workspaces.platformAdmins.title'),
    description: t('workspaces.platformAdmins.description'),
    saveFailed: t('workspaces.errors.generic'),
  }
  return (
    <UserSettingsPanel icon={Building2} copy={copy} save={savePlatformAdmin} users={users} refusals={PLATFORM_ADMIN_REFUSALS}
      row={(user, edit) => <PlatformAdminRow key={user.username} user={user} disabled={edit.disabled} onChange={edit.change} />} />
  )
}

function PlatformAdminRow({ user, disabled, onChange }: Readonly<{
  user: CognitoUser
  disabled: boolean
  onChange: (platformAdmin: boolean) => void
}>) {
  const { t } = useTranslation()
  const who = user.email || user.username
  const granted = user.platform_admin === true
  // A grant needs an administrator; a platform admin who is one no longer can still be revoked.
  const grantable = user.groups.includes('admins')
  // Why the box is off is said in the row, and named as the box's description.
  const reasonId = useId()
  const locked = !grantable && !granted
  return (
    <li className="flex flex-col sm:flex-row sm:items-center gap-2 py-2">
      <span className="text-sm text-text flex-1 truncate">{who}</span>
      <label className="flex items-center gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          className="accent-accent"
          checked={granted}
          disabled={disabled || locked}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={t('workspaces.platformAdmins.for', { user: who })}
          aria-describedby={locked ? reasonId : undefined}
        />
        {t('workspaces.platformAdmins.label')}
      </label>
      {locked ? <span id={reasonId} className="text-xs text-muted">{t('workspaces.platformAdmins.adminsOnly')}</span> : null}
    </li>
  )
}
