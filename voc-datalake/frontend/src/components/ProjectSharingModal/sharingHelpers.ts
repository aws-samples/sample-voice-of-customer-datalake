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

/** The best human label a row has: username, then email, then the raw sub. */
export function personLabel(person: { username: string; email: string; sub: string }): string {
  if (person.username !== '') return person.username
  return person.email !== '' ? person.email : person.sub
}

/**
 * The label a NON-manager may see: username, else the raw sub — never the email.
 *
 * On a public project every signed-in user can open the sharing dialog, and the
 * member list is not the place for them to harvest addresses. A username-less
 * member therefore shows as their sub to a non-manager — unlovely, but not a
 * disclosure. (The server still returns every email; narrowing that is a
 * separate owner decision — Agent 2's handover item 5.)
 */
export function publicPersonLabel(person: { username: string; sub: string }): string {
  return person.username !== '' ? person.username : person.sub
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
