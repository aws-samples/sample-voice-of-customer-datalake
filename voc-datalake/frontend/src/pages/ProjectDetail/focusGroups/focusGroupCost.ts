/**
 * @fileoverview What a focus group costs before it starts (docs/project-workspace.md → Persona focus groups): the
 * model calls on the assistant's chat model and roughly how many tokens they read and write. A dollar figure is not
 * shown: the prices are the deployment's Bedrock list prices, which this app does not hold (lambda/shared/model_prices.py
 * records none it could not read), and a guess would read as a quote.
 *
 * Every persona answers once a round (its profile, its evidence pack and, from round 2, the others' digest: about
 * 3,000 tokens read, 600 written, plus what it reads of the chosen documents and Library items: `readingChars`); the
 * moderator asks once before rounds 2 and 3; the synthesis reads every round.
 *
 * @module pages/ProjectDetail/focusGroups/focusGroupCost
 */
import { PERSONA_READING_CHARS } from '@stream/assistant/contract'

const PERSONA_INPUT = 3_000
const PERSONA_OUTPUT = 600
const MODERATOR_INPUT = 1_500
const MODERATOR_OUTPUT = 50
const SYNTHESIS_BASE_INPUT = 1_000
const SYNTHESIS_INPUT_PER_ANSWER = 500
const SYNTHESIS_OUTPUT = 800
/** Estimates are rounded to this, so they never read as exact. */
const ROUNDING = 1_000
/** About this many characters a token (English prose; the estimate's only conversion). */
const CHARS_PER_TOKEN = 4

interface FocusGroupCost {
  calls: number
  inputTokens: number
  outputTokens: number
}

function rounded(tokens: number): number {
  return Math.max(ROUNDING, Math.round(tokens / ROUNDING) * ROUNDING)
}

/**
 * The characters of reading every persona call carries, as the stream bounds them: the chosen documents' text, each
 * within an equal share of `PERSONA_READING_CHARS.documents`, and the chosen Library items' extracted text within
 * `PERSONA_READING_CHARS.library` (their best passages for the topic, at most that).
 */
export function readingChars(documentChars: readonly number[], libraryChars: readonly number[]): number {
  const share = documentChars.length === 0 ? 0 : Math.floor(PERSONA_READING_CHARS.documents / documentChars.length)
  const documents = documentChars.reduce((sum, chars) => sum + Math.min(Math.max(0, chars), share), 0)
  const library = Math.min(PERSONA_READING_CHARS.library, libraryChars.reduce((sum, chars) => sum + Math.max(0, chars), 0))
  return documents + library
}

export function focusGroupCost(personas: number, rounds: number, reading = 0): FocusGroupCost {
  const answers = personas * rounds
  const moderated = Math.max(0, rounds - 1)
  const perAnswer = PERSONA_INPUT + Math.ceil(Math.max(0, reading) / CHARS_PER_TOKEN)
  return {
    calls: answers + moderated + 1,
    inputTokens: rounded(answers * perAnswer + moderated * MODERATOR_INPUT + SYNTHESIS_BASE_INPUT
      + answers * SYNTHESIS_INPUT_PER_ANSWER),
    outputTokens: rounded(answers * PERSONA_OUTPUT + moderated * MODERATOR_OUTPUT + SYNTHESIS_OUTPUT),
  }
}
