/**
 * Tests for VoC Chat context builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildVocChatContext } from './voc-context.js';

function createMockDocClient(responses: Record<string, unknown>[][] = []) {
  let callIndex = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const items = callIndex < responses.length ? responses[callIndex] : [];
      callIndex++;
      return Promise.resolve({ Items: items });
    }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

describe('buildVocChatContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns system prompt, user message, and metadata', async () => {
    const docClient = createMockDocClient();
    const ctx = await buildVocChatContext(docClient, 'agg-table', {
      message: 'What do customers think?',
    });

    expect(ctx.systemPrompt).toContain('Voice of the Customer');
    expect(ctx.systemPrompt).toContain('search_feedback');
    expect(ctx.userMessage).toContain('What do customers think?');
    expect(ctx.metadata.days_analyzed).toBe(7); // default
    expect(ctx.metadata.filters.days).toBe(7);
  });

  it('clamps days to valid range', async () => {
    const docClient = createMockDocClient();

    const ctxLow = await buildVocChatContext(docClient, 'agg-table', {
      message: 'hi',
      days: -5,
    });
    expect(ctxLow.metadata.days_analyzed).toBe(1);

    const ctxHigh = await buildVocChatContext(docClient, 'agg-table', {
      message: 'hi',
      days: 999,
    });
    expect(ctxHigh.metadata.days_analyzed).toBe(365);
  });

  it('parses context filters from context string', async () => {
    const docClient = createMockDocClient();
    const ctx = await buildVocChatContext(docClient, 'agg-table', {
      message: 'hi',
      context: 'Source: webscraper. Category: delivery. Sentiment: negative.',
    });

    expect(ctx.metadata.filters.source).toBe('webscraper');
    expect(ctx.metadata.filters.category).toBe('delivery');
    expect(ctx.metadata.filters.sentiment).toBe('negative');
  });

  it('includes language instruction for non-English languages', async () => {
    const docClient = createMockDocClient();
    const ctx = await buildVocChatContext(docClient, 'agg-table', {
      message: 'hi',
      response_language: 'es',
    });

    expect(ctx.systemPrompt).toContain('Spanish');
    expect(ctx.systemPrompt).toContain('MUST respond entirely in');
  });

  it('does not include language instruction for English', async () => {
    const docClient = createMockDocClient();
    const ctx = await buildVocChatContext(docClient, 'agg-table', {
      message: 'hi',
      response_language: 'en',
    });

    expect(ctx.systemPrompt).not.toContain('MUST respond entirely in');
  });

  it('includes data summary in user message', async () => {
    // Return some metric values
    const docClient = createMockDocClient([
      [{ count: 100 }], // daily_total day 1
    ]);
    const ctx = await buildVocChatContext(docClient, 'agg-table', {
      message: 'summary please',
      days: 1,
    });

    expect(ctx.userMessage).toContain('Current Data Summary');
    expect(ctx.userMessage).toContain('Total Feedback Items');
    expect(ctx.userMessage).toContain('summary please');
  });

  it('includes active filters in user message when context filters present', async () => {
    const docClient = createMockDocClient();
    const ctx = await buildVocChatContext(docClient, 'agg-table', {
      message: 'hi',
      context: 'Source: webscraper.',
    });

    expect(ctx.userMessage).toContain('Active Filters');
    expect(ctx.userMessage).toContain('Source: webscraper');
  });
});
