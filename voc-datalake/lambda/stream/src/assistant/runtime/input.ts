/**
 * Request parsing: body → AG-UI `RunAgentInput` → validated `forwardedProps`.
 *
 * Policy, by who authored the value (same split as the old chat schema):
 *   - the user's NEW message (the last `user` message) REJECTS over
 *     LIMITS.maxUserMessageChars and over the attachment bounds — the user
 *     can fix it and the SPA mirrors the numbers;
 *   - replayed history and tool messages CLAMP (convert.ts / flatten.ts) —
 *     they are service-authored, and rejecting would kill the thread;
 *   - the message COUNT rejects at LIMITS.maxMessages, a sanity bound the SPA
 *     never reaches because it windows its own replay.
 *
 * `input.tools` and `input.context` are accepted (AG-UI requires them) but
 * ignored: the toolset and the system prompt are server-owned, so a client
 * can never add a tool or an instruction. `system`/`developer` messages are
 * dropped during conversion for the same reason.
 */
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { ContentPart, Message, RunAgentInput, UserMessage } from '@ag-ui/core';
import { forwardedPropsSchema, LIMITS, type ForwardedProps } from '../contract.js';
import { ValidationError } from '../../lib/errors.js';

interface IssueLike {
  path: PropertyKey[];
  message: string;
}

function describeIssue(prefix: string, issue: IssueLike | undefined): string {
  // Stryker disable next-line ConditionalExpression,StringLiteral: a failed zod safeParse always carries at least one issue; the guard only narrows the `noUncheckedIndexedAccess` type
  if (!issue) return `Invalid ${prefix}`;
  const path = issue.path.map(String).join('.');
  return path ? `Invalid ${prefix} at ${path}: ${issue.message}` : `Invalid ${prefix}: ${issue.message}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || 'null');
  } catch {
    throw new ValidationError('Request body is not valid JSON');
  }
}

/** Parse and validate the AG-UI envelope (identity is checked separately). */
export function parseRunAgentInput(bodyText: string): RunAgentInput {
  const parsed = RunAgentInputSchema.safeParse(parseJson(bodyText));
  if (!parsed.success) {
    throw new ValidationError(describeIssue('run input', parsed.error.issues[0]));
  }
  return parsed.data;
}

export function parseForwardedProps(input: RunAgentInput): ForwardedProps {
  const parsed = forwardedPropsSchema.safeParse(input.forwardedProps);
  if (!parsed.success) {
    throw new ValidationError(describeIssue('forwardedProps', parsed.error.issues[0]));
  }
  return parsed.data;
}

export function isUserMessage(message: Message | undefined): message is UserMessage {
  return message?.role === 'user';
}

/** Index of the last `user` message, or -1. */
export function lastUserIndex(messages: readonly Message[]): number {
  return messages.reduce((found, message, i) => (message.role === 'user' ? i : found), -1);
}

export function partsOf(content: string | ContentPart[]): ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function textOfParts(content: string | ContentPart[]): string {
  return partsOf(content)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

function enforceNewUserMessage(message: UserMessage): void {
  const parts = partsOf(message.content);
  if (textOfParts(message.content).length > LIMITS.maxUserMessageChars) {
    throw new ValidationError(`Message exceeds ${LIMITS.maxUserMessageChars} characters`);
  }
  const media = parts.filter((part) => part.type !== 'text');
  if (media.length > LIMITS.maxAttachments) {
    throw new ValidationError(`At most ${LIMITS.maxAttachments} attachments are allowed`);
  }
  for (const part of media) {
    if (part.source.type === 'data' && part.source.value.length > LIMITS.maxAttachmentBase64Chars) {
      throw new ValidationError('Attachment exceeds the size limit');
    }
  }
}

export function enforceLimits(input: RunAgentInput): void {
  if (input.messages.length > LIMITS.maxMessages) {
    throw new ValidationError(`At most ${LIMITS.maxMessages} messages are allowed`);
  }
  const last = input.messages[lastUserIndex(input.messages)];
  if (!isUserMessage(last)) {
    throw new ValidationError('The run must contain a user message');
  }
  enforceNewUserMessage(last);
}
