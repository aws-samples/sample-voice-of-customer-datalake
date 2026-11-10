/**
 * Server-side session record: the conversation the stream Lambda persists
 * while a run streams, in EXACTLY the item shape `chat_handler.py` stores and
 * serves (`GET /chat/conversations/{id}`, kind 'assistant'), so the SPA can
 * load it with the same reader it uses for its own saves.
 *
 * Item (table `voc-conversations`):
 *   pk USER#{sub} · sk CONV#{threadId} · conversation_id · kind 'assistant' ·
 *   title · messages_json · page_json · pending_json · message_count ·
 *   created_at · updated_at — the attributes chat_handler writes — plus the
 *   three this Lambda owns: run_id · run_status · revision.
 *
 * What is stored mirrors the SPA's own save (`frontend/src/assistant/sessions/serialize.ts`):
 * attachment parts lose their data (name + mimeType survive in `metadata`),
 * tool contents are trimmed to MAX_STORED_TOOL_CHARS (a persona-cards result keeps valid JSON
 * within its own cap, persona-result.ts), the title is the first
 * user message (≤ 120 chars), the list keeps the newest whole turns within
 * MAX_STORED_MESSAGES, and an item over MAX_ITEM_BYTES drops its oldest turns
 * (then shrinks tool contents) the way the SPA's 413 retry does.
 *
 * Pure: no AWS, no clock — the recorder passes timestamps in.
 */
import type { ContentPart, Message } from '@ag-ui/core';
import type { PageContext, SESSION_RUN_STATUSES } from '../contract.js';
import { MAX_RETRY_PERSONA_CHARS, MAX_STORED_PERSONA_CHARS, storedPersonaResult } from './persona-result.js';

export type RunStatus = (typeof SESSION_RUN_STATUSES)[number];

/** Same as the SPA's MAX_STORED_TOOL_CHARS (sessions/serialize.ts). */
const MAX_STORED_TOOL_CHARS = 4000;
/** Same as the SPA's MAX_RETRY_TOOL_CHARS: the shrink step for a one-turn record over the cap. */
const MAX_RETRY_TOOL_CHARS = 1000;
/** Same as the SPA's MAX_TITLE_CHARS (sessions/serialize.ts) = chat_handler.MAX_TITLE_CHARS. */
const MAX_TITLE_CHARS = 120;
/** chat_handler.MAX_MESSAGES: the route refuses more, so the server never stores more. */
const MAX_STORED_MESSAGES = 300;
/** chat_handler.MAX_ITEM_BYTES (DynamoDB's 400 KB item limit, with a margin). */
export const MAX_ITEM_BYTES = 350_000;

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isStorableThreadId(threadId: string): boolean {
  return CONVERSATION_ID_PATTERN.test(threadId);
}

/** The partition is ALWAYS the verified caller's Cognito subject (authorizer claims), never request data. */
export function callerPartition(callerSub: string): string {
  return `USER#${callerSub}`;
}

export function sessionKey(callerSub: string, threadId: string): { pk: string; sk: string } {
  return { pk: callerPartition(callerSub), sk: `CONV#${threadId}` };
}

/** LOCKSTEP with chat_handler.CANCEL_SK_PREFIX: the Stop marker of a thread's run. */
const CANCEL_SK_PREFIX = 'RUNCANCEL#';

/** The key of the Stop marker chat_handler writes for this thread (`POST .../cancel`). */
export function cancelKey(callerSub: string, threadId: string): { pk: string; sk: string } {
  return { pk: callerPartition(callerSub), sk: `${CANCEL_SK_PREFIX}${threadId}` };
}

