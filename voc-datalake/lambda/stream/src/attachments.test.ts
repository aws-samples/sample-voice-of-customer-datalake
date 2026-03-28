/**
 * Tests for attachment validation and Bedrock content block conversion.
 */
import { describe, it, expect } from 'vitest';
import { attachmentsToContentBlocks } from './attachments.js';
import type { Attachment } from './schema.js';

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    name: 'test.png',
    media_type: 'image/png',
    data: Buffer.from('fake-image-data').toString('base64'),
    ...overrides,
  };
}

describe('attachmentsToContentBlocks', () => {
  it('converts a PNG image to an image content block', () => {
    const blocks = attachmentsToContentBlocks([makeAttachment()]);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.image).toBeDefined();
    expect(block.image?.format).toBe('png');
    expect(block.image?.source?.bytes).toBeInstanceOf(Buffer);
  });

  it('converts a JPEG image to an image content block', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'photo.jpg', media_type: 'image/jpeg' }),
    ]);
    expect(blocks[0].image?.format).toBe('jpeg');
  });

  it('converts a GIF image to an image content block', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'anim.gif', media_type: 'image/gif' }),
    ]);
    expect(blocks[0].image?.format).toBe('gif');
  });

  it('converts a WebP image to an image content block', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'photo.webp', media_type: 'image/webp' }),
    ]);
    expect(blocks[0].image?.format).toBe('webp');
  });

  it('converts a PDF to a document content block', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'report.pdf', media_type: 'application/pdf' }),
    ]);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.document).toBeDefined();
    expect(block.document?.format).toBe('pdf');
    expect(block.document?.name).toBe('report');
    expect(block.document?.source?.bytes).toBeInstanceOf(Buffer);
  });

  it('strips file extension from PDF document name', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'my.report.v2.pdf', media_type: 'application/pdf' }),
    ]);
    expect(blocks[0].document?.name).toBe('my.report.v2');
  });

  it('uses full name when PDF has no extension', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'report', media_type: 'application/pdf' }),
    ]);
    expect(blocks[0].document?.name).toBe('report');
  });

  it('converts multiple attachments in order', () => {
    const blocks = attachmentsToContentBlocks([
      makeAttachment({ name: 'a.png', media_type: 'image/png' }),
      makeAttachment({ name: 'b.pdf', media_type: 'application/pdf' }),
      makeAttachment({ name: 'c.jpg', media_type: 'image/jpeg' }),
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].image?.format).toBe('png');
    expect(blocks[1].document?.format).toBe('pdf');
    expect(blocks[2].image?.format).toBe('jpeg');
  });

  it('returns empty array for empty input', () => {
    expect(attachmentsToContentBlocks([])).toEqual([]);
  });

  it('throws ValidationError when attachment exceeds 5MB', () => {
    const largeData = Buffer.alloc(6 * 1024 * 1024).toString('base64');
    expect(() =>
      attachmentsToContentBlocks([makeAttachment({ data: largeData })]),
    ).toThrow(/exceeds 5MB limit/);
  });

  it('accepts attachment at exactly 5MB', () => {
    const exactData = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const blocks = attachmentsToContentBlocks([makeAttachment({ data: exactData })]);
    expect(blocks).toHaveLength(1);
  });
});
