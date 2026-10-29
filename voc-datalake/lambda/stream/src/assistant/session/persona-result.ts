/**
 * Storing a persona-cards result (`consult_personas`, the persona round) without breaking it.
 *
 * Saved tool contents are cut to a character cap. A persona result is JSON
 * (`{"responses":[{persona_id,name,avatar_url?,answer}]}`), and a plain cut left
 * invalid JSON, so the cards vanished after a reload (one answer is up to 4,000
 * characters on its own). Here the ANSWERS are shortened instead, evenly, so the
 * stored text is always valid JSON within its own, larger cap.
 *
 * LOCKSTEP with the SPA's `frontend/src/assistant/sessions/personaResult.ts`
 * (`personaResult.lockstep.test.ts` compares both on the same inputs): the
 * stream Lambda and the SPA must store the same thing.
 */
import { z } from 'zod';
import { isRecord } from '../../lib/is-record.js';

/** A full round (6 personas × a 4,000-char answer, names, avatar URLs) fits. */
export const MAX_STORED_PERSONA_CHARS = 32_000;
/** The persona cap of the shrink step for a one-turn record over the item size. */
export const MAX_RETRY_PERSONA_CHARS = 6_000;
/** Under this many characters per answer the avatar URLs go first (the card falls back to an icon). */
const MIN_ANSWER_CHARS = 200;
const ELLIPSIS = '…';

const responseSchema = z.object({ persona_id: z.string(), answer: z.string() });
const resultSchema = z.object({ responses: z.array(responseSchema).min(1) });

/** The parsed result, kept as the raw objects so re-serialising keeps the original key order. */
interface PersonaResult {
  rest: Record<string, unknown>;
  responses: Array<Record<string, unknown> & { answer: string }>;
}

function parseResult(text: string): PersonaResult | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!resultSchema.safeParse(raw).success || !isRecord(raw) || !Array.isArray(raw.responses)) return null;
    const list: unknown[] = raw.responses;
    const responses = list.flatMap((row) => (isRecord(row) && typeof row.answer === 'string' ? [{ ...row, answer: row.answer }] : []));
    return { rest: raw, responses };
  } catch {
    return null;
  }
}

function serialise(result: PersonaResult, answerOf: (answer: string) => string): string {
  return JSON.stringify({ ...result.rest, responses: result.responses.map((r) => ({ ...r, answer: answerOf(r.answer) })) });
}

function withoutAvatars(result: PersonaResult): PersonaResult {
  return {
    ...result,
    responses: result.responses.map((response) => ({
      ...Object.fromEntries(Object.entries(response).filter(([key]) => key !== 'avatar_url')),
      answer: response.answer,
    })),
  };
}

/** Characters available to each answer once everything else is serialised. */
function answerShare(result: PersonaResult, budget: number): number {
  return Math.floor((budget - serialise(result, () => '').length) / result.responses.length);
}

/** Length of `value` inside a JSON string (escapes included, quotes not). */
function escapedLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

/** `answer` cut so its ESCAPED form fits `max` characters (newlines and quotes count double). */
function clipAnswer(answer: string, max: number): string {
  if (escapedLength(answer) <= max) return answer;
  if (max <= ELLIPSIS.length) return '';
  const cut = { length: Math.min(answer.length, max - ELLIPSIS.length) };
  // Each pass removes at least the overshoot; escapes make it at most a few passes.
  while (cut.length > 0 && escapedLength(answer.slice(0, cut.length)) + ELLIPSIS.length > max) {
    cut.length -= Math.max(1, escapedLength(answer.slice(0, cut.length)) + ELLIPSIS.length - max);
  }
  return cut.length > 0 ? `${answer.slice(0, cut.length)}${ELLIPSIS}` : '';
}

/**
 * The stored text of a persona result within `budget` characters, or null when `text` is not
 * a persona result (the caller trims it like any other tool content). Always valid JSON, and
 * within `budget` unless the names and ids alone exceed it (then every answer is emptied).
 */
export function storedPersonaResult(text: string, budget: number): string | null {
  const result = parseResult(text);
  if (result === null) return null;
  if (text.length <= budget) return text;
  const lean = answerShare(result, budget) < MIN_ANSWER_CHARS ? withoutAvatars(result) : result;
  const share = Math.max(0, answerShare(lean, budget));
  return serialise(lean, (answer) => clipAnswer(answer, share));
}
