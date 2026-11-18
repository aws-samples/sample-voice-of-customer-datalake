/**
 * @fileoverview The form's paths (UX §5.4): every route through the questions that first-matching rules can take,
 * from the first question to an ending. Jumps only go forward, so the questions are a DAG in form order and the
 * counts come from one pass: how many paths reach each question and each ending, and the shortest and longest path
 * in questions. A rule whose target is missing or earlier (an error the Logic section shows) is left out.
 *
 * @module pages/FeedbackForms/model/paths
 */
import type { FormV2, Question } from './formsV2'
import { matchesEverything } from './rules'

/** Where a question can send a respondent: a later question, or an ending. */
export interface Outcome {
  /** The question id or ending id. */
  readonly target: string
  /** The rule index that jumps there, or null for "no rule matched" (the next question, or the default ending). */
  readonly ruleIndex: number | null
}

export interface FormPaths {
  /** How many paths reach each question (0: no path does). */
  readonly questionWays: ReadonlyMap<string, number>
  /** How many paths end at each ending. */
  readonly endingWays: ReadonlyMap<string, number>
  readonly total: number
  /** The shortest and longest path, in questions answered (0 when the form has none). */
  readonly shortest: number
  readonly longest: number
}

/** The target a question falls through to when no rule matches: the next question, else the default ending. */
export function fallthroughTarget(form: FormV2, index: number): string | null {
  return form.questions[index + 1]?.id ?? form.endings[0]?.id ?? null
}

/** Is `target` a valid jump from the question at `index` (a later question, or an ending)? */
function isForwardTarget(form: FormV2, index: number, target: string): boolean {
  const at = form.questions.findIndex((question) => question.id === target)
  return at > index || (at === -1 && form.endings.some((ending) => ending.id === target))
}

/** Where the question at `index` can send a respondent, each target once, in rule order then the fall-through. */
export function outcomesOf(form: FormV2, index: number): Outcome[] {
  const question: Question | undefined = form.questions[index]
  if (question === undefined) return []
  const logic = question.logic ?? []
  const stop = logic.findIndex((rule, at) => matchesEverything(question, rule, logic[at + 1]))
  // (an Otherwise pair, submitted + skipped, ends at its second rule)
  const pairExtra = logic[stop + 1]?.when.op === 'skipped' ? 1 : 0
  const considered = stop === -1 ? logic : logic.slice(0, stop + pairExtra + 1)
  const seen = new Set<string>()
  const outcomes: Outcome[] = []
  considered.forEach((rule, ruleIndex) => {
    const target = rule.then.jump_to
    if (!isForwardTarget(form, index, target) || seen.has(target)) return
    seen.add(target)
    outcomes.push({ target, ruleIndex })
  })
  const fallthrough = fallthroughTarget(form, index)
  if (stop === -1 && fallthrough !== null && !seen.has(fallthrough)) outcomes.push({ target: fallthrough, ruleIndex: null })
  return outcomes
}

interface Walk {
  readonly ways: Map<string, number>
  readonly shortest: Map<string, number>
  readonly longest: Map<string, number>
}

function add(walk: Walk, target: string, ways: number, lengths: { readonly shortest: number; readonly longest: number }): void {
  walk.ways.set(target, (walk.ways.get(target) ?? 0) + ways)
  walk.shortest.set(target, Math.min(walk.shortest.get(target) ?? Infinity, lengths.shortest))
  walk.longest.set(target, Math.max(walk.longest.get(target) ?? 0, lengths.longest))
}

/** Every path's count and length, from the first question (the welcome card routes nowhere). */
export function formPaths(form: FormV2): FormPaths {
  const walk: Walk = { ways: new Map(), shortest: new Map(), longest: new Map() }
  const first = form.questions[0]
  if (first !== undefined) add(walk, first.id, 1, { shortest: 1, longest: 1 })
  form.questions.forEach((question, index) => {
    const ways = walk.ways.get(question.id) ?? 0
    if (ways === 0) return
    const shortest = walk.shortest.get(question.id) ?? 0
    const longest = walk.longest.get(question.id) ?? 0
    for (const { target } of outcomesOf(form, index)) {
      // (an ending's length is the questions answered before it: this question's own)
      const step = form.questions.some((other) => other.id === target) ? 1 : 0
      add(walk, target, ways, { shortest: shortest + step, longest: longest + step })
    }
  })
  const endingWays = new Map(form.endings.map((ending) => [ending.id, walk.ways.get(ending.id) ?? 0]))
  const reached = form.endings.filter((ending) => (endingWays.get(ending.id) ?? 0) > 0)
  return {
    questionWays: new Map(form.questions.map((question) => [question.id, walk.ways.get(question.id) ?? 0])),
    endingWays,
    total: [...endingWays.values()].reduce((sum, count) => sum + count, 0),
    shortest: reached.length === 0 ? 0 : Math.min(...reached.map((ending) => walk.shortest.get(ending.id) ?? 0)),
    longest: reached.length === 0 ? 0 : Math.max(...reached.map((ending) => walk.longest.get(ending.id) ?? 0)),
  }
}

/** One way into a target: from which question, by which rule (null: no rule matched). */
export interface Arrival {
  readonly questionId: string
  readonly ruleIndex: number | null
}

/** Every way into `target` (a question or an ending): the reverse of the Flow outline (UX §7 "Reached by"). */
export function arrivalsAt(form: FormV2, target: string): Arrival[] {
  return form.questions.flatMap((question, index) => outcomesOf(form, index)
    .filter((outcome) => outcome.target === target)
    .map((outcome) => ({ questionId: question.id, ruleIndex: outcome.ruleIndex })))
}

/** The picker's estimate (UX §2.2): the longest path × 10 s, rounded up to whole minutes (at least 1). */
export function minutesToAnswer(form: FormV2): number {
  return Math.max(1, Math.ceil((formPaths(form).longest * 10) / 60))
}
