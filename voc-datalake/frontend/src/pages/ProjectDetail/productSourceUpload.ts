/**
 * @fileoverview What the Product tab's Sources card takes as a file (7.104.00, docs/project-workspace.md → Product
 * tab), and how one is prepared and uploaded: an image is downscaled first (resizeImage.ts), a PDF, DOCX or PPTX is
 * hashed (SHA-256, required: signed into its PUT, so S3 refuses any other body, and checked by its reading) and, once
 * its PUT landed, announced (`POST …/{doc}/uploaded`, which starts its reading on the projects assist twin). MD, TXT
 * and images are read by the S3-triggered extractor as before.
 *
 * @module pages/ProjectDetail/productSourceUpload
 */
import { projectsApi } from '../../api/projectsApi'
import { IMAGE_MIME_EXTENSIONS } from '../../utils/imageInput'
import { resizeImageForUpload } from './resizeImage'

/** Read by the projects assist twin (`library_extract`): hashed before upload, announced after it. */
const DOCUMENT_MIME = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
} as const

/** Every content type the upload boundary takes (api/product_context.py `ALLOWED_CONTENT_TYPES`). */
const ALLOWED_MIME = {
  ...IMAGE_MIME_EXTENSIONS,
  'text/markdown': '.md',
  'text/plain': '.txt',
  ...DOCUMENT_MIME,
} as const

type AllowedMime = keyof typeof ALLOWED_MIME

function isAllowedMime(value: string): value is AllowedMime {
  return Object.hasOwn(ALLOWED_MIME, value)
}

/** A PDF, DOCX or PPTX: read on the projects assist twin, so the one kind of file `POST …/refresh` reads again. */
export function isDocumentMime(value: string): value is keyof typeof DOCUMENT_MIME {
  return Object.hasOwn(DOCUMENT_MIME, value)
}

/**
 * The general cap, applied to text uploads. Mirrored in lambda/api/product_context.py and pinned to it by
 * lambda/shared/test/test_image_limits_lockstep.py, which reads this line as source text: keep it a single plain
 * multiplication.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** A PDF's, DOCX's or PPTX's cap: shared/library_extract.py MAX_UPLOAD_BYTES. */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

/** The picker's filter: the types, plus the extensions an OS may not map (text/markdown is not registered everywhere). */
export const SOURCE_ACCEPT_ATTR = [...Object.keys(ALLOWED_MIME), ...new Set(Object.values(ALLOWED_MIME))].join(',')

/** The accepted extensions, for a refusal's message (sorted, as the API's own refusal names them). */
export const SOURCE_ACCEPTED_LABEL = [...new Set(Object.values(ALLOWED_MIME))]
  .sort((a, b) => a.localeCompare(b))
  .join(', ')

/** A file's content type: the browser's, or the one its extension names when the browser gave none it knows. */
function sourceTypeOf(file: File): AllowedMime | null {
  if (isAllowedMime(file.type)) return file.type
  const dot = file.name.lastIndexOf('.')
  const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase()
  const byExtension = Object.entries(ALLOWED_MIME).find(([, value]) => value === extension)?.[0] ?? ''
  return isAllowedMime(byExtension) ? byExtension : null
}

/** Why a file is refused before any request, or null when it may be uploaded. */
export type SourceRefusal = { readonly reason: 'type'; readonly type: string } | { readonly reason: 'size'; readonly capMb: number }

export function uploadRefusal(file: File): SourceRefusal | null {
  const type = sourceTypeOf(file)
  if (type === null) return { reason: 'type', type: file.type || 'unknown' }
  // An image's size is decided by the resize below, whose own failure names the reason.
  if (type.startsWith('image/')) return null
  const cap = isDocumentMime(type) ? MAX_DOCUMENT_BYTES : MAX_FILE_BYTES
  return file.size > cap ? { reason: 'size', capMb: Math.round(cap / (1024 * 1024)) } : null
}

/**
 * The file's SHA-256 as hex. Required for a PDF, DOCX or PPTX (`upload-url` refuses one without it): the server signs
 * it into the presigned PUT (`ChecksumSHA256`), so S3 itself refuses a body that is not this file, and the reading
 * holds the stored object to it. A file that cannot be hashed is not uploaded: the failure is the upload's.
 */
async function sha256Hex(blob: Blob): Promise<string> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch (error: unknown) {
    throw new Error('The file could not be hashed for its upload', { cause: error })
  }
}

/** Upload one file the refusal above let through: prepare, declare, PUT, and announce a twin-read document. */
export async function uploadSourceFile(projectId: string, file: File): Promise<void> {
  const type = sourceTypeOf(file) ?? file.type
  // Images are re-encoded, so what is declared and what is PUT are the PREPARED blob: the presigned URL signs
  // ContentLength from `size_bytes`, and declaring the original's size makes S3 refuse the smaller body.
  const prepared = type.startsWith('image/')
    ? await resizeImageForUpload(file)
    : { blob: file, filename: file.name, contentType: type, sizeBytes: file.size }
  const twinRead = isDocumentMime(prepared.contentType)
  const presigned = await projectsApi.createProductDocUploadUrl(projectId, {
    filename: prepared.filename,
    content_type: prepared.contentType,
    size_bytes: prepared.sizeBytes,
    ...(twinRead ? { sha256: await sha256Hex(prepared.blob) } : {}),
  })
  // Every header the server signed (Content-Type, and for a twin-read file `x-amz-checksum-sha256`), sent as given.
  const put = await fetch(presigned.presigned_url, { method: 'PUT', headers: presigned.headers, body: prepared.blob })
  if (!put.ok) throw new Error(`S3 PUT ${String(put.status)}`)
  if (twinRead) await projectsApi.markProductDocUploaded(projectId, presigned.doc_id)
}
