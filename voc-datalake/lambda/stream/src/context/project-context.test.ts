/**
 * Tests for Project Chat context builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildProjectChatContext } from './project-context.js';

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
    expect(ctx.metadata.selected_personas).toEqual(['Budget Buyer']);
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
    expect(ctx.metadata.mentioned_personas).toEqual(['Power User']);
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
    expect(ctx.metadata.referenced_documents).toEqual(['Product Requirements']);
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
    expect(ctx.metadata.context).toEqual(
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

    expect(ctx.metadata.context).toEqual({
      feedback_count: expect.any(Number),
      persona_count: 2,
      document_count: 1,
    });
  });
});
