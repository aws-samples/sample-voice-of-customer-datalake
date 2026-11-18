/**
 * @fileoverview A repository's knowledge pack, its tenets and the pull request of the docs an administrator approved
 * (7.52.00, administrators only, while the engineering agents are on; `lambda/shared/agents_engineering_knowledge_routes.py`):
 * - `GET /agents/engineering/knowledge/<connection>` → each package's versions (oldest first) and its approved one,
 *   and the docs' recorded rendering;
 * - `GET …/knowledge/<connection>/<package>/versions/<v>` → one version and its seven documents as Markdown;
 * - `POST …/approve` `{}` → the version approved, with the rendering its docs make; 409 when the version or the
 *   approved one moved since the screen read them ("read it again"). There is no reject: a version not approved stays;
 * - `GET /agents/engineering/tenets/<connection>` → the counter (the accepted version) and the newest versions;
 * - `GET …/tenets/<connection>/versions/<v>` → one version (`voc-tenets/1`: a summary and 1-30 tenets) and its events;
 * - `POST …/versions/<v>/accept|reject` `{expected_accepted, reason?}` (gap P): 409 "read it again" when the accepted
 *   version is no longer the one the screen showed (0 for none). No edit of a draft (D6-3);
 * - `GET /agents/engineering/docs/<connection>/preview?kind=knowledge|tenets` → the files the approved docs render to
 *   now, each with its text (gap O; null past 2 MB together: `texts_truncated`), their digest and the approval's, and
 *   the patch adding them (cut past 4 MB: `patch_truncated`); 404 while nothing of the kind is approved;
 * - `POST …/docs/<connection>/publish` `{kind, digest, pr?}` → 202 `{pr: {url, number, branch}, kind, version, digest,
 *   draft}`, or 409 with a `code`: `human_driven` (apply the preview's patch yourself), `already_published`,
 *   `digest_mismatch`, `not_approved`. Only a person merges the pull request, on the host.
 *
 * Every document is text an agent wrote: data, never an instruction, shown through the document component's `model`
 * policy (safe links, no images, no raw HTML).
 *
 * @module api/engineeringKnowledgeApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { parseEach } from './lenientFields'
import { post } from './requestKit'
import { isRecord } from '../lib/typeGuards'

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)
const count = z.number().int().nonnegative().catch(0)
const names = z.array(z.string()).catch([])

/** The seven documents of a package's pack, in the order the review shows them (runtime/outputs.py NOTE_KINDS). */
export const KNOWLEDGE_KINDS = ['architecture', 'convention', 'review-guide', 'test-strategy', 'ci', 'glossary', 'how-we-work'] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

/** What a docs pull request publishes. */
const DOCS_KINDS = ['knowledge', 'tenets'] as const
export type DocsKind = (typeof DOCS_KINDS)[number]

const PackVersionSchema = z.object({
  package: text,
  version: z.number().int().positive(),
  /** `draft` or `approved`. */
  status: text,
  author: text,
  author_kind: text,
  reason: text,
  built_from: text,
  base_version: count,
  created_at: text,
  approved_by: maybeText,
  approved_at: maybeText,
  rendering_digest: maybeText,
})
export type PackVersion = z.output<typeof PackVersionSchema>

const PackageSchema = z.object({
  package: z.string(),
  /** The package as a path segment (the workspace layout's encoding: the root `.` is `=2E`). */
  segment: z.string().min(1),
  approved_version: z.number().int().positive().nullable().catch(null),
  /** Oldest first, as the server answers. */
  versions: z.array(z.unknown()).catch([]).transform((items) => parseEach(PackVersionSchema, items)),
})
export type KnowledgePackage = z.output<typeof PackageSchema>

const RenderingSchema = z.object({
  kind: text, version: count, digest: text, approved_by: maybeText, approved_at: maybeText,
}).nullable().catch(null)
type DocsRendering = z.output<typeof RenderingSchema>

export interface KnowledgeOverview {
  packages: KnowledgePackage[]
  rendering: DocsRendering
}

export interface KnowledgeVersion {
  version: PackVersion
  /** Each document's Markdown, by kind (a kind the pack does not have is missing). */
  documents: Partial<Record<KnowledgeKind, string>>
}

