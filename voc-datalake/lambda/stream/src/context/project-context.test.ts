/**
 * Tests for Project Chat context builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProjectChatContext } from './project-context.js';

function createMockDocClient(
  responses: Record<string, unknown>[][] = [],
  rejectAt?: { index: number; error: Error },
) {
  let callIndex = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const current = callIndex;
      callIndex++;
      if (rejectAt && current === rejectAt.index) {
        return Promise.reject(rejectAt.error);
      }
      const items = current < responses.length ? responses[current] : [];
      return Promise.resolve({ Items: items });
    }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

const projectMeta = {
  pk: 'PROJECT#proj-1',
  sk: 'META',
  project_id: 'proj-1',
  name: 'Test Project',
  description: 'A test project',
  status: 'active',
  persona_count: 2,
  document_count: 1,
};

const persona1 = {
  pk: 'PROJECT#proj-1',
  sk: 'PERSONA#p1',
  persona_id: 'p1',
  name: 'Budget Buyer',
  tagline: 'Price-conscious shopper',
  quote: 'I always look for the best deal',
  goals: ['Save money', 'Find quality products'],
  frustrations: ['Hidden fees', 'Poor value'],
  needs: ['Transparent pricing'],
};

const persona2 = {
  pk: 'PROJECT#proj-1',
  sk: 'PERSONA#p2',
  persona_id: 'p2',
  name: 'Power User',
  tagline: 'Tech enthusiast',
  quote: 'I need advanced features',
  goals: ['Efficiency'],
  frustrations: ['Slow performance'],
  needs: ['Speed'],
};

const document1 = {
  pk: 'PROJECT#proj-1',
  sk: 'DOC#doc-1',
  document_id: 'doc-1',
  document_type: 'prd',
  title: 'Product Requirements',
  content: '# PRD\n\nThis is the product requirements document.',
};

describe('buildProjectChatContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ConfigurationError when projects table is empty', async () => {
    const docClient = createMockDocClient();
    await expect(
      buildProjectChatContext(docClient, '', 'feedback-table', 'proj-1', 'hello'),
    ).rejects.toThrow('Projects table not configured');
  });

  it('throws NotFoundError when project has no items', async () => {
    const docClient = createMockDocClient([[]]);
    await expect(
      buildProjectChatContext(docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello'),
    ).rejects.toThrow('Project not found');
  });

  it('throws NotFoundError when META item is missing', async () => {
    const docClient = createMockDocClient([[persona1]]);
    await expect(
      buildProjectChatContext(docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello'),
    ).rejects.toThrow('Project metadata not found');
  });

  it('returns context with project name in system prompt', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.systemPrompt).toContain('Test Project');
    expect(ctx.userMessage).toBe('hello');
    expect(ctx.metadata).toBeDefined();
  });

  it('activates selected personas and includes their context', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'What would you think?',
      ['p1'], // selected persona
    );

    expect(ctx.systemPrompt).toContain('Budget Buyer');
    expect(ctx.systemPrompt).toContain('PERSONA MODE ACTIVE');
    expect(ctx.systemPrompt).toContain('Price-conscious shopper');
    expect(ctx.systemPrompt).toContain('Save money');
    expect(ctx.metadata.selected_personas).toStrictEqual(['Budget Buyer']);
  });

  it('activates personas mentioned with @ in message', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'Hey @Power what do you think?',
    );

    expect(ctx.systemPrompt).toContain('Power User');
    expect(ctx.metadata.mentioned_personas).toStrictEqual(['Power User']);
  });

  it('includes selected document content in system prompt', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'Review this document',
      [],
      ['doc-1'], // selected document
    );

    expect(ctx.systemPrompt).toContain('Product Requirements');
    expect(ctx.systemPrompt).toContain('PRD');
    expect(ctx.systemPrompt).toContain('update_document');
    expect(ctx.metadata.referenced_documents).toStrictEqual(['Product Requirements']);
  });

  it('lists unselected documents as available', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'hello',
    );

    expect(ctx.systemPrompt).toContain('Other Available Documents');
    expect(ctx.systemPrompt).toContain('Product Requirements');
  });

  it('lists available personas when none are active', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'hello',
    );

    expect(ctx.systemPrompt).toContain('Available Personas');
    expect(ctx.systemPrompt).toContain('@Budget Buyer');
    expect(ctx.systemPrompt).toContain('@Power User');
  });

  it('includes language instruction for non-English', async () => {
    const docClient = createMockDocClient([
      [projectMeta],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'hola', [], [], 'es',
    );

    expect(ctx.systemPrompt).toContain('Spanish');
  });

  it('skips feedback fetch when documents are selected', async () => {
    const docClient = createMockDocClient([
      [projectMeta, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'review', [], ['doc-1'],
    );

    // Only 1 DynamoDB call (project query), no feedback query
    expect(docClient.send).toHaveBeenCalledTimes(1);
    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 0 }),
    );
  });

  it('includes metadata with persona and document counts', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'hello',
    );

    expect(ctx.metadata.context).toStrictEqual({
      feedback_count: expect.any(Number),
      persona_count: 2,
      document_count: 1,
    });
  });

  it('does not throw when a persona has a null avatar_url (regression)', async () => {
    // DynamoDB stores empty optional attributes as null. A persona without a
    // generated avatar has avatar_url: null, which previously failed Zod
    // validation (expected string, received null) and took down project chat
    // with an opaque "Unknown error".
    const personaWithNulls = {
      pk: 'PROJECT#proj-1',
      sk: 'PERSONA#p3',
      persona_id: 'p3',
      name: 'No Avatar Persona',
      tagline: 'Generated without an avatar',
      quote: 'I should still render',
      avatar_url: null,
      goals: null,
      frustrations: null,
      needs: null,
    } as unknown as Record<string, unknown>;

    const docClient = createMockDocClient([
      [projectMeta, personaWithNulls],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1',
      'hello', ['p3'],
    );

    expect(ctx.systemPrompt).toContain('No Avatar Persona');
    expect(ctx.metadata.selected_personas).toStrictEqual(['No Avatar Persona']);
  });
});

describe('fetchRecentFeedback via buildProjectChatContext (regression #220)', () => {
  // Pin the clock so the DATE#YYYY-MM-DD assertions can't flake across a
  // UTC-midnight boundary during a test run.
  const FIXED_NOW = new Date('2026-07-17T12:00:00Z');
  const todayUtc = '2026-07-17';
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  // One parallel batch of day queries (mirrors DAY_QUERY_BATCH_SIZE in
  // recent-feedback.ts); +1 for the initial project query.
  const BATCH = 7;

  function makeFeedback(overrides: Record<string, unknown> = {}) {
    return {
      source_platform: 'webscraper',
      sentiment_label: 'negative',
      category: 'delivery',
      original_text: 'Package arrived late',
      ...overrides,
    };
  }

  /** Extract the gsi1pk value from a recorded QueryCommand call. */
  function pkOfCall(call: unknown[]): string {
    const cmd = call[0] as { input: { ExpressionAttributeValues?: Record<string, unknown> } };
    const pk = cmd.input.ExpressionAttributeValues?.[':pk'];
    return typeof pk === 'string' ? pk : '';
  }

  it('queries per-day DATE#YYYY-MM-DD partitions, never the bare DATE literal', async () => {
    const docClient = createMockDocClient([
      [projectMeta],
      [makeFeedback()],
    ]);

    await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    const sendMock = (docClient.send as ReturnType<typeof vi.fn>);
    const feedbackCalls = sendMock.mock.calls.slice(1); // call 0 = project query
    expect(feedbackCalls.length).toBeGreaterThan(0);
    for (const call of feedbackCalls) {
      const pk = pkOfCall(call);
      expect(pk).toMatch(/^DATE#\d{4}-\d{2}-\d{2}$/);
      expect(pk).not.toBe('DATE');
    }
    // The walk starts at today's UTC partition.
    expect(pkOfCall(feedbackCalls[0])).toBe(`DATE#${todayUtc}`);
  });

  it('includes the recent-feedback section when a recent day has items', async () => {
    const docClient = createMockDocClient([
      [projectMeta],
      [makeFeedback(), makeFeedback({ original_text: 'Love the new feature' })],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.systemPrompt).toContain('Recent Customer Feedback');
    expect(ctx.systemPrompt).toContain('Package arrived late');
    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 2 }),
    );
  });

  it('collects across days newest-first and stops batching once the target is met', async () => {
    const day0 = Array.from({ length: 20 }, (_, i) => makeFeedback({ original_text: `day0 item ${i}` }));
    const day1 = Array.from({ length: 20 }, (_, i) => makeFeedback({ original_text: `day1 item ${i}` }));
    const docClient = createMockDocClient([
      [projectMeta],
      day0,
      day1,
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    // 20 from day 0 top up to the 30-item target from day 1; newest day's
    // items keep priority in the prompt, and no second batch is issued.
    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 30 }),
    );
    expect(ctx.systemPrompt).toContain('day0 item 0');
    const sendMock = (docClient.send as ReturnType<typeof vi.fn>);
    expect(sendMock.mock.calls).toHaveLength(1 + BATCH);
    expect(pkOfCall(sendMock.mock.calls[1])).toBe(`DATE#${todayUtc}`);
    expect(pkOfCall(sendMock.mock.calls[2])).toBe('DATE#2026-07-16');
  });

  it('keeps collecting when one day query fails transiently, and warns', async () => {
    // Call 1 (today's partition) rejects; call 2 (yesterday) has an item.
    const responses: Record<string, unknown>[][] = [[projectMeta]];
    responses[2] = [makeFeedback()];
    const docClient = createMockDocClient(responses, {
      index: 1,
      error: new Error('throttled'),
    });

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 1 }),
    );
    expect(ctx.systemPrompt).toContain('Recent Customer Feedback');
    // The original bug's worst property was silence — failures must be logged.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`day query failed for ${todayUtc}`),
    );
  });

  it('stops the lookback on a persistent error instead of repeating it for 30 days', async () => {
    const denied = new Error('not authorized');
    denied.name = 'AccessDeniedException';
    const docClient = createMockDocClient([[projectMeta]], { index: 1, error: denied });

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 0 }),
    );
    const sendMock = (docClient.send as ReturnType<typeof vi.fn>);
    // Only the first batch runs — no pointless retries across the window.
    expect(sendMock.mock.calls).toHaveLength(1 + BATCH);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AccessDeniedException'),
    );
  });

  it('skips a malformed row without discarding the rest of the day', async () => {
    const docClient = createMockDocClient([
      [projectMeta],
      [
        { ...makeFeedback(), original_text: 12345 }, // wrong type → safeParse fails
        makeFeedback({ original_text: 'valid row survives' }),
      ],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, 'projects-table', 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 1 }),
    );
    expect(ctx.systemPrompt).toContain('valid row survives');
  });
});
