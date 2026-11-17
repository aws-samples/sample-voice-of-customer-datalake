/**
 * @fileoverview The People list (7.54.00): one row per person with what an administrator checks at a glance — Name,
 * Role, Way of working, Flags and Status — and an Edit button that opens the person's editor sheet. From `md` up it is
 * a table; below, a card per person with the same facts. Every change is made in the sheet (UserEditorSheet.tsx).
 * @module components/UserAdmin/UserAdminComponents
 */
import type { ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { readStoredAiMode } from '../../api/aiModeApi'
import type { CognitoUser } from '../../api/types'
import { MODE_KEYS } from './aiModeCopy'
import { displayName, isAdminUser, shownFlags } from './userFacts'
import type { ShownFlag } from './userFacts'

const FLAG_COPY: Readonly<Record<ShownFlag, { readonly labelKey: string }>> = {
  fallbackOwner: { labelKey: 'components:userAdmin.flags.fallbackOwner' },
  memoryReviewer: { labelKey: 'components:userAdmin.flags.memoryReviewer' },
  platformAdmin: { labelKey: 'components:userAdmin.flags.platformAdmin' },
}

function StatusBadge({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  if (!user.enabled) return <span className="badge badge-danger">{t('userAdmin.disabled')}</span>
  if (user.status === 'CONFIRMED') return <span className="badge badge-ok">{t('userAdmin.active')}</span>
  if (user.status === 'FORCE_CHANGE_PASSWORD') return <span className="badge badge-warn">{t('userAdmin.pendingStatus')}</span>
  return <span className="badge badge-muted">{user.status}</span>
}

function RoleText({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  return <span className="text-sm text-text">{isAdminUser(user) ? t('userAdmin.adminRole') : t('userAdmin.userRole')}</span>
}

/** The saved way of working, or "Not set" (a state: nothing saved, so the automations push nothing for them). */
function WayOfWorking({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  const mode = readStoredAiMode(user)
  if (!mode.saved) return <span className="badge badge-warn">{t('userAdmin.aiMode.notSet')}</span>
  return <span className="text-sm text-text">{t(MODE_KEYS[mode.mode].labelKey)}</span>
}

function Flags({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  const flags = shownFlags(user)
  if (flags.length === 0) return <span className="text-sm text-muted">{t('userAdmin.table.noFlags')}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => <span key={flag} className="badge badge-muted">{t(FLAG_COPY[flag].labelKey)}</span>)}
    </span>
  )
}

/** The name (or the email when none is set) and, under it, the email. Both wrap rather than being cut. */
function Who({ user }: Readonly<{ user: CognitoUser }>) {
  const name = displayName(user)
  return (
    <span className="block min-w-0">
      <span className="block font-medium text-text-strong break-words [overflow-wrap:anywhere]">{name}</span>
      {name === user.email ? null : <span className="block text-sm text-muted break-words [overflow-wrap:anywhere]">{user.email}</span>}
    </span>
  )
}

function EditButton({ user, onEdit }: Readonly<{ user: CognitoUser; onEdit: (user: CognitoUser) => void }>) {
  const { t } = useTranslation('components')
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(user)}
      aria-label={t('userAdmin.editor.title', { name: displayName(user) })}>
      <Pencil size={14} aria-hidden="true" /> {t('userAdmin.edit')}
    </button>
  )
}

interface UsersListProps {
  readonly users: readonly CognitoUser[]
  readonly onEdit: (user: CognitoUser) => void
}

const HEADER_CELL = 'px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[.04em] text-muted-strong'

export function UsersTable({ users, onEdit }: UsersListProps) {
  const { t } = useTranslation('components')
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
      <table className="w-full">
        <thead className="border-b border-border bg-bg-accent">
          <tr>
            <th scope="col" className={HEADER_CELL}>{t('userAdmin.table.name')}</th>
            <th scope="col" className={HEADER_CELL}>{t('userAdmin.table.role')}</th>
            <th scope="col" className={HEADER_CELL}>{t('userAdmin.table.wayOfWorking')}</th>
            <th scope="col" className={HEADER_CELL}>{t('userAdmin.table.flags')}</th>
            <th scope="col" className={HEADER_CELL}>{t('userAdmin.table.status')}</th>
            <th scope="col" className={HEADER_CELL}><span className="sr-only">{t('userAdmin.table.actions')}</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((user) => (
            <tr key={user.username} className="align-middle hover:bg-bg-hover">
              <td className="px-4 py-3"><Who user={user} /></td>
              <td className="px-4 py-3"><RoleText user={user} /></td>
              <td className="px-4 py-3"><WayOfWorking user={user} /></td>
              <td className="px-4 py-3"><Flags user={user} /></td>
              <td className="px-4 py-3"><StatusBadge user={user} /></td>
              <td className="px-4 py-3 text-right"><EditButton user={user} onEdit={onEdit} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {users.length === 0 ? <p className="py-8 text-center text-muted">{t('userAdmin.noUsers')}</p> : null}
    </div>
  )
}

/** One fact of a card: its label (the table's column header) and its value. */
function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function UsersCards({ users, onEdit }: UsersListProps) {
  const { t } = useTranslation('components')
  if (users.length === 0) {
    return <p className="rounded-lg border border-border py-8 text-center text-muted">{t('userAdmin.noUsers')}</p>
  }
  return (
    <ul className="space-y-3">
      {users.map((user) => (
        <li key={user.username} className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-start justify-between gap-2">
            <Who user={user} />
            <StatusBadge user={user} />
          </div>
          <dl className="space-y-1.5">
            <Fact label={t('userAdmin.table.role')}><RoleText user={user} /></Fact>
            <Fact label={t('userAdmin.table.wayOfWorking')}><WayOfWorking user={user} /></Fact>
            <Fact label={t('userAdmin.table.flags')}><Flags user={user} /></Fact>
          </dl>
          <EditButton user={user} onEdit={onEdit} />
        </li>
      ))}
    </ul>
  )
}
