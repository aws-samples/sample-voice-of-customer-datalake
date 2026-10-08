/**
 * @fileoverview "Share project" dialog: visibility, owner, members, invites.
 *
 * Driven entirely by GET /projects/{id}/members — its `access` decides what is
 * editable, so the dialog never infers permissions on its own. Non-managers see
 * the same content read-only; a member may still leave from their own row.
 * The server enforces every rule again; hiding a control is only courtesy.
 *
 * @module components/ProjectSharingModal
 */
import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../store/authStore'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import DialogClose from '../DialogClose/DialogClose'
import ModalShell from '../ModalShell/ModalShell'
import ProjectVisibilityBadge from '../ProjectVisibilityBadge/ProjectVisibilityBadge'
import VisibilityChoice from '../VisibilityChoice/VisibilityChoice'
import InviteSection from './InviteSection'
import { MemberRow, OwnerRow } from './MemberList'
import { sharingErrorKey } from './sharingErrors'
import { personLabel } from './sharingHelpers'
import { useProjectSharing } from './useProjectSharing'
import type { ProjectMember, ProjectMembersResponse } from '../../api/projectTypes'

interface ProjectSharingModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly projectId: string
  readonly projectName: string
  /** Called after the caller removed themselves (they may no longer see the project). */
  readonly onLeft?: () => void
}

type PendingConfirm =
  | { kind: 'transfer'; member: ProjectMember }
  | { kind: 'leave'; sub: string }
  | null

export default function ProjectSharingModal({
  isOpen, onClose, projectId, projectName, onLeft,
}: ProjectSharingModalProps) {
  const { t } = useTranslation('projects')
  const headingId = useId()
  const sharing = useProjectSharing(projectId, isOpen)
  const [pending, setPending] = useState<PendingConfirm>(null)

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} ariaLabelledBy={headingId} panelClassName="w-full max-w-lg max-h-[90vh]">
      <div className="dialog-header items-start justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="dialog-title whitespace-normal break-words">
            {t('sharing.title', { name: projectName })}
          </h2>
          <p className="dialog-description">{t('sharing.description')}</p>
        </div>
        <DialogClose onClick={onClose} className="flex-shrink-0" />
      </div>
      {/* No footer: every action applies immediately from its own row. */}
      <div className="dialog-body space-y-5">
        <SharingBody
          projectId={projectId}
          sharing={sharing}
          onTransfer={(member) => setPending({ kind: 'transfer', member })}
          onLeave={(sub) => setPending({ kind: 'leave', sub })}
        />
      </div>
      <ConfirmModal
        isOpen={pending?.kind === 'transfer'}
        title={t('sharing.transferTitle')}
        message={pending?.kind === 'transfer' ? t('sharing.transferMessage', { name: personLabel(pending.member) }) : ''}
        confirmLabel={t('sharing.transferConfirm')}
        cancelLabel={t('sharing.cancel')}
        variant="warning"
        isLoading={sharing.transferOwnership.isPending}
        onConfirm={() => {
          if (pending?.kind !== 'transfer') return
          sharing.resetErrors()
          sharing.transferOwnership.mutate(pending.member.sub, { onSettled: () => setPending(null) })
        }}
        onCancel={() => setPending(null)}
      />
      <ConfirmModal
        isOpen={pending?.kind === 'leave'}
        title={t('sharing.leaveTitle')}
        message={t('sharing.leaveMessage')}
        confirmLabel={t('sharing.leaveConfirm')}
        cancelLabel={t('sharing.cancel')}
        variant="danger"
        isLoading={sharing.leave.isPending}
        onConfirm={() => {
          if (pending?.kind !== 'leave') return
          sharing.resetErrors()
          // `leave` drops the project's cached queries first, so navigating away
          // never flashes a 404 for the project the caller just left.
          sharing.leave.mutate(pending.sub, {
            onSuccess: () => {
              onClose()
              onLeft?.()
            },
            onSettled: () => setPending(null),
          })
        }}
        onCancel={() => setPending(null)}
      />
    </ModalShell>
  )
}

interface SharingBodyProps {
  readonly projectId: string
  readonly sharing: ReturnType<typeof useProjectSharing>
  readonly onTransfer: (member: ProjectMember) => void
  readonly onLeave: (sub: string) => void
}

function SharingBody({
  projectId, sharing, onTransfer, onLeave,
}: SharingBodyProps) {
  const { t } = useTranslation('projects')
  const { membersQuery } = sharing

  if (membersQuery.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        {t('sharing.loading')}
      </p>
    )
  }
  if (membersQuery.data === undefined) {
    return <p role="alert" className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{t('sharing.loadError')}</p>
  }
  return <SharingContent projectId={projectId} data={membersQuery.data} sharing={sharing} onTransfer={onTransfer} onLeave={onLeave} />
}

interface SharingContentProps extends SharingBodyProps {
  readonly data: ProjectMembersResponse
}

function SharingContent({
  projectId, data, sharing, onTransfer, onLeave,
}: SharingContentProps) {
  const { t } = useTranslation('projects')
  const currentUserSub = useAuthStore((state) => state.user?.sub)
  const membersHeadingId = useId()
  const canManage = data.access.can_manage
  const busy = sharing.isMutating

  return (
    <>
      {canManage ? null : (
        // info, not warn: nothing is refused here, the controls are simply read-only.
        <p className="text-[13px] text-info bg-info-subtle border border-info/30 rounded-lg px-3 py-2">{t('sharing.readOnlyNotice')}</p>
      )}

      {sharing.mutationError === null ? null : (
        <p role="alert" className="text-[13px] text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {t(sharingErrorKey(sharing.mutationError))}
        </p>
      )}

      {canManage ? (
        <VisibilityChoice
          value={data.visibility}
          disabled={busy}
          onChange={(visibility) => {
            if (visibility === data.visibility) return
            sharing.resetErrors()
            sharing.setVisibility.mutate(visibility)
          }}
        />
      ) : (
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-text">{t('visibility.label')}</p>
          <div className="flex items-center gap-2">
            <ProjectVisibilityBadge visibility={data.visibility} />
            <span className="text-xs text-muted">
              {data.visibility === 'private' ? t('visibility.privateHint') : t('visibility.publicHint')}
            </span>
          </div>
        </div>
      )}

      <section aria-labelledby={membersHeadingId} className="space-y-1">
        <h3 id={membersHeadingId} className="text-sm font-semibold tracking-tight text-text-strong">{t('sharing.members')}</h3>
        <ul className="divide-y divide-border">
          <OwnerRow owner={data.owner} canManage={canManage} currentUserSub={currentUserSub} />
          {data.members.map((member) => (
            <MemberRow
              key={member.sub}
              member={member}
              canManage={canManage}
              isSelf={currentUserSub !== undefined && member.sub === currentUserSub}
              disabled={busy}
              onRoleChange={(sub, role) => {
                sharing.resetErrors()
                sharing.updateRole.mutate({ sub, role })
              }}
              onRemove={(m) => {
                sharing.resetErrors()
                sharing.removeMember.mutate(m.sub)
              }}
              onMakeOwner={onTransfer}
              onLeave={() => onLeave(member.sub)}
            />
          ))}
        </ul>
        {data.members.length === 0 ? <p className="text-xs text-muted">{t('sharing.noMembers')}</p> : null}
      </section>

      {canManage ? (
        <InviteSection
          projectId={projectId}
          disabled={busy}
          onInvite={(sub, role, onDone) => {
            sharing.resetErrors()
            sharing.addMember.mutate({ sub, role }, { onSuccess: onDone })
          }}
        />
      ) : null}
    </>
  )
}
