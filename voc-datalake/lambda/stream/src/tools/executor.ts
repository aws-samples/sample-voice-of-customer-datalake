/**
 * Tool execution dispatcher.
 * Routes tool calls to the appropriate implementation.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { executeSearchFeedback } from './search-feedback.js';
import { executeUpdateDocument, executeCreateDocument } from './update-document.js';
import type { DocumentChange } from './update-document.js';
import { sendSSE } from '../lib/streaming.js';
import { ServiceError } from '../lib/errors.js';
import type { ToolUseBlock } from '../bedrock/stream-processor.js';

interface ContextFilters {
  source?: string;
  category?: string;
  sentiment?: string;
  days?: number;
}

interface ToolResult {
  toolUseId: string;
  content: string;
  sources: Record<string, unknown>[];
  documentChange?: DocumentChange;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleSearchFeedback(
  input: unknown,
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  contextFilters: ContextFilters,
): Promise<{ content: string; sources: Record<string, unknown>[] }> {
  const parsed = isRecord(input) ? input : {};
  const result = await executeSearchFeedback(docClient, feedbackTable, parsed, contextFilters);
  return { content: result.formatted, sources: result.items.slice(0, 5) };
}

interface ExecuteToolOptions {
  docClient: DynamoDBDocumentClient;
  feedbackTable: string;
  projectsTable?: string;
  projectId?: string;
  contextFilters: ContextFilters;
  stream: NodeJS.WritableStream;
}

export async function executeTool(
  tool: ToolUseBlock,
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  contextFilters: ContextFilters,
  stream: NodeJS.WritableStream,
  projectsTable?: string,
  projectId?: string,
): Promise<ToolResult> {
  sendSSE(stream, { type: 'tool_use', toolName: tool.name, toolInput: tool.input });

  let result: { content: string; sources: Record<string, unknown>[]; documentChange?: DocumentChange };

  switch (tool.name) {
    case 'search_feedback': {
      const searchResult = await handleSearchFeedback(tool.input, docClient, feedbackTable, contextFilters);
      result = searchResult;
      break;
    }
    case 'update_document': {
      if (!projectsTable || !projectId) throw new ServiceError('Project context required for update_document');
      console.log('update_document called:', JSON.stringify(tool.input));
      const updateResult = await executeUpdateDocument(docClient, projectsTable, projectId, tool.input);
      console.log('update_document result:', updateResult.content);
      result = { content: updateResult.content, sources: [], documentChange: updateResult.documentChange };
      break;
    }
    case 'create_document': {
      if (!projectsTable || !projectId) throw new ServiceError('Project context required for create_document');
      console.log('create_document called:', JSON.stringify(tool.input));
      const createResult = await executeCreateDocument(docClient, projectsTable, projectId, tool.input);
      console.log('create_document result:', createResult.content);
      result = { content: createResult.content, sources: [], documentChange: createResult.documentChange };
      break;
    }
    default:
      throw new ServiceError(`Unknown tool '${tool.name}'`);
  }

  // Send tool_result SSE event
  const resultSummary = result.documentChange
    ? `${result.documentChange.action}: ${result.documentChange.title}`
    : `Found ${result.sources.length} items`;
  sendSSE(stream, { type: 'tool_result', toolName: tool.name, content: resultSummary });

  // Send document_changed SSE event if a document was modified
  if (result.documentChange) {
    sendSSE(stream, {
      type: 'document_changed',
      documentChange: result.documentChange,
    });
  }

  return {
    toolUseId: tool.toolUseId,
    content: result.content,
    sources: result.sources,
    documentChange: result.documentChange,
  };
}
