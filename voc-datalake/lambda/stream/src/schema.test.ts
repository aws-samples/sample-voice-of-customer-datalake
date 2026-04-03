/**
 * Tests for Zod request validation schemas.
 */
import { describe, it, expect } from 'vitest';
import { chatRequestSchema, attachmentSchema } from './schema.js';

describe('attachmentSchema', () => {
  it('accepts a valid PNG attachment', () => {
    const result = attachmentSchema.safeParse({
      name: 'screenshot.png',
      media_type: 'image/png',
      data: 'iVBORw0KGgo=',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid PDF attachment', () => {
    const result = attachmentSchema.safeParse({
      name: 'report.pdf',
      media_type: 'application/pdf',
      data: 'JVBERi0xLjQ=',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all allowed image types', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      const result = attachmentSchema.safeParse({
        name: 'file',
        media_type: type,
        data: 'abc',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unsupported media types', () => {
    const result = attachmentSchema.safeParse({
      name: 'file.txt',
      media_type: 'text/plain',
      data: 'abc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Unsupported file type');
    }
  });

  it('rejects empty name', () => {
    const result = attachmentSchema.safeParse({
      name: '',
      media_type: 'image/png',
      data: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty data', () => {
    const result = attachmentSchema.safeParse({
      name: 'file.png',
      media_type: 'image/png',
      data: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(attachmentSchema.safeParse({}).success).toBe(false);
    expect(attachmentSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
});

describe('chatRequestSchema', () => {
  it('accepts a minimal VoC chat request', () => {
    const result = chatRequestSchema.safeParse({ message: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('hello');
      expect(result.data.attachments).toBeUndefined();
    }
  });

  it('accepts a full VoC chat request', () => {
    const result = chatRequestSchema.safeParse({
      message: 'What do customers think?',
      context: 'Source: webscraper',
      days: 30,
      response_language: 'es',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days).toBe(30);
      expect(result.data.response_language).toBe('es');
    }
  });

  it('accepts a project chat request with attachments', () => {
    const result = chatRequestSchema.safeParse({
      message: 'Analyze this screenshot',
      project_id: 'proj-123',
      selected_personas: ['persona-1'],
      selected_documents: ['doc-1'],
      attachments: [
        { name: 'screen.png', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toHaveLength(1);
      expect(result.data.project_id).toBe('proj-123');
    }
  });

  it('rejects empty message', () => {
    const result = chatRequestSchema.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing message', () => {
    const result = chatRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects days below 1', () => {
    const result = chatRequestSchema.safeParse({ message: 'hi', days: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects days above 365', () => {
    const result = chatRequestSchema.safeParse({ message: 'hi', days: 400 });
    expect(result.success).toBe(false);
  });

  it('rejects more than 5 attachments', () => {
    const att = { name: 'f.png', media_type: 'image/png' as const, data: 'abc' };
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      attachments: [att, att, att, att, att, att],
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 5 attachments', () => {
    const att = { name: 'f.png', media_type: 'image/png' as const, data: 'abc' };
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      attachments: [att, att, att, att, att],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid attachment inside array', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      attachments: [{ name: 'f.txt', media_type: 'text/plain', data: 'abc' }],
    });
    expect(result.success).toBe(false);
  });
});
