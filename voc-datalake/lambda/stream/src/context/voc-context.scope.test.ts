/**
 * Tests for the structured-filters scope channel of buildVocChatContext —
 * how a chat request's `filters` field reaches the search tool and the prompt,
 * and how it supersedes the legacy prose `context` string. Split from
 * voc-context.test.ts to keep each file under the line cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildVocChatContext, clearCategoryCache } from './voc-context.js';

function createMockDocClient() {
  return {
    send: vi.fn().mockResolvedValue({ Items: [] }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

describe('buildVocChatContext structured filters scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCategoryCache();
  });

  it('carries a structured filters scope into metadata and the Active Filters line', async () => {
    const ctx = await buildVocChatContext(createMockDocClient(), 'agg-table', {
      message: 'hi',
      filters: { source: ['webscraper', 'manual_import'], usefulness: 'high', urgent: true },
    });

    expect(ctx.metadata.filters.scope).toStrictEqual({
      sources: ['webscraper', 'manual_import'],
      categories: [], subcategories: [], sentiments: [], usefulness: ['high'], urgentOnly: true,
    });
    expect(ctx.userMessage).toContain('Active Filters');
    expect(ctx.userMessage).toContain('Sources: webscraper, manual_import');
    expect(ctx.userMessage).toContain('Usefulness: high');
    expect(ctx.userMessage).toContain('Urgent only');
  });

  it('a present but empty filters scope reaches the tool as "no narrowing", not "no scope"', async () => {
    const ctx = await buildVocChatContext(createMockDocClient(), 'agg-table', { message: 'hi', filters: {} });

    // The scope object is present (empty), so the tool honours "all feedback".
    expect(ctx.metadata.filters.scope).toStrictEqual({
      sources: [], categories: [], subcategories: [], sentiments: [], usefulness: [], urgentOnly: false,
    });
    expect(ctx.userMessage).not.toContain('Active Filters');
  });

  it('structured filters win over a stale prose context string', async () => {
    const ctx = await buildVocChatContext(createMockDocClient(), 'agg-table', {
      message: 'hi',
      context: 'Source: webscraper.',
      filters: { source: ['manual_import'] },
    });

    expect(ctx.metadata.filters.scope?.sources).toStrictEqual(['manual_import']);
    expect(ctx.userMessage).toContain('Sources: manual_import');
    expect(ctx.userMessage).not.toContain('Source: webscraper');
  });

  it('falls back to the prose context when no structured filters are sent (older client)', async () => {
    const ctx = await buildVocChatContext(createMockDocClient(), 'agg-table', {
      message: 'hi',
      context: 'Source: webscraper.',
    });

    expect(ctx.metadata.filters.scope).toBeUndefined();
    expect(ctx.metadata.filters.source).toBe('webscraper');
    expect(ctx.userMessage).toContain('Source: webscraper');
  });
})
