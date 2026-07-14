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
import { getModelOverride } from './bedrock/model-override.js';
import { processStreamEvent, createStreamState, type ToolUseBlock } from './bedrock/stream-processor.js';
import { executeTool } from './tools/executor.js';
import { getSearchFeedbackTool, getUpdateDocumentTool, getCreateDocumentTool, getCreateProjectTool } from './tools/index.js';
import type { DocumentChange } from './tools/update-document.js';
import type { ProjectChange } from './tools/create-project.js';
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

// Max agentic tool-call rounds before we stop and ask the user to narrow the
// question. Each round = 1 Bedrock call + 1 tool execution (~6-15s observed),
// so the real ceiling is the Lambda's 300s timeout, not this number. 15 rounds
// (~225s worst case) leaves headroom while letting multi-step questions
// converge. Broad questions ("summarize all" / "most urgent") are answered in a
// single round via search_feedback mode="aggregate", so they shouldn't loop.
const MAX_TOOL_LOOPS = 15;

// Roundtable tuning: one turn per persona, generous budget for a full perspective.
const ROUNDTABLE_MAX_TOKENS = 4000;
const ROUNDTABLE_THINKING_BUDGET = 2000;


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
  /** 'imported' (default) or 'review' — which date the days window uses. */
  dateBasis?: 'imported' | 'review';
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
  collectedProjectChanges: ProjectChange[],
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
    if (result.projectChange) {
      collectedProjectChanges.push(result.projectChange);
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
  collectedProjectChanges: ProjectChange[],
  loopCount: number,
  projectsTable?: string,
  projectId?: string,
): Promise<void> {
  if (loopCount >= MAX_TOOL_LOOPS) {
    // Log so CloudWatch shows WHY the loop exhausted (which tools kept getting
    // called). The user-facing SSE message alone leaves no server-side trace.
    console.warn(`Tool loop hit MAX_TOOL_LOOPS=${MAX_TOOL_LOOPS}; stopping.`);
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
    modelId: await getModelOverride(docClient, AGGREGATES_TABLE),
  });

  for await (const event of events) {
    processStreamEvent(event, state, stream);
  }

  if (state.stopReason !== 'tool_use' || state.toolUseBlocks.length === 0) return;

  // Trace which tools were requested this round — makes loop exhaustion (and
  // repeated identical searches) diagnosable from CloudWatch.
  console.log(
    `Tool round ${loopCount + 1}/${MAX_TOOL_LOOPS}:`,
    JSON.stringify(state.toolUseBlocks.map((tb) => ({ name: tb.name, input: tb.input }))),
  );

  messages.push({ role: 'assistant', content: buildAssistantContent(state) });

  const toolResults = await executeToolsAndBuildResults(
    state.toolUseBlocks, contextFilters, collectedSources, collectedDocumentChanges,
    collectedProjectChanges, stream, projectsTable, projectId,
  );
  messages.push({ role: 'user', content: toolResults });

  await runConversationLoop(
    messages, tools, stream, systemPrompt, contextFilters,
    collectedSources, collectedDocumentChanges, collectedProjectChanges, loopCount + 1,
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
    date_basis: body.date_basis,
    response_language: body.response_language,
  });

  sendSSE(stream, { type: 'metadata', metadata: ctx.metadata });

  const messages: Message[] = [
    ...historyToBedrockMessages(body.history),
    { role: 'user', content: [{ text: ctx.userMessage }] },
  ];
  // search_feedback for analysis + create_project so the user can turn the
  // insights into a pre-filled project ("make a project out of this"). No
  // projectId here (VoC chat is project-agnostic), but create_project only
  // needs the table, so PROJECTS_TABLE is passed as the projectsTable arg.
  const tools: Tool[] = [getSearchFeedbackTool(), getCreateProjectTool()];
  const sources: Record<string, unknown>[] = [];
  const documentChanges: DocumentChange[] = [];
  const projectChanges: ProjectChange[] = [];

  await runConversationLoop(
    messages, tools, stream, ctx.systemPrompt, ctx.metadata.filters,
    sources, documentChanges, projectChanges, 0,
    PROJECTS_TABLE,
  );

  sendSSE(stream, {
    type: 'done',
    metadata: { sources: deduplicateSources(sources), project_changes: projectChanges },
  });
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

  // Roundtable = exactly ONE turn per selected persona. Each persona answers the
  // user's message in its own voice, from its own prompt only. We deliberately do
  // NOT feed personas each other's responses: the previous multi-round design
  // injected the running transcript ("## Conversation so far") into every later
  // turn and asked personas to "respond to what others said", which made the model
  // re-quote everyone — producing ~8 noisy bubbles that each repeated
  // "Stefan: … Margarete: … Thomas: …". One persona → one clean, distinct bubble.

  // Hoist loop-invariant work: attachments and history are the same for every persona.
  const attachmentBlocks = (body.attachments?.length)
    ? attachmentsToContentBlocks(body.attachments)
    : [];
  const historyMessages = historyToBedrockMessages(body.history);

  const responses: string[] = [];

  for (const persona of ctx.personas) {
    sendSSE(stream, {
      type: 'persona_turn',
      persona: {
        persona_id: persona.persona_id,
        name: persona.name,
        avatar_url: persona.avatar_url,
      },
    });

    try {
      const userContent: ContentBlock[] = [{ text: ctx.userMessage }, ...attachmentBlocks];

      const messages: Message[] = [
        ...historyMessages,
        { role: 'user', content: userContent },
      ];

      const systemPrompt = `${persona.systemPrompt}

Share your own perspective on the user's message in your own voice. Be direct and specific. Speak only as yourself — do not narrate, summarize, or quote what the other personas might say.`;

      const state = createStreamState();
      const events = converseStream({
        messages,
        systemPrompt,
        maxTokens: ROUNDTABLE_MAX_TOKENS,
        thinkingBudget: ROUNDTABLE_THINKING_BUDGET,
        modelId: await getModelOverride(docClient, AGGREGATES_TABLE),
      });

      for await (const event of events) {
        processStreamEvent(event, state, stream);
      }

      if (state.textContent) {
        responses.push(state.textContent);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `Roundtable turn failed for persona ${persona.persona_id} (${persona.name}): ${errorMessage}`,
      );
      sendSSE(stream, {
        type: 'persona_error',
        persona: { persona_id: persona.persona_id, name: persona.name },
        error: errorMessage,
      });
    }
  }

  sendSSE(stream, {
    type: 'done',
    metadata: {
      ...ctx.metadata,
      roundtable_responses: responses.length,
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
  const projectChanges: ProjectChange[] = [];

  await runConversationLoop(
    messages, tools, stream, ctx.systemPrompt,
    // Project chat has no context string, but the picker's window settings
    // still apply to the search tool (issue #150).
    { days: body.days, dateBasis: body.date_basis },
    [], documentChanges, projectChanges, 0,
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
