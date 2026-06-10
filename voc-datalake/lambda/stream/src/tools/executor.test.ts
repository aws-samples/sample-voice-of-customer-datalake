/**
 * Tests for the tool execution dispatcher (executor.ts).
 *
 * Verifies routing to the correct tool implementation, SSE event emission,
 * document change propagation, and error handling for unknown/misconfigured tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ToolUseBlock } from '../bedrock/stream-processor.js';

// ── Mocks ──

const mockExecuteSearchFeedback = vi.fn();
const mockExecuteUpdateDocument = vi.fn();
const mockExecuteCreateDocument = vi.fn();
const mockSendSSE = vi.fn();

vi.mock('./search-feedback.js', () => ({
  executeSearchFeedback: (...args: unknown[]) => mockExecuteSearchFeedback(...args),
}));

vi.mock('./update-document.js', () => ({
  executeUpdateDocument: (...args: unknown[]) => mockExecuteUpdateDocument(...args),
  executeCreateDocument: (...args: unknown[]) => mockExecuteCreateDocument(...args),
}));

vi.mock('../lib/streaming.js', () => ({
  sendSSE: (...args: unknown[]) => mockSendSSE(...args),
}));

// Import AFTER mocks
import { executeTool } from './executor.js';

// ── Helpers ──

function createMockDocClient(): DynamoDBDocumentClient {
  return { send: vi.fn() } as unknown as DynamoDBDocumentClient;
}

function createMockStream(): NodeJS.WritableStream {
  return { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
}

function makeToolBlock(overrides: Partial<ToolUseBlock> = {}): ToolUseBlock {
  return {
    toolUseId: 'tool-use-123',
    name: 'search_feedback',
    input: { query: 'delivery' },
    ...overrides,
  };
}

// ── Tests ──

describe('executeTool', () => {
  const docClient = createMockDocClient();
  const stream = createMockStream();
  const feedbackTable = 'test-feedback';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('routing', () => {
    it('routes search_feedback to executeSearchFeedback', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({
        formatted: 'Found 2 items',
        items: [{ feedback_id: 'f1' }, { feedback_id: 'f2' }],
      });

      const result = await executeTool(
        makeToolBlock({ name: 'search_feedback', input: { query: 'test' } }),
        docClient, feedbackTable, { days: 7 }, stream,
      );

      expect(mockExecuteSearchFeedback).toHaveBeenCalledOnce();
      expect(result.content).toBe('Found 2 items');
      expect(result.sources).toHaveLength(2);
      expect(result.documentChange).toBeUndefined();
    });

    it('routes update_document to executeUpdateDocument', async () => {
      mockExecuteUpdateDocument.mockResolvedValueOnce({
        content: 'Successfully updated "My PRD"',
        documentChange: { document_id: 'doc-1', title: 'My PRD', action: 'updated', summary: 'Added section' },
      });

      const result = await executeTool(
        makeToolBlock({ name: 'update_document', input: { document_id: 'doc-1', content: 'new', summary: 'Added section' } }),
        docClient, feedbackTable, {}, stream, 'projects-table', 'proj-1',
      );

      expect(mockExecuteUpdateDocument).toHaveBeenCalledWith(docClient, 'projects-table', 'proj-1', expect.any(Object));
      expect(result.content).toBe('Successfully updated "My PRD"');
      expect(result.documentChange?.action).toBe('updated');
      expect(result.sources).toEqual([]);
    });

    it('routes create_document to executeCreateDocument', async () => {
      mockExecuteCreateDocument.mockResolvedValueOnce({
        content: 'Successfully created new PRD "Launch Plan"',
        documentChange: { document_id: 'doc-new', title: 'Launch Plan', action: 'created', summary: 'Created new prd document' },
      });

      const result = await executeTool(
        makeToolBlock({ name: 'create_document', input: { title: 'Launch Plan', content: '# Plan', document_type: 'prd' } }),
        docClient, feedbackTable, {}, stream, 'projects-table', 'proj-1',
      );

      expect(mockExecuteCreateDocument).toHaveBeenCalledWith(docClient, 'projects-table', 'proj-1', expect.any(Object));
      expect(result.documentChange?.action).toBe('created');
      expect(result.documentChange?.title).toBe('Launch Plan');
    });

    it('throws ServiceError for unknown tool name', async () => {
      await expect(
        executeTool(
          makeToolBlock({ name: 'nonexistent_tool' }),
          docClient, feedbackTable, {}, stream,
        ),
      ).rejects.toThrow("Unknown tool 'nonexistent_tool'");
    });
  });

  describe('project context validation', () => {
    it('throws ServiceError when update_document called without projectsTable', async () => {
      await expect(
        executeTool(
          makeToolBlock({ name: 'update_document' }),
          docClient, feedbackTable, {}, stream, undefined, 'proj-1',
        ),
      ).rejects.toThrow('Project context required');
    });

    it('throws ServiceError when update_document called without projectId', async () => {
      await expect(
        executeTool(
          makeToolBlock({ name: 'update_document' }),
          docClient, feedbackTable, {}, stream, 'projects-table', undefined,
        ),
      ).rejects.toThrow('Project context required');
    });

    it('throws ServiceError when create_document called without projectsTable', async () => {
      await expect(
        executeTool(
          makeToolBlock({ name: 'create_document' }),
          docClient, feedbackTable, {}, stream, undefined, 'proj-1',
        ),
      ).rejects.toThrow('Project context required');
    });

    it('throws ServiceError when create_document called without projectId', async () => {
      await expect(
        executeTool(
          makeToolBlock({ name: 'create_document' }),
          docClient, feedbackTable, {}, stream, 'projects-table', undefined,
        ),
      ).rejects.toThrow('Project context required');
    });
  });

  describe('SSE events', () => {
    it('sends tool_use SSE event before execution', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({ formatted: 'ok', items: [] });

      await executeTool(makeToolBlock(), docClient, feedbackTable, {}, stream);

      const firstCall = mockSendSSE.mock.calls[0];
      expect(firstCall[0]).toBe(stream);
      expect(firstCall[1]).toEqual({
        type: 'tool_use',
        toolName: 'search_feedback',
        toolInput: { query: 'delivery' },
      });
    });

    it('sends tool_result SSE event with item count for search_feedback', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({
        formatted: 'Found 3 items',
        items: [{ feedback_id: '1' }, { feedback_id: '2' }, { feedback_id: '3' }],
      });

      await executeTool(makeToolBlock(), docClient, feedbackTable, {}, stream);

      const toolResultCall = mockSendSSE.mock.calls.find(
        (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'tool_result',
      );
      expect(toolResultCall).toBeDefined();
      expect((toolResultCall?.[1] as Record<string, unknown>).content).toBe('Found 3 items');
    });

    it('sends tool_result SSE event with action summary for document tools', async () => {
      mockExecuteUpdateDocument.mockResolvedValueOnce({
        content: 'Updated doc',
        documentChange: { document_id: 'd1', title: 'My Doc', action: 'updated', summary: 'Rewrote intro' },
      });

      await executeTool(
        makeToolBlock({ name: 'update_document' }),
        docClient, feedbackTable, {}, stream, 'projects-table', 'proj-1',
      );

      const toolResultCall = mockSendSSE.mock.calls.find(
        (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'tool_result',
      );
      expect((toolResultCall?.[1] as Record<string, unknown>).content).toBe('updated: My Doc');
    });

    it('sends document_changed SSE event when document is modified', async () => {
      const docChange = { document_id: 'd1', title: 'PRD', action: 'updated' as const, summary: 'Fixed typos' };
      mockExecuteUpdateDocument.mockResolvedValueOnce({
        content: 'Updated',
        documentChange: docChange,
      });

      await executeTool(
        makeToolBlock({ name: 'update_document' }),
        docClient, feedbackTable, {}, stream, 'projects-table', 'proj-1',
      );

      const docChangedCall = mockSendSSE.mock.calls.find(
        (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'document_changed',
      );
      expect(docChangedCall).toBeDefined();
      expect((docChangedCall?.[1] as Record<string, unknown>).documentChange).toEqual(docChange);
    });

    it('does not send document_changed SSE event for search_feedback', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({ formatted: 'ok', items: [] });

      await executeTool(makeToolBlock(), docClient, feedbackTable, {}, stream);

      const docChangedCall = mockSendSSE.mock.calls.find(
        (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'document_changed',
      );
      expect(docChangedCall).toBeUndefined();
    });
  });

  describe('search_feedback input handling', () => {
    it('passes record input directly to executeSearchFeedback', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({ formatted: 'ok', items: [] });
      const input = { query: 'shipping', sentiment: 'negative' };

      await executeTool(
        makeToolBlock({ input }),
        docClient, feedbackTable, { source: 'webscraper' }, stream,
      );

      expect(mockExecuteSearchFeedback).toHaveBeenCalledWith(
        docClient, feedbackTable, input, { source: 'webscraper' },
      );
    });

    it('passes empty object when input is not a record', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({ formatted: 'ok', items: [] });

      await executeTool(
        makeToolBlock({ input: 'not-an-object' }),
        docClient, feedbackTable, {}, stream,
      );

      expect(mockExecuteSearchFeedback).toHaveBeenCalledWith(
        docClient, feedbackTable, {}, {},
      );
    });

    it('caps sources to 5 items in the result', async () => {
      const items = Array.from({ length: 10 }, (_, i) => ({ feedback_id: `f${i}` }));
      mockExecuteSearchFeedback.mockResolvedValueOnce({ formatted: 'ok', items });

      const result = await executeTool(makeToolBlock(), docClient, feedbackTable, {}, stream);

      expect(result.sources).toHaveLength(5);
    });
  });

  describe('return value', () => {
    it('returns toolUseId from the tool block', async () => {
      mockExecuteSearchFeedback.mockResolvedValueOnce({ formatted: 'ok', items: [] });

      const result = await executeTool(
        makeToolBlock({ toolUseId: 'my-tool-id-456' }),
        docClient, feedbackTable, {}, stream,
      );

      expect(result.toolUseId).toBe('my-tool-id-456');
    });

    it('returns documentChange for create_document', async () => {
      const docChange = { document_id: 'new-doc', title: 'FAQ', action: 'created' as const, summary: 'New FAQ doc' };
      mockExecuteCreateDocument.mockResolvedValueOnce({
        content: 'Created FAQ',
        documentChange: docChange,
      });

      const result = await executeTool(
        makeToolBlock({ name: 'create_document' }),
        docClient, feedbackTable, {}, stream, 'projects-table', 'proj-1',
      );

      expect(result.documentChange).toEqual(docChange);
    });
  });
});
