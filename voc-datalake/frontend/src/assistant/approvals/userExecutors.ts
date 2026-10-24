/**
 * @fileoverview REST executors of the user-administration write tools, through
 * the existing API clients (`fetchApi` → the user's own Cognito token; every
 * route is admin-only). Each one re-reads the current state right before it
 * writes:
 * - `create_user` refuses an email that is already registered (a create never
 *   overwrites), then creates the user — Cognito emails them a temporary
 *   password and nothing else happens;
 * - `create_users` checks every email first, then creates them in order and
 *   stops at the first failure, reporting who was created;
 * - `update_user` refuses when the stored user differs from the one the card
 *   diffed against (fingerprint on the shown record) and never changes the
 *   signed-in administrator's own role or enabled state; then it applies the
 *   fields IN ORDER — names, role, enabled state — stopping at the first failure
 *   and reporting what was applied;
 * - `set_user_access` refuses when the stored grant differs from the one shown,
 *   then saves the proposed one.
 * The refusal sentences are our own (StaleApprovalError — the one error class
 * whose text reaches the model, see `safeError.ts`); a stopped update reports
 * through it too, with the status-derived sentence of the failed call.
 *
 * @module assistant/approvals/userExecutors
 */
import { api } from '../../api/client'
import { categoryAccessApi } from '../../api/categoryAccessApi'
import { useAuthStore } from '../../store/authStore'
import { invalidateKeys, keysFor } from './invalidation'
import { safeErrorMessage } from './safeError'
import { StaleApprovalError, shownOf } from './shown'
import { accessFingerprint, proposedAccess, userFingerprint, userRecordSchema } from './userSchemas'
import type { CategoryScope, SourceGrant } from '../../api/categoryAccessApi'
import type { WriteToolExecutionContext } from '../types'
import type { CreateUserArgs, CreateUsersArgs, SetUserAccessArgs, UpdateUserArgs, UserRecord, UserUpdates } from './userSchemas'

export const USER_CHANGED_MESSAGE = 'The user changed since this approval was shown (or their current record was never shown); '
  + 'nothing was changed. Read them again with list_users and propose the change again.'
export const ACCESS_CHANGED_MESSAGE = 'This user\u2019s access changed since this approval was shown (or it was never shown); '
  + 'nothing was saved. Read it again with get_user_access and propose the change again.'
export const SELF_CHANGE_MESSAGE = 'You cannot change your own role or enabled state; nothing was changed. Another administrator must do that.'
const userExistsMessage = (email: string, username: string) =>
  `A user with email "${email}" already exists (username ${username}); nothing was created. To change them, propose update_user.`
const userMissingMessage = (username: string) => `No user has username "${username}" any more; nothing was changed.`

/** Every listed user, kept to the fields the tools read (a malformed row is skipped, not fatal). */
async function listUsers(): Promise<UserRecord[]> {
  const { users } = await api.getUsers()
  return users.flatMap((user) => {
    const parsed = userRecordSchema.safeParse(user)
    return parsed.success ? [parsed.data] : []
  })
}

