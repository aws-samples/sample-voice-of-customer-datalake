/**
 * @fileoverview Per-user flags (users Lambda, admin only).
 *
 * - `fallback_owner` — the admin who receives agent-created projects whose
 *   category has no owner. Only admins may carry it, and at most one user does:
 *   the server clears it elsewhere when it is set here.
 * - `memory_reviewer` — may curate company memory (review, merge, imports).
 *
 * `GET /users` rows carry `flags`; a row without them reads as both false.
 *
 * @module api/userFlagsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'

const UserFlagsSchema = z.object({
  fallback_owner: z.boolean().catch(false),
  memory_reviewer: z.boolean().catch(false),
}).catch({ fallback_owner: false, memory_reviewer: false })
export type UserFlags = z.output<typeof UserFlagsSchema>
export type UserFlag = keyof UserFlags

const FlagsCarrierSchema = z.looseObject({ flags: z.unknown().optional() })

/** The flags of a `GET /users` row (or a `PUT .../flags` answer). */
export function readUserFlags(raw: unknown): UserFlags {
  const carrier = FlagsCarrierSchema.safeParse(raw)
  return UserFlagsSchema.parse(carrier.data?.flags ?? {})
}

export const userFlagsApi = {
  save: async (username: string, patch: Partial<UserFlags>): Promise<UserFlags> =>
    readUserFlags(await fetchApi<unknown>(`/users/${encodeURIComponent(username)}/flags`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })),
}
