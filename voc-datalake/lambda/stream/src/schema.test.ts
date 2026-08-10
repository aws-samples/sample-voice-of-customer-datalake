/**
 * Tests for Zod request validation schemas.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { chatRequestSchema, attachmentSchema, MAX_MESSAGE_LENGTH } from './schema.js';
import { MAX_HISTORY_CONTENT_LENGTH, TRUNCATION_MARKER } from './history-budget.js';

/** Returns the flattened dot-path of every issue in a failed parse result. */
function errorPaths(result: z.SafeParseReturnType<unknown, unknown>): string[] {
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

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
    expect(() => attachmentSchema.parse({
      name: 'file.txt',
      media_type: 'text/plain',
      data: 'abc',
    })).toThrow(/Unsupported file type/);
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

  it('rejects attachment name exceeding 255 characters', () => {
    const result = attachmentSchema.safeParse({
      name: 'a'.repeat(256),
      media_type: 'image/png',
      data: 'abc',
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('name');
  });

  it('accepts attachment name at exactly 255 characters', () => {
    const result = attachmentSchema.safeParse({
      name: 'a'.repeat(255),
      media_type: 'image/png',
      data: 'abc',
    });
    expect(result.success).toBe(true);
  });

  it('rejects attachment data exceeding 2 800 000 characters', () => {
    const result = attachmentSchema.safeParse({
      name: 'big.png',
      media_type: 'image/png',
      data: 'a'.repeat(2_800_001),
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('data');
  });

  it('accepts attachment data at exactly 2 800 000 characters', () => {
    const result = attachmentSchema.safeParse({
      name: 'big.png',
      media_type: 'image/png',
      data: 'a'.repeat(2_800_000),
    });
    expect(result.success).toBe(true);
  });
});

describe('chatRequestSchema', () => {
  it('accepts a minimal VoC chat request', () => {
    // parse (not safeParse): an invalid payload throws and fails the test,
    // so the data assertions below need no conditional guard.
    const data = chatRequestSchema.parse({ message: 'hello' });
    expect(data.message).toBe('hello');
    expect(data.attachments).toBeUndefined();
  });

  it('accepts a full VoC chat request', () => {
    const data = chatRequestSchema.parse({
      message: 'What do customers think?',
      context: 'Source: webscraper',
      days: 30,
      response_language: 'es',
    });
    expect(data.days).toBe(30);
    expect(data.response_language).toBe('es');
  });

  it('accepts a project chat request with attachments', () => {
    const data = chatRequestSchema.parse({
      message: 'Analyze this screenshot',
      project_id: 'proj-123',
      selected_personas: ['persona-1'],
      selected_documents: ['doc-1'],
      attachments: [
        { name: 'screen.png', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    });
    expect(data.attachments).toHaveLength(1);
    expect(data.project_id).toBe('proj-123');
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

  it('accepts the use_web_search opt-in flag', () => {
    const result = chatRequestSchema.safeParse({ message: 'hi', use_web_search: true });
    expect(result.success).toBe(true);
    expect(result.success && result.data.use_web_search).toBe(true);
  });

  it('rejects a non-boolean use_web_search', () => {
    const result = chatRequestSchema.safeParse({ message: 'hi', use_web_search: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects message exceeding the cap', () => {
    const result = chatRequestSchema.safeParse({ message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('message');
  });

  it('accepts message at exactly the cap', () => {
    const result = chatRequestSchema.safeParse({ message: 'a'.repeat(MAX_MESSAGE_LENGTH) });
    expect(result.success).toBe(true);
  });

  // The old 2 000-char cap was ~300 words, which refused a pasted review or
  // support thread — a normal input for an analytics tool.
  it('accepts a pasted excerpt of several thousand characters', () => {
    const result = chatRequestSchema.safeParse({ message: 'a'.repeat(5_000) });
    expect(result.success).toBe(true);
  });

  it('rejects context exceeding 500 characters', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      context: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('context');
  });

  it('accepts context at exactly 500 characters', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      context: 'a'.repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it('rejects project_id exceeding 128 characters', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      project_id: 'a'.repeat(129),
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('project_id');
  });

  it('accepts project_id at exactly 128 characters', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      project_id: 'a'.repeat(128),
    });
    expect(result.success).toBe(true);
  });

  // History carries text this service generated, so it is clamped rather than
  // rejected. The regression these guard is the one that mattered most: a single
  // long assistant answer used to make every LATER message in the conversation
  // fail validation, with no field named in the error.
  it('accepts a follow-up whose history replays an answer longer than the old 4 000-char cap', () => {
    const result = chatRequestSchema.safeParse({
      message: 'and what about last week?',
      history: [
        { role: 'user', content: 'summarise the urgent issues' },
        { role: 'assistant', content: 'a'.repeat(20_000) },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('truncates a turn longer than the model can emit instead of rejecting it', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      history: [{ role: 'assistant', content: 'a'.repeat(MAX_HISTORY_CONTENT_LENGTH + 5_000) }],
    });
    expect(result.success).toBe(true);
    const entry = result.data?.history?.[0];
    expect(entry?.content).toHaveLength(MAX_HISTORY_CONTENT_LENGTH);
    expect(entry?.content.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('accepts a conversation past the 50-turn window, keeping the most recent turns', () => {
    const history = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const, content: `turn-${i}`,
    }));
    const result = chatRequestSchema.safeParse({
      message: 'hi', history,
    });
    expect(result.success).toBe(true);
    expect(result.data?.history).toHaveLength(50);
    // The window ends at the newest turn, so turn-59 survives and turn-0 does not.
    expect(result.data?.history?.at(-1)?.content).toBe('turn-59');
    expect(result.data?.history?.[0]?.content).toBe('turn-10');
  });

  it('rejects more than 20 selected_personas', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      selected_personas: Array.from({ length: 21 }, (_, i) => `persona-${i}`),
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('selected_personas');
  });

  it('rejects a selected_persona ID exceeding 128 characters', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      selected_personas: ['a'.repeat(129)],
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result).some((f) => f.startsWith('selected_personas'))).toBe(true);
  });

  it('rejects more than 20 selected_documents', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      selected_documents: Array.from({ length: 21 }, (_, i) => `doc-${i}`),
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result)).toContain('selected_documents');
  });

  it('rejects a selected_document ID exceeding 128 characters', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      selected_documents: ['a'.repeat(129)],
    });
    expect(result.success).toBe(false);
    expect(errorPaths(result).some((f) => f.startsWith('selected_documents'))).toBe(true);
  });
});

