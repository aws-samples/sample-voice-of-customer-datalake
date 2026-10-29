/**
 * @fileoverview The `{sub, username, email}` reference to a Cognito user that
 * several wire shapes carry (a project's owner and members, a category's
 * product owners, member candidates).
 * @module api/userRefSchema
 */
import { z } from 'zod'

/**
 * `sub` is the identity the backend grants by, so a reference without a usable
 * one does not parse; `username` / `email` are display only and default to ''.
 */
export const UserRefSchema = z.object({
  sub: z.string().trim().min(1),
  username: z.string().catch(''),
  email: z.string().catch(''),
})
