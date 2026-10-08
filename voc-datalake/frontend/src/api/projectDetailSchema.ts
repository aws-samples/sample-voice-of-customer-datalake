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
import type {
  ProjectDocument,
} from './types'
import type {
  Project,
  ProjectAccess,
  ProjectDetail,
  ProjectMember,
  ProjectMemberCandidate,
  ProjectMembersResponse,
  ProjectPersona,
} from './projectTypes'

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
  /** An unmanaged (research / custom) document's edit counter; absent = 1. */
  revision: z.number().int().positive().optional().catch(undefined),
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

// ── Sharing fields (see voc-datalake/lambda/shared/project_access.py) ──
// A legacy payload without them is a public project the caller can view; it
// is NOT assumed editable or manageable — the server stays the authority, so
// a missing field can only hide controls, never grant them.

const DEFAULT_PROJECT_ACCESS: ProjectAccess = Object.freeze({
  role: null, can_view: true, can_edit: false, can_manage: false,
})

const ProjectAccessSchema = z.object({
  role: z.enum(['owner', 'admin', 'editor', 'viewer']).nullable().catch(null),
  can_view: z.boolean().catch(true),
  can_edit: z.boolean().catch(false),
  can_manage: z.boolean().catch(false),
}).catch(() => ({ ...DEFAULT_PROJECT_ACCESS }))

const ProjectOwnerSchema = z.object({
  sub: z.string().min(1),
  username: z.string().catch(''),
  email: z.string().catch(''),
}).nullable().catch(null)

const ProjectMemberSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(['editor', 'viewer']).catch('viewer'),
  username: z.string().catch(''),
  email: z.string().catch(''),
  added_by: optionalString,
  added_at: optionalString,
})

const MemberCandidateSchema = z.object({
  sub: z.string().min(1),
  username: z.string().catch(''),
  email: z.string().catch(''),
  name: optionalString,
})

const VisibilitySchema = z.enum(['public', 'private']).catch('public')

/** Keep only the rows `schema` accepts; a non-array becomes []. */
function lenientList<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

const optionalMembersSchema = z
  .array(z.unknown())
  .optional()
  .catch(undefined)
  .transform((items) => (items === undefined ? undefined : lenientList(ProjectMemberSchema, items)))

const ProjectSchema = z.looseObject({
  visibility: VisibilitySchema,
  owner: ProjectOwnerSchema,
  access: ProjectAccessSchema,
  member_count: z.number().int().nonnegative().catch(0),
  members: optionalMembersSchema,
  project_id: z.string().min(1),
  name: z.string().catch(''),
  description: z.string().catch(''),
  status: z.enum(['active', 'archived']).catch('active'),
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
  persona_count: z.number().int().nonnegative().catch(0),
  document_count: z.number().int().nonnegative().catch(0),
  filters: z.record(z.string(), z.unknown()).optional().catch(undefined),
  kiro_default_export_prompt: optionalString,
})

const ProjectDetailEnvelopeSchema = z.looseObject({
  project: ProjectSchema,
  personas: z.array(z.unknown()).catch(() => []),
  documents: z.array(z.unknown()).catch(() => []),
})

/** One project detail response, dropping only rows with no usable identity/type. */
export function normalizeProjectDetail(raw: unknown): ProjectDetail {
  return normalizedDetail(ProjectDetailEnvelopeSchema.parse(raw))
}

function normalizedDetail(parsed: z.infer<typeof ProjectDetailEnvelopeSchema>): ProjectDetail {
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

const ProjectDetailBatchSchema = z.looseObject({ details: z.array(z.unknown()).catch(() => []) })

/**
 * `GET /projects?ids=…`: the details the caller can view (no personas — the batch
 * read omits them). An entry without a usable project is dropped, not fatal: one
 * damaged record must not blank the Prioritization board.
 */
export function normalizeProjectDetailBatch(raw: unknown): ProjectDetail[] {
  return ProjectDetailBatchSchema.parse(raw).details.flatMap((entry) => {
    const parsed = ProjectDetailEnvelopeSchema.safeParse(entry)
    return parsed.success ? [normalizedDetail(parsed.data)] : []
  })
}

/** One document from a write answer (an edit / restore), or null when it is unusable. */
export function normalizeProjectDocument(raw: unknown): ProjectDocument | null {
  const parsed = ProjectDocumentSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ── Document versions (GET /projects/{id}/documents/{doc}/versions) ──
// A PRD / PR-FAQ version is a document row of its own (`version_id` = its
// document_id); a research / custom version is a saved revision (`r{n}`).
const DocumentVersionSchema = z.object({
  version_id: z.string().min(1),
  document_id: optionalString,
  version: z.number().int().positive(),
  title: z.string().catch(''),
  content: z.string().catch(''),
  created_at: z.string().nullable().catch(null),
  current: z.boolean().catch(false),
  edit_kind: z.enum(['edit', 'restore']).nullable().optional().catch(null),
  restored_from_version: z.number().int().positive().nullable().optional().catch(null),
})
export type DocumentVersion = z.output<typeof DocumentVersionSchema>

/** The versions list, newest first; an unusable row costs only itself. */
export function normalizeDocumentVersions(raw: unknown): DocumentVersion[] {
  const items = asRecord(raw)?.versions
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    const parsed = DocumentVersionSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

/** Normalize GET /projects, dropping only rows without a usable project_id. */
export function normalizeProjectList(raw: unknown): { projects: Project[] } {
  const record = asRecord(raw)
  const projects = lenientList(ProjectSchema, record?.projects)
  return { ...record, projects }
}

/** Normalize one project object (e.g. the `project` of a POST /projects response). */
export function normalizeProject(raw: unknown): Project | null {
  const parsed = ProjectSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Normalize GET /projects/{id}/members. */
export function normalizeProjectMembers(raw: unknown): ProjectMembersResponse {
  const record = asRecord(raw) ?? {}
  return {
    visibility: VisibilitySchema.parse(record.visibility),
    owner: ProjectOwnerSchema.parse(record.owner),
    members: lenientList(ProjectMemberSchema, record.members),
    access: ProjectAccessSchema.parse(record.access),
  }
}

/** Normalize one member row (POST / PUT member responses); null when unusable. */
export function normalizeProjectMember(raw: unknown): ProjectMember | null {
  const parsed = ProjectMemberSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Normalize GET /projects/{id}/members/candidates. */
export function normalizeMemberCandidates(raw: unknown): ProjectMemberCandidate[] {
  return lenientList(MemberCandidateSchema, asRecord(raw)?.users)
}
