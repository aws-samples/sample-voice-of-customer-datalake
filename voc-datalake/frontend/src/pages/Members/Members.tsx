/**
 * @fileoverview Members of the current workspace, at `/members` inside it (`/w/{slug}/members`; docs/multi-workspace.md
 * → Roles, Invites), opened from the header's workspace menu.
 *
 * - Every member reads the list (name or email, role, joined), a page at a time.
 * - A workspace admin (the role the server applies here: a member admin, or a platform admin who entered) adds a
 *   member by email with a role, changes a role and removes a member, each removal confirmed (and lowering their
 *   own role confirmed too).
 * - A member leaves with a confirmation, then a full page load to `/`: the gate offers the workspaces left.
 * - Every refusal is said in words (`workspace/workspaceRefusals.ts`): the last admin, a membership changed
 *   meanwhile, an admin demoted meanwhile, a new email from someone who may not create accounts.
 *
 * The server decides every one of these; the page only hides what the caller's role cannot do, and shows the loading
 * state until it knows the role the server applies (`/current`). Outside a workspace
 * the address is not a page (the app's "Page not found"), and the header offers no link to it.
 *
 * @module pages/Members
 */
import { useTranslation } from 'react-i18next'
import { Info, LogOut } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import CursorPagesList from '../../components/CursorPagesList/CursorPagesList'
import Notice from '../../components/Notice/Notice'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import PageLoader from '../../components/PageLoader/PageLoader'
import NotFound from '../../components/RouteErrorBoundary/NotFound'
import type { CursorPagesQuery } from '../../hooks/useCursorPages'
import { useAuthStore } from '../../store/authStore'
import RefusalAlert from '../../workspace/RefusalAlert'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { useMyWorkspaces, useServerWorkspace } from '../../workspace/useMyWorkspaces'
import { MEMBER_REFUSALS } from '../../workspace/workspaceRefusals'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import type { WorkspaceMember } from '../../api/workspaceMembersApi'
import type { WorkspaceRole } from '../../api/workspacesApi'
import AddMemberForm from './AddMemberForm'
import MemberRow from './MemberRow'
import { memberLabel } from './memberLabel'
import { useMemberActions, useMembersList } from './useMembers'
import type { PendingWrite } from './useMembers'

export default function Members() {
  const current = useCurrentWorkspace()
  if (current === null) return <NotFound />
  return <MembersFor workspace={current} />
}

/**
 * The page once the role the server applies here is known (`/current`, which the gate asked on entering): until
 * then the store holds the membership row's role, so a platform admin who is also an editor or a viewer would be
 * shown the read-only page for a moment. If that read fails for another reason than a 404 (the gate's not-found),
 * the membership's role stays, as in the gate; the server decides every write either way.
 */
function MembersFor({ workspace }: Readonly<{ workspace: CurrentWorkspace }>) {
  const server = useServerWorkspace(workspace.id)
  if (server.isPending) return <PageLoader />
  const role = server.data?.id === workspace.id ? server.data.role : workspace.role
  return <MembersView workspace={workspace} role={role} />
}

