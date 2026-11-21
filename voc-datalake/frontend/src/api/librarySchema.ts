/**
 * @fileoverview Lenient boundaries of the Documents Library's routes (`/projects/library…`,
 * lambda/shared/library_routes.py, docs/documents-library.md): an item without a usable id is dropped, a
 * malformed field degrades, a missing envelope reads as empty.
 *
 * @module api/librarySchema
 */
import { z } from 'zod'
import { parseEach } from './lenientFields'

/** = lambda/shared/library_keys.py ITEM_ID_PATTERN. */
export const LIBRARY_ITEM_ID = /^lib_\d{14}_[0-9a-f]{8}$/
const LIBRARY_STATUSES = ['pending', 'extracting', 'ready', 'failed'] as const
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number]

const optionalString = z.string().optional().catch(undefined)
const optionalNumber = z.number().optional().catch(undefined)
const person = z.looseObject({ sub: z.string().catch(''), name: z.string().catch('') }).optional().catch(undefined)

const libraryItemSchema = z.looseObject({
  item_id: z.string().regex(LIBRARY_ITEM_ID),
  title: z.string().catch(''),
  slug: z.string().catch(''),
  source: z.string().catch(''),
  doc_date: z.string().catch(''),
  tags: z.array(z.string()).catch([]),
  project_id: optionalString,
  filename: z.string().catch(''),
  content_type: z.string().catch(''),
  format: z.string().catch(''),
  bytes: z.number().catch(0),
  status: z.enum(LIBRARY_STATUSES).catch('failed'),
  /**
   * Stopped, no longer polled: an extraction 16 minutes or more old (its worker cannot be running), offered for a retry,
   * or a pending item as old (its upload link lasts 15 minutes: no file will arrive; delete it and upload again).
   */
  stale: z.boolean().optional().catch(undefined),
  error: optionalString,
  extracted_chars: z.number().catch(0),
  pages: optionalNumber,
  chunks: z.number().catch(0),
  native: z.boolean().catch(false),
  truncated: z.boolean().optional().catch(undefined),
  method: optionalString,
  created_by: person,
  created_at: z.string().catch(''),
  updated_by: person,
  updated_at: z.string().catch(''),
  version: z.number().catch(1),
})
export type LibraryItem = z.infer<typeof libraryItemSchema>

const listEnvelope = z.looseObject({
  items: z.unknown().optional(),
  total: z.number().catch(0),
  tags: z.array(z.string()).catch([]),
  next_cursor: z.string().nullable().optional().catch(null),
})

export interface LibraryPage {
  items: LibraryItem[]
  total: number
  tags: string[]
  nextCursor: string | null
}

export function normalizeLibraryPage(raw: unknown): LibraryPage {
  const parsed = listEnvelope.safeParse(raw)
  if (!parsed.success) return { items: [], total: 0, tags: [], nextCursor: null }
  return {
    items: parseEach(libraryItemSchema, parsed.data.items),
    total: parsed.data.total,
    tags: parsed.data.tags,
    nextCursor: parsed.data.next_cursor ?? null,
  }
}

/** What `#` offers: a ready item (the suggest route's slim fields). */
const librarySuggestionSchema = z.looseObject({
  item_id: z.string().regex(LIBRARY_ITEM_ID),
  slug: z.string().min(1),
  title: z.string().catch(''),
  format: z.string().catch(''),
  bytes: z.number().catch(0),
  native: z.boolean().catch(false),
  extracted_chars: z.number().catch(0),
  pages: optionalNumber,
  project_id: optionalString,
})
export type LibrarySuggestion = z.infer<typeof librarySuggestionSchema>

export function normalizeLibrarySuggestions(raw: unknown): LibrarySuggestion[] {
  const parsed = z.looseObject({ items: z.unknown().optional() }).safeParse(raw)
  return parsed.success ? parseEach(librarySuggestionSchema, parsed.data.items) : []
}

const uploadSchema = z.looseObject({
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).catch({}),
  expires_in: z.number().catch(900),
})
export type LibraryUpload = z.infer<typeof uploadSchema>

export interface LibraryCreated {
  item: LibraryItem
  upload: LibraryUpload
}

/** `POST /projects/library`'s 201; a malformed answer is an error (nothing to upload to). */
export function normalizeLibraryCreated(raw: unknown): LibraryCreated {
  return z.looseObject({ item: libraryItemSchema, upload: uploadSchema }).parse(raw)
}

/** An answer carrying one item (`uploaded`, `retry`, `PUT`). */
export function normalizeLibraryItemAnswer(raw: unknown): LibraryItem {
  return z.looseObject({ item: libraryItemSchema }).parse(raw).item
}

const previewSchema = z.looseObject({
  text_excerpt: z.string().catch(''),
  text_parts: z.number().catch(0),
  original_url: z.string().nullable().optional().catch(null),
})

export interface LibraryDetail {
  item: LibraryItem
  excerpt: string
  textParts: number
  originalUrl: string | null
}

export function normalizeLibraryDetail(raw: unknown): LibraryDetail {
  const parsed = z.looseObject({ item: libraryItemSchema, preview: previewSchema.optional() }).parse(raw)
  return {
    item: parsed.item,
    excerpt: parsed.preview?.text_excerpt ?? '',
    textParts: parsed.preview?.text_parts ?? 0,
    originalUrl: parsed.preview?.original_url ?? null,
  }
}

export interface LibraryText {
  page: number
  parts: number
  paged: boolean
  text: string
}

export function normalizeLibraryText(raw: unknown): LibraryText {
  return z.looseObject({
    page: z.number().catch(1), parts: z.number().catch(1), paged: z.boolean().catch(false), text: z.string().catch(''),
  }).parse(raw)
}
