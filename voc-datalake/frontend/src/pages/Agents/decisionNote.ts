/**
 * @fileoverview The note a human's decision sends to the next revision step
 * (the conductor appends it to the revision brief as "Note from a human: …"):
 * the persona objections they ticked, one per line with the persona's name,
 * then their own instructions. Pure, so the form and its tests share it.
 *
 * @module pages/Agents/decisionNote
 */
import { MAX_DECISION_NOTE_CHARS } from '../../api/agentRunDecision'
import type { RunVerdict } from '../../api/agentRunDecision'

/** One objection a persona raised, addressable by a stable key (`{verdict}:{objection}` indexes). */
export interface PickableObjection {
  key: string
  persona: string
  text: string
  blocking: boolean
}

/** One persona's objections, for a heading per persona. */
export interface PersonaObjections {
  persona: string
  blocking: boolean
  objections: PickableObjection[]
}

/** The objections grouped by the verdict they came from (two personas may share a name). */
export function objectionsByPersona(verdicts: readonly RunVerdict[]): PersonaObjections[] {
  const all = objectionsOf(verdicts)
  return verdicts
    .map((verdict, v) => ({
      persona: verdict.name, blocking: verdict.blocking,
      objections: all.filter((o) => o.key.startsWith(`${v}:`)),
    }))
    .filter((group) => group.objections.length > 0)
}

/** Every objection of every verdict, in panel order. */
export function objectionsOf(verdicts: readonly RunVerdict[]): PickableObjection[] {
  return verdicts.flatMap((verdict, v) => verdict.objections.map((text, o) => ({
    key: `${v}:${o}`, persona: verdict.name, text, blocking: verdict.blocking,
  })))
}

/** The keys ticked by default: every objection of a blocking persona. */
export function blockingKeys(objections: readonly PickableObjection[]): Set<string> {
  return new Set(objections.filter((o) => o.blocking).map((o) => o.key))
}

/**
 * "Fix these objections:" + one "- {persona}: {objection}" line per ticked
 * objection, then the human's own instructions — capped at the server's note
 * limit (cut at the end, so the ticked objections, which come first, survive).
 */
export function buildDecisionNote(picked: readonly PickableObjection[], instructions: string): string {
  const parts: string[] = []
  if (picked.length > 0) parts.push(['Fix these objections:', ...picked.map((o) => `- ${o.persona}: ${o.text}`)].join('\n'))
  const own = instructions.trim()
  if (own !== '') parts.push(own)
  return parts.join('\n\n').slice(0, MAX_DECISION_NOTE_CHARS)
}
