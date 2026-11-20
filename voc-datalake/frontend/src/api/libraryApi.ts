/**
 * @fileoverview The Documents Library's routes (docs/documents-library.md), on the projects API's
 * `/projects/{proxy+}` (lambda/shared/library_routes.py). Workspace-scoped like every `fetchApi` call
 * (`X-Workspace-Id`): a workspace's library is its own; without one, the deployment's.
 *
 * An upload is three steps: `create` (a pending item and a 15-minute presigned PUT bound to the file's
 * exact length and type, written once), the PUT itself (`putLibraryFile`, which reports progress), then
 * `markUploaded`, which starts the extraction.
 *
 * @module api/libraryApi
 */
import { del, post, put } from './requestKit'
import { fetchApi } from './client'
import {
  normalizeLibraryCreated, normalizeLibraryDetail, normalizeLibraryItemAnswer, normalizeLibraryPage,
  normalizeLibrarySuggestions, normalizeLibraryText,
} from './librarySchema'
import type {
  LibraryCreated, LibraryDetail, LibraryItem, LibraryPage, LibrarySuggestion, LibraryText, LibraryUpload,
} from './librarySchema'

export const LIBRARY_SORTS = ['newest', 'oldest', 'title', 'doc_date'] as const
export type LibrarySort = (typeof LIBRARY_SORTS)[number]

export interface LibraryListQuery {
  q?: string
  tag?: string
  projectId?: string
  sort?: LibrarySort
  cursor?: string
  limit?: number
}

export interface LibraryCreateBody {
  filename: string
  content_type: string
  bytes: number
  title?: string
  slug?: string
  source?: string
  doc_date?: string
  tags?: string[]
  project_id?: string
  sha256?: string
}

export interface LibraryEditBody {
  expected_version: number
  title?: string
  slug?: string
  source?: string
  doc_date?: string
  tags?: string[]
  project_id?: string
}

function listQuery(query: LibraryListQuery): string {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.tag) params.set('tag', query.tag)
  if (query.projectId) params.set('project_id', query.projectId)
  if (query.sort) params.set('sort', query.sort)
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const text = params.toString()
  return text ? `?${text}` : ''
}

const itemPath = (itemId: string) => `/projects/library/${encodeURIComponent(itemId)}`

export const libraryApi = {
  list: async (query: LibraryListQuery = {}): Promise<LibraryPage> =>
    normalizeLibraryPage(await fetchApi<unknown>(`/projects/library${listQuery(query)}`)),

  suggest: async (q: string): Promise<LibrarySuggestion[]> =>
    normalizeLibrarySuggestions(await fetchApi<unknown>(`/projects/library/suggest?q=${encodeURIComponent(q)}`)),

  create: async (body: LibraryCreateBody): Promise<LibraryCreated> =>
    normalizeLibraryCreated(await fetchApi<unknown>('/projects/library', post(body))),

  markUploaded: async (itemId: string): Promise<LibraryItem> =>
    normalizeLibraryItemAnswer(await fetchApi<unknown>(`${itemPath(itemId)}/uploaded`, post())),

  retry: async (itemId: string): Promise<LibraryItem> =>
    normalizeLibraryItemAnswer(await fetchApi<unknown>(`${itemPath(itemId)}/retry`, post())),

  get: async (itemId: string): Promise<LibraryDetail> =>
    normalizeLibraryDetail(await fetchApi<unknown>(itemPath(itemId))),

  text: async (itemId: string, page: number): Promise<LibraryText> =>
    normalizeLibraryText(await fetchApi<unknown>(`${itemPath(itemId)}/text?page=${String(page)}`)),

  update: async (itemId: string, body: LibraryEditBody): Promise<LibraryItem> =>
    normalizeLibraryItemAnswer(await fetchApi<unknown>(itemPath(itemId), put(body))),

  remove: (itemId: string) => fetchApi<{ success: boolean; deleted: string }>(itemPath(itemId), del()),
}

/** The query keys of the library (the page and the composer's `#` read the same list and suggestions). */
export const libraryKeys = {
  all: ['library'] as const,
  list: (query: LibraryListQuery) => ['library', 'list', query] as const,
  item: (itemId: string) => ['library', 'item', itemId] as const,
  text: (itemId: string, page: number) => ['library', 'text', itemId, page] as const,
  suggest: (q: string) => ['library', 'suggest', q] as const,
}

/**
 * PUT the file to its presigned URL with exactly the headers the API signed, reporting progress (0–1). XHR, not
 * fetch: fetch reports no upload progress. Resolves on a 2xx; a 412 means the item already holds a file.
 */
export function putLibraryFile(upload: LibraryUpload, file: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', upload.url)
    for (const [name, value] of Object.entries(upload.headers)) request.setRequestHeader(name, value)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve()
      else reject(new LibraryUploadError(request.status))
    }
    request.onerror = () => { reject(new LibraryUploadError(0)) }
    request.send(file)
  })
}

/** The PUT was refused (its HTTP status; 0 when the network failed). */
export class LibraryUploadError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`The upload failed (${String(status)})`)
    this.name = 'LibraryUploadError'
    this.status = status
  }
}
