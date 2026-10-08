/**
 * Where a persona's goals, frustrations and voice actually live.
 *
 * The TypeScript twin of `lambda/shared/persona_context.py`, and it exists for
 * the same reason: two prompt builders here read `persona.goals`,
 * `persona.frustrations`, `persona.needs` and `persona.quote` — keys NO writer
 * produces. Stored personas follow `schemas/persona.schema.json`, so goals live
 * under `goals_motivations`, frustrations under `pain_points`, and the voice line
 * under `quotes[0].text`.
 *
 * Consequence before this: project chat rendered "**Goals:**" with nothing under
 * it, and the roundtable prompt told the model to BE a persona while handing it an
 * empty identity. Neither errored, so neither was noticed.
 *
 * Kept deliberately small and capped: these strings land in a system prompt that
 * competes with the conversation history budget (`src/history-budget.ts`).
 */
/**
 * The persona sections these readers touch. Structural on purpose: the
 * assistant's persona record from the chat-context route satisfies it without
 * this module depending on that reader.
 */
export interface PersonaFieldSource {
  quotes?: unknown[];
  goals_motivations?: Record<string, unknown>;
  pain_points?: Record<string, unknown>;
}

/** Chat prompts have more room than the Python document paths, which cap at 3. */
const DEFAULT_PERSONA_ITEMS = 4;

/**
 * One key off a value that is only believed to be an object.
 *
 * The persona sections arrive as opaque records — the chat-context reader
 * (`assistant/tools/server/chat-context.ts`) declares them that way on purpose,
 * because naming their leaves would let one malformed row throw and take down
 * the whole read. So every read goes through a guard here rather than trusting
 * the declared type. Kept local (three lines) so this leaf module imports nothing.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readKey(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * Keys worth reading off an entry that turned up as an object where a string was
 * expected. Mirrors `_TEXTUAL_KEYS` in `shared/persona_context.py` — the twins
 * must not disagree about whether content survives, or the same persona yields a
 * goal in a PRD and silence in chat.
 */
const TEXTUAL_KEYS = ['text', 'description', 'value', 'name'] as const;

/** The readable text of one list entry, or '' when it holds none. */
function entryText(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  // Number.isFinite is false for every non-number, so it is the type test too.
  if (Number.isFinite(entry)) return String(entry);
  if (isRecord(entry)) {
    for (const key of TEXTUAL_KEYS) {
      const candidate = entry[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  // Deliberately NOT `String(entry)`: an object renders as "[object Object]",
  // which is worse in a prompt than saying nothing.
  return '';
}

function cleanStrings(values: unknown, limit: number): string[] {
  if (typeof values === 'string') {
    const single = values.trim();
    return single ? [single] : [];
  }
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= limit) break;
    const text = entryText(value);
    if (text) out.push(text);
  }
  return out;
}

/**
 * The persona's representative quote, or ''.
 *
 * `quotes` entries are `{text, context}` objects; a bare string is tolerated
 * because the Python renderer tolerates it and rows exist in both shapes.
 */
export function personaVoice(persona: PersonaFieldSource): string {
  const quotes = persona.quotes;
  if (!Array.isArray(quotes)) return '';
  for (const quote of quotes) {
    const text = typeof quote === 'string' ? quote : readKey(quote, 'text');
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/** Primary goal first, then secondary goals. */
export function personaGoals(persona: PersonaFieldSource, limit = DEFAULT_PERSONA_ITEMS): string[] {
  const section = persona.goals_motivations;
  const goals: string[] = [];
  const primary = readKey(section, 'primary_goal');
  if (typeof primary === 'string' && primary.trim()) goals.push(primary.trim());
  goals.push(...cleanStrings(readKey(section, 'secondary_goals'), limit));
  return goals.slice(0, limit);
}

/**
 * Current challenges first, topped up with blockers.
 *
 * Both belong under "frustrations" for a prompt: a challenge is what hurts, a
 * blocker is what stops them, and a model reasoning about a feature needs both.
 */
export function personaFrustrations(persona: PersonaFieldSource, limit = DEFAULT_PERSONA_ITEMS): string[] {
  const section = persona.pain_points;
  const pains = cleanStrings(readKey(section, 'current_challenges'), limit);
  for (const blocker of cleanStrings(readKey(section, 'blockers'), limit)) {
    if (pains.length >= limit) break;
    if (!pains.includes(blocker)) pains.push(blocker);
  }
  return pains;
}

/**
 * What the persona is working around or motivated by — the closest real data to
 * the old phantom `needs` key.
 *
 * `needs` never existed on any row. Rather than drop the concept, it maps to the
 * two canonical fields that answer the same question for a model: how they cope
 * today (`pain_points.workarounds`) and what actually drives them
 * (`goals_motivations.underlying_motivations`).
 */
export function personaNeeds(persona: PersonaFieldSource, limit = DEFAULT_PERSONA_ITEMS): string[] {
  const needs = cleanStrings(readKey(persona.goals_motivations, 'underlying_motivations'), limit);
  for (const workaround of cleanStrings(readKey(persona.pain_points, 'workarounds'), limit)) {
    if (needs.length >= limit) break;
    if (!needs.includes(workaround)) needs.push(workaround);
  }
  return needs;
}

/** `- one\n- two`, or '' when there is nothing — so a caller can omit the label. */
export function bulletList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}
