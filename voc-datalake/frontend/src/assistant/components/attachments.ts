/**
 * @fileoverview Composer attachments → AG-UI image/document content parts.
 *
 * Images (png/jpeg/gif/webp) become `image` parts; every document format Bedrock
 * Converse reads natively (pdf, csv, doc, docx, xls, xlsx, html, txt, md) becomes a
 * `document` part — Bedrock parses Office files itself. All are carried inline as
 * base64 `data` sources. Bounds mirror `LIMITS`: at most `maxAttachments` files
 * (which also keeps the Converse limit of 5 documents per request) and
 * `maxAttachmentBase64Chars` of base64 in total.
 *
 * @module assistant/components/attachments
 */
import { LIMITS } from '../contract'
import type { ContentPart } from '@ag-ui/core'

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/html',
  'text/plain',
  'text/markdown',
] as const
const ATTACHMENT_MIME_TYPES = [...IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES] as const
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number]

/**
 * File extension → MIME type. Browsers report an empty or platform-specific type
 * for several of these (`.md` is often '', `.csv` is `application/vnd.ms-excel`
 * on Windows), so a known extension wins over the reported type.
 */
const EXTENSION_MIME: ReadonlyMap<string, AttachmentMime> = new Map<string, AttachmentMime>([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['pdf', 'application/pdf'], ['csv', 'text/csv'], ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['html', 'text/html'], ['htm', 'text/html'], ['txt', 'text/plain'], ['md', 'text/markdown'], ['markdown', 'text/markdown'],
])

export const ATTACHMENT_ACCEPT = [...ATTACHMENT_MIME_TYPES, ...[...EXTENSION_MIME.keys()].map((ext) => `.${ext}`)].join(',')

/** Decoded bytes per base64 character (4 characters carry 3 bytes). */
const BYTES_PER_BASE64_CHAR = 3 / 4
/** The total attachment budget in decoded megabytes, rounded down to one decimal (shown in the size error). */
export const MAX_ATTACHMENT_MB = Math.floor((LIMITS.maxAttachmentBase64Chars * BYTES_PER_BASE64_CHAR) / 100_000) / 10

export interface PendingAttachment {
  id: string
  name: string
  mimeType: AttachmentMime
  /** Base64 without the `data:` prefix. */
  data: string
}

export type AttachmentError = 'type' | 'count' | 'size' | 'read'

function isAttachmentMime(value: string): value is AttachmentMime {
  return ATTACHMENT_MIME_TYPES.some((m) => m === value)
}

function isImageMime(value: AttachmentMime): boolean {
  return IMAGE_MIME_TYPES.some((m) => m === value)
}

/** The MIME type to send for a file: its known extension first, else its reported type, else null. */
export function resolveAttachmentMime(file: Pick<File, 'name' | 'type'>): AttachmentMime | null {
  const dot = file.name.lastIndexOf('.')
  const byExtension = dot === -1 ? undefined : EXTENSION_MIME.get(file.name.slice(dot + 1).toLowerCase())
  if (byExtension) return byExtension
  return isAttachmentMime(file.type) ? file.type : null
}

function totalBase64(attachments: readonly PendingAttachment[]): number {
  return attachments.reduce((sum, a) => sum + a.data.length, 0)
}

/** Why `next` cannot join `current`, or null when it fits. */
export function attachmentRejection(current: readonly PendingAttachment[], next: PendingAttachment): AttachmentError | null {
  if (current.length >= LIMITS.maxAttachments) return 'count'
  if (totalBase64(current) + next.data.length > LIMITS.maxAttachmentBase64Chars) return 'size'
  return null
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('read'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

function toContentPart(attachment: PendingAttachment): ContentPart {
  const source = { type: 'data' as const, value: attachment.data, mimeType: attachment.mimeType }
  const metadata = { name: attachment.name, mimeType: attachment.mimeType }
  return isImageMime(attachment.mimeType)
    ? { type: 'image', source, metadata }
    : { type: 'document', source, metadata }
}

/** The user message content: plain text, or text + attachment parts. */
export function buildUserContent(text: string, attachments: readonly PendingAttachment[]): ContentPart[] | string {
  const parts: ContentPart[] = [
    ...(attachments.length === 0 || text.trim() === '' ? [] : [{ type: 'text' as const, text }]),
    ...attachments.map(toContentPart),
  ]
  return parts.length === 0 ? text : parts
}
