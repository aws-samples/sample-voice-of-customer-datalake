/**
 * Tests for the main streaming chat Lambda handler.
 *
 * Tests the request routing, validation, and error handling logic.
 * The actual Bedrock streaming and tool execution are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted so vi.mock factories can reference them) ──

const {
  mockBuildVocChatContext,
  mockBuildProjectChatContext,
  mockConverseStream,
  mockSendSSE,
  mockSendErrorAndClose,
  mockStreamifyResponse,
  mockWrapStreamWithHeaders,
} = vi.hoisted(() => ({
  mockBuildVocChatContext: vi.fn(),
  mockBuildProjectChatContext: vi.fn(),
  mockConverseStream: vi.fn(),
  mockSendSSE: vi.fn(),
  mockSendErrorAndClose: vi.fn(),
  mockStreamifyResponse: vi.fn(),
  mockWrapStreamWithHeaders: vi.fn(),
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
  executeTool: vi.fn().mockResolvedValue({
    toolUseId: 'tu-1',
    content: 'result',
    sources: [],
  }),
}));

// Import handler after mocks
import { handler } from './handler.js';

function mockStream() {
  return {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as NodeJS.WritableStream;
}

function makeEvent(body: Record<string, unknown>, path = '/chat/stream') {
  return {
    body: JSON.stringify(body),
    rawPath: path,
    headers: { origin: 'https://example.com' },
    requestContext: {},
  };
}

describe('handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: converseStream yields a simple text response then stops
    mockConverseStream.mockReturnValue(
      (async function* () {
        yield { contentBlockDelta: { delta: { text: 'Hello' }, contentBlockIndex: 0 } };
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
  });

  it('routes to VoC chat when no project_id', async () => {
    const stream = mockStream();
    const event = makeEvent({ message: 'hello' });

    await (handler as Function)(event, stream);

    expect(mockBuildVocChatContext).toHaveBeenCalledOnce();
    expect(mockBuildProjectChatContext).not.toHaveBeenCalled();
  });

  it('routes to project chat when project_id in body', async () => {
    const stream = mockStream();
    const event = makeEvent({ message: 'hello', project_id: 'proj-1' });

    await (handler as Function)(event, stream);

    expect(mockBuildProjectChatContext).toHaveBeenCalledOnce();
    expect(mockBuildVocChatContext).not.toHaveBeenCalled();
  });

  it('routes to project chat when project_id in URL path', async () => {
    const stream = mockStream();
    const event = makeEvent({ message: 'hello' }, '/projects/proj-1/chat');

    await (handler as Function)(event, stream);

    expect(mockBuildProjectChatContext).toHaveBeenCalledOnce();
  });

  it('sends validation error for empty message', async () => {
    const stream = mockStream();
    const event = makeEvent({ message: '' });

    await (handler as Function)(event, stream);

    expect(mockSendErrorAndClose).toHaveBeenCalledOnce();
    const [, message] = mockSendErrorAndClose.mock.calls[0];
    expect(message).toBeTruthy();
  });

  it('sends validation error for missing body', async () => {
    const stream = mockStream();
    const event = { body: '{}', rawPath: '/chat/stream', headers: {} };

    await (handler as Function)(event, stream);

    expect(mockSendErrorAndClose).toHaveBeenCalledOnce();
  });

  it('sends metadata SSE event at start of VoC chat', async () => {
    const stream = mockStream();
    const event = makeEvent({ message: 'hello' });

    await (handler as Function)(event, stream);

    expect(mockSendSSE).toHaveBeenCalled();
    const metadataCall = mockSendSSE.mock.calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).type === 'metadata',
    );
    expect(metadataCall).toBeDefined();
  });

  it('sends done SSE event at end of VoC chat', async () => {
    const stream = mockStream();
    const event = makeEvent({ message: 'hello' });

    await (handler as Function)(event, stream);

    const doneCall = mockSendSSE.mock.calls.find(
      (c: unknown[]) => (c[1] as Record<string, unknown>).type === 'done',
    );
    expect(doneCall).toBeDefined();
    expect(stream.end).toHaveBeenCalled();
  });

  it('handles malformed JSON body gracefully', async () => {
    const stream = mockStream();
    const event = { body: 'not json', rawPath: '/chat/stream', headers: {} };

    await (handler as Function)(event, stream);

    expect(mockSendErrorAndClose).toHaveBeenCalledOnce();
  });

  it('handles context builder errors gracefully', async () => {
    mockBuildVocChatContext.mockRejectedValue(new Error('DynamoDB timeout'));
    const stream = mockStream();
    const event = makeEvent({ message: 'hello' });

    await (handler as Function)(event, stream);

    expect(mockSendErrorAndClose).toHaveBeenCalledOnce();
    const [, message] = mockSendErrorAndClose.mock.calls[0];
    expect(message).toContain('DynamoDB timeout');
  });

  it('passes attachments to project chat content blocks', async () => {
    const stream = mockStream();
    const event = makeEvent({
      message: 'analyze this',
      project_id: 'proj-1',
      attachments: [
        { name: 'screen.png', media_type: 'image/png', data: Buffer.from('fake').toString('base64') },
      ],
    });

    await (handler as Function)(event, stream);

    expect(mockBuildProjectChatContext).toHaveBeenCalledOnce();
    // The handler should have processed without error
    expect(mockSendErrorAndClose).not.toHaveBeenCalled();
  });

  it('handles missing event fields gracefully', async () => {
    const stream = mockStream();
    // Completely empty event
    await (handler as Function)({}, stream);

    // Should send error (missing message)
    expect(mockSendErrorAndClose).toHaveBeenCalled();
  });
});
