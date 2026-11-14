/**
 * @fileoverview The current workspace's members: the list, a page at a time, and the writes (add, change a role,
 * remove, leave) with what the page says about each. Every write settles by reading the caller's workspaces again
 * (the `my-workspaces` root: the list, the current workspace's role, the members), so a role the caller changed for
 * themselves reaches the header and the page at once. Leaving ends with a full page load to `/`.
 *
 * @module pages/Members/useMembers
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useCursorPages } from '../../hooks/useCursorPages'
import { useExpiringValue } from '../../hooks/useExpiringValue'
import { myWorkspacesKey } from '../../api/workspacesApi'
import { workspaceMembersApi, workspaceMembersKey } from '../../api/workspaceMembersApi'
import type { AddedMember, WorkspaceMember } from '../../api/workspaceMembersApi'
import type { WorkspaceRole } from '../../api/workspacesApi'
import { memberLabel } from './memberLabel'

export function useMembersList(workspaceId: string) {
  const { query, rows } = useCursorPages<WorkspaceMember>(workspaceMembersKey(workspaceId), workspaceMembersApi.list)
  return { query, members: rows }
}

/** A write waiting for its confirmation: removing a member, leaving, or lowering your own role. */
export type PendingWrite =
  | { readonly kind: 'remove'; readonly member: WorkspaceMember }
  | { readonly kind: 'leave' }
  | { readonly kind: 'demote-self'; readonly member: WorkspaceMember; readonly role: WorkspaceRole }

/** What a role may do, compared: a lower rank can do less. */
const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = { viewer: 0, editor: 1, admin: 2 }

function useMemberWrites() {
  const queryClient = useQueryClient()
  const onSettled = () => queryClient.invalidateQueries({ queryKey: myWorkspacesKey() })
  const add = useMutation({
    mutationFn: ({ email, role }: { email: string; role: WorkspaceRole }) => workspaceMembersApi.add(email, role),
    onSettled,
  })
  const changeRole = useMutation({
    mutationFn: ({ sub, role }: { sub: string; role: WorkspaceRole }) => workspaceMembersApi.changeRole(sub, role),
    onSettled,
  })
  const remove = useMutation({ mutationFn: (sub: string) => workspaceMembersApi.remove(sub), onSettled })
  // Leaving ends with a full page load to `/` (the gate then offers what is left), so nothing is read again here.
  const leave = useMutation({
    mutationFn: (sub: string) => workspaceMembersApi.remove(sub),
    onSuccess: () => window.location.assign('/'),
  })
  return { add, changeRole, remove, leave }
}

/** The page's writes, the confirmation waiting, the last refusal (`error`) and the last success line (`done`). */
export function useMemberActions(selfSub: string | undefined) {
  const { t } = useTranslation()
  const writes = useMemberWrites()
  const [pending, setPending] = useState<PendingWrite | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, showDone] = useExpiringValue<string>(6000)
  const busy = writes.add.isPending || writes.changeRole.isPending || writes.remove.isPending || writes.leave.isPending
  const roleName = (role: WorkspaceRole) => t(`workspaces.role.${role}`)

  const add = async (email: string, role: WorkspaceRole): Promise<AddedMember> => {
    setError(null)
    try {
      const member = await writes.add.mutateAsync({ email, role })
      const values = { email: member.email, role: roleName(member.role) }
      showDone(member.account === 'created' ? t('workspaces.members.addedCreated', values) : t('workspaces.members.addedExisting', values))
      return member
    } catch (cause: unknown) {
      setError(cause)
      throw cause
    }
  }

  const sendRole = (member: WorkspaceMember, role: WorkspaceRole, onSettled?: () => void) => {
    setError(null)
    writes.changeRole.mutate({ sub: member.sub, role }, {
      onSuccess: () => showDone(t('workspaces.members.roleChanged', { who: memberLabel(member), role: roleName(role) })),
      onError: setError,
      onSettled,
    })
  }

  // Lowering your own role takes away what you can do here: it waits for a confirmation.
  const changeRole = (member: WorkspaceMember, role: WorkspaceRole) => {
    if (member.sub === selfSub && ROLE_RANK[role] < ROLE_RANK[member.role]) setPending({ kind: 'demote-self', member, role })
    else sendRole(member, role)
  }

  const confirm = () => {
    setError(null)
    const close = { onError: setError, onSettled: () => setPending(null) }
    if (pending?.kind === 'demote-self') sendRole(pending.member, pending.role, () => setPending(null))
    if (pending?.kind === 'leave' && selfSub !== undefined) writes.leave.mutate(selfSub, close)
    if (pending?.kind === 'remove') {
      const who = memberLabel(pending.member)
      writes.remove.mutate(pending.member.sub, { ...close, onSuccess: () => showDone(t('workspaces.members.removed', { who })) })
    }
  }

  return { busy, pending, setPending, error, done, add, changeRole, confirm }
}
