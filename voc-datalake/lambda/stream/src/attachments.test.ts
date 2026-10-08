/**
 * Tests for AG-UI media parts → Bedrock content blocks.
 */
import { describe, it, expect } from 'vitest';
import type { ContentPart } from '@ag-ui/core';
import { partsToContentBlocks, sanitizeDocumentName } from './attachments.js';
import { nth } from './lib/nth-fixtures.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');

function image(mimeType: string, value = b64('img')): ContentPart {
  return { type: 'image', source: { type: 'data', value, mimeType } };
}

function pdf(name?: string): ContentPart {
  return { type: 'document', source: { type: 'data', value: b64('%PDF'), mimeType: 'application/pdf' }, ...(name ? { metadata: { name } } : {}) };
}

describe('partsToContentBlocks', () => {
  it('converts images and PDFs and skips text parts', () => {
    const blocks = partsToContentBlocks([{ type: 'text', text: 'hi' }, image('image/webp'), pdf('Q3 report.pdf')]);
    expect(blocks).toHaveLength(2);
    expect(nth(blocks, 0).image?.format).toBe('webp');
    expect(Buffer.from(nth(blocks, 0).image?.source?.bytes ?? []).toString()).toBe('img');
    expect(nth(blocks, 1).document).toMatchObject({ format: 'pdf', name: 'Q3 report' });
  });

  it('gives duplicate and missing document names unique fallbacks', () => {
    const names = partsToContentBlocks([pdf('a.pdf'), pdf('a.pdf'), pdf()]).map((b) => b.document?.name);
    expect(names).toStrictEqual(['a', 'a (2)', 'document-3']);
  });

  it.each([
    ['an unsupported image type', image('image/tiff'), 'Unsupported attachment: image (image/tiff)'],
    ['audio', { type: 'audio', source: { type: 'data', value: b64('x'), mimeType: 'audio/mpeg' } }, 'Unsupported attachment: audio (audio/mpeg)'],
    ['a document that is not a PDF', { type: 'document', source: { type: 'data', value: b64('x'), mimeType: 'text/html' } }, 'Unsupported attachment: document (text/html)'],
  ] satisfies [string, ContentPart, string][])('rejects %s', (_label, part, message) => {
    expect(() => partsToContentBlocks([part])).toThrow(message);
  });
});

describe('sanitizeDocumentName', () => {
  it('keeps only characters Bedrock accepts', () => {
    expect(sanitizeDocumentName('my_file   v2 (final)!.pdf', 0)).toBe('my-file v2 (final)-');
    expect(sanitizeDocumentName('...', 4)).toBe('--');
    expect(sanitizeDocumentName('', 4)).toBe('document-5');
  });
});

// Pins the mutation run found missing: every format, the exact 5MB boundary,
// the bytes of a document, the metadata name rules and the full refusal texts.
describe('partsToContentBlocks — exact mapping', () => {
  it.each([
    ['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ])('maps %s to the %s image format', (mimeType, format) => {
    expect(partsToContentBlocks([image(mimeType)])).toStrictEqual([
      { image: { format, source: { bytes: Buffer.from('img') } } },
    ]);
  });

  it('passes a PDF\'s bytes through', () => {
    expect(partsToContentBlocks([pdf('x.pdf')])).toStrictEqual([
      { document: { format: 'pdf', name: 'x', source: { bytes: Buffer.from('%PDF') } } },
    ]);
  });

  it('accepts exactly 5MB and names the size of one byte more', () => {
    const limit = 5 * 1024 * 1024;
    expect(partsToContentBlocks([image('image/png', Buffer.alloc(limit).toString('base64'))])).toHaveLength(1);
    expect(() => partsToContentBlocks([image('image/png', Buffer.alloc(limit + 1).toString('base64'))]))
      .toThrow(`Attachment exceeds 5MB limit (${limit + 1} bytes)`);
  });

  it.each([
    ['a URL source', { type: 'image', source: { type: 'url', value: 'https://x.test/a.png' } }, 'Attachments must be sent inline (source type "data")'],
    ['a document carrying an image type', { type: 'document', source: { type: 'data', value: b64('x'), mimeType: 'image/png' } }, 'Unsupported attachment: document (image/png)'],
    ['an image carrying a PDF type', { type: 'image', source: { type: 'data', value: b64('x'), mimeType: 'application/pdf' } }, 'Unsupported attachment: image (application/pdf)'],
  ] satisfies [string, ContentPart, string][])('refuses %s with its exact cause', (_label, part, message) => {
    expect(() => partsToContentBlocks([part])).toThrow(message);
  });

  it.each([
    ['null metadata', null, 'document-1'],
    ['a filename', { filename: 'f.pdf' }, 'f'],
    ['an empty name before a filename', { name: '', filename: 'f.pdf' }, 'f'],
    ['a non-string name before a filename', { name: ['a'], filename: 'f.pdf' }, 'f'],
  ])('names a document from %s', (_label, metadata, name) => {
    const part: ContentPart = { type: 'document', source: { type: 'data', value: b64('%PDF'), mimeType: 'application/pdf' }, metadata };
    expect(nth(partsToContentBlocks([part]), 0).document?.name).toBe(name);
  });
});

describe('sanitizeDocumentName — exact cleanup', () => {
  it.each([
    ['only the last extension is dropped', 'a.b.pdf', 'a-b'],
    ['surrounding spaces are trimmed', '  x  .pdf', 'x'],
    ['names are cut to 200 characters', `${'n'.repeat(250)}.pdf`, 'n'.repeat(200)],
  ])('%s', (_label, raw, expected) => {
    expect(sanitizeDocumentName(raw, 0)).toBe(expected);
  });
});
