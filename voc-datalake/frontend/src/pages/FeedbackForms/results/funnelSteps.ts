/**
 * @fileoverview The drop-off funnel's steps (UX §10.3), with the form's logic in mind: Opened → Started → each question
 * → Completed. A question every path through the form passes is a step of the funnel proper: its count is exact and
 * its drop is measured from the step every path passed before it. A question only some paths show (logic sends the
 * others past it) is shown to fewer people BY DESIGN, so it never carries a drop, nor "largest drop": its count is
 * the people it was shown to (the completed responses that saw it, and those who left at it).
 *
 * The beacon gives, per visit that left, its furthest question (`api/feedbackFormsResultsAdapter.ts` turns that into
 * "reached" = completed + those who left at or after it, which is exact for an every-path question).
 *
 * @module pages/FeedbackForms/results/funnelSteps
 */
import type { FormFunnel, FormResults } from '../../../api/feedbackFormsV2Results'
import type { FormV2 } from '../model/formsV2'
import { formPaths, outcomesOf } from '../model/paths'
import { percentOf } from './scoreMath'

/** The funnel card's heading id: the summary's "largest drop at …" moves the focus to it. */
export const FUNNEL_HEADING_ID = 'results-funnel'

export interface FunnelStep {
  /** 'opened', 'started', 'completed', or the question id. */
  readonly key: string
  /** The question's place in the form (1-based); null for Opened, Started and Completed. */
  readonly number: number | null
  readonly count: number
  /** Every path through the form passes it (Opened, Started and Completed always do). */
  readonly everyPath: boolean
  /** The share lost since the step every path passed before it (null: not an every-path step, or nothing before). */
  readonly dropPercent: number | null
  /** The people lost since that step (0 when none). */
  readonly dropped: number
}

/** How many ways lead from each question to an ending (a reverse walk over the forward-only jumps). */
function waysToAnEnding(form: FormV2): ReadonlyMap<string, number> {
  const ways = new Map<string, number>(form.endings.map((ending) => [ending.id, 1]))
  // (last question first: every jump goes forward, so each target's count is known when a question needs it)
  form.questions.map((question, index) => ({ question, index })).reverse().forEach(({ question, index }) => {
    ways.set(question.id, outcomesOf(form, index).reduce((sum, { target }) => sum + (ways.get(target) ?? 0), 0))
  })
  return ways
}

/** The questions every path from the first question to an ending passes: ways in × ways out = every path. */
export function everyPathQuestions(form: FormV2): ReadonlySet<string> {
  const paths = formPaths(form)
  if (paths.total === 0) return new Set()
  const out = waysToAnEnding(form)
  return new Set(form.questions
    .filter((question) => (paths.questionWays.get(question.id) ?? 0) * (out.get(question.id) ?? 0) === paths.total)
    .map((question) => question.id))
}

/** Who saw a question only some paths show: the completed responses it was shown to, and those who left at it. */
function shownTo(results: FormResults, funnel: FormFunnel, index: number): number {
  const step = funnel.steps[index]
  if (step === undefined) return 0
  const leftHere = step.reached - (funnel.steps[index + 1]?.reached ?? funnel.completed)
  const aggregate = results.questions[step.question_id]
  return Math.max(leftHere, 0) + (aggregate === undefined ? 0 : aggregate.answered + aggregate.skipped)
}

/** The funnel's steps in order, each with its drop when it is an every-path step. */
export function funnelSteps(form: FormV2, funnel: FormFunnel, results: FormResults): FunnelStep[] {
  const onEvery = everyPathQuestions(form)
  const raw = [
    { key: 'opened', number: null, count: funnel.opened, everyPath: true },
    { key: 'started', number: null, count: funnel.started, everyPath: true },
    ...funnel.steps.map((step, index) => {
      const at = form.questions.findIndex((question) => question.id === step.question_id)
      const everyPath = onEvery.has(step.question_id)
      return { key: step.question_id, number: at === -1 ? null : at + 1, everyPath, count: everyPath ? step.reached : shownTo(results, funnel, index) }
    }),
    { key: 'completed', number: null, count: funnel.completed, everyPath: true },
  ]
  return raw.map((step, index) => {
    // (measured from the every-path step before it: a question only some paths show is stepped over)
    const previous = raw.slice(0, index).filter((earlier) => earlier.everyPath).at(-1)?.count
    if (!step.everyPath || previous === undefined || previous === 0) return { ...step, dropPercent: null, dropped: 0 }
    const dropped = Math.max(previous - step.count, 0)
    return { ...step, dropped, dropPercent: percentOf(dropped, previous) }
  })
}

/** The index of the every-path step that lost the most people (null: none lost any). */
export function largestDrop(steps: readonly FunnelStep[]): number | null {
  const worst = Math.max(0, ...steps.map((step) => step.dropped))
  return worst === 0 ? null : steps.findIndex((step) => step.dropped === worst)
}
