/**
 * @fileoverview Lenient boundary for a persona's `copied_from` (company personas, 5.60).
 *
 * A copy (into the company library, or into a project from the library or another
 * project) records where it came from. A malformed value reads as "not a copy"
 * rather than failing the persona it sits on.
 *
 * @module api/personaCopiedFrom
 */
import { z } from 'zod'
import type { PersonaCopiedFrom } from './projectTypes'

const optionalText = z.string().optional().catch(undefined)

const copiedFromObject = z.object({
  scope: z.enum(['project', 'company']),
  project_id: optionalText,
  project_name: optionalText,
  persona_id: z.string().catch(''),
  copied_at: z.string().catch(''),
  copied_by: optionalText,
})

/**
 * The persona field: absent or unreadable = undefined. Typed against the declared
 * wire type, so the schema and `PersonaCopiedFrom` cannot drift apart.
 */
export const copiedFromSchema: z.ZodType<PersonaCopiedFrom | undefined> = copiedFromObject.optional().catch(undefined)
