/**
 * Accumulates one Bedrock ConverseStream turn.
 *
 * Pure with respect to transport: it never writes to the response stream.
 * Live deltas (text, reasoning) are handed to a `TurnSink`, which the AG-UI
 * runtime maps onto TEXT_MESSAGE_* / REASONING_* events. Everything needed
 * after the turn — the assistant content blocks in arrival order (reasoning
 * with its signature, text, toolUse), the tool calls, the stop reason and the
 * token usage — is collected in `TurnState`.
 *
 * Reasoning blocks are kept verbatim (text + signature, or redacted bytes)
 * because Claude requires the thinking block of the last tool-using assistant
 * turn to be sent back unmodified while the tool loop continues.
 */
import type { ContentBlock, ConverseStreamOutput, TokenUsage } from '@aws-sdk/client-bedrock-runtime';

/** Matches the Smithy DocumentType used by the Bedrock SDK for tool inputs. */
export type DocumentType = null | boolean | number | string | DocumentType[] | { [prop: string]: DocumentType };

export interface ToolUseBlock {
  toolUseId: string;
  name: string;
  input: Record<string, DocumentType>;
}

/** Receives live deltas while the turn streams. */
export interface TurnSink {
  onText(delta: string): void;
  onReasoning(delta: string): void;
  /** A content block closed (lets the sink end an open reasoning message). */
  onBlockStop(kind: 'text' | 'reasoning' | 'toolUse'): void;
}

type OpenBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; signature: string; redacted: Uint8Array | null }
  | { kind: 'toolUse'; toolUseId: string; name: string; chunks: string[] };

export interface TurnState {
  stopReason: string | null;
  /** Assistant content in arrival order, ready to be replayed to Bedrock. */
  content: ContentBlock[];
  toolUses: ToolUseBlock[];
  text: string;
  usage: TokenUsage | null;
  open: OpenBlock | null;
}

export function createTurnState(): TurnState {
  return { stopReason: null, content: [], toolUses: [], text: '', usage: null, open: null };
}

/**
 * A JSON object at the top level. JSON.parse only ever yields DocumentType
 * values (null, booleans, numbers, strings, arrays and objects of them), so
 * checking the top level is checking the whole value.
 */
function isJsonObject(parsed: unknown): parsed is Record<string, DocumentType> {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** Parse streamed tool-input JSON; anything that is not a JSON object becomes `{}`. */
export function parseToolInput(raw: string): Record<string, DocumentType> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type TextBlock = Extract<OpenBlock, { kind: 'text' }>;
type ReasoningBlock = Extract<OpenBlock, { kind: 'reasoning' }>;
type ToolUseOpenBlock = Extract<OpenBlock, { kind: 'toolUse' }>;

function textToContent(text: string): ContentBlock | null {
  return text ? { text } : null;
}

function reasoningToContent(block: ReasoningBlock): ContentBlock | null {
  if (block.redacted) return { reasoningContent: { redactedContent: block.redacted } };
  if (!block.text && !block.signature) return null;
  return {
    reasoningContent: {
      reasoningText: { text: block.text, ...(block.signature ? { signature: block.signature } : {}) },
    },
  };
}

function commitToolUse(state: TurnState, block: ToolUseOpenBlock): void {
  const input = parseToolInput(block.chunks.join(''));
  state.toolUses.push({ toolUseId: block.toolUseId, name: block.name, input });
  state.content.push({ toolUse: { toolUseId: block.toolUseId, name: block.name, input } });
}

function closeOpenBlock(state: TurnState, sink: TurnSink): void {
  const block = state.open;
  if (!block) return;
  state.open = null;
  if (block.kind === 'toolUse') {
    commitToolUse(state, block);
  } else {
    const content = block.kind === 'text' ? textToContent(block.text) : reasoningToContent(block);
    if (content) state.content.push(content);
  }
  sink.onBlockStop(block.kind);
}

function openText(state: TurnState, sink: TurnSink): TextBlock {
  if (state.open?.kind === 'text') return state.open;
  closeOpenBlock(state, sink);
  const block: TextBlock = { kind: 'text', text: '' };
  state.open = block;
  return block;
}

function openReasoning(state: TurnState, sink: TurnSink): ReasoningBlock {
  if (state.open?.kind === 'reasoning') return state.open;
  closeOpenBlock(state, sink);
  const block: ReasoningBlock = { kind: 'reasoning', text: '', signature: '', redacted: null };
  state.open = block;
  return block;
}

function handleReasoningDelta(event: ConverseStreamOutput, state: TurnState, sink: TurnSink): boolean {
  const delta = event.contentBlockDelta?.delta?.reasoningContent;
  if (!delta) return false;
  const block = openReasoning(state, sink);
  if (delta.text) {
    block.text += delta.text;
    sink.onReasoning(delta.text);
  }
  if (delta.signature) block.signature += delta.signature;
  if (delta.redactedContent) block.redacted = delta.redactedContent;
  return true;
}

function handleTextDelta(event: ConverseStreamOutput, state: TurnState, sink: TurnSink): boolean {
  const text = event.contentBlockDelta?.delta?.text;
  if (text === undefined) return false;
  if (!text) return true;
  openText(state, sink).text += text;
  state.text += text;
  sink.onText(text);
  return true;
}

function handleToolInputChunk(event: ConverseStreamOutput, state: TurnState): boolean {
  const chunk = event.contentBlockDelta?.delta?.toolUse?.input;
  if (chunk === undefined) return false;
  if (state.open?.kind === 'toolUse') state.open.chunks.push(chunk);
  return true;
}

function handleToolUseStart(event: ConverseStreamOutput, state: TurnState, sink: TurnSink): boolean {
  const toolUse = event.contentBlockStart?.start?.toolUse;
  if (!toolUse) return false;
  closeOpenBlock(state, sink);
  state.open = {
    kind: 'toolUse',
    toolUseId: toolUse.toolUseId ?? '',
    name: toolUse.name ?? 'unknown',
    chunks: [],
  };
  return true;
}

function handleBlockStop(event: ConverseStreamOutput, state: TurnState, sink: TurnSink): boolean {
  if (event.contentBlockStop === undefined) return false;
  closeOpenBlock(state, sink);
  return true;
}

function handleMessageStop(event: ConverseStreamOutput, state: TurnState, sink: TurnSink): boolean {
  if (!event.messageStop) return false;
  closeOpenBlock(state, sink);
  state.stopReason = event.messageStop.stopReason ?? 'end_turn';
  return true;
}

/** Record the token usage (Bedrock sends it in the last event, after messageStop). */
function applyMetadata(event: ConverseStreamOutput, state: TurnState): void {
  const usage = event.metadata?.usage;
  if (usage) state.usage = usage;
}

/** Apply one stream event to the turn state; first matching handler wins, metadata only when none did. */
export function processStreamEvent(event: ConverseStreamOutput, state: TurnState, sink: TurnSink): void {
  const handlers = [
    () => handleReasoningDelta(event, state, sink),
    () => handleTextDelta(event, state, sink),
    () => handleToolInputChunk(event, state),
    () => handleToolUseStart(event, state, sink),
    () => handleBlockStop(event, state, sink),
    () => handleMessageStop(event, state, sink),
  ];
  if (!handlers.some((handler) => handler())) applyMetadata(event, state);
}

/** Close whatever is still open (a stream that ended without messageStop). */
export function finishTurn(state: TurnState, sink: TurnSink): void {
  closeOpenBlock(state, sink);
}
