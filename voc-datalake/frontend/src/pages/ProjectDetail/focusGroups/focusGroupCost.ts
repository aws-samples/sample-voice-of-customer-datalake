/**
 * @fileoverview What a focus group costs before it starts (docs/project-workspace.md → Persona focus groups): the
 * model calls on the assistant's chat model and roughly how many tokens they read and write. A dollar figure is not
 * shown: the prices are the deployment's Bedrock list prices, which this app does not hold (lambda/shared/model_prices.py
 * records none it could not read), and a guess would read as a quote.
 *
 * Every persona answers once a round (its profile, its evidence pack and, from round 2, the others' digest: about
 * 3,000 tokens read, 600 written); the moderator asks once before rounds 2 and 3; the synthesis reads every round.
 *
 * @module pages/ProjectDetail/focusGroups/focusGroupCost
 */

const PERSONA_INPUT = 3_000
const PERSONA_OUTPUT = 600
const MODERATOR_INPUT = 1_500
const MODERATOR_OUTPUT = 50
const SYNTHESIS_BASE_INPUT = 1_000
const SYNTHESIS_INPUT_PER_ANSWER = 500
const SYNTHESIS_OUTPUT = 800
/** Estimates are rounded to this, so they never read as exact. */
const ROUNDING = 1_000

interface FocusGroupCost {
  calls: number
  inputTokens: number
  outputTokens: number
}

function rounded(tokens: number): number {
  return Math.max(ROUNDING, Math.round(tokens / ROUNDING) * ROUNDING)
}

export function focusGroupCost(personas: number, rounds: number): FocusGroupCost {
  const answers = personas * rounds
  const moderated = Math.max(0, rounds - 1)
  return {
    calls: answers + moderated + 1,
    inputTokens: rounded(answers * PERSONA_INPUT + moderated * MODERATOR_INPUT + SYNTHESIS_BASE_INPUT
      + answers * SYNTHESIS_INPUT_PER_ANSWER),
    outputTokens: rounded(answers * PERSONA_OUTPUT + moderated * MODERATOR_OUTPUT + SYNTHESIS_OUTPUT),
  }
}
