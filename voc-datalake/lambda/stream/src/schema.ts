/**
 * Zod request validation schemas for the streaming chat Lambda.
 *
 * ## Field-length reasoning
 *
 * Every free-text field carries an explicit `.max()` so that an oversized
 * payload is rejected before any Bedrock call is made.  The caps below are
 * sized to real use with generous headroom:
 *
 *   message          2 000 chars  — chat queries; a short essay is ~800 chars
 *   context          500 chars    — filter hints ("Source: x. Category: y.")
 *   project_id       128 chars    — UUID (36) or short slug; 128 is very safe
 *   selected_personas/documents items  128 chars each  — IDs/slugs
 *   selected_personas/documents arrays  20 items each  — project persona/doc counts
 *   history[].content  4 000 chars  — one turn; long AI response is ~1 000 tokens
 *   history array    50 items     — existing cap kept
 *   attachment.name  255 chars    — filesystem filename limit
 *   attachment.data  2 800 000 chars  — base64 of ~2 MB file; real images/PDFs fit
 *   attachments array  5 items   — existing cap kept
 *
 * Total history budget: 50 × 4 000 = 200 000 chars ≈ 50 000 tokens.
 * Total attachment budget: 5 × 2 800 000 = 14 000 000 chars ≈ 10 500 000 base64
 * bytes ≈ 10 MB of raw file data.  These are the dominant cost vectors, and both
 * are now hard-capped before any Bedrock call.
 *
 * `response_language` is constrained to SUPPORTED_LANGUAGES (the eight locales
 * that have a shipped UI catalogue).  Unrecognised values are silently coerced to
 * `undefined` so that older clients degrade to English instead of receiving a 400.
 */
import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from './context/language.js';

const ALLOWED_MEDIA_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
] as const;

// ── Per-field length constants (documented above) ──

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_CONTEXT_LENGTH = 500;
const MAX_ID_LENGTH = 128;
const MAX_HISTORY_CONTENT_LENGTH = 4_000;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_DATA_LENGTH = 2_800_000;
const MAX_PERSONAS_DOCS_ARRAY = 20;

// Used by the response_language preprocess step below; Set.has() avoids the
// TypeScript narrowing awkwardness of ReadonlyArray.includes().
const supportedLanguageSet: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

export const attachmentSchema = z.object({
  name: z.string().min(1, 'Attachment name is required').max(MAX_ATTACHMENT_NAME_LENGTH),
  media_type: z.enum(ALLOWED_MEDIA_TYPES, {
    errorMap: () => ({ message: `Unsupported file type. Allowed: ${ALLOWED_MEDIA_TYPES.join(', ')}` }),
  }),
  data: z.string().min(1, 'Attachment data is required').max(MAX_ATTACHMENT_DATA_LENGTH),
});

export type Attachment = z.infer<typeof attachmentSchema>;

const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_HISTORY_CONTENT_LENGTH),
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
    (v) => (typeof v === 'string' && supportedLanguageSet.has(v) ? v : undefined),
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
  // Conversation history for multi-turn context
  history: z.array(historyMessageSchema).max(50).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
