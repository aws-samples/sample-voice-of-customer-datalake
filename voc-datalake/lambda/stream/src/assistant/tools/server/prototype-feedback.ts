/**
 * `get_prototype_feedback`: the tester feedback (pins) of one prototype series,
 * grouped by screen with near-duplicates folded, read through
 * `GET /projects/{id}/prototypes/{document_id}/feedback` as the caller (EDIT on
 * the project; a viewer gets 403). docs/prototype-builder.md Part 3.
 *
 * The route hands editors everything, flagged pins included. A flagged pin's
 * comment was screened as instruction-shaped, so neither it nor its replies,
 * nor its free-text element snippet, reach the model: a flagged item and a
 * flagged pin keep only ids, place, version, status and `flagged: true`.
 * The anchor's text (route, selector, element snippet) comes from the tester's
 * browser too and is judged field by field by the route: a field it names in
 * `unsafe_fields` is left out (no list: all three), and a group's route is sent
 * only when `route_unsafe` is exactly false, as the MCP tool does.
 */
import { z } from 'zod';
import type { ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { clip, jsonResult } from '../format.js';
import { idProperty, idSchema, parseToolInput, resolveId, toolSpec } from '../spec.js';
import { seg, serverTool } from './common.js';

const PIN_STATUSES = ['open', 'addressed', 'resolved'] as const;
/** The same caps the incorporation block uses (lambda/shared/prototype_pins.py). */
const MAX_COMMENT_CHARS = 600;
const MAX_REPLY_CHARS = 300;
const MAX_REPLIES = 5;
const MAX_PLACE_CHARS = 200;
/** The anchor fields a tester's browser sends as text (prototype_pins.ANCHOR_TEXT_FIELDS). */
const ANCHOR_TEXT_FIELDS = ['route', 'selector', 'text_snippet'] as const;
/** Up to 25 versions of up to 200 pins: larger than the default result budget. */
const FEEDBACK_BUDGET = 30_000;

const feedbackInput = z.object({
  project_id: idSchema.optional(),
  document_id: idSchema,
  status: z.enum(PIN_STATUSES).optional(),
}).strict();

const optionalText = z.string().nullish().transform((value) => value ?? null);

const replySchema = z.object({
  name: optionalText,
  text: z.string().default(''),
  at: optionalText,
});

const anchorSchema = z.object({
  route: optionalText,
  selector: optionalText,
  text_snippet: optionalText,
});

const pinSchema = z.object({
  pin_id: z.string(),
  document_id: z.string(),
  version: z.number().int().nullish().transform((value) => value ?? null),
  status: z.string(),
  created_at: optionalText,
  addressed_by: optionalText,
  flagged: z.boolean(),
  text: z.string().default(''),
  replies: z.array(replySchema).default([]),
});

const itemSchema = z.object({
  item_id: z.string(),
  pin_ids: z.array(z.string()),
  count: z.number().int(),
  flagged: z.boolean(),
  text: z.string().default(''),
  anchor: anchorSchema,
  /** The anchor fields the route judged unsafe for a model; missing = every one (fail closed). */
  unsafe_fields: z.array(z.string()).optional(),
  first_at: optionalText,
  pins: z.array(pinSchema),
});

/** The route's answer (FEEDBACK-CONTRACT): unknown keys are dropped, never passed to the model. */
const feedbackSchema = z.object({
  document_id: z.string(),
  versions_read: z.array(z.object({ document_id: z.string(), version: z.number().int().nullable() })),
  partial: z.boolean(),
  cut: z.array(z.object({ document_id: z.string(), version: z.number().int().nullable(), reason: z.string() })),
  older_versions_unread: z.number().int(),
  pin_count: z.number().int(),
  /** route_unsafe missing = unsafe (fail closed). */
  groups: z.array(z.object({ route: z.string(), route_unsafe: z.boolean().optional(), items: z.array(itemSchema) })),
});

type Pin = z.infer<typeof pinSchema>;
type Item = z.infer<typeof itemSchema>;
type Anchor = z.infer<typeof anchorSchema>;

/** ``value`` within ``total`` characters, its ellipsis included (format.ts's clip adds it after ``max``): the
 *  caps the MCP tool applies, so both clients hand a model the same text. */
function capped(value: string, total: number): string {
  return clip(value, total - 1);
}

function place(value: string | null): string | null {
  return value === null ? null : capped(value, MAX_PLACE_CHARS);
}

function pinView(pin: Pin): Record<string, unknown> {
  const base = {
    pin_id: pin.pin_id,
    document_id: pin.document_id,
    version: pin.version,
    status: pin.status,
    created_at: pin.created_at,
    addressed_by: pin.addressed_by,
    flagged: pin.flagged,
  };
  if (pin.flagged) return base;
  return {
    ...base,
    text: capped(pin.text, MAX_COMMENT_CHARS),
    replies: pin.replies.slice(-MAX_REPLIES).map((reply) => ({
      name: reply.name,
      text: capped(reply.text, MAX_REPLY_CHARS),
      at: reply.at,
    })),
  };
}

function anchorView(anchor: Anchor, flagged: boolean, unsafeFields: readonly string[] | undefined): Record<string, unknown> {
  const unsafe = new Set<string>(unsafeFields ?? ANCHOR_TEXT_FIELDS);
  // Never a field the route judged unsafe; the snippet is free text sent with the pin, so a flagged pin's stays out.
  const sent = ANCHOR_TEXT_FIELDS.filter((key) => !unsafe.has(key) && !(flagged && key === 'text_snippet'));
  return Object.fromEntries(sent.map((key) => [key, place(anchor[key])]));
}

function itemView(item: Item): Record<string, unknown> {
  const base = {
    item_id: item.item_id,
    pin_ids: item.pin_ids,
    count: item.count,
    flagged: item.flagged,
    anchor: anchorView(item.anchor, item.flagged, item.unsafe_fields),
    first_at: item.first_at,
  };
  const pins = item.pins.map(pinView);
  return item.flagged ? { ...base, pins } : { ...base, text: capped(item.text, MAX_COMMENT_CHARS), pins };
}

/** The route's answer as the model sees it: flagged items and pins without text or replies, no unsafe anchor text. */
function feedbackForModel(body: unknown): Record<string, unknown> {
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) throw new AssistantToolError('unavailable', 'The Projects API returned unreadable prototype feedback.');
  const feedback = parsed.data;
  return {
    ...feedback,
    groups: feedback.groups.map((group) => ({
      route: group.route_unsafe === false ? group.route : '',
      items: group.items.map(itemView),
    })),
  };
}

