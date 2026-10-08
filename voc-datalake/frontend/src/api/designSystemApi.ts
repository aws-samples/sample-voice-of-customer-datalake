/**
 * @fileoverview Company design system — tokens, guidelines, logo, references and
 * the write-only Figma/GitHub integration tokens.
 *
 * - `GET /settings/design-system` (any user); `PUT` admin-only (tokens + guidelines).
 * - `POST /settings/design-system/references` (admin) `{kind, title, url?}`; an
 *   upload kind (screenshot / html) answers with a presigned PUT the SPA sends the
 *   file to. `POST .../references/{id}/refresh` re-fetches a Figma/GitHub link;
 *   `DELETE .../references/{id}` ARCHIVES (status 'archived', object kept).
 * - `POST /settings/design-system/logo` (admin) `{content_type, size_bytes}` →
 *   a presigned PUT for the logo.
 * - `PUT /settings/design-system/integrations` (admin) — tokens are write-only:
 *   every response carries only `{figma: bool, github: bool}`.
 *
 * @module api/designSystemApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText as text, optionalText, parsedList } from './schemaList'

export const REFERENCE_KINDS = ['screenshot', 'html', 'figma', 'github'] as const
export type ReferenceKind = typeof REFERENCE_KINDS[number]

/** Kinds sent as a file through a presigned PUT; the others are links. */
export const UPLOAD_KINDS: ReadonlySet<ReferenceKind> = new Set(['screenshot', 'html'])

const MB = 1024 * 1024
/** Accepted content types and size caps per upload kind (server-enforced too). */
export const UPLOAD_LIMITS = {
  screenshot: { types: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 5 * MB },
  html: { types: ['text/html'], maxBytes: 2 * MB },
  // No SVG: an SVG is a document that can carry script (the API refuses it too).
  logo: { types: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 5 * MB },
} as const satisfies Record<string, { types: readonly string[]; maxBytes: number }>
export type UploadTarget = keyof typeof UPLOAD_LIMITS

const REFERENCE_STATUSES = ['pending', 'processing', 'ready', 'failed', 'archived'] as const
export type ReferenceStatus = typeof REFERENCE_STATUSES[number]

const NamedValueSchema = z.object({ name: z.string().min(1), value: text })
export type NamedValue = z.output<typeof NamedValueSchema>

const TypographySchema = z.object({
  role: z.string().min(1),
  family: text,
  size: optionalText,
  weight: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
})
export type TypographyToken = z.output<typeof TypographySchema>

const TokensSchema = z.object({
  colors: parsedList(NamedValueSchema),
  typography: parsedList(TypographySchema),
  spacing: parsedList(NamedValueSchema),
  radius: parsedList(NamedValueSchema),
}).catch({ colors: [], typography: [], spacing: [], radius: [] })
export type DesignTokens = z.output<typeof TokensSchema>

const ReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(REFERENCE_KINDS),
  title: text,
  url: optionalText,
  s3_key: optionalText,
  extracted_summary: optionalText,
  // The API stores a failed fetch as 'error' (lambda/shared/design_references.py
  // record_outcome); read it as 'failed' so it is not mistaken for "in progress".
  // Unknown → pending: shown as "in progress", never as a confirmed state.
  status: z.preprocess((value) => (value === 'error' ? 'failed' : value), z.enum(REFERENCE_STATUSES)).catch('pending'),
  /** The user-safe reason a fetch failed ("Figma refused access — …"), absent otherwise. */
  error: optionalText,
})
export type DesignReference = z.output<typeof ReferenceSchema>

const IntegrationsSchema = z.object({
  figma: z.boolean().catch(false),
  github: z.boolean().catch(false),
}).catch({ figma: false, github: false })
export type IntegrationsStatus = z.output<typeof IntegrationsSchema>

const DesignSystemSchema = z.object({
  tokens: TokensSchema,
  guidelines: text,
  logo_url: optionalText,
  references: parsedList(ReferenceSchema),
  integrations: IntegrationsSchema,
  updated_at: optionalText,
}).catch({
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  guidelines: '',
  references: [],
  integrations: { figma: false, github: false },
})
export type DesignSystem = z.output<typeof DesignSystemSchema>

/**
 * A presigned PUT. Read from `upload: {url, headers}` or the flat
 * `upload_url`/`presigned_url` + `headers` shape other upload routes use.
 */