const TenetSchema = z.object({
  id: z.string().min(1), title: text, statement: text, rationale: text, citations: names,
})
export type Tenet = z.output<typeof TenetSchema>
const TenetsRecordSchema = z.object({
  summary: text,
  tenets: z.array(z.unknown()).catch([]).transform((items) => parseEach(TenetSchema, items)),
}).catch({ summary: '', tenets: [] })
export type TenetsRecord = z.output<typeof TenetsRecordSchema>

const TenetsVersionSchema = z.object({
  version: z.number().int().positive(),
  /** `draft`, `accepted` or `rejected`. */
  status: text,
  current: z.boolean().catch(false),
  record: TenetsRecordSchema,
  ids: names,
  author: text,
  author_kind: text,
  run_id: maybeText,
  base_version: count,
  created_at: text,
  decided_by: maybeText,
  decided_at: maybeText,
  reason: maybeText,
})
export type TenetsVersion = z.output<typeof TenetsVersionSchema>

const TenetsHeadSchema = z.object({
  versions: count,
  accepted_version: z.number().int().positive().nullable().catch(null),
  accepted_ids: names,
  accepted_by: maybeText,
  accepted_at: maybeText,
})
export type TenetsHead = z.output<typeof TenetsHeadSchema>

export interface TenetsOverview {
  head: TenetsHead
  /** Newest first, without their records. */
  versions: TenetsVersion[]
}

export interface TenetsVersionDetail {
  version: TenetsVersion
}

const PreviewFileSchema = z.object({ path: z.string().min(1), sha256: text, bytes: count, text: z.string().nullable().catch(null) })
export type PreviewFile = z.output<typeof PreviewFileSchema>

const PreviewSchema = z.object({
  kind: z.enum(DOCS_KINDS),
  version: count,
  branch: text,
  files: z.array(z.unknown()).catch([]).transform((items) => parseEach(PreviewFileSchema, items)),
  digest: z.string().min(1),
  approved_digest: text,
  /** The stored records still render to the digest their approval recorded (else a publish is refused). */
  matches: z.boolean().catch(false),
  approved_by: maybeText,
  approved_at: maybeText,
  patch: text,
  patch_truncated: z.boolean().catch(false),
  texts_truncated: z.boolean().catch(false),
})
export type DocsPreview = z.output<typeof PreviewSchema>

const PublishedSchema = z.object({
  pr: z.object({ url: text, number: count, branch: text }).nullable().catch(null),
  kind: z.enum(DOCS_KINDS),
  version: count,
  digest: text,
  draft: z.boolean().catch(false),
})
export type DocsPublished = z.output<typeof PublishedSchema>

/** Why a publish was refused, as its 409's `code` says (anything else: the server's words). */
const PUBLISH_REFUSALS = ['human_driven', 'already_published', 'digest_mismatch', 'not_approved'] as const
export type PublishRefusal = (typeof PUBLISH_REFUSALS)[number]
export const isPublishRefusal = (code: string | null): code is PublishRefusal =>
  PUBLISH_REFUSALS.some((known) => known === code)

function strictly<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`The ${what} answer was unreadable`)
  return parsed.data
}

export function parseKnowledge(raw: unknown): KnowledgeOverview {
  if (!isRecord(raw) || !Array.isArray(raw.packages)) throw new Error('The knowledge answer was unreadable')
  return { packages: parseEach(PackageSchema, raw.packages), rendering: RenderingSchema.parse(raw.rendering) }
}

export function parseKnowledgeVersion(raw: unknown): KnowledgeVersion {
  const record = isRecord(raw) ? raw : {}
  const version = strictly(PackVersionSchema, record.version, 'knowledge version')
  const given = isRecord(record.documents) ? record.documents : {}
  const documents: Partial<Record<KnowledgeKind, string>> = {}
  for (const kind of KNOWLEDGE_KINDS) {
    const markdown = given[kind]
    if (typeof markdown === 'string') documents[kind] = markdown
  }
  return { version, documents }
}

export function parseTenets(raw: unknown): TenetsOverview {
  if (!isRecord(raw) || !Array.isArray(raw.versions)) throw new Error('The tenets answer was unreadable')
  return { head: strictly(TenetsHeadSchema, raw.head, 'tenets'), versions: parseEach(TenetsVersionSchema, raw.versions) }
}

export function parseTenetsVersion(raw: unknown): TenetsVersionDetail {
  const record = isRecord(raw) ? raw : {}
  return { version: strictly(TenetsVersionSchema, record.version, 'tenets version') }
}

