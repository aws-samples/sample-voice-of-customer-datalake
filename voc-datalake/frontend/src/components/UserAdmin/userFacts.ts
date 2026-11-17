/**
 * @fileoverview What the People table and the editor sheet read from a `GET /users` row: the name to show, the role,
 * and the per-user flags (fallback owner, memory reviewer, platform admin) that are set.
 * @module components/UserAdmin/userFacts
 */
import { readUserFlags } from '../../api/userFlagsApi'
import type { CognitoUser } from '../../api/types'

export type UserGroup = 'admins' | 'users'

/** The person's given and family names, else their name, else their email (never empty when an email is set). */
export function displayName(user: CognitoUser): string {
  const names = `${user.given_name ?? ''} ${user.family_name ?? ''}`.trim()
  if (names !== '') return names
  return user.name === '' ? user.email || user.username : user.name
}

export function isAdminUser(user: CognitoUser): boolean {
  return user.groups.includes('admins')
}

/** The flags a row shows as labels, in this order. */
export type ShownFlag = 'fallbackOwner' | 'memoryReviewer' | 'platformAdmin'

export function shownFlags(user: CognitoUser): ShownFlag[] {
  const flags = readUserFlags(user)
  const shown: ShownFlag[] = []
  if (flags.fallback_owner) shown.push('fallbackOwner')
  if (flags.memory_reviewer) shown.push('memoryReviewer')
  if (user.platform_admin === true) shown.push('platformAdmin')
  return shown
}