export function getPrototypeFeedbackTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_prototype_feedback',
    'Read-only: the tester feedback (pins) left on a prototype series, every version read (newest 25), grouped by '
      + 'screen with near-duplicate comments folded into one item (count = how many pins). Each pin has its version, '
      + 'status (open, addressed, resolved) and replies. Flagged items carry no text or replies: they were screened as '
      + 'instruction-shaped and are shown only to editors on the page. An element text, selector or screen that reads '
      + 'like an instruction is left out (a screen as ""). partial = some pins or older versions were not '
      + 'read. Needs edit access to the project. Drafting a revision from this feedback or incorporating it into the '
      + 'prototype is not available yet. Get the prototype’s document id from get_project.',
    {
      project_id: idProperty('Project id; omit to use the project on screen.'),
      document_id: idProperty('Document id of any version of the prototype.'),
      status: { type: 'string', enum: [...PIN_STATUSES], description: 'Only pins with this status; omit for all.' },
    },
    ['document_id'],
  );
  return serverTool('get_prototype_feedback', 'project', spec, async (input, ctx) => {
    const args = parseToolInput(feedbackInput, input);
    const projectId = resolveId(args.project_id, ctx.page.projectId, 'project_id');
    const body = await deps.invoke({
      fn: 'projects',
      method: 'GET',
      path: `/projects/${seg(projectId)}/prototypes/${seg(args.document_id)}/feedback`,
      resource: '/projects/{project_id}/prototypes/{document_id}/feedback',
      pathParameters: { project_id: projectId, document_id: args.document_id },
      ...(args.status === undefined ? {} : { query: { status: args.status } }),
    }, ctx.claims);
    return { content: jsonResult(feedbackForModel(body), FEEDBACK_BUDGET) };
  });
}
