/**
 * Processes Bedrock ConverseStream events and emits SSE events.
 *
 * Maps Bedrock stream events to our SSE protocol:
 *   contentBlockDelta.delta.text          → { type: 'text', content }
 *   contentBlockDelta.delta.reasoningContent.text → { type: 'thinking', content }
 *   contentBlockStart.start.toolUse       → { type: 'tool_use', toolName }
 *   contentBlockStop (tool)               → triggers tool execution
 *   messageStop                           → { type: 'done' }
 */
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { sendSSE } from '../lib/streaming.js';

/** Matches the Smithy DocumentType used by the Bedrock SDK for tool inputs. */
export type DocumentType = null | boolean | number | string | DocumentType[] | { [prop: string]: DocumentType };

export interface StreamState {
  stopReason: string | null;
  toolUseBlocks: ToolUseBlock[];
  currentToolUseId: string | null;
  currentToolName: string | null;
  toolInputChunks: string[];
  textContent: string;
}

export interface ToolUseBlock {
  toolUseId: string;
  name: string;
  input: DocumentType;
}

export function createStreamState(): StreamState {
  return {
    stopReason: null,
    toolUseBlocks: [],
    currentToolUseId: null,
    currentToolName: null,
    toolInputChunks: [],
    textContent: '',
  };
}

// ── Event handlers (one per event type to keep complexity low) ──

function handleTextDelta(event: ConverseStreamOutput, state: StreamState, stream: NodeJS.WritableStream): boolean {
  const text = event.contentBlockDelta?.delta?.text;
  if (!text) return false;
  state.textContent += text;
  sendSSE(stream, { type: 'text', content: text });
  return true;
}

function handleThinkingDelta(event: ConverseStreamOutput, stream: NodeJS.WritableStream): boolean {
  const text = event.contentBlockDelta?.delta?.reasoningContent?.text;
  if (!text) return false;
  sendSSE(stream, { type: 'thinking', content: text });
  return true;
}

function handleToolInputChunk(event: ConverseStreamOutput, state: StreamState): boolean {
  const chunk = event.contentBlockDelta?.delta?.toolUse?.input;
  if (!chunk) return false;
  state.toolInputChunks.push(chunk);
  return true;
}

function handleToolUseStart(event: ConverseStreamOutput, state: StreamState, stream: NodeJS.WritableStream): boolean {
  const tu = event.contentBlockStart?.start?.toolUse;
  if (!tu) return false;
  state.currentToolUseId = tu.toolUseId ?? null;
  state.currentToolName = tu.name ?? null;
  state.toolInputChunks = [];
  // Notify the frontend that a tool is being invoked
  sendSSE(stream, { type: 'tool_use', toolName: tu.name ?? 'unknown' });
  return true;
}

function isDocumentType(value: unknown): value is DocumentType {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isDocumentType);
  if (typeof value === 'object') return Object.values(value).every(isDocumentType);
  return false;
}

function parseToolInput(chunks: string[]): Record<string, DocumentType> {
  const inputStr = chunks.join('');
  try {
    const parsed: unknown = JSON.parse(inputStr || '{}');
    if (isDocumentType(parsed) && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function handleContentBlockStop(event: ConverseStreamOutput, state: StreamState): boolean {
  if (event.contentBlockStop === undefined || !state.currentToolUseId) return false;
  const input = parseToolInput(state.toolInputChunks);
  state.toolUseBlocks.push({
    toolUseId: state.currentToolUseId,
    name: state.currentToolName ?? 'unknown',
    input,
  });
  state.currentToolUseId = null;
  state.currentToolName = null;
  state.toolInputChunks = [];
  return true;
}

function handleMessageStop(event: ConverseStreamOutput, state: StreamState): boolean {
  if (!event.messageStop) return false;
  state.stopReason = event.messageStop.stopReason ?? 'end_turn';
  return true;
}

// ── Main dispatcher ──

export function processStreamEvent(
  event: ConverseStreamOutput,
  state: StreamState,
  stream: NodeJS.WritableStream,
): void {
  // Try each handler in priority order; first match wins
  const handlers = [
    () => handleTextDelta(event, state, stream),
    () => handleThinkingDelta(event, stream),
    () => handleToolInputChunk(event, state),
    () => handleToolUseStart(event, state, stream),
    () => handleContentBlockStop(event, state),
    () => handleMessageStop(event, state),
  ];
  handlers.some((handler) => handler());
  // Metadata events (usage, etc.) are silently ignored
}
