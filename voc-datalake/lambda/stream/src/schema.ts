/**
 * Zod request validation schemas for the streaming chat Lambda.
 *
 * ## Three policies, by who authored the value
 *
 * **User-authored** fields REJECT: the caller typed or pasted it, so telling them
 * is the useful response, and the frontend carries a matching limit (see
 * `frontend/src/api/streamLimits.ts`, pinned by a lockstep test) so a real user is
 * stopped before sending rather than after. `message` is the case.
 *
 * **Service-authored** text CLAMPS. `history` replays answers this service
 * generated, so a bound below the model's own output ceiling would turn a normal
 * long answer into a 400 on every later message in that conversation. See
 * history-budget.ts for the reasoning and the derivation.
 *
 * **Bounded by construction on the client** REJECTS here, with no i18n message,
 * because reaching it would be a bug rather than user input. `context` is the
 * case: `buildChatContext()` emits at most four clauses from three single-valued
 * filters AND caps each value, so its output is provably under 500 for filter
 * values of any length — `frontend/src/pages/Chat/chatContext.test.ts` asserts that
 * against a 10 000-char value.
 *
 * The per-value cap is load-bearing, not decoration: `category` comes from the
 * tenant's configured list and its length is validated nowhere, so "short by
 * nature" was an assumption about data, not a property of the code. If `context`
 * ever becomes multi-valued, or the client cap is removed, it moves to the first
 * policy and needs a client-side mirror with a translated message.
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
 * `response_language` is constrained to SUPPORTED_LANGUAGES — the languages the
 * model may be asked to answer in, which is deliberately WIDER than the set the UI
 * is translated into. Safety here comes from interpolating a name from that
 * module's table rather than the caller's own string, so the list's size is a
 * coverage decision and not a security one. Unrecognised values are silently
 * coerced to `undefined`, so older clients degrade to English rather than 400.
 */
import { z } from 'zod';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from './context/language.js';
import { clampHistoryToBudget, MAX_HISTORY_ARRAY } from './history-budget.js';

const ALLOWED_MEDIA_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
] as const;

// ── Per-field length constants (documented above) ──

export const MAX_MESSAGE_LENGTH = 8_000;
const MAX_CONTEXT_LENGTH = 500;
export const MAX_ID_LENGTH = 128;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_DATA_LENGTH = 2_800_000;
export const MAX_PERSONAS_DOCS_ARRAY = 20;

const projectContextIdSchema = z.string()
  .min(1, 'ID is required')
  .max(MAX_ID_LENGTH);

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
  project_id: projectContextIdSchema.optional(),
  selected_personas: z.array(projectContextIdSchema).max(MAX_PERSONAS_DOCS_ARRAY).optional(),
  selected_documents: z.array(projectContextIdSchema).max(MAX_PERSONAS_DOCS_ARRAY).optional(),
  // Roundtable mode: each selected persona responds in turn
  roundtable: z.boolean().optional(),
  // Opt-in public web search (only honored when the AgentCore web search
  // gateway is deployed; silently ignored otherwise)
  use_web_search: z.boolean().optional(),
  // Attachments (images, PDFs)
  attachments: z.array(attachmentSchema).max(5).optional(),
  // Conversation history for multi-turn context. Clamped to the budget rather
  // than capped at the product limit: the count bound used to reject, which killed
  // a conversation at turn 51 the same way the content cap killed it after one long
  // answer. MAX_HISTORY_ARRAY is an order of magnitude above the window, so no real
  // conversation meets it — it only stops an absurd array being validated
  // element-by-element before the window discards almost all of it.
  history: z.array(historyMessageSchema)
    .max(MAX_HISTORY_ARRAY)
    .transform(clampHistoryToBudget)
    .optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
