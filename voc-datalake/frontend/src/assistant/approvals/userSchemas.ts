/**
 * @fileoverview The SPA approval boundary of the user-administration write
 * tools — `create_user`, `create_users`, `update_user`, `set_user_access` — and the pure
 * builders their cards and executors share, so the card shows exactly what is
 * saved.
 *
 * Limits and patterns mirror the routes (`lambda/api/users_handler.py`,
 * `lambda/shared/category_access.py`, `category_config.py`, the source-profile
 * id rule) and are IDENTICAL to the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/user-schemas.ts`):
 * `userSchemas.lockstep.test.ts` compares both. The routes re-validate
 * everything (configured category names and source ids included).
 *
 * @module assistant/approvals/userSchemas
 */
import { z } from 'zod'
import type { CategoryScope, SourceGrant, UserCategoryGrant } from '../../api/categoryAccessApi'

export const SPA_USER_LIMITS = {
  maxEmailLength: 254,
  maxNameLength: 100,
  maxUsernameLength: 128,
  maxCategories: 50,
  maxCategoryNameLength: 64,
  maxSources: 50,
  maxSourceIdLength: 48,
  maxUsersPerCard: 25,
} as const

export const USER_ROLES = ['admins', 'users'] as const
export type UserRole = (typeof USER_ROLES)[number]
/** Cognito usernames here are UUIDs; the email alias is accepted too. */
export const USERNAME_PATTERN = /^[A-Za-z0-9@._+-]{1,128}$/
export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/
export const CATEGORY_NAME_PATTERN = /^[^\s#]{1,64}$/
export const ACCESS_WILDCARD = '*'

const WHITESPACE = /\s/

/** Why `value` is not an address the route would accept, else null. */
function emailProblem(value: string): string | null {
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return 'must have exactly one "@" with text on both sides'
  if (WHITESPACE.test(value)) return 'must not contain whitespace'
  return null
}

/**
 * Why `values` is not a valid grant list, else null: no repeats, and EITHER
 * exactly `['*']` OR names that all match `pattern` (the wildcard never mixed in).
 */
function grantListProblem(values: readonly string[], pattern: RegExp, what: string): string | null {
  if (new Set(values).size !== values.length) return `${what} must not repeat`
  if (values.includes(ACCESS_WILDCARD)) return values.length === 1 ? null : `"${ACCESS_WILDCARD}" cannot be combined with other ${what}`
  const invalid = values.find((value) => !pattern.test(value))
  return invalid === undefined ? null : `"${invalid}" is not a valid entry for ${what}`
}

const emailArg = z.string().trim().min(3).max(SPA_USER_LIMITS.maxEmailLength).check((ctx) => {
  const problem = emailProblem(ctx.value)
  if (problem !== null) ctx.issues.push({ code: 'custom', message: `email ${problem}`, input: ctx.value })
})
const nameArg = z.string().trim().min(1).max(SPA_USER_LIMITS.maxNameLength)
const roleArg = z.enum(USER_ROLES)
const usernameArg = z.string().trim().regex(USERNAME_PATTERN, 'must be a Cognito username (letters, digits, "@", ".", "_", "+" or "-")')

function grantList(max: number, pattern: RegExp, what: string) {
  return z.array(z.string().trim()).max(max).check((ctx) => {
    const problem = grantListProblem(ctx.value, pattern, what)
    if (problem !== null) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value })
  })
}

export const createUserArgs = z.strictObject({
  email: emailArg,
  role: roleArg,
  given_name: nameArg.optional(),
  family_name: nameArg.optional(),
})

/** `create_users`: up to 25 `create_user` rows, each email once (compared case-insensitively). */
export const createUsersArgs = z.strictObject({
  users: z.array(createUserArgs).min(1).max(SPA_USER_LIMITS.maxUsersPerCard).refine(
    (users) => new Set(users.map((user) => user.email.toLowerCase())).size === users.length,
    { message: 'each email may appear only once' },
  ),
})

