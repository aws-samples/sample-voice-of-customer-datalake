/**
 * @fileoverview One rule as a sentence of controls (UX §5.2): "If the answer [operator ▾] [value] → go to [target ▾]
 * [⋯]", each control named by an sr-only "Rule 1: operator / value / go to", its §5.5 problems under it. ⋯ moves,
 * duplicates or deletes it; Alt+Shift+↑/↓ moves the focused rule.
 *
 * @module pages/FeedbackForms/logic/RuleRow
 */
import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react'
import ActionsMenu from '../ui/ActionsMenu'
import type { Rule } from '../model/formsV2'
import type { QuestionLogic } from './useQuestionLogic'
import { choiceKey, opChoices, targetGroups, withChoice } from './ruleControls'
import RuleValue from './RuleValue'
import TargetSelect from './TargetSelect'
import RuleProblemList from './RuleProblemList'

export type RuleFocus = 'operator' | 'value'

export interface RuleRowProps {
  readonly logic: QuestionLogic
  /** The rule's index among the question's own rules. */
  readonly at: number
  /** Focus a control once (a rule just added focuses its value; a moved one its operator). */
  readonly focus: RuleFocus | null
  readonly onFocused: () => void
  /** Move the rule to `to` (the parent announces it and focuses it there). */
  readonly onMove: (to: number) => void
}

export default function RuleRow({ logic, at, focus, onFocused, onMove }: RuleRowProps) {
  const { t } = useTranslation('feedbackForms')
  const base = useId()
  const operatorRef = useRef<HTMLSelectElement>(null)
  const valueRef = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (focus === null) return
    const target = focus === 'value' ? valueRef.current ?? operatorRef.current : operatorRef.current
    target?.focus()
    onFocused()
  }, [focus, onFocused])
  const { form, question, index, rules } = logic
  const rule = rules[at]
  if (rule === undefined) return null
  const number = at + 1
  const problems = logic.problems.filter((problem) => problem.ruleIndex === at)
  const problemsId = problems.length > 0 ? `${base}-problems` : undefined
  const choices = opChoices(t, question)
  const change = (next: Rule) => logic.setRule(at, next)
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (!event.altKey || !event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const to = event.key === 'ArrowUp' ? at - 1 : at + 1
    if (to >= 0 && to < rules.length) onMove(to)
  }
  return (
    <li onKeyDown={onKeyDown} className="rounded-md border border-border bg-card p-2" data-testid={`rule-${String(number)}`}>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text">
        <span className="w-5 font-mono text-[12px] text-muted" aria-hidden="true">{number}</span>
        <span>{t('logic.ifTheAnswer')}</span>
        <select id={`${base}-op`} ref={operatorRef} aria-label={t('logic.controls.operator', { number })}
          aria-describedby={problemsId} className="select select-sm w-auto" value={choiceKey(question, rule)}
          onChange={(event) => {
            const choice = choices.find((c) => c.key === event.target.value)
            if (choice !== undefined) change(withChoice(question, rule, choice))
          }}>
          {choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
        </select>
        <RuleValue form={form} question={question} rule={rule} id={`${base}-value`} label={t('logic.controls.value', { number })}
          describedBy={problemsId} controlRef={valueRef} onChange={change} />
        <span>{t('logic.goTo')}</span>
        <TargetSelect id={`${base}-target`} label={t('logic.controls.goTo', { number })} value={rule.then.jump_to}
          describedBy={problemsId} groups={targetGroups(t, form, index, rule.then.jump_to)}
          onChange={(target) => change({ ...rule, then: { jump_to: target } })} />
        <ActionsMenu label={t('logic.actions.label', { number })} className="ml-auto" items={[
          { label: t('logic.actions.moveUp'), icon: ArrowUp, onSelect: () => onMove(at - 1), disabledReason: at === 0 ? t('logic.actions.first') : undefined },
          { label: t('logic.actions.moveDown'), icon: ArrowDown, onSelect: () => onMove(at + 1), disabledReason: at === rules.length - 1 ? t('logic.actions.last') : undefined },
          { label: t('logic.actions.duplicate'), icon: Copy, onSelect: () => logic.duplicateRule(at) },
          null,
          { label: t('logic.actions.delete'), icon: Trash2, danger: true, onSelect: () => logic.deleteRule(at) },
        ]} />
      </div>
      <RuleProblemList problems={problems} id={problemsId} />
    </li>
  )
}
