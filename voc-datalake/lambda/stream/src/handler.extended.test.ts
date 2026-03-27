/**
 * Extended tests for the streaming chat Lambda handler.
 *
 * Covers: conversation history, tool loop execution, source deduplication,
 * project chat with documents, and edge cases not covered by handler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted) ──

const {
  mockBuildVocChatContext,
  mockBuildProjectChatContext,
  mockConverseStream,
  mockSendSSE,
  mockSendErrorAndClose,
  mockStreamifyResponse,
  mockWrapStreamWithHeaders,
  mockExecuteTool,
} = vi.hoisted(() => ({
  mockBuildVocChatContext: vi.fn(),
  mockBuildProjectChatContext: vi.fn(),
  mockConverseStream: vi.fn(),
  mockSendSSE: vi.fn(),
  mockSendErrorAndClose: vi.fn(),
  mockStreamifyResponse: vi.fn(),
  mockWrapStreamWithHeaders: vi.fn(),
  mockExecuteTool: vi.fn(),
}));

vi.mock('./context/voc-context.js', () => ({
  buildVocChatContext: mockBuildVocChatContext,
}));

vi.mock('./context/project-context.js', () => ({
  buildProjectChatContext: mockBuildProjectChatContext,
}));

vi.mock('./bedrock/converse-stream.js', () => ({
  converseStream: mockConverseStream,
}));

vi.mock('./lib/streaming.js', () => ({
  streamifyResponse: mockStreamifyResponse.mockImplementation((handler: Function) => handler),
  wrapStreamWithHeaders: mockWrapStreamWithHeaders.mockImplementation(
    (stream: NodeJS.WritableStream) => stream,
  ),
  sendSSE: mockSendSSE,
  sendErrorAndClose: mockSendErrorAndClose,
}));

vi.mock('./tools/index.js', () => ({
  getSearchFeedbackTool: vi.fn().mockReturnValue({ toolSpec: { name: 'search_feedback' } }),
  getUpdateDocumentTool: vi.fn().mockReturnValue({ toolSpec: { name: 'update_document' } }),
  getCreateDocumentTool: vi.fn().mockReturnValue({ toolSpec: { name: 'create_document' } }),
}));

vi.mock('./tools/executor.js', () => ({
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

import { handler } from './handler.js';

function mockStream() {
  return { write: vi.fn(), end: vi.fn() } as unknown as NodeJS.WritableStream;
}

function makeEvent(body: Record<string, unknown>, path = '/chat/stream', headers: Record<string, string> = {}) {
  return {
    body: JSON.stringify(body),
    rawPath: path,
    headers: { origin: 'https://example.com', ...headers },
    requestContext: {},
  };
}

describe('handler - extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockConverseStream.mockReturnValue(
      (async function* () {
        yield { contentBlockDelta: { delta: { text: 'Response' }, contentBlockIndex: 0 } };
        yield { messageStop: { stopReason: 'end_turn' } };
      })(),
    );

    mockBuildVocChatContext.mockResolvedValue({
      systemPrompt: 'You are a VoC assistant',
      userMessage: 'User Question: hello',
      metadata: { total_feedback: 0, days_analyzed: 7, urgent_count: 0, filters: { days: 7 } },
    });

    mockBuildProjectChatContext.mockResolvedValue({
      systemPrompt: 'You are a project assistant',
      userMessage: 'hello',
      metadata: { context: { feedback_count: 0, persona_count: 0, document_count: 0 } },
    });

    mockExecuteTool.mockResolvedValue({
      toolUseId: 'tu-1',
      content: 'Found 3 items',
      sources: [{ feedback_id: 'f1' }, { feedback_id: 'f2' }],
    });
  });

  describe('conversation history', () => {
    it('passes history messages to Bedrock as prior conversation turns', async () => {
      const stream = mockStream();
      const event = makeEvent({
        message: 'follow up question',
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
        ],
      });

      await (handler as Function)(event, stream);

      expect(mockConverseStream).toHaveBeenCalledOnce();
      const callArgs = mockConverseStream.mock.calls[0][0];
      // History messages + current user message
      expect(callArgs.messages).toHaveLength(3);
      expect(callArgs.messages[0]).toEqual({ role: 'user', content: [{ text: 'first question' }] });
      expect(callArgs.messages[1]).toEqual({ role: 'assistant', content: [{ text: 'first answer' }] });
    });

    it('works with empty history array', async () => {
      const stream = mockStream();
      const event = makeEvent({ message: 'hello', history: [] });

      await (handler as Function)(event, stream);

      const callArgs = mockConverseStream.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(1);
    });

    it('works without history field', async () => {
      const stream = mockStream();
      const event = makeEvent({ message: 'hello' });

      await (handler as Function)(event, stream);

      const callArgs = mockConverseStream.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(1);
    });
  });

  describe('tool loop execution', () => {
    it('executes tool when Bedrock returns tool_use stop reason', async () => {
      // First call: Bedrock requests a tool
      // Second call: Bedrock responds with text after tool result
      let callCount = 0;
      mockConverseStream.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield {
              contentBlockStart: {
                start: { toolUse: { toolUseId: 'tu-1', name: 'search_feedback' } },
                contentBlockIndex: 0,
              },
            };
            yield {
              contentBlockDelta: {
                delta: { toolUse: { input: '{"query":"delivery"}' } },
                contentBlockIndex: 0,
              },
            };
            yield { contentBlockStop: { contentBlockIndex: 0 } };
            yield { messageStop: { stopReason: 'tool_use' } };
          })();
        }
        return (async function* () {
          yield { contentBlockDelta: { delta: { text: 'Based on the feedback...' }, contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'end_turn' } };
        })();
      });

      const stream = mockStream();
      const event = makeEvent({ message: 'show delivery feedback' });

      await (handler as Function)(event, stream);

      expect(mockExecuteTool).toHaveBeenCalledOnce();
      expect(mockConverseStream).toHaveBeenCalledTimes(2);
    });

    it('stops after MAX_TOOL_LOOPS iterations', async () => {
      // Always return tool_use to trigger the loop limit
      mockConverseStream.mockImplementation(() => {
        return (async function* () {
          yield {
            contentBlockStart: {
              start: { toolUse: { toolUseId: 'tu-loop', name: 'search_feedback' } },
              contentBlockIndex: 0,
            },
          };
          yield {
            contentBlockDelta: {
              delta: { toolUse: { input: '{}' } },
              contentBlockIndex: 0,
            },
          };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'tool_use' } };
        })();
      });

      const stream = mockStream();
      const event = makeEvent({ message: 'loop test' });

      await (handler as Function)(event, stream);

      // Should stop at MAX_TOOL_LOOPS (5) and send a warning
      expect(mockConverseStream).toHaveBeenCalledTimes(5);
      const maxLoopCall = mockSendSSE.mock.calls.find(
        (c: unknown[]) => {
          const payload = c[1] as Record<string, unknown>;
          return payload.type === 'text' && typeof payload.content === 'string' && payload.content.includes('maximum tool iterations');
        },
      );
      expect(maxLoopCall).toBeDefined();
    });
  });

  describe('source deduplication', () => {
    it('deduplicates sources by feedback_id in done event', async () => {
      // Simulate tool returning duplicate sources
      let callCount = 0;
      mockConverseStream.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield {
              contentBlockStart: {
                start: { toolUse: { toolUseId: 'tu-1', name: 'search_feedback' } },
                contentBlockIndex: 0,
              },
            };
            yield { contentBlockDelta: { delta: { toolUse: { input: '{}' } }, contentBlockIndex: 0 } };
            yield { contentBlockStop: { contentBlockIndex: 0 } };
            yield { messageStop: { stopReason: 'tool_use' } };
          })();
        }
        return (async function* () {
          yield { contentBlockDelta: { delta: { text: 'Done' }, contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'end_turn' } };
        })();
      });

      mockExecuteTool.mockResolvedValue({
        toolUseId: 'tu-1',
        content: 'results',
        sources: [
          { feedback_id: 'f1', text: 'first' },
          { feedback_id: 'f1', text: 'duplicate' },
          { feedback_id: 'f2', text: 'second' },
        ],
      });

      const stream = mockStream();
      const event = makeEvent({ message: 'test dedup' });

      await (handler as Function)(event, stream);

      const doneCall = mockSendSSE.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>).type === 'done',
      );
      expect(doneCall).toBeDefined();
      const donePayload = doneCall![1] as Record<string, unknown>;
      const metadata = donePayload.metadata as Record<string, unknown>;
      const sources = metadata.sources as Record<string, unknown>[];
      expect(sources).toHaveLength(2);
      expect(sources.map((s) => s.feedback_id)).toEqual(['f1', 'f2']);
    });
  });

  describe('project chat with documents', () => {
    it('provides search_feedback, update_document and create_document tools for project chat', async () => {
      const stream = mockStream();
      const event = makeEvent({
        message: 'edit the PRD',
        project_id: 'proj-1',
        selected_documents: ['doc-1'],
      });

      await (handler as Function)(event, stream);

      expect(mockConverseStream).toHaveBeenCalledOnce();
      const callArgs = mockConverseStream.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(3);
      const toolNames = callArgs.tools.map((t: { toolSpec?: { name: string } }) => t.toolSpec?.name);
      expect(toolNames).toContain('search_feedback');
      expect(toolNames).toContain('update_document');
      expect(toolNames).toContain('create_document');
    });

    it('provides all three tools even when no documents are selected', async () => {
      const stream = mockStream();
      const event = makeEvent({
        message: 'create a new PRD',
        project_id: 'proj-1',
      });

      await (handler as Function)(event, stream);

      const callArgs = mockConverseStream.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(3);
    });

    it('includes document_changes in done metadata for project chat', async () => {
      const stream = mockStream();
      const event = makeEvent({
        message: 'hello',
        project_id: 'proj-1',
      });

      await (handler as Function)(event, stream);

      const doneCall = mockSendSSE.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>).type === 'done',
      );
      expect(doneCall).toBeDefined();
      const donePayload = doneCall![1] as Record<string, unknown>;
      const metadata = donePayload.metadata as Record<string, unknown>;
      expect(metadata).toHaveProperty('document_changes');
    });
  });

  describe('error handling edge cases', () => {
    it('handles ApiError with statusCode < 500 as warning', async () => {
      const { ValidationError } = await import('./lib/errors.js');
      mockBuildVocChatContext.mockRejectedValue(new ValidationError('Bad input'));

      const stream = mockStream();
      const event = makeEvent({ message: 'hello' });

      await (handler as Function)(event, stream);

      expect(mockSendErrorAndClose).toHaveBeenCalledWith(
        stream, 'Bad input', 'ValidationError', 400,
      );
    });

    it('handles non-Error thrown values', async () => {
      mockBuildVocChatContext.mockRejectedValue('string error');

      const stream = mockStream();
      const event = makeEvent({ message: 'hello' });

      await (handler as Function)(event, stream);

      expect(mockSendErrorAndClose).toHaveBeenCalledWith(
        stream, 'Internal error', 'ServiceError', 500,
      );
    });

    it('closes stream even when sendErrorAndClose throws', async () => {
      mockBuildVocChatContext.mockRejectedValue(new Error('boom'));
      mockSendErrorAndClose.mockImplementation(() => {
        throw new Error('stream write failed');
      });

      const stream = mockStream();
      const event = makeEvent({ message: 'hello' });

      await (handler as Function)(event, stream);

      expect(stream.end).toHaveBeenCalled();
    });
  });

  describe('event parsing', () => {
    it('extracts project_id from /projects/:id/chat URL path', async () => {
      const stream = mockStream();
      const event = makeEvent({ message: 'hello' }, '/projects/my-proj-123/chat');

      await (handler as Function)(event, stream);

      expect(mockBuildProjectChatContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        'my-proj-123',
        'hello',
        [],
        [],
        undefined,
      );
    });

    it('prefers project_id from body over URL path', async () => {
      const stream = mockStream();
      const event = makeEvent(
        { message: 'hello', project_id: 'body-proj' },
        '/projects/url-proj/chat',
      );

      await (handler as Function)(event, stream);

      expect(mockBuildProjectChatContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        'body-proj',
        expect.any(String),
        expect.any(Array),
        expect.any(Array),
        undefined,
      );
    });

    it('handles event with requestContext.http.path', async () => {
      const stream = mockStream();
      const event = {
        body: JSON.stringify({ message: 'hello', project_id: 'proj-1' }),
        requestContext: { http: { path: '/projects/proj-1/chat', method: 'POST' } },
        headers: {},
      };

      await (handler as Function)(event, stream);

      expect(mockBuildProjectChatContext).toHaveBeenCalled();
    });

    it('handles event with Origin header (capital O)', async () => {
      const stream = mockStream();
      const event = {
        body: JSON.stringify({ message: 'hello' }),
        rawPath: '/chat/stream',
        headers: { Origin: 'https://example.com' },
      };

      await (handler as Function)(event, stream);

      expect(mockWrapStreamWithHeaders).toHaveBeenCalledWith(
        stream, 'https://example.com',
      );
    });
  });
});
