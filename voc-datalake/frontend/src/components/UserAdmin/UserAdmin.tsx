/**
 * @fileoverview Administration → People (7.54.00): everyone who can sign in, in ONE list (Name, Role, Way of working,
 * Flags, Status), and the one primary of the page, **Invite person**.
 *
 * Everything set per person is set in that person's editor, a SideSheet (UserEditorSheet.tsx): role, way of working
 * with AI, category and source access, the fallback owner and memory reviewer flags, platform admin (platform admins
 * only), the name, the account actions and Delete. The four lists of before (users, flags, platform admins, ways of
 * working) are gone.
 *
 * Where the page is lives in its path (`/admin/people[/<username>|/invite]`, pages/Settings/adminPaths.ts): the host
 * passes the open item (`openItem`: a username, or `invite` for the invite dialog) and the move that opens one
 * (`onOpenItem`, null: none), so Back closes the editor and a copied link opens it. A username the list does not hold
 * opens nothing. Only visible to users in the `admins` group (the routes are admin-only server-side).
 *
 * @module components/UserAdmin
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { usersKey } from '../../api/queryKeys'
import type { CognitoUser } from '../../api/types'
import { PEOPLE_INVITE } from '../../pages/Settings/adminPaths'
import SavedStatus from '../SavedStatus/SavedStatus'
import CreateUserModal from './CreateUserModal'
import UserEditorSheet from './UserEditorSheet'
import { UsersCards, UsersTable } from './UserAdminComponents'

interface UserAdminProps {
  /** The person whose editor is open (their username), `invite` for the invite dialog, or null. */
  readonly openItem: string | null
  readonly onOpenItem: (item: string | null) => void
}

function UsersList({ users, onEdit }: Readonly<{ users: readonly CognitoUser[]; onEdit: (user: CognitoUser) => void }>) {
  return (
    <>
      <UsersTable users={users} onEdit={onEdit} />
      <div className="md:hidden">
        <UsersCards users={users} onEdit={onEdit} />
      </div>
    </>
  )
}

export default function UserAdmin({ openItem, onOpenItem }: UserAdminProps) {
  const { t } = useTranslation('components')
  const queryClient = useQueryClient()
  // What the last removal did ("User deleted"), said until the next move on the page.
  const [notice, setNotice] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({ queryKey: usersKey(), queryFn: () => api.getUsers() })
  const open = (item: string | null) => {
    setNotice(null)
    onOpenItem(item)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-accent" size={32} aria-hidden="true" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-danger-subtle p-4 text-danger">
        <AlertCircle size={20} aria-hidden="true" />
        <span>{t('userAdmin.loadError')}</span>
      </div>
    )
  }

  const users = data?.users ?? []
  const editing = openItem === null || openItem === PEOPLE_INVITE ? undefined : users.find((user) => user.username === openItem)

  return (
    <div className="space-y-4">
      {/* No heading of its own: the People page supplies it. */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">{t('userAdmin.usersCount', { count: users.length })}</span>
          <SavedStatus saved={notice !== null} label={notice ?? undefined} />
        </div>
        <button type="button" onClick={() => open(PEOPLE_INVITE)} className="btn btn-primary flex w-full items-center justify-center gap-2 sm:w-auto">
          <UserPlus size={16} aria-hidden="true" />
          {t('userAdmin.invite')}
        </button>
      </div>

      <UsersList users={users} onEdit={(user) => open(user.username)} />

      <CreateUserModal
        isOpen={openItem === PEOPLE_INVITE}
        onClose={() => open(null)}
        onSuccess={() => void queryClient.invalidateQueries({ queryKey: usersKey() })}
      />

      {editing === undefined ? null : (
        <UserEditorSheet key={editing.username} user={editing} onClose={() => open(null)}
          onDeleted={(said) => { onOpenItem(null); setNotice(said) }} />
      )}
    </div>
  )
}
