/**
 * @fileoverview How the members page names a member.
 * @module pages/Members/memberLabel
 */
import type { WorkspaceMember } from '../../api/workspaceMembersApi'

/** The best label for a member: name, then email, then the account id (an erased row holds neither). */
export function memberLabel(member: WorkspaceMember): string {
  if (member.name.trim() !== '') return member.name.trim()
  return member.email === '' ? member.sub : member.email
}
