/**
 * @fileoverview One member of the workspace: who (name, email), their role, when they joined and, for a workspace
 * admin, a role menu and Remove (never on their own row: they leave instead). Everyone else reads the role.
 *
 * @module pages/Members/MemberRow
 */
import { useTranslation } from 'react-i18next'
import { UserMinus } from 'lucide-react'
import { formatDate } from '../../utils/dateUtils'
import { WORKSPACE_ROLES } from '../../api/workspacesApi'
import type { WorkspaceRole } from '../../api/workspacesApi'
import type { WorkspaceMember } from '../../api/workspaceMembersApi'
import { memberLabel } from './memberLabel'

function isRole(value: string): value is WorkspaceRole {
  return WORKSPACE_ROLES.some((role) => role === value)
}

interface MemberRowProps {
  readonly member: WorkspaceMember
  readonly isSelf: boolean
  /** The caller manages members here: the role menu and Remove. */
  readonly canManage: boolean
  readonly busy: boolean
  readonly onRoleChange: (member: WorkspaceMember, role: WorkspaceRole) => void
  readonly onRemove: (member: WorkspaceMember) => void
}

export default function MemberRow({ member, isSelf, canManage, busy, onRoleChange, onRemove }: MemberRowProps) {
  const { t, i18n } = useTranslation()
  const who = memberLabel(member)
  // A row written before the members routes may hold no date: no line then.
  const joined = formatDate(member.joined_at, i18n.language)
  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-strong break-words [overflow-wrap:anywhere]">
          {who}
          {isSelf ? <span className="badge badge-accent">{t('workspaces.members.you')}</span> : null}
        </p>
        {member.email !== '' && member.email !== who ? <p className="text-xs text-muted break-words [overflow-wrap:anywhere]">{member.email}</p> : null}
        {joined === '' ? null : <p className="text-xs text-muted">{t('workspaces.members.joined', { date: joined })}</p>}
      </div>
      <div className="flex items-center gap-2">
        {canManage ? (
          <select
            className="select select-sm w-auto"
            value={member.role}
            disabled={busy}
            aria-label={t('workspaces.members.roleFor', { who })}
            onChange={(event) => { if (isRole(event.target.value)) onRoleChange(member, event.target.value) }}
          >
            {WORKSPACE_ROLES.map((role) => <option key={role} value={role}>{t(`workspaces.role.${role}`)}</option>)}
          </select>
        ) : (
          <span className="badge badge-muted">{t(`workspaces.role.${member.role}`)}</span>
        )}
        {canManage && !isSelf ? (
          <button
            type="button"
            className="icon-btn focus-ring text-muted hover:text-danger"
            disabled={busy}
            onClick={() => onRemove(member)}
            aria-label={t('workspaces.members.removeWho', { who })}
            title={t('workspaces.members.removeWho', { who })}
          >
            <UserMinus size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </li>
  )
}
