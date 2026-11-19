/**
 * @fileoverview The Otherwise line (UX §5.2), always there under a question's rules: where everyone goes whom no rule
 * sent elsewhere. Its default is "Next question: n", or "End: <the default ending>" on the last question; a
 * statement reads it as "Then go to". Stored as the trailing `submitted` (+ `skipped`) rules (UX §5.3).
 *
 * @module pages/FeedbackForms/logic/OtherwiseRow
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuestionLogic } from './useQuestionLogic'
import { fallthroughTarget } from '../model/paths'
import { fallthroughLabel, otherwiseValue, targetGroups } from './ruleControls'
import TargetSelect from './TargetSelect'
import RuleProblemList from './RuleProblemList'

export default function OtherwiseRow({ logic }: Readonly<{ logic: QuestionLogic }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const { form, question, index, rules, otherwise } = logic
  const statement = question.type === 'statement'
  const skip = fallthroughTarget(form, index)
  const value = otherwiseValue(form, index, otherwise)
  const problems = logic.problems.filter((problem) => problem.ruleIndex >= rules.length)
  const label = statement ? t('logic.thenGoTo') : t('logic.otherwise')
  return (
    <div className="rounded-md border border-dashed border-border p-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text">
        <span className="pl-7">{label}</span>
        <span aria-hidden="true">→</span>
        <TargetSelect id={id} label={label} value={value}
          first={{ value: '', label: fallthroughLabel(t, form, index) }}
          groups={targetGroups(t, form, index, value === '' ? null : value, skip)}
          onChange={(target) => logic.setOtherwise(target === '' ? null : target)} />
      </div>
      <RuleProblemList problems={problems} />
    </div>
  )
}
