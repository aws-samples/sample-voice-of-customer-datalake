/**
 * Flatten the thread BEFORE the newest user message into plain text turns.
 *
 * Earlier runs' tool traffic is history, not a live tool loop, so it is
 * rendered as short `[tool name(args) → result]` lines inside the assistant
 * turn instead of toolUse/toolResult blocks. That keeps the prefix
 * deterministic (prompt-cache friendly), keeps Bedrock's strict
 * toolUse→toolResult pairing out of old turns entirely, and bounds its size.
 *
 * Output invariants (Bedrock Converse requirements):
 *   - roles strictly alternate, starting with `user`;
 *   - it ends with `assistant` (the newest user message follows it);
 *   - no empty turns.
 */
import type { ContentPart, Message as AguiMessage, AssistantMessage, ToolMessage } from '@ag-ui/core';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { clampHistoryToBudget } from '../../history-budget.js';
import { partsOf, textOfParts } from './input.js';

export interface FlatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const TOOL_ARGS_PREVIEW_CHARS = 300;
const TOOL_RESULT_PREVIEW_CHARS = 600;
/** Assistant placeholder when a user turn was never answered. */
export const NO_REPLY_PLACEHOLDER = '(no reply was recorded for this message)';

function preview(text: string, max: number): string {
  const singleLine = text.replaceAll(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function toolMessageText(message: ToolMessage): string {
  const text = textOfParts(message.content);
  if (!message.error) return text;
  return text ? `error: ${message.error} ${text}` : `error: ${message.error}`;
}

function collectToolResults(messages: readonly AguiMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool' && !results.has(message.toolCallId)) {
      results.set(message.toolCallId, toolMessageText(message));
    }
  }
  return results;
}

function renderAssistant(message: AssistantMessage, results: ReadonlyMap<string, string>): string {
  const lines = message.content ? [message.content] : [];
  for (const call of message.toolCalls ?? []) {
    const args = preview(call.function.arguments, TOOL_ARGS_PREVIEW_CHARS);
    const result = results.get(call.id);
    const shown = result === undefined ? '(no result)' : preview(result, TOOL_RESULT_PREVIEW_CHARS);
    lines.push(`[tool ${call.function.name}(${args}) → ${shown}]`);
  }
  return lines.join('\n');
}

function renderUser(content: string | ContentPart[]): string {
  return partsOf(content)
    .map((part) => (part.type === 'text' ? part.text : `[attached ${part.type}]`))
    .join('\n');
}

function toTurn(message: AguiMessage, results: ReadonlyMap<string, string>): FlatTurn | null {
  if (message.role === 'user') return { role: 'user', content: renderUser(message.content) };
  if (message.role === 'assistant') return { role: 'assistant', content: renderAssistant(message, results) };
  // tool messages are folded into their assistant turn; system/developer/
  // activity/reasoning messages are never taken from the client.
  return null;
}

function mergeNeighbours(turns: readonly FlatTurn[]): FlatTurn[] {
  const merged: FlatTurn[] = [];
  for (const turn of turns) {
    const previous = merged.at(-1);
    if (previous?.role === turn.role) {
      merged[merged.length - 1] = { role: turn.role, content: `${previous.content}\n\n${turn.content}` };
    } else {
      merged.push(turn);
    }
  }
  return merged;
}

/** Flatten, merge, clamp to the history budget, and restore the invariants. */
export function flattenHistory(messages: readonly AguiMessage[]): FlatTurn[] {
  const results = collectToolResults(messages);
  const turns = messages
    .map((message) => toTurn(message, results))
    .filter((turn): turn is FlatTurn => turn !== null && turn.content.trim().length > 0);
  const clamped = clampHistoryToBudget(mergeNeighbours(turns));
  const firstUser = clamped.findIndex((turn) => turn.role === 'user');
  if (firstUser < 0) return [];
  const window = clamped.slice(firstUser);
  // Stryker disable next-line OptionalChaining: firstUser >= 0, so the window holds at least that user turn; `?.` only satisfies noUncheckedIndexedAccess
  return window.at(-1)?.role === 'user'
    ? [...window, { role: 'assistant', content: NO_REPLY_PLACEHOLDER }]
    : window;
}

export function flatTurnsToBedrock(turns: readonly FlatTurn[]): Message[] {
  return turns.map((turn) => ({ role: turn.role, content: [{ text: turn.content }] }));
}