export const updateUserArgs = z.strictObject({
  username: usernameArg,
  updates: z.strictObject({
    given_name: nameArg.optional(),
    family_name: nameArg.optional(),
    role: roleArg.optional(),
    enabled: z.boolean().optional(),
  }).refine((u) => Object.keys(u).length > 0, { message: 'updates must change at least one field' }),
})

export const setUserAccessArgs = z.strictObject({
  username: usernameArg,
  categories: grantList(SPA_USER_LIMITS.maxCategories, CATEGORY_NAME_PATTERN, 'category names').min(1),
  sources: grantList(SPA_USER_LIMITS.maxSources, SOURCE_ID_PATTERN, 'source ids').nullish(),
})

export type CreateUserArgs = z.infer<typeof createUserArgs>
export type CreateUsersArgs = z.infer<typeof createUsersArgs>
export type UpdateUserArgs = z.infer<typeof updateUserArgs>
export type UserUpdates = UpdateUserArgs['updates']
export type SetUserAccessArgs = z.infer<typeof setUserAccessArgs>

// ── The stored user, as the cards and executors read it ─────────────────────

/**
 * One listed user (`GET /users`), kept to the fields the tools show and
 * fingerprint. Lenient: a malformed optional field reads as its empty value
 * rather than failing the card; `sub`, flags and dates are dropped on purpose.
 */
export const userRecordSchema = z.object({
  username: z.string().min(1),
  email: z.string().catch(''),
  given_name: z.string().catch(''),
  family_name: z.string().catch(''),
  groups: z.array(z.string()).catch([]),
  enabled: z.boolean().catch(true),
})
export type UserRecord = z.infer<typeof userRecordSchema>

/** The role a user's groups give them (`admins` wins; no group reads as `users`). */
export function roleOf(groups: readonly string[]): UserRole {
  return groups.includes('admins') ? 'admins' : 'users'
}

const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))

/** Key-sorted JSON of what the user tools show: equal fingerprints = the same stored user. */
export function userFingerprint(user: UserRecord): string {
  return JSON.stringify({
    email: user.email,
    enabled: user.enabled,
    family_name: user.family_name,
    given_name: user.given_name,
    groups: sorted(user.groups),
    username: user.username,
  })
}

/** Key-sorted JSON of a user's grant (content only — who saved it when is not part of it). */
export function accessFingerprint(grant: UserCategoryGrant): string {
  return JSON.stringify({
    all: grant.all,
    categories: sorted(grant.categories),
    sourceMode: grant.sourceGrant.mode,
    sources: sorted(grant.sourceGrant.sources),
  })
}

// ── Builders (what the card shows = what is saved) ──────────────────────────

/** The stored user with the proposed updates applied (a new role replaces the role groups). */
export function updatedUserRecord(user: UserRecord, updates: UserUpdates): UserRecord {
  return {
    ...user,
    given_name: updates.given_name ?? user.given_name,
    family_name: updates.family_name ?? user.family_name,
    groups: updates.role === undefined ? user.groups : [updates.role],
    enabled: updates.enabled ?? user.enabled,
  }
}

const isWildcardOnly = (values: readonly string[]) => values.length === 1 && values[0] === ACCESS_WILDCARD

/** `sources` as the grant it saves: omitted = unchanged, null = the default rule, `['*']` = every source. */
function sourceGrantOf(sources: readonly string[] | null | undefined): SourceGrant | undefined {
  if (sources === undefined) return undefined
  if (sources === null) return { mode: 'default', sources: [] }
  return isWildcardOnly(sources) ? { mode: 'all', sources: [] } : { mode: 'list', sources: [...sources] }
}

/** What `set_user_access` saves: the category scope, and the source grant when the args name one. */
export function proposedAccess(args: SetUserAccessArgs): { grant: CategoryScope; sourceGrant: SourceGrant | undefined } {
  const grant: CategoryScope = isWildcardOnly(args.categories) ? { all: true, categories: [] } : { all: false, categories: [...args.categories] }
  return { grant, sourceGrant: sourceGrantOf(args.sources) }
}
