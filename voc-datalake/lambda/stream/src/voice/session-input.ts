/**
 * What the projects API hands one voice session (lambda/shared/voice_sessions.py writes it when it mints the URL):
 * `scratch/voice/<session id>/evidence.json` in the raw bucket, under `scratch/`, which expires after 2 days.
 *
 * Two kinds, on `kind` (lambda/shared/voice_subjects.py):
 * - `persona_interview` (also an input with no `kind`: the projects API and the relay deploy in different stacks):
 *   the persona's profile, its evidence pack (shared/persona_grounding.py, read as the person who started the
 *   session: their category and source access);
 * - `product_interview` (7.104.00): the product team talks its own product through with an AI interviewer: the
 *   questions it asks, each with the Product tab field it fills (an empty question: the field's default,
 *   assistant/tools/product-interview.ts), and what the form already says.
 *
 * Both carry the voice, the language of the person's UI and the session's limits. The relay reads it once, checks it
 * names this session and this scope, and never writes it. Parsed strictly where it bounds the session (ids, limits,
 * the usage key) and leniently in the evidence and the interview's data, whose unreadable items are dropped as the
 * focus groups drop them (tools/server/evidence-pack.ts).
 */
import { z } from 'zod';

import { evidenceSchema, type EvidenceItem } from '../assistant/tools/server/evidence-pack.js';
import { parseEach } from '../assistant/tools/server/common.js';
import { VOICE_IDS, type VoiceId } from './protocol.js';

/** A session id as AgentCore requires it (at least 33 characters: a UUID) and a project id as the API writes it. */
export const SESSION_ID = /^[A-Za-z0-9-]{33,100}$/;
export const SCOPE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** An AgentCore session lives at most 20 minutes (the runtime's `maxLifetime`): no session limit is above it. */
const MAX_SESSION_SECONDS = 1200;
/** The pack's ceiling (lambda/shared/persona_grounding.py: 12 stored and 8 fresh; the plan allowed up to 40). */
const MAX_EVIDENCE = 40;
/** The product interview's bounds (voice_subjects.py: one question per field, a known value clipped at 500). */
const MAX_QUESTIONS = 12;
const MAX_QUESTION_CHARS = 200;
const MAX_KNOWN_CHARS = 500;
const FIELD = /^[a-z_]{1,40}$/;

const baseSchema = z.object({
  version: z.literal(1),
  session_id: z.string().regex(SESSION_ID),
  project_id: z.string().regex(SCOPE_ID),
  project_name: z.string().max(500).catch(''),
  voice_id: z.enum(VOICE_IDS),
  voice_gender: z.enum(['feminine', 'masculine']),
  language: z.string().regex(/^[a-z]{2}$/).catch('en'),
  session_seconds: z.number().int().min(60).max(MAX_SESSION_SECONDS),
  monthly_seconds: z.number().int().positive(),
  minutes_left: z.number().nonnegative(),
  usage_key: z.string().regex(/^VOICEUSE#[A-Za-z0-9#_-]{1,200}$/),
  /** The session's and the month's cost caps in micro-dollars (voice_sessions.py MAX_CENTS_PER_MINUTE). */
  session_cost_cap_microusd: z.number().int().positive(),
  monthly_cost_cap_microusd: z.number().int().positive(),
});

const personaSchema = baseSchema.extend({
  kind: z.literal('persona_interview').optional(),
  persona: z.object({
    persona_id: z.string().min(1).max(128),
    name: z.string().max(200).catch('Persona'),
    tagline: z.string().max(500).optional().catch(undefined),
    quotes: z.array(z.unknown()).optional().catch(undefined),
    goals_motivations: z.record(z.string(), z.unknown()).optional().catch(undefined),
    pain_points: z.record(z.string(), z.unknown()).optional().catch(undefined),
  }),
  evidence: z.array(z.unknown()).max(MAX_EVIDENCE).catch([]),
});

const questionSchema = z.object({
  field: z.string().regex(FIELD),
  question: z.string().max(MAX_QUESTION_CHARS).catch(''),
});

const productSchema = baseSchema.extend({
  kind: z.literal('product_interview'),
  questions: z.array(z.unknown()).max(MAX_QUESTIONS).catch([]),
  known: z.record(z.string().regex(FIELD), z.string().max(MAX_KNOWN_CHARS)).catch({}),
});

/** One question of a product interview: the Product tab field it fills, and its text ('' for the field's default). */
export interface InterviewQuestion {
  field: string;
  question: string;
}

/** What both kinds of session share: the project, the voice, the language and the limits. */
interface SessionBase {
  projectName: string;
  voiceId: VoiceId;
  voiceGender: 'feminine' | 'masculine';
  language: string;
  sessionSeconds: number;
  monthlySeconds: number;
  minutesLeft: number;
  usageKey: string;
  sessionCostCapMicroUsd: number;
  monthlyCostCapMicroUsd: number;
}

/** A session with a project's persona. */
export interface PersonaSessionInput extends SessionBase {
  kind: 'persona_interview';
  persona: z.infer<typeof personaSchema>['persona'];
  evidence: EvidenceItem[];
}

/** A product interview: the questions in the order they are asked, and the fields the form already holds. */
export interface ProductSessionInput extends SessionBase {
  kind: 'product_interview';
  questions: InterviewQuestion[];
  known: Record<string, string>;
}

/** The input of the session the browser connected for (its id and project are checked when it is parsed). */
export type SessionInput = PersonaSessionInput | ProductSessionInput;

function base(data: z.infer<typeof baseSchema>): SessionBase {
  return {
    projectName: data.project_name,
    voiceId: data.voice_id,
    voiceGender: data.voice_gender,
    language: data.language,
    sessionSeconds: data.session_seconds,
    monthlySeconds: data.monthly_seconds,
    minutesLeft: data.minutes_left,
    usageKey: data.usage_key,
    sessionCostCapMicroUsd: data.session_cost_cap_microusd,
    monthlyCostCapMicroUsd: data.monthly_cost_cap_microusd,
  };
}

/** A record's `kind`, or undefined (a persona input written before 7.104.00 has none). */
function kindOf(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null && 'kind' in raw ? raw.kind : undefined;
}

function parseKind(raw: unknown): SessionInput | undefined {
  if (kindOf(raw) === 'product_interview') {
    const parsed = productSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return {
      ...base(parsed.data), kind: 'product_interview', known: parsed.data.known,
      questions: parseEach(questionSchema, parsed.data.questions),
    };
  }
  const parsed = personaSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    ...base(parsed.data), kind: 'persona_interview', persona: parsed.data.persona,
    evidence: parseEach(evidenceSchema, parsed.data.evidence),
  };
}

/** The session's input, or undefined when it is unreadable or names another session or scope (refused: 1008). */
export function parseSessionInput(raw: unknown, sessionId: string, scope: string): SessionInput | undefined {
  const parsed = baseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.session_id !== sessionId || parsed.data.project_id !== scope) return undefined;
  return parseKind(raw);
}
