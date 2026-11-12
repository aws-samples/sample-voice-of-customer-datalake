/**
 * @fileoverview The server's refusals of the members, platform console and platform-admin writes, as the message
 * key each one shows (`common:workspaces.errors.*`, in every locale).
 *
 * A status alone cannot tell them apart (two different 409s: the last admin, a membership changed meanwhile), so a
 * row may also name the server's exact reason (`error` of the body, `serverReason`). Those texts are the constants
 * of lambda/shared/workspace_members.py, platform_workspaces.py, user_admin_guard.py and users_handler.py;
 * `workspaceRefusals.lockstep.test.ts` fails when one changes on one side only. A refusal no row names shows the
 * generic message, with the server's own reason when it gave one.
 *
 * @module workspace/workspaceRefusals
 */
import { apiErrorStatus } from '../api/apiErrorStatus'
import { serverReason } from '../lib/errors'

export interface Refusal {
  readonly status: number
  /** The server's reason, when the status is shared with another refusal. */
  readonly reason?: string
  readonly messageKey: string
}

/** The refusals of `/me/workspaces/current/members` (workspace_members.py, workspace.py). */
export const MEMBER_REFUSALS: readonly Refusal[] = [
  { status: 409, reason: 'A workspace needs an admin: make another member an admin first', messageKey: 'common:workspaces.errors.lastAdmin' },
  { status: 409, reason: 'The membership changed meanwhile: reload the members and try again', messageKey: 'common:workspaces.errors.changedMeanwhile' },
  { status: 409, reason: 'That person is already a member of this workspace', messageKey: 'common:workspaces.errors.alreadyMember' },
  { status: 409, reason: 'More than one account has this email: ask a platform admin to resolve it', messageKey: 'common:workspaces.errors.ambiguousEmail' },
  { status: 409, reason: 'An account already uses this email under another spelling: add it as that account writes it', messageKey: 'common:workspaces.errors.emailElsewhere' },
  { status: 403, reason: 'You are no longer an admin of this workspace', messageKey: 'common:workspaces.errors.noLongerAdmin' },
  {
    status: 403,
    reason: 'This email has no account yet: only a deployment administrator can create one while the data is shared across workspaces',
    messageKey: 'common:workspaces.errors.newAccountAdminsOnly',
  },
  { status: 403, messageKey: 'common:workspaces.errors.notWorkspaceAdmin' },
  { status: 404, reason: 'Member not found', messageKey: 'common:workspaces.errors.memberGone' },
  { status: 404, messageKey: 'common:workspaces.errors.workspaceGone' },
]

/** The refusals of `POST /platform/workspaces` (platform_workspaces.py, workspaces_handler.py). */
export const PLATFORM_REFUSALS: readonly Refusal[] = [
  { status: 409, reason: 'That slug is taken: choose another', messageKey: 'common:workspaces.errors.slugTaken' },
  { status: 403, messageKey: 'common:workspaces.errors.notPlatformAdmin' },
]

/** The refusals of `PUT /users/{username}/platform-admin` (user_admin_guard.py, users_handler.py). */
export const PLATFORM_ADMIN_REFUSALS: readonly Refusal[] = [
  {
    status: 409,
    reason: 'This is the last enabled platform admin: make another administrator a platform admin first.',
    messageKey: 'common:workspaces.errors.lastPlatformAdmin',
  },
  {
    status: 400,
    reason: 'Only an administrator can be a platform admin: make the user an administrator first',
    messageKey: 'common:workspaces.errors.grantNeedsAdmin',
  },
  { status: 403, messageKey: 'common:workspaces.errors.notPlatformAdmin' },
  { status: 404, messageKey: 'common:workspaces.errors.userGone' },
]

/** What to show for a failed write: a message key, and the server's reason for the generic message. */
interface RefusalMessage {
  readonly messageKey: string
  readonly reason: string | null
}

/** The first row of `table` that matches the error's status (and reason, when the row names one); else generic. */
export function workspaceRefusalMessage(error: unknown, table: readonly Refusal[]): RefusalMessage {
  const status = apiErrorStatus(error)
  const reason = serverReason(error)
  const row = table.find((entry) => entry.status === status && (entry.reason === undefined || entry.reason === reason))
  if (row !== undefined) return { messageKey: row.messageKey, reason: null }
  return reason === null
    ? { messageKey: 'common:workspaces.errors.generic', reason }
    : { messageKey: 'common:workspaces.errors.genericWithReason', reason }
}