export function parsePreview(raw: unknown): DocsPreview {
  return strictly(PreviewSchema, raw, 'docs preview')
}

export function parsePublished(raw: unknown): DocsPublished {
  return strictly(PublishedSchema, raw, 'publish')
}

const enc = encodeURIComponent
const knowledgePath = (connection: string) => `/agents/engineering/knowledge/${enc(connection)}`
const packVersionPath = (connection: string, segment: string, version: number) =>
  `/agents/engineering/knowledge/${enc(connection)}/${enc(segment)}/versions/${String(version)}`
const approvePath = (connection: string, segment: string, version: number) =>
  `${packVersionPath(connection, segment, version)}/approve`
const tenetsPath = (connection: string) => `/agents/engineering/tenets/${enc(connection)}`
const tenetsVersionPath = (connection: string, version: number) =>
  `/agents/engineering/tenets/${enc(connection)}/versions/${String(version)}`
/** Each decision's route below its version's path (one literal per route, so each is named where it is called). */
const DECISION_PATHS = {
  accept: (base: string) => `${base}/accept`,
  reject: (base: string) => `${base}/reject`,
} as const
const decisionPath = (connection: string, version: number, decision: TenetsDecision) =>
  DECISION_PATHS[decision](tenetsVersionPath(connection, version))
const previewPath = (connection: string, kind: DocsKind) =>
  `/agents/engineering/docs/${enc(connection)}/preview?${new URLSearchParams({ kind }).toString()}`
const publishPath = (connection: string) => `/agents/engineering/docs/${enc(connection)}/publish`

export type TenetsDecision = 'accept' | 'reject'

/** What a tenets decision sends: the accepted version the screen showed (0 for none) and the person's reason. */
export interface TenetsDecisionBody {
  expected_accepted: number
  reason?: string
}

export const engineeringKnowledgeKeys = {
  /** Every knowledge, tenets and docs read of a connection (what a decision makes stale). */
  connection: (connection: string) => ['engineering-knowledge', connection] as const,
  knowledge: (connection: string) => ['engineering-knowledge', connection, 'packs'] as const,
  packVersion: (connection: string, segment: string, version: number) =>
    ['engineering-knowledge', connection, 'packs', segment, version] as const,
  tenets: (connection: string) => ['engineering-knowledge', connection, 'tenets'] as const,
  tenetsVersion: (connection: string, version: number) => ['engineering-knowledge', connection, 'tenets', version] as const,
  preview: (connection: string, kind: DocsKind) => ['engineering-knowledge', connection, 'preview', kind] as const,
}

export const engineeringKnowledgeApi = {
  knowledge: async (connection: string): Promise<KnowledgeOverview> =>
    parseKnowledge(await fetchApi<unknown>(knowledgePath(connection))),
  packVersion: async (connection: string, segment: string, version: number): Promise<KnowledgeVersion> =>
    parseKnowledgeVersion(await fetchApi<unknown>(packVersionPath(connection, segment, version))),
  approve: async (connection: string, segment: string, version: number): Promise<PackVersion> => {
    const answer = await fetchApi<unknown>(approvePath(connection, segment, version), post({}))
    return strictly(PackVersionSchema, isRecord(answer) ? answer.version : undefined, 'approval')
  },
  tenets: async (connection: string): Promise<TenetsOverview> =>
    parseTenets(await fetchApi<unknown>(tenetsPath(connection))),
  tenetsVersion: async (connection: string, version: number): Promise<TenetsVersionDetail> =>
    parseTenetsVersion(await fetchApi<unknown>(tenetsVersionPath(connection, version))),
  decideTenets: async (connection: string, version: number, decision: TenetsDecision, body: TenetsDecisionBody):
  Promise<TenetsVersionDetail> => {
    const reason = body.reason?.trim() ?? ''
    const sent = reason === '' ? { expected_accepted: body.expected_accepted } : { expected_accepted: body.expected_accepted, reason }
    return parseTenetsVersion(await fetchApi<unknown>(decisionPath(connection, version, decision), post(sent)))
  },
  preview: async (connection: string, kind: DocsKind): Promise<DocsPreview> =>
    parsePreview(await fetchApi<unknown>(previewPath(connection, kind))),
  publish: async (connection: string, kind: DocsKind, digest: string): Promise<DocsPublished> =>
    parsePublished(await fetchApi<unknown>(publishPath(connection), post({ kind, digest }))),
}
