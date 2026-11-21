/**
 * @fileoverview The invite list's rows as typed (7.71.00, InviteList.tsx), and the address check Create a trial runs
 * before it sends anything.
 *
 * @module pages/Settings/trial/invites
 */
import type { PlaybookRole } from '../../../api/onboardingApi'
import type { WorkspaceRole } from '../../../api/workspacesApi'

/** One row as typed: its email may still be empty or wrong. */
export interface InviteDraft {
  readonly key: number
  readonly email: string
  readonly role: WorkspaceRole
  readonly playbook: PlaybookRole | null
}

/** An address the member add can take: one `@`, a dotted domain, no whitespace (the server's rule is stricter). */
export function isInviteEmail(email: string): boolean {
  const [local = '', domain = '', ...rest] = email.trim().split('@')
  return rest.length === 0 && /^\S+$/.test(local) && /^[^\s.]+(\.[^\s.]+)+$/.test(domain)
}
