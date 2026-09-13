/**
 * Runtime normalization for GET /projects/{id}.
 *
 * Project detail is a mixed-age DynamoDB payload: sparse legacy records and
 * newer additive fields must remain readable together. Loose schemas retain
 * fields this bundle does not know yet, while known fields are made safe for
 * the components that consume them.
 */
import { z } from 'zod'
import { asRecord } from './wireRecord'
import type { ProjectDetail, ProjectDocument, ProjectPersona } from './types'

const optionalString = z.string().optional().catch(undefined)
const optionalNullableString = z.string().nullable().optional().catch(undefined)
const optionalNonnegativeInteger = z.number().int().nonnegative().optional().catch(undefined)
const optionalStringArray = z
  .array(z.unknown())
  .optional()
  .catch(undefined)
  .transform((items) => items?.filter((item): item is string => typeof item === 'string'))

const personaIdentitySchema = z.looseObject({
  age_range: optionalString,
  location: optionalString,
  occupation: optionalString,
  income_bracket: optionalString,
  education: optionalString,
  family_status: optionalString,
  bio: optionalString,
}).optional().catch(undefined)

const personaGoalsSchema = z.looseObject({
  primary_goal: optionalString,
  secondary_goals: optionalStringArray,
  success_definition: optionalString,
  underlying_motivations: optionalStringArray,
}).optional().catch(undefined)

const personaPainPointsSchema = z.looseObject({
  current_challenges: optionalStringArray,
  blockers: optionalStringArray,
  workarounds: optionalStringArray,
  emotional_impact: optionalString,
}).optional().catch(undefined)

const personaBehaviorsSchema = z.looseObject({
  current_solutions: optionalStringArray,
  tools_used: optionalStringArray,
  activity_frequency: optionalString,
  tech_savviness: optionalString,
  decision_style: optionalString,
}).optional().catch(undefined)

const personaContextSchema = z.looseObject({
  usage_context: optionalString,
  devices: optionalStringArray,
  time_constraints: optionalString,
  social_context: optionalString,
  influencers: optionalStringArray,
}).optional().catch(undefined)

const personaScenarioSchema = z.looseObject({
  title: optionalString,
  narrative: optionalString,
  trigger: optionalString,
  outcome: optionalString,
}).optional().catch(undefined)

const quoteSchema = z.looseObject({
  text: z.string(),
  context: optionalString,
})

const optionalQuotesSchema = z
  .array(z.unknown())
  .optional()
  .catch(undefined)
  .transform((items) => items?.flatMap((item) => {
    const parsed = quoteSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  }))

const researchNoteSchema = z.union([
  z.string(),
  z.looseObject({
    note_id: optionalString,
    text: z.string(),
    author: optionalString,
    created_at: optionalString,
    tags: optionalStringArray,
  }),
])

const optionalResearchNotesSchema = z
  .array(z.unknown())
  .optional()
  .catch(undefined)
  .transform((items) => items?.flatMap((item) => {
    const parsed = researchNoteSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  }))

const ProjectPersonaSchema = z.looseObject({
  persona_id: z.string().min(1),
  name: z.string().catch(''),
  tagline: z.string().catch(''),
  created_at: z.string().catch(''),
  confidence: z.enum(['high', 'medium', 'low']).optional().catch(undefined),
  feedback_count: optionalNonnegativeInteger,
  avatar_url: optionalString,
  avatar_prompt: optionalString,
  identity: personaIdentitySchema,
  goals_motivations: personaGoalsSchema,
  pain_points: personaPainPointsSchema,
  behaviors: personaBehaviorsSchema,
  context_environment: personaContextSchema,
  quotes: optionalQuotesSchema,
  scenario: personaScenarioSchema,
  research_notes: optionalResearchNotesSchema,
  supporting_evidence: optionalStringArray,
  source_breakdown: z.record(z.string(), z.number()).optional().catch(undefined),
})

function withLegacyManagedDocumentType(raw: unknown): unknown {
  const record = asRecord(raw)
  if (record === null || typeof record.document_type === 'string') return raw

  const sortKey = typeof record.sk === 'string' ? record.sk : ''
  const separator = sortKey.indexOf('#')
  const legacyType = (separator === -1 ? '' : sortKey.slice(0, separator)).toLowerCase()
  if (legacyType !== 'prd' && legacyType !== 'prfaq' && legacyType !== 'prototype') return raw

  return { ...record, document_type: legacyType }
}

const ProjectDocumentSchema = z.preprocess(withLegacyManagedDocumentType, z.looseObject({
  document_id: z.string().min(1),
  document_type: z.string().trim().min(1),
  title: z.string().catch(''),
  base_title: optionalString,
  version: z.number().int().positive().optional().catch(undefined),
  // S3-backed prototypes intentionally omit inline content. Keeping content a
  // required string after this boundary lets every consumer stay honest.
  content: z.string().catch(''),
  sk: optionalString,
  feature_idea: optionalString,
  question: optionalString,
  prototype_format: optionalString,
  prototype_url: z.url().optional().catch(undefined),
  source_prd_id: optionalNullableString,
  source_prfaq_id: optionalNullableString,
  source_documents: optionalStringArray,
  merge_instructions: optionalString,
  feedback_count: optionalNonnegativeInteger,
  revised_from_id: optionalNullableString,
  revision_feedback: optionalString,
  created_at: z.string().catch(''),
  updated_at: optionalString,
}))

const ProjectSchema = z.looseObject({
  project_id: z.string().min(1),
  name: z.string().catch(''),
  description: z.string().catch(''),
  status: z.enum(['active', 'archived']).catch('active'),
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
  persona_count: z.number().int().nonnegative().catch(0),
  document_count: z.number().int().nonnegative().catch(0),
  filters: z.record(z.string(), z.unknown()).optional().catch(undefined),
  kiro_export_prompt: optionalString,
  kiro_default_export_prompt: optionalString,
})

const ProjectDetailEnvelopeSchema = z.looseObject({
  project: ProjectSchema,
  personas: z.array(z.unknown()).catch(() => []),
  documents: z.array(z.unknown()).catch(() => []),
})

/** Normalize one project detail response, dropping only rows with no usable identity/type. */
export function normalizeProjectDetail(raw: unknown): ProjectDetail {
  const parsed = ProjectDetailEnvelopeSchema.parse(raw)
  const personas: ProjectPersona[] = []
  const documents: ProjectDocument[] = []

  for (const rawPersona of parsed.personas) {
    const persona = ProjectPersonaSchema.safeParse(rawPersona)
    if (persona.success) personas.push(persona.data)
    else console.warn('[projectDetailSchema] dropping persona without a usable id')
  }

  for (const rawDocument of parsed.documents) {
    const document = ProjectDocumentSchema.safeParse(rawDocument)
    if (document.success) documents.push(document.data)
    else console.warn('[projectDetailSchema] dropping document without a usable id or type')
  }

  return { ...parsed, personas, documents }
}
