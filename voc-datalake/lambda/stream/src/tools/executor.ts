/**
 * Tool execution dispatcher.
 * Routes tool calls to the appropriate implementation.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { executeSearchFeedback } from './search-feedback.js';
import { executeUpdateDocument, executeCreateDocument } from './update-document.js';
import type { DocumentChange } from './update-document.js';
import { executeCreateProject } from './create-project.js';
import type { ProjectChange } from './create-project.js';
import { executeWebSearch } from './web-search.js';
import type { WebSource } from './web-search.js';
import { sendSSE } from '../lib/streaming.js';
import { ServiceError } from '../lib/errors.js';
import type { ToolUseBlock } from '../bedrock/stream-processor.js';

interface ContextFilters {
  source?: string;
  category?: string;
  sentiment?: string;
  days?: number;
  /** 'imported' (default) or 'review' — which date the days window uses. */
  dateBasis?: 'imported' | 'review';
}

interface ToolResult {
  toolUseId: string;
  content: string;
  sources: Record<string, unknown>[];
  documentChange?: DocumentChange;
  projectChange?: ProjectChange;
  webSources?: WebSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One-line summary for the tool_result SSE event. */
function summarizeToolResult(result: {
  sources: Record<string, unknown>[];
  documentChange?: DocumentChange;
  projectChange?: ProjectChange;
  webSources?: WebSource[];
}): string {
  if (result.projectChange) return `${result.projectChange.action}: ${result.projectChange.name}`;
  if (result.documentChange) return `${result.documentChange.action}: ${result.documentChange.title}`;
  if (result.webSources) return `Found ${result.webSources.length} web results`;
  return `Found ${result.sources.length} items`;
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

interface DispatchedResult {
  content: string;
  sources: Record<string, unknown>[];
  documentChange?: DocumentChange;
  projectChange?: ProjectChange;
  webSources?: WebSource[];
}

/** Route a tool call to its implementation. */
async function dispatchTool(
  tool: ToolUseBlock,
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
  contextFilters: ContextFilters,
  projectsTable?: string,
  projectId?: string,
): Promise<DispatchedResult> {
  switch (tool.name) {
    case 'search_feedback': {
      return handleSearchFeedback(tool.input, docClient, feedbackTable, contextFilters);
    }
    case 'web_search': {
      const webResult = await executeWebSearch(tool.input);
      // Web results are NOT feedback sources — they flow through webSources
      // so the frontend renders them as cited links, not feedback cards.
      return { content: webResult.content, sources: [], webSources: webResult.webSources };
    }
    case 'create_project': {
      if (!projectsTable) throw new ServiceError('Projects table not configured for create_project');
      console.log('create_project called:', JSON.stringify(tool.input));
      const projectResult = await executeCreateProject(docClient, projectsTable, tool.input);
      console.log('create_project result:', projectResult.content);
      return { content: projectResult.content, sources: [], projectChange: projectResult.projectChange };
    }
    case 'update_document': {
      if (!projectsTable || !projectId) throw new ServiceError('Project context required for update_document');
      console.log('update_document called:', JSON.stringify(tool.input));
      const updateResult = await executeUpdateDocument(docClient, projectsTable, projectId, tool.input);
      console.log('update_document result:', updateResult.content);
      return { content: updateResult.content, sources: [], documentChange: updateResult.documentChange };
    }
    case 'create_document': {
      if (!projectsTable || !projectId) throw new ServiceError('Project context required for create_document');
      console.log('create_document called:', JSON.stringify(tool.input));
      const createResult = await executeCreateDocument(docClient, projectsTable, projectId, tool.input);
      console.log('create_document result:', createResult.content);
      return { content: createResult.content, sources: [], documentChange: createResult.documentChange };
    }
    default:
      throw new ServiceError(`Unknown tool '${tool.name}'`);
  }
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

  const result = await dispatchTool(tool, docClient, feedbackTable, contextFilters, projectsTable, projectId);

  // Send tool_result SSE event
  sendSSE(stream, { type: 'tool_result', toolName: tool.name, content: summarizeToolResult(result) });

  // Send document_changed SSE event if a document was modified
  if (result.documentChange) {
    sendSSE(stream, {
      type: 'document_changed',
      documentChange: result.documentChange,
    });
  }

  // Send project_changed SSE event so the frontend can surface/link the new project
  if (result.projectChange) {
    sendSSE(stream, {
      type: 'project_changed',
      projectChange: result.projectChange,
    });
  }

  return {
    toolUseId: tool.toolUseId,
    content: result.content,
    sources: result.sources,
    documentChange: result.documentChange,
    projectChange: result.projectChange,
    webSources: result.webSources,
  };
}