function MembersView({ workspace, role }: Readonly<{ workspace: CurrentWorkspace; role: WorkspaceRole }>) {
  const { t } = useTranslation()
  const selfSub = useAuthStore((state) => state.user?.sub)
  const { data: mine } = useMyWorkspaces()
  const { query, members } = useMembersList(workspace.id)
  const actions = useMemberActions(selfSub)
  const isAdmin = role === 'admin'
  // Leave is for a member (a platform admin who entered without a membership has nothing to leave).
  const canLeave = selfSub !== undefined && (mine ?? []).some((own) => own.id === workspace.id)

  return (
    <div className="max-w-4xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageTitle title={t('workspaces.members.title')} subtitle={t('workspaces.members.subtitle', { name: workspace.name })} />
        {canLeave ? (
          <button type="button" className="btn btn-danger gap-2 justify-center" disabled={actions.busy}
            onClick={() => actions.setPending({ kind: 'leave' })}>
            <LogOut size={16} aria-hidden="true" />
            {t('workspaces.members.leave')}
          </button>
        ) : null}
      </div>

      <Notice variant="banner" tone="warn" role="note" icon={Info} text={t('workspaces.sharedData')} />

      {isAdmin
        ? <AddMemberForm busy={actions.busy} onAdd={actions.add} />
        : <p className="text-sm text-muted">{t('workspaces.members.readOnly')}</p>}

      <RefusalAlert error={actions.error} refusals={MEMBER_REFUSALS} />
      {actions.done === null ? null : <p role="status" className="rounded-lg bg-ok-subtle p-3 text-sm text-ok">{actions.done}</p>}

      <section className="card" aria-labelledby="members-list-title">
        <h2 id="members-list-title" className="text-base font-semibold tracking-tight text-text-strong">
          {t('workspaces.members.listTitle')}
        </h2>
        <MembersList query={query} members={members} selfSub={selfSub} canManage={isAdmin} busy={actions.busy}
          onRoleChange={actions.changeRole} onRemove={(member) => actions.setPending({ kind: 'remove', member })} />
      </section>

      <PendingDialog pending={actions.pending} workspaceName={workspace.name} busy={actions.busy}
        onConfirm={actions.confirm} onCancel={() => actions.setPending(null)} />
    </div>
  )
}

/** The confirmation of a removal or of leaving. */
function PendingDialog({ pending, workspaceName, busy, onConfirm, onCancel }: Readonly<{
  pending: PendingWrite | null
  workspaceName: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}>) {
  const { t } = useTranslation()
  if (pending === null) return null
  const copy = pendingCopy(pending, workspaceName, t)
  return (
    <ConfirmModal isOpen variant={pending.kind === 'demote-self' ? 'warning' : 'danger'} {...copy} isLoading={busy}
      onConfirm={onConfirm} onCancel={onCancel} />
  )
}

/** The confirmation's title, question and button, per write. */
function pendingCopy(pending: PendingWrite, name: string, t: (key: string, values?: Record<string, string>) => string) {
  if (pending.kind === 'leave') {
    return { title: t('workspaces.members.leaveTitle'), message: t('workspaces.members.leaveConfirm', { name }), confirmLabel: t('workspaces.members.leave') }
  }
  if (pending.kind === 'demote-self') {
    const role = t(`workspaces.role.${pending.role}`)
    return { title: t('workspaces.members.demoteSelfTitle'), message: t('workspaces.members.demoteSelfConfirm', { name, role }), confirmLabel: t('workspaces.members.demoteSelf', { role }) }
  }
  return {
    title: t('workspaces.members.removeTitle'),
    message: t('workspaces.members.removeConfirm', { who: memberLabel(pending.member), name }),
    confirmLabel: t('workspaces.members.remove'),
  }
}

function MembersList({ query, members, selfSub, canManage, busy, onRoleChange, onRemove }: Readonly<{
  query: CursorPagesQuery
  members: readonly WorkspaceMember[]
  selfSub: string | undefined
  canManage: boolean
  busy: boolean
  onRoleChange: (member: WorkspaceMember, role: WorkspaceRole) => void
  onRemove: (member: WorkspaceMember) => void
}>) {
  const { t } = useTranslation()
  const copy = {
    loading: t('workspaces.members.loading'), loadFailed: t('workspaces.members.loadFailed'),
    more: t('workspaces.members.more'), moreFailed: t('workspaces.moreFailed'), refreshFailed: t('workspaces.refreshFailed'),
  }
  return (
    <CursorPagesList query={query} count={members.length} copy={copy}>
      <ul className="divide-y divide-border">
        {members.map((member) => (
          <MemberRow key={member.sub} member={member} isSelf={member.sub === selfSub} canManage={canManage} busy={busy}
            onRoleChange={onRoleChange} onRemove={onRemove} />
        ))}
      </ul>
    </CursorPagesList>
  )
}
