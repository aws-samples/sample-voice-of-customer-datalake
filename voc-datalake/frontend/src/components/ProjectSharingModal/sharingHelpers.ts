/**
 * @fileoverview Pure helpers shared by the sharing modal's components.
 * @module components/ProjectSharingModal/sharingHelpers
 */
import type { ProjectMemberRole } from '../../api/projectTypes'

/** Roles an invited member can hold, in the order the role pickers list them. */
export const MEMBER_ROLES: readonly ProjectMemberRole[] = ['editor', 'viewer']

/**
 * Each role's label key, namespace-qualified and held as `labelKey:` data so
 * scripts/i18n-check.mjs can see the keys a template-string lookup would hide.
 */
const ROLE_LABELS: Readonly<Record<ProjectMemberRole, { labelKey: string }>> = {
  editor: { labelKey: 'projects:sharing.roles.editor' },
  viewer: { labelKey: 'projects:sharing.roles.viewer' },
}

export function roleLabelKey(role: ProjectMemberRole): string {
  return ROLE_LABELS[role].labelKey
}

export function isMemberRole(value: string): value is ProjectMemberRole {
  return MEMBER_ROLES.some((role) => role === value)
}

/**
 * A Cognito username that is a machine id, not a name: a pool that signs in by email
 * gives every user a UUID username (often the sub itself). Shown as a name it reads
 * "aff8498b-61ed-…" in the picker, so the labels below skip it.
 */
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PersonRef {
  readonly username: string
  readonly email: string
  readonly sub: string
  /** The Cognito `name` attribute, when the wire shape carries one (member candidates). */
  readonly name?: string
}

/** The name, else a human username; '' when the row has neither (an empty, sub-equal or UUID-shaped username). */
function humanName(person: Pick<PersonRef, 'username' | 'sub' | 'name'>): string {
  const name = person.name?.trim() ?? ''
  if (name !== '') return name
  const username = person.username.trim()
  return username === '' || username === person.sub || MACHINE_ID.test(username) ? '' : username
}

/** The best human label a row has: name, then a human username, then email, then the raw sub. */
export function personLabel(person: PersonRef): string {
  const name = humanName(person)
  if (name !== '') return name
  return person.email !== '' ? person.email : person.sub
}

/**
 * The label a NON-manager may see: name, then a human username, else the raw sub —
 * never the email.
 *
 * On a public project every signed-in user can open the sharing dialog, and the
 * member list is not the place for them to harvest addresses. A member without a
 * name or a human username therefore shows as their sub to a non-manager —
 * unlovely, but not a disclosure. (The server still returns every email; narrowing
 * that is a separate owner decision — Agent 2's handover item 5.)
 */
export function publicPersonLabel(person: Pick<PersonRef, 'username' | 'sub' | 'name'>): string {
  const name = humanName(person)
  return name !== '' ? name : person.sub
}

/** The candidates endpoint caps `q` at this length. */
export const CANDIDATE_QUERY_MAX_LENGTH = 64
/**
 * The candidates endpoint refuses shorter prefixes with a 400
 * (`projects.MIN_CANDIDATE_QUERY_LENGTH`), so the search does not fire below it.
 */
export const CANDIDATE_QUERY_MIN_LENGTH = 3
export const CANDIDATE_SEARCH_DEBOUNCE_MS = 300

/** The query as the API will accept it: no `"` or `\`, trimmed, capped. */
export function cleanCandidateQuery(raw: string): string {
  return raw.replace(/["\\]/g, '').trim().slice(0, CANDIDATE_QUERY_MAX_LENGTH)
}
