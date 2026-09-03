/**
 * Tests for Project Chat context builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProjectChatContext, buildRoundtableContext } from './project-context.js';
import type { ProjectLoader } from './projects-client.js';

const projectLoaders = new WeakMap<object, ProjectLoader>();

function createMockDocClient(
  responses: Record<string, unknown>[][] = [],
  rejectAt?: { index: number; error: Error },
) {
  const projectItems = responses[0] ?? [];
  let callIndex = 1;
  const client = {
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
  projectLoaders.set(client, vi.fn().mockResolvedValue(projectItems));
  return client;
}

function projectLoaderFor(client: object): ProjectLoader {
  const loader = projectLoaders.get(client);
  if (!loader) throw new Error('Missing project loader for test client');
  return loader;
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

// Canonical `schemas/persona.schema.json` shape, which is what every writer
// persists. These fixtures previously used flat `quote` / `goals` / `frustrations`
// / `needs` arrays — keys no writer produces — and that is precisely why the chat
// prompt could render empty persona sections while these tests stayed green. The
// value assertions below are the ones that now mean something.
const persona1 = {
  pk: 'PROJECT#proj-1',
  sk: 'PERSONA#p1',
  persona_id: 'p1',
  name: 'Budget Buyer',
  tagline: 'Price-conscious shopper',
  quotes: [{ text: 'I always look for the best deal', context: 'interview' }],
  goals_motivations: {
    primary_goal: 'Save money',
    secondary_goals: ['Find quality products'],
    underlying_motivations: ['Transparent pricing'],
  },
  pain_points: {
    current_challenges: ['Hidden fees', 'Poor value'],
    workarounds: ['Compares three sites before buying'],
  },
};

const persona2 = {
  pk: 'PROJECT#proj-1',
  sk: 'PERSONA#p2',
  persona_id: 'p2',
  name: 'Power User',
  tagline: 'Tech enthusiast',
  quotes: [{ text: 'I need advanced features' }],
  goals_motivations: { primary_goal: 'Efficiency' },
  pain_points: { current_challenges: ['Slow performance'], blockers: ['No bulk actions'] },
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

  it('propagates project loader configuration errors', async () => {
    const docClient = createMockDocClient();
    const loadProject: ProjectLoader = () => Promise.reject(
      new Error('Projects function not configured'),
    );
    await expect(
      buildProjectChatContext(docClient, loadProject, 'feedback-table', 'proj-1', 'hello'),
    ).rejects.toThrow('Projects function not configured');
  });

  it('throws NotFoundError when project has no items', async () => {
    const docClient = createMockDocClient([[]]);
    await expect(
      buildProjectChatContext(docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello'),
    ).rejects.toThrow('Project not found');
  });

  it('throws NotFoundError when META item is missing', async () => {
    const docClient = createMockDocClient([[persona1]]);
    await expect(
      buildProjectChatContext(docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello'),
    ).rejects.toThrow('Project metadata not found');
  });

  it('returns context with project name in system prompt', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
      'Review this document',
      [],
      ['doc-1'], // selected document
    );

    expect(ctx.systemPrompt).toContain('Product Requirements');
    expect(ctx.systemPrompt).toContain('PRD');
    expect(ctx.systemPrompt).toContain('update_document');
    expect(ctx.metadata.referenced_documents).toStrictEqual(['Product Requirements']);
    expect(projectLoaderFor(docClient)).toHaveBeenCalledWith('proj-1', ['doc-1']);
  });

  it('lists unselected documents as available', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
      'hola', [], [], 'es',
    );

    expect(ctx.systemPrompt).toContain('Spanish');
  });

  it('skips feedback fetch when documents are selected', async () => {
    const docClient = createMockDocClient([
      [projectMeta, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
      'review', [], ['doc-1'],
    );

    // Project data comes from the canonical loader; no feedback query is needed.
    expect(docClient.send).not.toHaveBeenCalled();
    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 0 }),
    );
  });

  it('includes metadata with persona and document counts', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, persona2, document1],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
      'hello',
    );

    expect(ctx.metadata.context).toStrictEqual({
      feedback_count: expect.any(Number),
      persona_count: 2,
      document_count: 1,
    });
  });

  it('never emits an UNSIGNED avatar url when signing is unavailable (issue #229)', async () => {
    // /avatars/* is restricted by a CloudFront trusted key group, so this
    // Lambda must sign the URLs it puts in the persona_turn SSE event. With no
    // signing key configured (as here), the avatar has to be omitted — leaking
    // the bare CDN URL is the exact hole this closed, and it would 403 anyway.
    const personaWithAvatar = {
      pk: 'PROJECT#proj-1',
      sk: 'PERSONA#p9',
      persona_id: 'p9',
      name: 'Avatar Persona',
      avatar_url: 's3://raw-bucket/avatars/persona_20260101120000_0.jpeg',
    } as unknown as Record<string, unknown>;

    const docClient = createMockDocClient([[projectMeta, personaWithAvatar]]);

    // buildRoundtableContext, not buildProjectChatContext: this is the one that
    // returns per-persona records, and its avatar_url is what handler.ts puts on
    // the wire in the persona_turn SSE event.
    const ctx = await buildRoundtableContext(
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
      'hello', ['p9'],
    );

    expect(ctx.personas).toHaveLength(1);
    expect(ctx.personas[0].avatar_url).toBeUndefined();
  });

  it('does not throw when a persona has a null avatar_url (regression)', async () => {
    // DynamoDB stores empty optional attributes as null. A persona without a
    // generated avatar has avatar_url: null, which previously failed Zod
    // validation (expected string, received null) and took down project chat
    // with an opaque "Unknown error".
    // The nulled fields are the CANONICAL ones. They used to be `goals` /
    // `frustrations` / `needs`, which the schema no longer declares — so this
    // regression test would have kept passing while exercising nothing, because
    // Zod strips undeclared keys before `nullsToUndefined` matters.
    const personaWithNulls = {
      pk: 'PROJECT#proj-1',
      sk: 'PERSONA#p3',
      persona_id: 'p3',
      name: 'No Avatar Persona',
      tagline: 'Generated without an avatar',
      avatar_url: null,
      quotes: null,
      goals_motivations: null,
      pain_points: null,
    } as unknown as Record<string, unknown>;

    const docClient = createMockDocClient([
      [projectMeta, personaWithNulls],
    ]);

    const ctx = await buildProjectChatContext(
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1',
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
  // recent-feedback.ts).
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
    );

    const sendMock = (docClient.send as ReturnType<typeof vi.fn>);
    const feedbackCalls = sendMock.mock.calls;
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
    );

    // 20 from day 0 top up to the 30-item target from day 1; newest day's
    // items keep priority in the prompt, and no second batch is issued.
    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 30 }),
    );
    expect(ctx.systemPrompt).toContain('day0 item 0');
    const sendMock = (docClient.send as ReturnType<typeof vi.fn>);
    expect(sendMock.mock.calls).toHaveLength(BATCH);
    expect(pkOfCall(sendMock.mock.calls[0])).toBe(`DATE#${todayUtc}`);
    expect(pkOfCall(sendMock.mock.calls[1])).toBe('DATE#2026-07-16');
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 0 }),
    );
    const sendMock = (docClient.send as ReturnType<typeof vi.fn>);
    // Only the first batch runs — no pointless retries across the window.
    expect(sendMock.mock.calls).toHaveLength(BATCH);
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
      docClient, projectLoaderFor(docClient), 'feedback-table', 'proj-1', 'hello',
    );

    expect(ctx.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 1 }),
    );
    expect(ctx.systemPrompt).toContain('valid row survives');
  });
});


describe('canonical managed document titles', () => {
  const versionOne = {
    pk: 'PROJECT#proj-1',
    sk: 'PRD#d1',
    document_id: 'd1',
    document_type: 'prd',
    base_title: 'Launch',
    version: 1,
    title: 'Launch (v1)',
    content: '# first',
  };
  const versionTwo = {
    pk: 'PROJECT#proj-1',
    sk: 'PRD#d2',
    document_id: 'd2',
    document_type: 'prd',
    base_title: 'Launch',
    version: 2,
    title: 'Launch (v2)',
    content: '# second',
  };

  it('uses canonical titles in selected content, inventories, and metadata', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, versionOne, versionTwo],
    ]);

    const context = await buildProjectChatContext(
      docClient,
      projectLoaderFor(docClient),
      'feedback-table',
      'proj-1',
      'Review the latest launch plan',
      [],
      ['d2'],
    );

    expect(context.systemPrompt).toContain('DOCUMENT: Launch (v2)');
    expect(context.systemPrompt).toContain('PRD: Launch (v1) [ID: d1]');
    expect(context.systemPrompt).toContain('PRD: Launch (v2) [ID: d2]');
    expect(context.metadata.referenced_documents).toStrictEqual(['Launch (v2)']);
  });

  it('uses the same canonical titles in roundtable prompts and results', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, versionOne, versionTwo],
    ]);

    const context = await buildRoundtableContext(
      docClient,
      projectLoaderFor(docClient),
      'feedback-table',
      'proj-1',
      'Discuss this plan',
      ['p1'],
      ['d2'],
    );

    expect(context.personas[0].systemPrompt).toContain('Launch (v2)');
    expect(context.documents.map((document) => document.title)).toStrictEqual([
      'Launch (v1)', 'Launch (v2)',
    ]);
    expect(context.metadata.referenced_documents).toStrictEqual(['Launch (v2)']);
  });
});


describe('bounded document family metadata', () => {
  it('keeps product reports and prototypes in project-chat inventories', async () => {
    const report = {
      pk: 'PROJECT#proj-1',
      sk: 'PRODUCT_REPORT#report-1',
      document_id: 'report-1',
      document_type: 'product_report',
      title: 'Product report',
      content: '# Report',
    };
    const prototype = {
      pk: 'PROJECT#proj-1',
      sk: 'PROTOTYPE#prototype-1',
      document_id: 'prototype-1',
      document_type: 'prototype',
      title: 'Prototype',
    };
    const docClient = createMockDocClient([[projectMeta, report, prototype]]);

    const context = await buildProjectChatContext(
      docClient,
      projectLoaderFor(docClient),
      'feedback-table',
      'proj-1',
      'Compare these artifacts',
      [],
      ['report-1'],
    );

    expect(context.systemPrompt).toContain('DOCUMENT: Product report');
    expect(context.systemPrompt).toContain('PROTOTYPE: Prototype [ID: prototype-1]');
    expect(context.metadata.context).toStrictEqual(
      expect.objectContaining({ document_count: 2 }),
    );
    expect(projectLoaderFor(docClient)).toHaveBeenCalledWith(
      'proj-1', ['report-1'],
    );
  });
});

describe('prototype selection boundaries', () => {
  const prototype = {
    pk: 'PROJECT#proj-1',
    sk: 'PROTOTYPE#prototype-1',
    document_id: 'prototype-1',
    document_type: 'prototype',
    title: 'Checkout prototype',
    content: '<html>RAW_PROTOTYPE_HTML</html>',
  };
  const report = {
    pk: 'PROJECT#proj-1',
    sk: 'PRODUCT_REPORT#report-1',
    document_id: 'report-1',
    document_type: 'product_report',
    title: 'Product report',
    content: '# Grounded product findings',
  };

  beforeEach(() => vi.clearAllMocks());

  it('keeps a selected prototype metadata-only and falls back to recent feedback', async () => {
    const feedback = {
      source_platform: 'feedback-form',
      sentiment_label: 'negative',
      category: 'checkout',
      original_text: 'Checkout feedback remains grounded',
    };
    const docClient = createMockDocClient([
      [projectMeta, prototype],
      [feedback],
    ]);

    const context = await buildProjectChatContext(
      docClient,
      projectLoaderFor(docClient),
      'feedback-table',
      'proj-1',
      'Review the prototype',
      [],
      ['prototype-1'],
    );

    expect(context.systemPrompt).toContain(
      'Available Prototype Artifacts (metadata only; revise through the prototype workflow)',
    );
    expect(context.systemPrompt).toContain(
      'PROTOTYPE: Checkout prototype [ID: prototype-1]',
    );
    expect(context.systemPrompt).toContain('Checkout feedback remains grounded');
    expect(context.systemPrompt).not.toContain('RAW_PROTOTYPE_HTML');
    expect(context.systemPrompt).not.toContain(
      'You MUST use the document content provided above',
    );
    expect(context.metadata.referenced_documents).toStrictEqual([]);
    expect(context.metadata.context).toStrictEqual(
      expect.objectContaining({ feedback_count: 1 }),
    );
    expect(docClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: 'feedback-table',
          IndexName: 'gsi1-by-date',
          KeyConditionExpression: 'gsi1pk = :pk',
          ScanIndexForward: false,
          Limit: 30,
        }),
      }),
    );
  });

  it('returns only actual textual grounding IDs and references from roundtable context', async () => {
    const docClient = createMockDocClient([
      [projectMeta, persona1, prototype, report],
    ]);

    const context = await buildRoundtableContext(
      docClient,
      projectLoaderFor(docClient),
      'feedback-table',
      'proj-1',
      'Compare the selected artifacts',
      ['p1'],
      ['prototype-1', 'report-1'],
    );

    expect(context.selectedDocumentIds).toStrictEqual(['report-1']);
    expect(context.metadata.referenced_documents).toStrictEqual(['Product report']);
    expect(context.personas[0].systemPrompt).toContain('Grounded product findings');
    expect(context.personas[0].systemPrompt).toContain(
      'PROTOTYPE: Checkout prototype [ID: prototype-1]',
    );
    expect(context.personas[0].systemPrompt).not.toContain('RAW_PROTOTYPE_HTML');
  });
});
