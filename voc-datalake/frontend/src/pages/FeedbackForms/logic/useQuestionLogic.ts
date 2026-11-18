/**
 * @fileoverview One question's logic as the Logic section and the Flow outline edit it: its own rules and its
 * Otherwise (read with `splitOtherwise`, written back with `withLogic`, UX §5.3), their problems (§5.5), and the
 * edits both views make (add, change, move, duplicate, delete a rule; set the Otherwise).
 *
 * @module pages/FeedbackForms/logic/useQuestionLogic
 */
import { useMemo } from 'react'
import { useDraft } from '../builder/formDraftContext'
import type { FormV2, Question, Rule } from '../model/formsV2'
import { moved, updateQuestion } from '../model/mutations'
import { defaultOp, splitOtherwise, withLogic } from '../model/rules'
import { ruleProblems } from '../model/ruleProblems'
import type { RuleProblem } from '../model/ruleProblems'
import { fallthroughTarget } from '../model/paths'

export interface QuestionLogic {
  readonly form: FormV2
  readonly question: Question
  readonly index: number
  readonly rules: readonly Rule[]
  readonly otherwise: string | null
  /** Every problem of the question's logic, by its index in the stored logic (the Otherwise's come last). */
  readonly problems: readonly RuleProblem[]
  readonly setRule: (at: number, rule: Rule) => void
  /** Add a rule with the type's most likely operator and no value; resolves to its index. */
  readonly addRule: () => number
  readonly moveRule: (at: number, to: number) => void
  readonly duplicateRule: (at: number) => void
  readonly deleteRule: (at: number) => void
  readonly setOtherwise: (target: string | null) => void
}

/** A new rule's first target: the question after the next, else the next one, else the default ending. */
function firstTarget(form: FormV2, index: number): string {
  return form.questions[index + 2]?.id ?? fallthroughTarget(form, index) ?? ''
}

/** The logic of the question `questionId` in the draft; null when the draft has no such question. */
export function useQuestionLogic(questionId: string): QuestionLogic | null {
  const draft = useDraft()
  const { form, update } = draft
  const index = form.questions.findIndex((q) => q.id === questionId)
  const question = form.questions[index]
  const split = useMemo(() => (question === undefined ? null : splitOtherwise(question)), [question])
  const problems = useMemo(() => (index === -1 ? [] : ruleProblems(form, index)), [form, index])
  if (question === undefined || split === null) return null
  const { rules, otherwise } = split
  const write = (nextRules: readonly Rule[], nextOtherwise: string | null) => update((current) =>
    updateQuestion(current, questionId, (q) => withLogic(q, nextRules, nextOtherwise)))
  return {
    form, question, index, rules, otherwise, problems,
    setRule: (at, rule) => write(rules.map((current, i) => (i === at ? rule : current)), otherwise),
    addRule: () => {
      write([...rules, { when: { op: defaultOp(question) }, then: { jump_to: firstTarget(form, index) } }], otherwise)
      return rules.length
    },
    moveRule: (at, to) => write(moved(rules, at, to), otherwise),
    duplicateRule: (at) => {
      const rule = rules[at]
      if (rule !== undefined) write([...rules.slice(0, at + 1), rule, ...rules.slice(at + 1)], otherwise)
    },
    deleteRule: (at) => write(rules.filter((_rule, i) => i !== at), otherwise),
    setOtherwise: (target) => write(rules, target),
  }
}
