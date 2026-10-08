/**
 * The thread FROM the newest user message onward → Bedrock messages.
 *
 * This is the live part of the conversation: after an approval interrupt the
 * SPA resumes with the assistant turn(s) that proposed tool calls and one
 * `tool` message per call (server results, approval outcomes). Two renderings:
 *
 *   structured — assistant `toolUse` + user `toolResult` blocks, so the model
 *                continues its own tool loop. Every toolUse is answered in the
 *                very next user message; a call without a tool message gets a
 *                synthetic error result ("no result — abandoned", or
 *                "declined" when the resume entry says so).
 *   text       — the same turns rendered as plain text. Used when the
 *                structured form cannot be sent: a referenced tool is not in
 *                the run's toolset, an id is not a valid Bedrock toolUseId, or
 *                Bedrock rejected the structured tail (e.g. a missing thinking
 *                block — see reasoning.ts).
 *
 * Approval outcomes in tool messages are JSON strings and reach the model
 * verbatim (clamped to LIMITS.maxToolMessageChars).
 */
import type {
  AssistantMessage,
  Message as AguiMessage,
  ResumeEntry,
  ToolMessage,
  UserMessage,
} from '@ag-ui/core';
import type { ContentBlock, Message } from '@aws-sdk/client-bedrock-runtime';
import { INTERRUPT_ID_PREFIX, LIMITS } from '../contract.js';
import { partsToContentBlocks } from '../../attachments.js';
import { ValidationError } from '../../lib/errors.js';
import { parseToolInput } from '../../bedrock/stream-processor.js';
import { partsOf, textOfParts } from './input.js';
import { decodeReasoning } from './reasoning.js';
import { toolResultBlock } from './tool-calls.js';

export type TailMode = 'structured' | 'text';

export const ABANDONED_RESULT = 'No result — the tool call was abandoned before it completed.';
export const DECLINED_RESULT = JSON.stringify({ status: 'declined' });
const TRUNCATION_MARKER = '\n[... truncated]';
const BEDROCK_TOOL_USE_ID = /^[\w-]{1,64}$/;
/** Text rendering keeps tool arguments short: the model only needs to recognise the call. */
const TEXT_ARGS_MAX_CHARS = 2000;

interface Outcome {
  text: string;
  isError: boolean;
}

interface ToolTurn {
  /** Merged assistant content between two user/tool boundaries. */
  assistants: AssistantMessage[];
}

function clampToolText(text: string): string {
  if (text.length <= LIMITS.maxToolMessageChars) return text;
  return text.slice(0, LIMITS.maxToolMessageChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** True when a tool message is an approval outcome JSON with `status: 'failed'` ('declined' is not an error). */
function isFailedOutcome(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'status') === 'failed';
  } catch {
    return false;
  }
}

function outcomeOf(message: ToolMessage): Outcome {
  const text = textOfParts(message.content);
  const error = message.error ?? '';
  const body = [text, error].find((candidate) => candidate.length > 0) ?? '(empty result)';
  return { text: clampToolText(body), isError: error.length > 0 || isFailedOutcome(text) };
}

function syntheticOutcome(toolCallId: string, resume: readonly ResumeEntry[]): Outcome {
  const entry = resume.find((item) => item.interruptId === `${INTERRUPT_ID_PREFIX}${toolCallId}`);
  const payload: unknown = entry?.payload;
  const approved = typeof payload === 'object' && payload !== null && Reflect.get(payload, 'approved') === true;
  if (entry && (entry.status === 'cancelled' || !approved)) {
    return { text: DECLINED_RESULT, isError: false };
  }
  return { text: ABANDONED_RESULT, isError: true };
}

function collectOutcomes(messages: readonly AguiMessage[]): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const message of messages) {
    if (message.role === 'tool' && !outcomes.has(message.toolCallId)) {
      outcomes.set(message.toolCallId, outcomeOf(message));
    }
  }
  return outcomes;
}

/** Group consecutive assistant messages; a group ends at its tool calls. */
function groupAssistantTurns(after: readonly AguiMessage[]): ToolTurn[] {
  const turns: ToolTurn[] = [];
  const state = { open: false };
  for (const message of after) {
    if (message.role !== 'assistant') continue;
    const current = turns.at(-1);
    if (current && state.open) {
      current.assistants.push(message);
    } else {
      turns.push({ assistants: [message] });
    }
    state.open = (message.toolCalls ?? []).length === 0;
  }
  return turns;
}

function userBlocks(message: UserMessage): ContentBlock[] {
  const parts = partsOf(message.content);
  const text = textOfParts(message.content);
  const blocks: ContentBlock[] = [
    ...(text.trim() ? [{ text }] : []),
    ...partsToContentBlocks(parts),
  ];
  if (blocks.length === 0) throw new ValidationError('The user message is empty');
  return blocks;
}

