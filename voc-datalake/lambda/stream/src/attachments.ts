/**
 * AG-UI media parts → Bedrock Converse content blocks.
 *
 * Only inline bytes (`source.type === 'data'`) are accepted: a URL source would
 * make the Lambda fetch an arbitrary address, and a provider file handle is
 * meaningless to Bedrock. Images (png/jpeg/gif/webp) and every document format
 * Converse reads natively (pdf, csv, doc, docx, xls, xlsx, html, txt, md) are
 * supported — Bedrock parses Office files itself, so there is no parsing here.
 * Converse takes at most 5 documents per request, 4.5 MB each; anything else is
 * a ValidationError the user can act on.
 */
import type { ContentBlock, DocumentFormat, ImageFormat } from '@aws-sdk/client-bedrock-runtime';
import type { ContentPart } from '@ag-ui/core';
import { ValidationError } from './lib/errors.js';

// 5MB decoded
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
/** Converse limits for document blocks (API_runtime_Message): 5 per request, 4.5 MB each. */
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_BYTES = 4.5 * 1024 * 1024;
const MAX_DOCUMENT_NAME_LENGTH = 200;

const IMAGE_FORMATS: ReadonlyMap<string, ImageFormat> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

const DOCUMENT_FORMATS: ReadonlyMap<string, DocumentFormat> = new Map([
  ['application/pdf', 'pdf'],
  ['text/csv', 'csv'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['text/html', 'html'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
]);

type MediaPart = Exclude<ContentPart, { type: 'text' }>;

function metadataName(part: MediaPart): string | undefined {
  const metadata: unknown = part.metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const candidates = [Reflect.get(metadata, 'name'), Reflect.get(metadata, 'filename')];
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * Bedrock document names allow letters, digits, single spaces, hyphens,
 * parentheses and square brackets only.
 */
export function sanitizeDocumentName(raw: string | undefined, index: number): string {
  const base = (raw ?? '').replace(/\.[^.]*$/, '');
  const cleaned = base
    .replaceAll(/[^A-Za-z0-9 \-()[\]]/g, '-')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOCUMENT_NAME_LENGTH);
  return cleaned || `document-${index + 1}`;
}

function decode(part: MediaPart): { bytes: Uint8Array; mimeType: string } {
  if (part.source.type !== 'data') {
    throw new ValidationError('Attachments must be sent inline (source type "data")');
  }
  const bytes = Buffer.from(part.source.value, 'base64');
  if (bytes.length > MAX_SIZE_BYTES) {
    throw new ValidationError(`Attachment exceeds 5MB limit (${bytes.length} bytes)`);
  }
  return { bytes, mimeType: part.source.mimeType };
}

function toBlock(part: MediaPart, index: number, usedNames: Set<string>): ContentBlock {
  const { bytes, mimeType } = decode(part);
  const imageFormat = IMAGE_FORMATS.get(mimeType);
  if (part.type === 'image' && imageFormat) {
    return { image: { format: imageFormat, source: { bytes } } };
  }
  const documentFormat = DOCUMENT_FORMATS.get(mimeType);
  if (part.type === 'document' && documentFormat) {
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      throw new ValidationError(`Document exceeds the 4.5MB limit (${bytes.length} bytes)`);
    }
    const base = sanitizeDocumentName(metadataName(part), index);
    // Bedrock rejects two documents with the same name in one message.
    const name = usedNames.has(base) ? `${base} (${index + 1})` : base;
    usedNames.add(name);
    return { document: { format: documentFormat, name, source: { bytes } } };
  }
  throw new ValidationError(`Unsupported attachment: ${part.type} (${mimeType})`);
}

/** Convert the media parts of a user message (text parts are ignored here). */
export function partsToContentBlocks(parts: readonly ContentPart[]): ContentBlock[] {
  const usedNames = new Set<string>();
  const media = parts.filter((part): part is MediaPart => part.type !== 'text');
  if (media.filter((part) => part.type === 'document').length > MAX_DOCUMENTS) {
    throw new ValidationError(`At most ${MAX_DOCUMENTS} documents can be attached to one message`);
  }
  return media.map((part, index) => toBlock(part, index, usedNames));
}
