import { describe, expect, it } from 'vitest'
import { LIMITS } from '../contract'
import {
  ATTACHMENT_ACCEPT, MAX_ATTACHMENT_MB, attachmentRejection, buildUserContent, resolveAttachmentMime,
} from './attachments'
import type { PendingAttachment } from './attachments'

function pending(mimeType: PendingAttachment['mimeType'], data = 'QUJD', name = 'f'): PendingAttachment {
  return { id: name, name, mimeType, data }
}

describe('resolveAttachmentMime', () => {
  it.each([
    ['reviews.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['notes.md', '', 'text/markdown'],
    ['Notes.MD', '', 'text/markdown'],
    ['brief.docx', '', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['legacy.doc', 'application/msword', 'application/msword'],
    ['sheet.xlsx', '', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['sheet.xls', '', 'application/vnd.ms-excel'],
    ['page.htm', '', 'text/html'],
    ['readme.txt', '', 'text/plain'],
    ['scan.pdf', 'application/pdf', 'application/pdf'],
    ['photo.JPG', '', 'image/jpeg'],
  ])('resolves %s (reported %j) to %s', (name, type, expected) => {
    expect(resolveAttachmentMime({ name, type })).toBe(expected)
  })

  it('falls back to the reported type when the extension is unknown', () => {
    expect(resolveAttachmentMime({ name: 'export', type: 'text/plain' })).toBe('text/plain')
  })

  it('returns null for a file Bedrock cannot read', () => {
    expect(resolveAttachmentMime({ name: 'archive.zip', type: 'application/zip' })).toBeNull()
  })
})

describe('buildUserContent', () => {
  it('sends images as image parts and every other format as a document part', () => {
    const parts = buildUserContent('read these', [
      pending('image/png', 'QUJD', 'a.png'),
      pending('text/csv', 'QUJD', 'b.csv'),
      pending('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'QUJD', 'c.xlsx'),
    ])
    expect(parts).toStrictEqual([
      { type: 'text', text: 'read these' },
      expect.objectContaining({ type: 'image', source: { type: 'data', value: 'QUJD', mimeType: 'image/png' } }),
      expect.objectContaining({ type: 'document', source: { type: 'data', value: 'QUJD', mimeType: 'text/csv' } }),
      expect.objectContaining({ type: 'document', metadata: { name: 'c.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }),
    ])
  })
})

describe('attachment limits', () => {
  it('refuses a sixth attachment and an attachment past the base64 budget', () => {
    const five = Array.from({ length: LIMITS.maxAttachments }, (_, i) => pending('text/plain', 'QQ==', `n${i}`))
    expect(attachmentRejection(five, pending('text/plain'))).toBe('count')
    const big = pending('text/plain', 'A'.repeat(LIMITS.maxAttachmentBase64Chars))
    expect(attachmentRejection([], big)).toBeNull()
    expect(attachmentRejection([pending('text/plain', 'A')], big)).toBe('size')
  })

  it('states the total budget in decoded megabytes', () => {
    expect(MAX_ATTACHMENT_MB).toBeCloseTo(2.1, 10)
  })

  it('offers every document extension in the file picker', () => {
    for (const ext of ['.csv', '.doc', '.docx', '.xls', '.xlsx', '.html', '.txt', '.md', '.pdf']) {
      expect(ATTACHMENT_ACCEPT.split(',')).toContain(ext)
    }
  })
})