export interface SessionSnapshot {
  callerSub: string;
  threadId: string;
  runId: string;
  status: RunStatus;
  messages: readonly Message[];
  page: PageContext;
  pendingInterrupts: readonly unknown[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** The user's rename; when set it is the stored title (and kept as `custom_title`). */
  customTitle?: string;
}

function partMetadataName(part: ContentPart): string {
  const metadata: unknown = part.metadata;
  if (typeof metadata === 'object' && metadata !== null) {
    const name: unknown = Reflect.get(metadata, 'name');
    if (typeof name === 'string') return name;
  }
  return part.type;
}

/** An attachment without its data, as the SPA stores it (`stripPart`). */
function stripPart(part: ContentPart): ContentPart {
  if (part.type === 'text') return part;
  const mimeType = part.source.mimeType ?? 'application/octet-stream';
  return {
    type: part.type,
    source: { type: 'data', value: '', mimeType },
    metadata: { name: partMetadataName(part), mimeType },
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const text: unknown = typeof part === 'object' && part !== null ? Reflect.get(part, 'text') : undefined;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** Character caps for stored tool contents: any result, and a persona-cards result (persona-result.ts). */
interface ToolCaps {
  tool: number;
  persona: number;
}

const STORED_CAPS: ToolCaps = { tool: MAX_STORED_TOOL_CHARS, persona: MAX_STORED_PERSONA_CHARS };
const RETRY_CAPS: ToolCaps = { tool: MAX_RETRY_TOOL_CHARS, persona: MAX_RETRY_PERSONA_CHARS };

/** A tool content within its cap: a persona result keeps valid JSON, anything else is cut. */
function storedToolText(text: string, caps: ToolCaps): string {
  return storedPersonaResult(text, caps.persona) ?? text.slice(0, caps.tool);
}

/** One message as it is stored: no attachment data, tool content trimmed. */
function storedMessage(message: Message, caps: ToolCaps = STORED_CAPS): Message {
  if (message.role === 'tool') return { ...message, content: storedToolText(textOf(message.content), caps) };
  if (message.role === 'user' && typeof message.content !== 'string') {
    return { ...message, content: message.content.map(stripPart) };
  }
  return message;
}

/** First user message as plain text, ≤ MAX_TITLE_CHARS (the SPA's `sessionTitle`). */
function sessionTitle(messages: readonly Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text = first ? textOf(first.content).replaceAll(/\s+/g, ' ').trim() : '';
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}

function userIndexes(messages: readonly Message[]): number[] {
  return messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
}

/** The newest whole turns within `max` messages (a turn starts at a user message). */
function keepNewestTurns(messages: readonly Message[], max: number): Message[] {
  if (messages.length <= max) return [...messages];
  const starts = userIndexes(messages);
  const fitting = starts.find((i) => messages.length - i <= max);
  return messages.slice(fitting ?? starts.at(-1) ?? 0);
}

/** One shrink step: drop the oldest half of the turns, or (one turn left) shrink tool contents. */
function shrinkOnce(messages: readonly Message[]): Message[] | null {
  const starts = userIndexes(messages);
  if (starts.length > 1) return messages.slice(starts[Math.floor(starts.length / 2)]);
  const shrinks = messages.some((m) => m.role === 'tool' && storedToolText(textOf(m.content), RETRY_CAPS) !== textOf(m.content));
  return shrinks ? messages.map((m) => storedMessage(m, RETRY_CAPS)) : null;
}

/** Upper-bound size estimate (UTF-8 bytes), as chat_handler's `_estimated_item_bytes`. */
export function estimatedItemBytes(item: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(item));
}

function itemFor(snapshot: SessionSnapshot, messages: readonly Message[]): Record<string, unknown> {
  const { pk, sk } = sessionKey(snapshot.callerSub, snapshot.threadId);
  return {
    pk,
    sk,
    conversation_id: snapshot.threadId,
    kind: 'assistant',
    title: snapshot.customTitle ?? (sessionTitle(messages) || 'New conversation'),
    ...(snapshot.customTitle === undefined ? {} : { custom_title: snapshot.customTitle }),
    messages_json: JSON.stringify(messages),
    page_json: JSON.stringify(snapshot.page),
    pending_json: JSON.stringify(snapshot.pendingInterrupts),
    message_count: messages.length,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
    run_id: snapshot.runId,
    run_status: snapshot.status,
    revision: snapshot.revision,
  };
}

/**
 * The item to write, shrunk to fit MAX_ITEM_BYTES; null when even the newest
 * turn with trimmed tool contents does not fit (the caller logs and skips).
 */
export function buildSessionItem(snapshot: SessionSnapshot): Record<string, unknown> | null {
  const initial = keepNewestTurns(snapshot.messages.map((m) => storedMessage(m)), MAX_STORED_MESSAGES);
  const fit = (messages: Message[]): Record<string, unknown> | null => {
    const item = itemFor(snapshot, messages);
    if (estimatedItemBytes(item) <= MAX_ITEM_BYTES) return item;
    const smaller = shrinkOnce(messages);
    return smaller === null ? null : fit(smaller);
  };
  return fit(initial);
}