const HeadersSchema = z.record(z.string(), z.string()).catch({})
const UploadSchema = z.object({ url: z.url(), headers: HeadersSchema })
export type PresignedUpload = z.output<typeof UploadSchema>

const UploadEnvelopeSchema = z.looseObject({
  upload: z.unknown().optional(),
  upload_url: z.unknown().optional(),
  presigned_url: z.unknown().optional(),
  headers: z.unknown().optional(),
})

function readUpload(raw: unknown): PresignedUpload | null {
  const envelope = UploadEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return null
  const { upload, upload_url: uploadUrl, presigned_url: presignedUrl, headers } = envelope.data
  const nested = UploadSchema.safeParse(upload)
  if (nested.success) return nested.data
  const flat = UploadSchema.safeParse({ url: uploadUrl ?? presignedUrl, headers })
  return flat.success ? flat.data : null
}

export function normalizeDesignSystem(raw: unknown): DesignSystem {
  return DesignSystemSchema.parse(raw)
}

export function normalizeIntegrations(raw: unknown): IntegrationsStatus {
  const envelope = z.looseObject({ integrations: z.unknown().optional() }).safeParse(raw)
  return IntegrationsSchema.parse(envelope.data?.integrations ?? raw)
}

export interface CreatedReference {
  reference: DesignReference | null
  upload: PresignedUpload | null
}

export function normalizeCreatedReference(raw: unknown): CreatedReference {
  const envelope = z.looseObject({ reference: z.unknown().optional() }).safeParse(raw)
  const reference = ReferenceSchema.safeParse(envelope.data?.reference)
  return { reference: reference.success ? reference.data : null, upload: readUpload(raw) }
}

/** Why a file cannot be uploaded as `target`, or null when it can. */
export function uploadRejection(target: UploadTarget, file: Pick<File, 'type' | 'size'>): 'type' | 'size' | null {
  const limits = UPLOAD_LIMITS[target]
  if (!limits.types.some((type) => type === file.type)) return 'type'
  if (file.size > limits.maxBytes) return 'size'
  return null
}

/** True for colour values a swatch may paint (hex, rgb/hsl/oklch functions, plain names). */
export function isPaintableColor(value: string): boolean {
  const v = value.trim()
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)
    || /^(?:rgba?|hsla?|oklch|oklab|lab|lch)\([\d\s.,%/+-]+\)$/i.test(v)
    || /^[a-z]{3,20}$/i.test(v)
}

/** PUT a file to a presigned URL; throws on a non-OK answer. */
export async function putToPresigned(upload: PresignedUpload, file: Blob): Promise<void> {
  const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: file })
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
}

export interface CreateReferenceRequest {
  kind: ReferenceKind
  title: string
  url?: string
  content_type?: string
  size_bytes?: number
}

const BASE = '/settings/design-system'

export const designSystemKey = () => ['design-system'] as const

export const designSystemApi = {
  get: async (): Promise<DesignSystem> => normalizeDesignSystem(await fetchApi<unknown>(BASE)),

  save: async (body: { tokens: DesignTokens; guidelines: string }): Promise<DesignSystem> =>
    normalizeDesignSystem(await fetchApi<unknown>(BASE, { method: 'PUT', body: JSON.stringify(body) })),

  createReference: async (request: CreateReferenceRequest): Promise<CreatedReference> =>
    normalizeCreatedReference(await fetchApi<unknown>(`${BASE}/references`, {
      method: 'POST',
      body: JSON.stringify(request),
    })),

  refreshReference: async (id: string): Promise<void> => {
    await fetchApi<unknown>(`${BASE}/references/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
  },

  archiveReference: async (id: string): Promise<void> => {
    await fetchApi<unknown>(`${BASE}/references/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  createLogoUpload: async (contentType: string, sizeBytes: number): Promise<PresignedUpload | null> =>
    readUpload(await fetchApi<unknown>(`${BASE}/logo`, {
      method: 'POST',
      body: JSON.stringify({ content_type: contentType, size_bytes: sizeBytes }),
    })),

  saveIntegrations: async (tokens: { figma_token?: string; github_token?: string }): Promise<IntegrationsStatus> =>
    normalizeIntegrations(await fetchApi<unknown>(`${BASE}/integrations`, {
      method: 'PUT',
      body: JSON.stringify(tokens),
    })),
}
