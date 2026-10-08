/**
 * @fileoverview Composer attachments → AG-UI image/document content parts.
 *
 * Images (png/jpeg/gif/webp) become `image` parts and PDFs `document` parts,
 * carried inline as base64 `data` sources. Bounds mirror `LIMITS`: at most
 * `maxAttachments` files and `maxAttachmentBase64Chars` of base64 in total.
 *
 * @module assistant/components/attachments
 */
import { LIMITS } from '../contract'
import type { ContentPart } from '@ag-ui/core'

const ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number]
export const ATTACHMENT_ACCEPT = ATTACHMENT_MIME_TYPES.join(',')

export interface PendingAttachment {
  id: string
  name: string
  mimeType: AttachmentMime
  /** Base64 without the `data:` prefix. */
  data: string
}

export type AttachmentError = 'type' | 'count' | 'size' | 'read'

export function isAttachmentMime(value: string): value is AttachmentMime {
  return ATTACHMENT_MIME_TYPES.some((m) => m === value)
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
  return attachment.mimeType === 'application/pdf'
    ? { type: 'document', source, metadata }
    : { type: 'image', source, metadata }
}

/** The user message content: plain text, or text + attachment parts. */
export function buildUserContent(text: string, attachments: readonly PendingAttachment[]): ContentPart[] | string {
  const parts: ContentPart[] = [
    ...(attachments.length === 0 || text.trim() === '' ? [] : [{ type: 'text' as const, text }]),
    ...attachments.map(toContentPart),
  ]
  return parts.length === 0 ? text : parts
}
