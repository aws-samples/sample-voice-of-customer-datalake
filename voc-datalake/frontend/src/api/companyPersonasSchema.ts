/**
 * @fileoverview Lenient boundaries for the company persona library (`/company-personas`)
 * and the project-side copy routes (`/projects/{id}/personas/copy-sources|copy`).
 *
 * Same precedent as `projectDetailSchema.ts`: a persona without a usable id is
 * dropped, a malformed field degrades, and a missing envelope reads as empty.
 *
 * @module api/companyPersonasSchema
 */
import { z } from 'zod'
import { parseEach } from './lenientFields'
import { copiedFromSchema } from './personaCopiedFrom'
import { normalizePersona } from './projectDetailSchema'
import type { ProjectPersona } from './projectTypes'

/** = the copy route's 1–20 bound (brief: `persona_ids`, 1–20 unique non-empty strings). */
export const MAX_PERSONAS_PER_COPY = 20

function personaList(raw: unknown): ProjectPersona[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const persona = normalizePersona(item)
    return persona ? [persona] : []
  })
}

const listEnvelope = z.looseObject({
  personas: z.unknown().optional(),
  can_edit: z.boolean().catch(false),
})

/** `GET /company-personas` → the library, and whether the caller may write it (admins). */
export function normalizeCompanyPersonas(raw: unknown): { personas: ProjectPersona[]; canEdit: boolean } {
  const parsed = listEnvelope.safeParse(raw)
  if (!parsed.success) return { personas: [], canEdit: false }
  return { personas: personaList(parsed.data.personas), canEdit: parsed.data.can_edit }
}

const personaSummarySchema = z.object({
  persona_id: z.string().min(1),
  name: z.string().catch(''),
  tagline: z.string().catch(''),
  avatar_url: z.string().nullable().catch(null),
  copied_from: copiedFromSchema,
})

export type PersonaSummary = z.infer<typeof personaSummarySchema>

const sourceProjectSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().catch(''),
  persona_count: z.number().int().nonnegative().catch(0),
})

export type PersonaSourceProject = z.infer<typeof sourceProjectSchema>

export interface PersonaCopySources {
  readonly company: PersonaSummary[]
  readonly projects: PersonaSourceProject[]
}

const copySourcesEnvelope = z.looseObject({
  company: z.unknown().optional(),
  projects: z.unknown().optional(),
})

/** `GET /projects/{id}/personas/copy-sources`. */
export function normalizeCopySources(raw: unknown): PersonaCopySources {
  const parsed = copySourcesEnvelope.safeParse(raw)
  if (!parsed.success) return { company: [], projects: [] }
  return {
    company: parseEach(personaSummarySchema, parsed.data.company),
    projects: parseEach(sourceProjectSchema, parsed.data.projects),
  }
}

const copyEnvelope = z.looseObject({ personas: z.unknown().optional() })

/** `POST /projects/{id}/personas/copy` → the copies written. */
export function normalizeCopyAnswer(raw: unknown): { personas: ProjectPersona[] } {
  const parsed = copyEnvelope.safeParse(raw)
  return { personas: parsed.success ? personaList(parsed.data.personas) : [] }
}