type OutcomeLookup = (toolCallId: string) => Outcome;

function outcomeLookup(after: readonly AguiMessage[], resume: readonly ResumeEntry[]): OutcomeLookup {
  const outcomes = collectOutcomes(after);
  return (toolCallId) => outcomes.get(toolCallId) ?? syntheticOutcome(toolCallId, resume);
}

function callsOf(turn: ToolTurn) {
  return turn.assistants.flatMap((message) => message.toolCalls ?? []);
}

function textOf(turn: ToolTurn): string {
  return turn.assistants.map((message) => message.content ?? '').filter(Boolean).join('\n\n');
}

function structuredTurn(turn: ToolTurn, outcomeFor: OutcomeLookup): Message[] {
  const calls = callsOf(turn);
  const reasoning = calls.length > 0 ? turn.assistants.flatMap((m) => decodeReasoning(m.encryptedValue)) : [];
  const text = textOf(turn);
  const content: ContentBlock[] = [
    ...reasoning,
    ...(text ? [{ text }] : []),
    ...calls.map((call) => ({
      toolUse: { toolUseId: call.id, name: call.function.name, input: parseToolInput(call.function.arguments) },
    })),
  ];
  if (calls.length === 0) return text ? [{ role: 'assistant', content }] : [];
  const results: ContentBlock[] = calls.map((call) => {
    const outcome = outcomeFor(call.id);
    return toolResultBlock(call.id, outcome.text, outcome.isError);
  });
  return [{ role: 'assistant', content }, { role: 'user', content: results }];
}

function textTurn(turn: ToolTurn, outcomeFor: OutcomeLookup): Message[] {
  const calls = callsOf(turn);
  const text = textOf(turn);
  const callLines = calls.map(
    (call) => `[tool ${call.function.name}(${call.function.arguments.slice(0, TEXT_ARGS_MAX_CHARS)}) id=${call.id}]`,
  );
  const assistantText = [text, ...callLines].filter(Boolean).join('\n');
  if (!assistantText) return [];
  if (calls.length === 0) return [{ role: 'assistant', content: [{ text: assistantText }] }];
  const resultLines = calls.map((call) => {
    const outcome = outcomeFor(call.id);
    return `Result of ${call.function.name} (id=${call.id})${outcome.isError ? ' [error]' : ''}: ${outcome.text}`;
  });
  return [
    { role: 'assistant', content: [{ text: assistantText }] },
    { role: 'user', content: [{ text: `Tool results:\n${resultLines.join('\n')}` }] },
  ];
}

export interface BuiltTail {
  messages: Message[];
  /** Tool names referenced by the tail's tool calls (for `alsoInclude`). */
  toolNames: string[];
  /** Whether the tail carries toolUse/toolResult blocks at all. */
  hasToolCalls: boolean;
}

/** Tool names and id validity, before deciding on a rendering. */
export function inspectTail(after: readonly AguiMessage[]): { toolNames: string[]; idsValid: boolean } {
  const calls = groupAssistantTurns(after).flatMap(callsOf);
  return {
    toolNames: [...new Set(calls.map((call) => call.function.name))],
    idsValid: calls.every((call) => BEDROCK_TOOL_USE_ID.test(call.id)),
  };
}

/**
 * Build the tail. `user` is the newest user message, `after` everything after
 * it. A trailing assistant turn without tool calls is dropped: the model is
 * asked to answer again rather than to continue a finished answer.
 */
export function buildTail(
  user: UserMessage,
  after: readonly AguiMessage[],
  resume: readonly ResumeEntry[],
  mode: TailMode,
): BuiltTail {
  const outcomeFor = outcomeLookup(after, resume);
  const turns = groupAssistantTurns(after);
  const lastTurn = turns.at(-1);
  const kept = lastTurn && callsOf(lastTurn).length === 0 ? turns.slice(0, -1) : turns;
  const render = mode === 'structured' ? structuredTurn : textTurn;
  const rendered = kept.flatMap((turn) => render(turn, outcomeFor));
  const { toolNames } = inspectTail(after);
  return {
    messages: [{ role: 'user', content: userBlocks(user) }, ...mergeTextAssistants(rendered)],
    toolNames,
    hasToolCalls: toolNames.length > 0,
  };
}

/**
 * Two rendered assistant messages can only be adjacent when one of them is a
 * text-only turn followed by another turn; merge them to keep alternation.
 */
function mergeTextAssistants(messages: Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous && previous.role === message.role) {
      merged[merged.length - 1] = { role: message.role, content: [...(previous.content ?? []), ...(message.content ?? [])] };
    } else {
      merged.push(message);
    }
  }
  return merged;
}