/** The stored user `username`, read fresh. */
export async function fetchUser(username: string): Promise<UserRecord | undefined> {
  return (await listUsers()).find((user) => user.username === username)
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Refuse the first email already registered (a create never overwrites). */
function refuseRegistered(users: readonly UserRecord[], emails: readonly string[]): void {
  for (const email of emails) {
    const duplicate = users.find((user) => sameEmail(user.email, email))
    if (duplicate !== undefined) throw new StaleApprovalError(userExistsMessage(email, duplicate.username))
  }
}

/** Create one user like Settings → Users does; the username the route minted. */
async function createOne(args: CreateUserArgs): Promise<string> {
  // The email doubles as the requested username; the route mints the real one.
  const res = await api.createUser({
    username: args.email,
    email: args.email,
    group: args.role,
    ...(args.given_name === undefined ? {} : { given_name: args.given_name }),
    ...(args.family_name === undefined ? {} : { family_name: args.family_name }),
  })
  return res.user?.username ?? args.email
}

export async function createUser(args: CreateUserArgs, ctx: WriteToolExecutionContext) {
  refuseRegistered(await listUsers(), [args.email])
  const username = await createOne(args)
  void invalidateKeys(ctx.queryClient, keysFor.users())
  return {
    summary: `Created user ${args.email} (${args.role}) with username ${username}; Cognito emailed them a temporary password. Nothing else was created.`,
    data: { username, email: args.email },
  }
}

interface CreatedUser { email: string; username: string }

function createdList(created: readonly CreatedUser[]): string {
  return created.length === 0 ? 'nobody' : created.map((user) => `${user.email} (username ${user.username})`).join(', ')
}

/**
 * `create_users`: every email is checked first (one registered email refuses the
 * whole card, nothing created), then the users are created in order; the first
 * failure stops the rest and the report names who was created.
 */
export async function createUsers(args: CreateUsersArgs, ctx: WriteToolExecutionContext) {
  refuseRegistered(await listUsers(), args.users.map((user) => user.email))
  const created: CreatedUser[] = []
  try {
    for (const user of args.users) created.push({ email: user.email, username: await createOne(user) })
  } catch (error) {
    const failed = args.users[created.length]?.email ?? ''
    const notCreated = args.users.slice(created.length).map((user) => user.email).join(', ')
    throw new StaleApprovalError(`Creating users stopped at ${failed}: ${safeErrorMessage(error)} Created before that: `
      + `${createdList(created)}. Not created: ${notCreated}.`)
  } finally {
    void invalidateKeys(ctx.queryClient, keysFor.users())
  }
  return {
    summary: `Created ${String(created.length)} users: ${createdList(created)}; Cognito emailed each a temporary password. Nothing else was created.`,
    data: { users: created },
  }
}

interface UpdateStep {
  /** How the step is named in the summary and in a stopped-update report. */
  field: string
  run: () => Promise<unknown>
}

/** The REST calls an update makes, in the order they are applied: names, then role, then enabled state. */
function updateSteps(current: UserRecord, updates: UserUpdates): UpdateStep[] {
  const { username } = current
  const { role, enabled } = updates
  const steps: UpdateStep[] = []
  if (updates.given_name !== undefined || updates.family_name !== undefined) {
    // The merged pair: the new value for a changed name, the stored value for the other.
    const names = { given_name: updates.given_name ?? current.given_name, family_name: updates.family_name ?? current.family_name }
    steps.push({ field: 'name', run: () => api.updateUser(username, names) })
  }
  if (role !== undefined) steps.push({ field: 'role', run: () => api.updateUserGroup(username, role) })
  if (enabled !== undefined) steps.push({ field: 'enabled state', run: () => (enabled ? api.enableUser(username) : api.disableUser(username)) })
  return steps
}

function stoppedMessage(email: string, applied: readonly string[], remaining: readonly string[], error: unknown): string {
  const done = applied.length === 0 ? 'nothing' : applied.join(', ')
  return `Updating user ${email} stopped at the ${remaining[0] ?? ''}: ${safeErrorMessage(error)} `
    + `Applied before that: ${done}. Not applied: ${remaining.join(', ')}.`
}

/** Run `steps` in order, stopping at the first failure (reported with what was applied); the fields applied. */
async function applyInOrder(email: string, steps: readonly UpdateStep[]): Promise<string[]> {
  const applied: string[] = []
  for (const [index, step] of steps.entries()) {
    try {
      await step.run()
    } catch (error) {
      throw new StaleApprovalError(stoppedMessage(email, applied, steps.slice(index).map((s) => s.field), error))
    }
    applied.push(step.field)
  }
  return applied
}

/** The signed-in administrator's own role and enabled state are never changed here (another admin must). */
function refuseSelfChange(current: UserRecord, updates: UserUpdates): void {
  const touchesAccess = updates.role !== undefined || updates.enabled !== undefined
  if (touchesAccess && useAuthStore.getState().user?.username === current.username) throw new StaleApprovalError(SELF_CHANGE_MESSAGE)
}

export async function updateUser(args: UpdateUserArgs, ctx: WriteToolExecutionContext) {
  const current = await fetchUser(args.username)
  if (current === undefined) throw new StaleApprovalError(userMissingMessage(args.username))
  const shownBase = shownOf(ctx)?.userBase
  if (shownBase === undefined || shownBase !== userFingerprint(current)) throw new StaleApprovalError(USER_CHANGED_MESSAGE)
  refuseSelfChange(current, args.updates)
  const applied = await applyInOrder(current.email, updateSteps(current, args.updates))
  void invalidateKeys(ctx.queryClient, keysFor.users())
  return { summary: `Updated user ${current.email} (${applied.join(', ')}).`, data: { username: current.username } }
}

function sourcesText(sourceGrant: SourceGrant): string {
  switch (sourceGrant.mode) {
    case 'default': return 'the default rule (every source that is not restricted)'
    case 'all': return 'every source, restricted ones included'
    case 'list': return `${String(sourceGrant.sources.length)} sources`
  }
}

function accessSummary(username: string, grant: CategoryScope, sourceGrant: SourceGrant | undefined): string {
  const count = grant.categories.length
  const noun = count === 1 ? 'category' : 'categories'
  const categories = grant.all ? 'all categories' : `${String(count)} ${noun}`
  const sources = sourceGrant === undefined ? '' : `; sources: ${sourcesText(sourceGrant)}`
  return `Set access for user ${username}: ${categories}${sources}.`
}

export async function setUserAccess(args: SetUserAccessArgs, ctx: WriteToolExecutionContext) {
  const current = await categoryAccessApi.getUserGrant(args.username)
  const shownBase = shownOf(ctx)?.accessBase
  if (shownBase === undefined || shownBase !== accessFingerprint(current)) throw new StaleApprovalError(ACCESS_CHANGED_MESSAGE)
  const { grant, sourceGrant } = proposedAccess(args)
  await categoryAccessApi.saveUserGrant(args.username, grant, sourceGrant)
  void invalidateKeys(ctx.queryClient, [...keysFor.users(), ...keysFor.userAccess(args.username)])
  return { summary: accessSummary(args.username, grant, sourceGrant), data: { username: args.username } }
}
