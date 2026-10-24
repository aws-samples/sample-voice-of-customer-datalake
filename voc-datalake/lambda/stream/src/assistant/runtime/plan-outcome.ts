/**
 * What the model reads after the user approves a proposed plan.
 *
 * The SPA answers `propose_plan` with `{status: 'executed', summary, data: {plan_id}}`
 * once `POST /agents/plans` accepted the plan. On its own that left the model
 * with nothing to report and a rule not to claim a step finished, so it answered
 * "I haven't seen any results yet. Ask me to check…" — while the plan card above
 * it was already updating by itself. The stream owns this sentence (not the SPA)
 * so every client gets it: the plan IS running, the card shows each step's result
 * as it finishes, and the assistant can summarise the results when asked.
 *
 * @module assistant/runtime/plan-outcome
 */

/** The tool whose approved outcome is annotated. */
const PROPOSE_PLAN = 'propose_plan';

export const PLAN_APPROVED_NEXT = 'The plan is approved and now running in the background. Reply in one or two '
  + 'sentences: say it is running, and that the plan card above shows each step\u2019s result by itself as that step '
  + 'finishes, so the user does not need to ask you to check. Offer to summarise the results when they are in '
  + '(get_plan reads them). Do not say you have not seen any results, do not ask the user to ask you to check, and '
  + 'do not claim any step finished.';

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

/**
 * The tool-result text for `toolName`: an executed `propose_plan` outcome gains a
 * `next` field telling the model what to say; every other result is unchanged.
 */
export function annotatePlanOutcome(toolName: string, text: string): string {
  if (toolName !== PROPOSE_PLAN) return text;
  const outcome = parseRecord(text);
  if (outcome?.status !== 'executed') return text;
  return JSON.stringify({ ...outcome, next: PLAN_APPROVED_NEXT });
}
