/**
 * @fileoverview A persona-cards tool result (`consult_personas`, the persona round) as it is saved.
 *
 * Saved tool contents are cut to a character cap, and a plain cut of this JSON
 * (`{"responses":[{persona_id,name,avatar_url?,answer}]}`) left invalid JSON: the
 * cards vanished after a reload. The answers are shortened evenly instead, within
 * a larger cap of their own, so the saved text always parses.
 *
 * LOCKSTEP with the stream Lambda's `session/persona-result.ts` (both write the
 * same session): `personaResult.lockstep.test.ts` runs the two on the same inputs.
 *
 * @module assistant/sessions/personaResult
 */
import { z } from 'zod'
import { isRecord } from '../../lib/typeGuards'
import { jsonOrUndefined } from '../parseJson'

export const MAX_STORED_PERSONA_CHARS = 32_000
export const MAX_RETRY_PERSONA_CHARS = 6_000
/** Below this many characters per answer, avatar URLs are dropped first (the card shows an icon). */
const MIN_ANSWER_CHARS = 200
const ELLIPSIS = '…'

const envelopeSchema = z.object({ responses: z.array(z.object({ persona_id: z.string(), answer: z.string() })).min(1) })

type Row = Record<string, unknown> & { answer: string }

interface Parsed {
  envelope: Record<string, unknown>
  rows: Row[]
}

function readRows(text: string): Parsed | null {
  const value = jsonOrUndefined(text)
  if (!envelopeSchema.safeParse(value).success || !isRecord(value) || !Array.isArray(value.responses)) return null
  const list: unknown[] = value.responses
  const rows = list.flatMap((row): Row[] => (isRecord(row) && typeof row.answer === 'string' ? [{ ...row, answer: row.answer }] : []))
  return { envelope: value, rows }
}

function encode(parsed: Parsed, rows: readonly Row[]): string {
  return JSON.stringify({ ...parsed.envelope, responses: rows })
}

/** The per-answer room left by `rows` (answers emptied) within `budget`. */
function roomPerAnswer(parsed: Parsed, rows: readonly Row[], budget: number): number {
  const skeleton = encode(parsed, rows.map((row) => ({ ...row, answer: '' }))).length
  return Math.floor((budget - skeleton) / rows.length)
}

/** Characters `text` takes inside a JSON string literal. */
function jsonLength(text: string): number {
  return JSON.stringify(text).length - 2
}

/** The prefix of `answer` ending at `end` or earlier whose escaped form plus the ellipsis fits `room`. */
function prefixFitting(answer: string, end: number, room: number): string {
  if (end <= 0) return ''
  const over = jsonLength(answer.slice(0, end)) + ELLIPSIS.length - room
  // Each step drops at least the overshoot; escapes make it a few steps at most.
  return over <= 0 ? answer.slice(0, end) + ELLIPSIS : prefixFitting(answer, end - Math.max(1, over), room)
}

/** The longest prefix of `answer` whose escaped form plus the ellipsis fits `room`. */
function shorten(answer: string, room: number): string {
  if (jsonLength(answer) <= room) return answer
  if (room <= ELLIPSIS.length) return ''
  return prefixFitting(answer, Math.min(answer.length, room - ELLIPSIS.length), room)
}

/**
 * `text` saved within `budget` characters when it is a persona result, else null (cut it like
 * any tool content). Always valid JSON; over `budget` only when names and ids alone exceed it.
 */
export function storedPersonaResult(text: string, budget: number): string | null {
  const parsed = readRows(text)
  if (parsed === null) return null
  if (text.length <= budget) return text
  const rows = roomPerAnswer(parsed, parsed.rows, budget) < MIN_ANSWER_CHARS
    ? parsed.rows.map((row): Row => ({ ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'avatar_url')), answer: row.answer }))
    : parsed.rows
  const room = Math.max(0, roomPerAnswer(parsed, rows, budget))
  return encode(parsed, rows.map((row) => ({ ...row, answer: shorten(row.answer, room) })))
}
