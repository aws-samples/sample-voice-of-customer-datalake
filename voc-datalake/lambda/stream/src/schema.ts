/**
 * Zod request validation schemas for the streaming chat Lambda.
 *
 * ## Two policies, deliberately
 *
 * Bounds on **client-authored** fields REJECT: the caller supplied the value, so
 * telling them is the useful response, and the frontend carries a matching limit
 * (see `frontend/src/api/streamLimits.ts`, pinned by a lockstep test) so a real
 * user is stopped before sending rather than after.
 *
 * Bounds on **service-authored** text CLAMP. `history` replays answers this
 * service generated, so a bound below the model's own output ceiling would turn a
 * normal long answer into a 400 on every later message in that conversation.
 * See history-budget.ts for the reasoning and the derivation.
 *
 *   message          8 000 chars  — typed OR pasted; see below
 *   context          500 chars    — filter hints ("Source: x. Category: y.")
 *   project_id       128 chars    — UUID (36) or short slug; 128 is very safe
 *   selected_personas/documents items  128 chars each  — IDs/slugs
 *   selected_personas/documents arrays  20 items each  — roundtable fan-out bound
 *   history          clamped, not capped — history-budget.ts
 *   attachment.name  255 chars    — filesystem filename limit
 *   attachment.data  2 800 000 chars  — base64 of ~2 MB file; real images/PDFs fit
 *   attachments array  5 items   — existing cap kept
 *
 * `message` is 8 000 chars (~2 000 tokens) rather than something tighter because
 * this is an analytics tool: pasting a review, a support thread or a slice of a
 * PRD and asking "what do you make of this?" is a normal workflow. The generosity
 * is affordable precisely because the request is not the dominant cost term — a
 * single question can drive up to MAX_TOOL_LOOPS rounds of corpus context, which
 * dwarfs anything a human types. Request-side caps are a well-formedness control
 * here, not a cost control.
 *
 * The attachment array bound is NOT the binding constraint: 5 × 2 800 000 chars
 * exceeds the API Gateway request-payload limit, so the transport refuses first.
 * It is kept as a sanity bound only.
 *
 * `response_language` is constrained to SUPPORTED_LANGUAGES (the eight locales
 * that have a shipped UI catalogue).  Unrecognised values are silently coerced to
 * `undefined` so that older clients degrade to English instead of receiving a 400.
 */
import { z } from 'zod';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from './context/language.js';
import { clampHistoryToBudget } from './history-budget.js';

const ALLOWED_MEDIA_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
] as const;

// ── Per-field length constants (documented above) ──

export const MAX_MESSAGE_LENGTH = 8_000;
const MAX_CONTEXT_LENGTH = 500;
const MAX_ID_LENGTH = 128;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_DATA_LENGTH = 2_800_000;
export const MAX_PERSONAS_DOCS_ARRAY = 20;

export const attachmentSchema = z.object({
  name: z.string().min(1, 'Attachment name is required').max(MAX_ATTACHMENT_NAME_LENGTH),
  media_type: z.enum(ALLOWED_MEDIA_TYPES, {
    errorMap: () => ({ message: `Unsupported file type. Allowed: ${ALLOWED_MEDIA_TYPES.join(', ')}` }),
  }),
  data: z.string().min(1, 'Attachment data is required').max(MAX_ATTACHMENT_DATA_LENGTH),
});

export type Attachment = z.infer<typeof attachmentSchema>;

// No `.max()` on content: an over-long turn is truncated by
// clampHistoryToBudget on the array below, never rejected. See history-budget.ts.
const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

export const chatRequestSchema = z.object({
  message: z.string().min(1, 'Message is required').max(MAX_MESSAGE_LENGTH),
  // VoC chat fields
  context: z.string().max(MAX_CONTEXT_LENGTH).optional(),
  days: z.number().int().min(1).max(365).optional(),
  // Which date the days window applies to: 'imported' (default, ingestion
  // date) or 'review' (when the customer wrote the feedback). Issue #150.
  date_basis: z.enum(['imported', 'review']).optional(),
  // Constrained to the shipped locale set; unknown codes are silently coerced
  // to undefined (i.e. English) so older clients degrade gracefully.
  // z.preprocess sanitises the raw string before the enum parser runs: a
  // recognised code passes through; anything else becomes undefined, which
  // the trailing .optional() accepts.
  response_language: z.preprocess(
    (v) => (isSupportedLanguage(v) ? v : undefined),
    z.enum(SUPPORTED_LANGUAGES).optional(),
  ),
  // Project chat fields
  project_id: z.string().max(MAX_ID_LENGTH).optional(),
  selected_personas: z.array(z.string().max(MAX_ID_LENGTH)).max(MAX_PERSONAS_DOCS_ARRAY).optional(),
  selected_documents: z.array(z.string().max(MAX_ID_LENGTH)).max(MAX_PERSONAS_DOCS_ARRAY).optional(),
  // Roundtable mode: each selected persona responds in turn
  roundtable: z.boolean().optional(),
  // Opt-in public web search (only honored when the AgentCore web search
  // gateway is deployed; silently ignored otherwise)
  use_web_search: z.boolean().optional(),
  // Attachments (images, PDFs)
  attachments: z.array(attachmentSchema).max(5).optional(),
  // Conversation history for multi-turn context. Clamped to the budget rather
  // than capped: the count bound used to reject, which killed a conversation at
  // turn 51 the same way the content cap killed it after one long answer.
  history: z.array(historyMessageSchema).transform(clampHistoryToBudget).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
