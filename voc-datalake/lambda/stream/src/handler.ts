/**
 * Streaming chat Lambda handler (Node.js 22).
 *
 * Entry point using `awslambda.streamifyResponse` for true SSE streaming
 * through API Gateway with ResponseTransferMode: STREAM.
 *
 * Routes:
 *   POST /chat/stream  → VoC AI Chat (with search_feedback tool)
 *                       → Project AI Chat when project_id is in the body
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Message, ContentBlock, ToolResultContentBlock, Tool } from '@aws-sdk/client-bedrock-runtime';

import { streamifyResponse, wrapStreamWithHeaders, sendSSE, sendErrorAndClose } from './lib/streaming.js';
import { isApiError, ValidationError } from './lib/errors.js';
import { chatRequestSchema, type ChatRequest, type HistoryMessage } from './schema.js';
import { z } from 'zod';
import { converseStream } from './bedrock/converse-stream.js';
import { processStreamEvent, createStreamState, type ToolUseBlock } from './bedrock/stream-processor.js';
import { executeTool } from './tools/executor.js';
import { getSearchFeedbackTool, getUpdateDocumentTool, getCreateDocumentTool } from './tools/index.js';
import type { DocumentChange } from './tools/update-document.js';
import { buildVocChatContext } from './context/voc-context.js';
import { buildProjectChatContext, buildRoundtableContext } from './context/project-context.js';
import { attachmentsToContentBlocks } from './attachments.js';

// ── AWS Clients (module-level for connection reuse) ──
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// ── Environment ──
const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE ?? '';
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE ?? '';
const PROJECTS_TABLE = process.env.PROJECTS_TABLE ?? '';

const MAX_TOOL_LOOPS = 5;

// ── Types ──

interface LambdaEvent {
  body?: string;
  rawPath?: string;
  path?: string;
  requestContext?: {
    http?: { path?: string; method?: string };
    resourcePath?: string;
    authorizer?: { claims?: Record<string, string> };
  };
  headers?: Record<string, string>;
  resource?: string;
}

interface ContextFilters {
  source?: string;
  category?: string;
  sentiment?: string;
  days?: number;
}

// ── Route helpers ──

function getPath(event: LambdaEvent): string {
  return (
    event.rawPath ??
    event.requestContext?.http?.path ??
    event.path ??
    event.resource ??
    ''
  );
}

function extractProjectId(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) return parts[projectsIdx + 1];
  return null;
}

// ── Tool execution helpers ──

function buildAssistantContent(state: { textContent: string; toolUseBlocks: ToolUseBlock[] }): ContentBlock[] {
  const content: ContentBlock[] = [];
  if (state.textContent) {
    content.push({ text: state.textContent });
  }
  for (const tb of state.toolUseBlocks) {
    content.push({ toolUse: { toolUseId: tb.toolUseId, name: tb.name, input: tb.input } });
  }
  return content;
}

async function executeToolsAndBuildResults(
  toolUseBlocks: ToolUseBlock[],
  contextFilters: ContextFilters,
  collectedSources: Record<string, unknown>[],
  collectedDocumentChanges: DocumentChange[],
  stream: NodeJS.WritableStream,
  projectsTable?: string,
  projectId?: string,
): Promise<ContentBlock[]> {
  const toolResults: ContentBlock[] = [];
  for (const tb of toolUseBlocks) {
    const result = await executeTool(
      tb,
      docClient,
      FEEDBACK_TABLE,
      contextFilters,
      stream,
      projectsTable,
      projectId,
    );
    collectedSources.push(...result.sources);
    if (result.documentChange) {
      collectedDocumentChanges.push(result.documentChange);
    }
    // Notify the frontend that the tool has completed
    sendSSE(stream, { type: 'tool_result', toolName: tb.name });
    const resultContent: ToolResultContentBlock[] = [{ text: result.content }];
    toolResults.push({ toolResult: { toolUseId: result.toolUseId, content: resultContent } });
  }
  return toolResults;
}

// ── Agentic loop ──

async function runConversationLoop(
  messages: Message[],
  tools: Tool[],
  stream: NodeJS.WritableStream,
  systemPrompt: string,
  contextFilters: ContextFilters,
  collectedSources: Record<string, unknown>[],
  collectedDocumentChanges: DocumentChange[],
  loopCount: number,
  projectsTable?: string,
  projectId?: string,
): Promise<void> {
  if (loopCount >= MAX_TOOL_LOOPS) {
    sendSSE(stream, {
      type: 'text',
      content: '\n\n_Reached maximum tool iterations. Please try a more specific question._',
    });
    return;
  }

  const state = createStreamState();

  const events = converseStream({
    messages,
    systemPrompt,
    tools: tools.length > 0 ? tools : undefined,
    maxTokens: 16000,
    thinkingBudget: 5000,
  });

  for await (const event of events) {
    processStreamEvent(event, state, stream);
  }

  if (state.stopReason !== 'tool_use' || state.toolUseBlocks.length === 0) return;

  messages.push({ role: 'assistant', content: buildAssistantContent(state) });

  const toolResults = await executeToolsAndBuildResults(
    state.toolUseBlocks, contextFilters, collectedSources, collectedDocumentChanges, stream,
    projectsTable, projectId,
  );
  messages.push({ role: 'user', content: toolResults });

  await runConversationLoop(
    messages, tools, stream, systemPrompt, contextFilters,
    collectedSources, collectedDocumentChanges, loopCount + 1,
    projectsTable, projectId,
  );
}

// ── VoC Chat handler ──

// ── History helpers ──

function historyToBedrockMessages(history: HistoryMessage[] | undefined): Message[] {
  if (!history || history.length === 0) return [];
  return history.map((msg) => ({
    role: msg.role,
    content: [{ text: msg.content }],
  }));
}

async function handleVocChat(body: ChatRequest, stream: NodeJS.WritableStream): Promise<void> {
  const ctx = await buildVocChatContext(docClient, AGGREGATES_TABLE, {
    message: body.message,
    context: body.context,
    days: body.days,
    response_language: body.response_language,
  });

  sendSSE(stream, { type: 'metadata', metadata: ctx.metadata });

  const messages: Message[] = [
    ...historyToBedrockMessages(body.history),
    { role: 'user', content: [{ text: ctx.userMessage }] },
  ];
  const tools: Tool[] = [getSearchFeedbackTool()];
  const sources: Record<string, unknown>[] = [];
  const documentChanges: DocumentChange[] = [];

  await runConversationLoop(messages, tools, stream, ctx.systemPrompt, ctx.metadata.filters, sources, documentChanges, 0);

  sendSSE(stream, { type: 'done', metadata: { sources: deduplicateSources(sources) } });
  stream.end();
}

// ── Roundtable Chat handler ──

async function handleRoundtableChat(
  projectId: string,
  body: ChatRequest,
  stream: NodeJS.WritableStream,
): Promise<void> {
  const ctx = await buildRoundtableContext(
    docClient,
    PROJECTS_TABLE,
    FEEDBACK_TABLE,
    projectId,
    body.message,
    body.selected_personas ?? [],
    body.selected_documents ?? [],
    body.response_language,
  );

  sendSSE(stream, { type: 'metadata', metadata: ctx.metadata });

  const previousResponses: Array<{ name: string; response: string }> = [];
  const personaCount = ctx.personas.length;

  // Calculate rounds: aim for 6-8 total messages
  // With 2 personas → 3-4 rounds, 3 personas → 2-3 rounds, 4+ → 2 rounds
  const targetMessages = 8;
  const totalRounds = Math.max(2, Math.min(4, Math.ceil(targetMessages / Math.max(personaCount, 1))));

  for (let round = 0; round < totalRounds; round++) {
    for (const persona of ctx.personas) {
      // Stop if we've hit the target message count
      if (previousResponses.length >= targetMessages) break;

      sendSSE(stream, {
        type: 'persona_turn',
        persona: {
          persona_id: persona.persona_id,
          name: persona.name,
          avatar_url: persona.avatar_url,
        },
      });

      // Build user content blocks
      const userContent: ContentBlock[] = [{ text: ctx.userMessage }];
      if (round === 0 && body.attachments && body.attachments.length > 0) {
        const attachmentBlocks = attachmentsToContentBlocks(body.attachments);
        userContent.push(...attachmentBlocks);
      }

      const messages: Message[] = [
        ...historyToBedrockMessages(body.history),
        { role: 'user', content: userContent },
      ];

      // Build round-aware system prompt
      let systemPrompt = persona.systemPrompt;
      if (previousResponses.length > 0) {
        const conversationSoFar = previousResponses
          .map((r) => `**${r.name}:** ${r.response}`)
          .join('\n\n');
        systemPrompt += `\n\n## Conversation so far\n\n${conversationSoFar}`;
      }

      if (round === 0) {
        systemPrompt += '\n\nShare your initial reaction and perspective. Be direct and specific.';
      } else {
        systemPrompt += '\n\nThis is a follow-up round in the discussion. Respond to what others have said — agree, disagree, build on their points, or raise new concerns. Keep it conversational and concise (1-2 paragraphs). Do NOT repeat your earlier points.';
      }

      const state = createStreamState();
      const events = converseStream({
        messages,
        systemPrompt,
        maxTokens: round === 0 ? 4000 : 3000,
        thinkingBudget: round === 0 ? 2000 : 1024,
      });

      for await (const event of events) {
        processStreamEvent(event, state, stream);
      }

      if (state.textContent) {
        previousResponses.push({ name: persona.name, response: state.textContent });
      }
    }

    if (previousResponses.length >= targetMessages) break;
  }

  sendSSE(stream, {
    type: 'done',
    metadata: {
      ...ctx.metadata,
      roundtable_responses: previousResponses.length,
    },
  });
  stream.end();
}

// ── Project Chat handler ──

async function handleProjectChat(
  projectId: string,
  body: ChatRequest,
  stream: NodeJS.WritableStream,
): Promise<void> {
  const ctx = await buildProjectChatContext(
    docClient,
    PROJECTS_TABLE,
    FEEDBACK_TABLE,
    projectId,
    body.message,
    body.selected_personas ?? [],
    body.selected_documents ?? [],
    body.response_language,
  );

  sendSSE(stream, { type: 'metadata', metadata: ctx.metadata });

  // Build user content blocks: text + optional attachments
  const userContent: ContentBlock[] = [{ text: ctx.userMessage }];
  if (body.attachments && body.attachments.length > 0) {
    const attachmentBlocks = attachmentsToContentBlocks(body.attachments);
    userContent.push(...attachmentBlocks);
  }

  const messages: Message[] = [
    ...historyToBedrockMessages(body.history),
    { role: 'user', content: userContent },
  ];

  // Always provide document tools in project chat so the AI can edit/create
  // documents even when they aren't explicitly #-mentioned
  const tools: Tool[] = [getSearchFeedbackTool(), getUpdateDocumentTool(), getCreateDocumentTool()];
  console.log('Project chat tools:', tools.map(t => t.toolSpec?.name));
  console.log('Project ID:', projectId, 'PROJECTS_TABLE:', PROJECTS_TABLE);

  const documentChanges: DocumentChange[] = [];

  await runConversationLoop(
    messages, tools, stream, ctx.systemPrompt, {}, [], documentChanges, 0,
    PROJECTS_TABLE, projectId,
  );

  sendSSE(stream, {
    type: 'done',
    metadata: {
      ...ctx.metadata,
      document_changes: documentChanges,
    },
  });
  stream.end();
}

// ── Helpers ──

function deduplicateSources(sources: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const id = typeof s.feedback_id === 'string' ? s.feedback_id : '';
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const lambdaEventSchema = z.object({
  body: z.string().optional(),
  rawPath: z.string().optional(),
  path: z.string().optional(),
  requestContext: z.object({
    http: z.object({ path: z.string().optional(), method: z.string().optional() }).optional(),
    resourcePath: z.string().optional(),
    authorizer: z.object({ claims: z.record(z.string()).optional() }).optional(),
  }).optional(),
  headers: z.record(z.string()).optional(),
  resource: z.string().optional(),
}).passthrough();

function parseLambdaEvent(raw: unknown): LambdaEvent {
  const parsed = lambdaEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

// ── Request routing ──

async function routeRequest(event: LambdaEvent, stream: NodeJS.WritableStream): Promise<void> {
  const rawBody: unknown = JSON.parse(event.body ?? '{}');
  const parsed = chatRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
  }

  const body = parsed.data;

  // Route by project_id in body (preferred) or URL path (legacy)
  const projectId = body.project_id ?? extractProjectId(getPath(event));

  if (projectId && body.roundtable) {
    await handleRoundtableChat(projectId, body, stream);
  } else if (projectId) {
    await handleProjectChat(projectId, body, stream);
  } else {
    await handleVocChat(body, stream);
  }
}

// ── Main handler ──

export const handler = streamifyResponse(
  async (rawEvent: unknown, responseStream: NodeJS.WritableStream) => {
    const event = parseLambdaEvent(rawEvent);
    const origin = event.headers?.origin ?? event.headers?.Origin;
    const stream = wrapStreamWithHeaders(responseStream, origin);

    try {
      await routeRequest(event, stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      const errorType = isApiError(err) ? err.name : 'ServiceError';
      const statusCode = isApiError(err) ? err.statusCode : 500;

      // Log at appropriate level based on error type
      if (isApiError(err) && err.statusCode < 500) {
        console.warn(`${errorType}: ${message}`);
      } else {
        console.error('Stream handler error:', err);
      }

      try {
        sendErrorAndClose(stream, message, errorType, statusCode);
      } catch {
        stream.end();
      }
    }
  },
);
