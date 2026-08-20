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
import type { ProjectItem } from './project-context.js';

/** Chat prompts have more room than the Python document paths, which cap at 3. */
export const DEFAULT_PERSONA_ITEMS = 4;

function cleanStrings(values: unknown, limit: number): string[] {
  if (typeof values === 'string') {
    const single = values.trim();
    return single ? [single] : [];
  }
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The persona's representative quote, or ''.
 *
 * `quotes` entries are `{text, context}` objects; a bare string is tolerated
 * because the Python renderer tolerates it and rows exist in both shapes.
 */
export function personaVoice(persona: ProjectItem): string {
  const quotes = persona.quotes;
  if (!Array.isArray(quotes)) return '';
  for (const quote of quotes) {
    const text = typeof quote === 'string' ? quote : quote?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/** Primary goal first, then secondary goals. */
export function personaGoals(persona: ProjectItem, limit = DEFAULT_PERSONA_ITEMS): string[] {
  const section = persona.goals_motivations;
  if (!section) return [];
  const goals: string[] = [];
  if (typeof section.primary_goal === 'string' && section.primary_goal.trim()) {
    goals.push(section.primary_goal.trim());
  }
  goals.push(...cleanStrings(section.secondary_goals, limit));
  return goals.slice(0, limit);
}

/**
 * Current challenges first, topped up with blockers.
 *
 * Both belong under "frustrations" for a prompt: a challenge is what hurts, a
 * blocker is what stops them, and a model reasoning about a feature needs both.
 */
export function personaFrustrations(persona: ProjectItem, limit = DEFAULT_PERSONA_ITEMS): string[] {
  const section = persona.pain_points;
  if (!section) return [];
  const pains = cleanStrings(section.current_challenges, limit);
  for (const blocker of cleanStrings(section.blockers, limit)) {
    if (pains.length >= limit) break;
    if (!pains.includes(blocker)) pains.push(blocker);
  }
  return pains.slice(0, limit);
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
export function personaNeeds(persona: ProjectItem, limit = DEFAULT_PERSONA_ITEMS): string[] {
  const needs = cleanStrings(persona.goals_motivations?.underlying_motivations, limit);
  for (const workaround of cleanStrings(persona.pain_points?.workarounds, limit)) {
    if (needs.length >= limit) break;
    if (!needs.includes(workaround)) needs.push(workaround);
  }
  return needs.slice(0, limit);
}

/** `- one\n- two`, or '' when there is nothing — so a caller can omit the label. */
export function bulletList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}
