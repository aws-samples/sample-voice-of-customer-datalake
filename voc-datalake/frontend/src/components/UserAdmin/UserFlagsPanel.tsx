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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Flag } from 'lucide-react'
import { readUserFlags, userFlagsApi } from '../../api/userFlagsApi'
import type { UserFlag, UserFlags } from '../../api/userFlagsApi'
import type { CognitoUser } from '../../api/types'

interface FlagChange {
  username: string
  flag: UserFlag
  value: boolean
}

export default function UserFlagsPanel({ users }: Readonly<{ users: readonly CognitoUser[] }>) {
  const { t } = useTranslation('components')
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: ({ username, flag, value }: FlagChange) => userFlagsApi.save(username, { [flag]: value }),
    // Refetch: setting a fallback owner clears the previous one server-side.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  return (
    // A fieldset, not a heading: the Settings card owns the only section heading.
    <fieldset className="border border-border rounded-lg p-4">
      <legend className="flex items-center gap-2 px-1 text-sm font-semibold tracking-tight text-text-strong">
        <Flag size={14} className="text-accent" /> {t('userAdmin.flags.title')}
      </legend>
      <p className="text-xs text-muted mb-3">{t('userAdmin.flags.description')}</p>
      {save.isError ? (
        <p role="alert" className="text-xs text-danger flex items-center gap-1 mb-2">
          <AlertCircle size={12} /> {t('userAdmin.flags.saveFailed')}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {users.map((user) => (
          <UserFlagsRow
            key={user.username}
            user={user}
            flags={readUserFlags(user)}
            disabled={save.isPending}
            onChange={(flag, value) => save.mutate({ username: user.username, flag, value })}
          />
        ))}
      </ul>
    </fieldset>
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
