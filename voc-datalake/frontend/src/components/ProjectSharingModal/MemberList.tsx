/**
 * @fileoverview Owner row + member rows of the sharing modal.
 *
 * Managers get a role select, "make owner" and remove per member, and see each
 * person's email. Anyone sees "Leave project" on their own row. Everything else
 * is read-only text — usernames only, for a non-manager.
 *
 * @module components/ProjectSharingModal/MemberList
 */
import { Crown, LogOut, Trash2, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectMember, ProjectMemberRole, ProjectOwner } from '../../api/projectTypes'
import {
  MEMBER_ROLES, isMemberRole, personLabel, publicPersonLabel, roleLabelKey,
} from './sharingHelpers'

interface PersonTextProps {
  readonly person: { username: string; email: string; sub: string }
  readonly isSelf: boolean
  /** Managers only. This is the UI half: the members endpoint itself still returns every email (a pending API decision). */
  readonly revealEmail: boolean
}

function PersonText({ person, isSelf, revealEmail }: PersonTextProps) {
  const { t } = useTranslation('projects')
  const label = revealEmail ? personLabel(person) : publicPersonLabel(person)
  return (
    <div className="min-w-0 flex-1">
      <p className="text-[13px] font-medium text-text-strong truncate" title={label}>
        {label}
        {isSelf ? <span className="ml-1 text-muted font-normal">{t('sharing.you')}</span> : null}
      </p>
      {revealEmail && person.email !== '' && person.email !== label
        ? <p className="text-xs text-muted truncate" title={person.email}>{person.email}</p>
        : null}
    </div>
  )
}

interface OwnerRowProps {
  readonly owner: ProjectOwner | null
  readonly canManage: boolean
  readonly currentUserSub?: string
}

export function OwnerRow({ owner, canManage, currentUserSub }: OwnerRowProps) {
  const { t } = useTranslation('projects')
  return (
    // Same gaps as MemberRow so the owner's name lines up with the members' at every width.
    <li className="flex items-center gap-2 sm:gap-3 py-2">
      {/* Crown in `warn`: the conventional "gold" for the single owner, paired with the "Owner" label. */}
      <Crown size={16} className="text-warn flex-shrink-0" aria-hidden="true" />
      {owner === null
        ? <p className="text-[13px] text-muted flex-1">{t('sharing.noOwner')}</p>
        : <PersonText person={owner} isSelf={owner.sub === currentUserSub} revealEmail={canManage} />}
      <span className="text-xs font-medium text-muted">{t('sharing.owner')}</span>
    </li>
  )
}

interface MemberRowProps {
  readonly member: ProjectMember
  readonly canManage: boolean
  readonly isSelf: boolean
  readonly disabled: boolean
  readonly onRoleChange: (sub: string, role: ProjectMemberRole) => void
  readonly onRemove: (member: ProjectMember) => void
  readonly onMakeOwner: (member: ProjectMember) => void
  readonly onLeave: () => void
}

export function MemberRow({
  member, canManage, isSelf, disabled, onRoleChange, onRemove, onMakeOwner, onLeave,
}: MemberRowProps) {
  const { t } = useTranslation('projects')
  // Only read by the manage controls' labels, which exist only for a manager.
  const name = personLabel(member)
  const makeOwnerLabel = t('sharing.makeOwner', { name })
  const removeLabel = t('sharing.remove', { name })
  return (
    <li className="flex flex-wrap items-center gap-2 sm:gap-3 py-2">
      <User size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
      <PersonText person={member} isSelf={isSelf} revealEmail={canManage} />
      {canManage ? (
        <>
          <select
            aria-label={t('sharing.roleLabel', { name })}
            value={member.role}
            disabled={disabled}
            onChange={(e) => {
              if (isMemberRole(e.target.value)) onRoleChange(member.sub, e.target.value)
            }}
            className="select select-sm w-auto"
          >
            {MEMBER_ROLES.map((role) => <option key={role} value={role}>{t(roleLabelKey(role))}</option>)}
          </select>
          <button
            type="button"
            onClick={() => onMakeOwner(member)}
            disabled={disabled}
            aria-label={makeOwnerLabel}
            title={makeOwnerLabel}
            className="icon-btn hover:text-warn"
          >
            <Crown size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onRemove(member)}
            disabled={disabled}
            aria-label={removeLabel}
            title={removeLabel}
            className="icon-btn hover:text-danger"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </>
      ) : <span className="text-xs font-medium text-muted">{t(roleLabelKey(member.role))}</span>}
      {isSelf && !canManage ? (
        <button
          type="button"
          onClick={onLeave}
          disabled={disabled}
          className="btn btn-danger btn-sm"
        >
          <LogOut size={14} aria-hidden="true" />
          {t('sharing.leave')}
        </button>
      ) : null}
    </li>
  )
}
