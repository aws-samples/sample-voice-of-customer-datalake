/**
 * @fileoverview What the Documents Library accepts, checked in the browser before anything is declared to the API:
 * the content types and their formats, the size caps, and how a file's type is read.
 *
 * LOCKSTEP with lambda/shared/library_extract.py `FORMATS`, `MAX_UPLOAD_BYTES` and `MAX_NATIVE_IMAGE_BYTES` (and
 * lambda/shared/library_store.py, which refuses the same files with `unsupported_type` / `too_large`): a type
 * accepted here and not there is refused after the person filled in its details; one accepted there and not here
 * can never be uploaded.
 *
 * A file's type is read from its extension first, then from the browser's `type`: the browser names a `.md` file
 * '' or `text/x-markdown` on some systems, and Windows names a `.csv` `application/vnd.ms-excel` (which the
 * library would read as a legacy Excel file).
 *
 * @module pages/Library/libraryFormats
 */

/** Content type → the format the library stores (= library_extract.py FORMATS, name by name). */
export const LIBRARY_FORMATS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** File extension → its content type (every type above, with the spellings people's files carry). */
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 25 MB per file (= library_extract.py MAX_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/** An image Converse takes: at most 3.75 MB (= library_extract.py MAX_NATIVE_IMAGE_BYTES). */
export const MAX_IMAGE_BYTES = 3_750_000

/** The file picker's filter: every type and every extension (a type is not registered on every system). */
export const ACCEPT_ATTR = [
  ...Object.keys(LIBRARY_FORMATS),
  ...Object.keys(EXTENSION_TYPES).map((extension) => `.${extension}`),
].join(',')

/** The extensions a refusal names, in a stable order. */
export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_TYPES).map((extension) => `.${extension}`).join(', ')

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The content type the library is told for `file` (its extension's, else the browser's), or null when it takes none. */
export function contentTypeOf(file: Pick<File, 'name' | 'type'>): string | null {
  const byExtension = EXTENSION_TYPES[extensionOf(file.name)]
  if (byExtension !== undefined) return byExtension
  const declared = file.type.toLowerCase()
  return Object.hasOwn(LIBRARY_FORMATS, declared) ? declared : null
}

const isImageType = (contentType: string): boolean => contentType.startsWith('image/')

/** Why a file cannot be uploaded, or what it is. */
export type FileCheck =
  | { readonly ok: true; readonly contentType: string; readonly format: string }
  | { readonly ok: false; readonly reason: 'unsupported' | 'empty' | 'tooLarge' | 'imageTooLarge' }

export function checkFile(file: Pick<File, 'name' | 'type' | 'size'>): FileCheck {
  const contentType = contentTypeOf(file)
  if (contentType === null) return { ok: false, reason: 'unsupported' }
  if (file.size === 0) return { ok: false, reason: 'empty' }
  const image = isImageType(contentType)
  if (file.size > (image ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES)) return { ok: false, reason: image ? 'imageTooLarge' : 'tooLarge' }
  return { ok: true, contentType, format: LIBRARY_FORMATS[contentType] ?? '' }
}

/** A file's name without its extension: the title an upload starts from (= library_store.py's default). */
export function titleFromFilename(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot <= 0 ? name : name.slice(0, dot)
  return base.trim().slice(0, 200)
}

/** `Q3 Market Report` → `q3-market-report` (= library_store.py `slugify`): the short name the server makes. */
export function librarySlug(text: string): string {
  // NFKD, then only ASCII is kept (Python's `encode('ascii', 'ignore')`): `é` reads as `e`, `日本` as nothing.
  const plain = text.normalize('NFKD').replaceAll(/[^ -~]/g, '').toLowerCase()
  // Runs of anything else are one hyphen, so each end holds at most one.
  const slug = plain.replaceAll(/[^a-z0-9]+/g, '-').replace(/^-/, '').replace(/-$/, '').slice(0, 64).replace(/-$/, '')
  return slug === '' ? 'document' : slug
}

/** = lambda/shared/library_keys.py SLUG_PATTERN. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export const isSlug = (value: string): boolean => SLUG_PATTERN.test(value)

/** = library_store.py MAX_TAGS and MAX_TAG_CHARS. */
export const MAX_TAGS = 10
export const MAX_TAG_CHARS = 40

/** Tags typed as `market, q3 report` → `['market', 'q3 report']`: trimmed, spaces collapsed, lower case, no repeats. */
export function parseLibraryTags(text: string): string[] {
  const tags = text.split(',').map((tag) => tag.replaceAll(/\s+/g, ' ').trim().toLowerCase()).filter((tag) => tag !== '')
  return [...new Set(tags)]
}

/** What is wrong with a list of tags, or null. */
export function tagsProblem(tags: readonly string[]): 'tooMany' | 'tooLong' | null {
  if (tags.length > MAX_TAGS) return 'tooMany'
  return tags.some((tag) => tag.length > MAX_TAG_CHARS) ? 'tooLong' : null
}
