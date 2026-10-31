/**
 * The e2e users must be in the Cognito group `e2e` (5.62.00, owner decision): the app then runs
 * every model call made for them on Claude Haiku 5.5 (lambda/shared/model_profile.py), so a full
 * run does not spend flagship-model money. A user outside the group would run on the admin's
 * models, so setup fails fast; `E2E_ALLOW_FULL_MODELS=1` downgrades that to a loud warning.
 * Membership is admin-only and never changed by the suite (it needs no AWS write access).
 */
import type { Role } from './env'

export const E2E_GROUP = 'e2e'

/** The one-time admin command that adds `username` to the group (printed, never run). */
export function addToGroupCommand(username: string): string {
  return `aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username '${username}' --group-name ${E2E_GROUP}`
}

/**
 * null when `groups` holds `e2e`; else the message setup throws (or, with
 * `E2E_ALLOW_FULL_MODELS=1`, warns with).
 */
export function missingE2eGroup(role: Role, username: string, groups: readonly string[]): string | null {
  if (groups.includes(E2E_GROUP)) return null
  return `The ${role} test user is not in the Cognito group "${E2E_GROUP}", so its model calls would run on the `
    + `admin's configured models instead of Claude Haiku 5.5. Add it once (an admin, outside CI): `
    + `${addToGroupCommand(username)} — then sign in again. Set E2E_ALLOW_FULL_MODELS=1 to run anyway.`
}

/** Throws (or warns, when allowed) for a test user outside the `e2e` group. */
export function requireE2eGroup(
  role: Role, username: string, groups: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const problem = missingE2eGroup(role, username, groups)
  if (problem === null) return
  if (env['E2E_ALLOW_FULL_MODELS'] === '1') {
    console.warn(`\n!!! WARNING: ${problem}\n`)
    return
  }
  throw new Error(problem)
}