describe('chatRequestSchema response_language allowlist (issue #266)', () => {
  it('accepts every supported locale', () => {
    for (const lang of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh']) {
      const result = chatRequestSchema.safeParse({ message: 'hi', response_language: lang });
      expect(result.success).toBe(true);
      expect(result.success && result.data.response_language).toBe(lang);
    }
  });

  it('silently coerces an unknown locale to undefined instead of rejecting', () => {
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      response_language: 'xx-UNKNOWN',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.response_language).toBeUndefined();
  });

  it('does not let an unrecognised code pass through to the parsed value', () => {
    // The raw attacker string must never appear in the parsed output.
    const result = chatRequestSchema.safeParse({
      message: 'hi',
      response_language: 'prompt-injection-attempt',
    });
    const parsed = result.success ? JSON.stringify(result.data) : '';
    expect(parsed).not.toContain('prompt-injection-attempt');
  });
});

describe('chatRequestSchema date_basis (issue #150)', () => {
  it('accepts imported and review values', () => {
    for (const basis of ['imported', 'review'] as const) {
      const result = chatRequestSchema.safeParse({ message: 'hi', date_basis: basis });
      expect(result.success).toBe(true);
    }
  });

  it('defaults to absent without erroring', () => {
    const data = chatRequestSchema.parse({ message: 'hi' });
    expect(data.date_basis).toBeUndefined();
  });

  it('rejects values outside the allowlist', () => {
    const result = chatRequestSchema.safeParse({ message: 'hi', date_basis: 'whenever' });
    expect(result.success).toBe(false);
  });
});
