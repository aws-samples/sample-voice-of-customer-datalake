/**
 * Inputs for the persona-result trim, shared by its tests here and the SPA's lockstep test
 * (`frontend/src/assistant/sessions/personaResult.lockstep.test.ts`), which runs both
 * implementations on every input below.
 */

function result(responses: readonly Record<string, string>[]): string {
  return JSON.stringify({ responses });
}

/** Six personas with 4,000-character answers that need escaping, and long avatar URLs. */
export const SIX_LONG_ANSWERS = result(Array.from({ length: 6 }, (_, i) => ({
  persona_id: `p${String(i)}`,
  name: `Persona ${String(i)}`,
  avatar_url: `https://cdn.example/avatars/p${String(i)}.png?Signature=${'s'.repeat(400)}`,
  answer: `Line one "quoted"\n${'word '.repeat(800)}`,
})));

const SHORT = result([{ persona_id: 'p1', name: 'Pat', answer: 'Short.' }]);

export interface PersonaResultCase {
  name: string;
  text: string;
  budget: number;
  /** What the stream Lambda stores (null: not a persona result, trimmed like any tool content). */
  expected: string | null;
}

export const PERSONA_RESULT_CASES: readonly PersonaResultCase[] = [
  { name: 'a result within the budget is kept as is', text: SHORT, budget: 1000, expected: SHORT },
  { name: 'non-JSON is not a persona result', text: 'plain text', budget: 10, expected: null },
  { name: 'other JSON is not a persona result', text: '{"items":[1,2]}', budget: 5, expected: null },
  { name: 'an empty round is not a persona result', text: '{"responses":[]}', budget: 5, expected: null },
  {
    name: 'one long answer is shortened with an ellipsis',
    text: result([{ persona_id: 'p1', name: 'Pat', answer: 'abcdefghijklmnopqrstuvwxyz'.repeat(20) }]),
    budget: 300,
    expected: result([{ persona_id: 'p1', name: 'Pat', answer: `${'abcdefghijklmnopqrstuvwxyz'.repeat(20).slice(0, 239)}…` }]),
  },
  {
    name: 'avatar URLs go first when the answers would get too short',
    text: result([{ persona_id: 'p1', name: 'Pat', avatar_url: `https://cdn.example/${'a'.repeat(300)}`, answer: 'b'.repeat(500) }]),
    budget: 300,
    expected: result([{ persona_id: 'p1', name: 'Pat', answer: `${'b'.repeat(239)}…` }]),
  },
];

/** Every input the lockstep test runs through both implementations: the cases plus the big round at each cap. */
export const PERSONA_RESULT_LOCKSTEP_INPUTS: ReadonlyArray<{ text: string; budget: number }> = [
  ...PERSONA_RESULT_CASES.map(({ text, budget }) => ({ text, budget })),
  ...[32_000, 6000, 1000, 100].map((budget) => ({ text: SIX_LONG_ANSWERS, budget })),
];
