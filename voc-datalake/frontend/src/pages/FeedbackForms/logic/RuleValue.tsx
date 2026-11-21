/**
 * @fileoverview A rule's value control (UX §5.1): one option (a select of the labels, Other and None), several
 * options (removable chips and an "add" select), a score (a select of the scale), or nothing (answered, skipped, a
 * consent's accepted / not accepted). Codes are never shown: options read as their primary-language labels.
 *
 * @module pages/FeedbackForms/logic/RuleValue
 */
import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { FormV2, Question, Rule } from '../model/formsV2'
import { isScale } from '../model/formsV2'
import { opTakesCodes, opTakesValue, ruleCodes, scaleValues, valueCodes } from '../model/rules'
import { codeLabel } from './ruleSentence'
import { scoreLabel } from './ruleControls'

interface ValueProps {
  readonly form: FormV2
  readonly question: Question
  readonly rule: Rule
  /** The select's accessible name ("Rule 1: value"). */
  readonly label: string
  readonly id: string
  readonly describedBy?: string
  readonly controlRef?: Ref<HTMLSelectElement>
  readonly onChange: (rule: Rule) => void
}

const withValue = (rule: Rule, value: Rule['when']['value']): Rule =>
  (value === undefined ? { when: { op: rule.when.op }, then: rule.then } : { when: { op: rule.when.op, value }, then: rule.then })

function ScoreValue({ form, question, rule, label, id, describedBy, controlRef, onChange }: ValueProps) {
  const { t } = useTranslation('feedbackForms')
  const values = scaleValues(question)
  const value = rule.when.value
  return (
    <select id={id} ref={controlRef} aria-label={label} aria-describedby={describedBy} className="select select-sm w-auto"
      value={typeof value === 'number' ? String(value) : ''}
      onChange={(event) => onChange(withValue(rule, event.target.value === '' ? undefined : Number(event.target.value)))}>
      <option value="">{t('logic.chooseNumber')}</option>
      {values.map((score) => <option key={score} value={String(score)}>{scoreLabel(t, form, question, score, values)}</option>)}
    </select>
  )
}

function CodeValue({ form, question, rule, label, id, describedBy, controlRef, onChange }: ValueProps) {
  const { t } = useTranslation('feedbackForms')
  const [code] = valueCodes(rule.when.value)
  const codes = ruleCodes(question)
  const known = code === undefined || codes.includes(code)
  return (
    <select id={id} ref={controlRef} aria-label={label} aria-describedby={describedBy} className="select select-sm w-auto max-w-[16rem]"
      value={code ?? ''} onChange={(event) => onChange(withValue(rule, event.target.value === '' ? undefined : event.target.value))}>
      <option value="">{t('logic.chooseOption')}</option>
      {!known && <option value={code}>{t('logic.removedOption', { code })}</option>}
      {codes.map((c) => <option key={c} value={c}>{codeLabel(t, form, question, c)}</option>)}
    </select>
  )
}

function CodesValue({ form, question, rule, label, id, describedBy, controlRef, onChange }: ValueProps) {
  const { t } = useTranslation('feedbackForms')
  const chosen = valueCodes(rule.when.value)
  const left = ruleCodes(question).filter((code) => !chosen.includes(code))
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chosen.map((code) => {
        const text = codeLabel(t, form, question, code)
        const remove = t('logic.removeValue', { option: text })
        return (
          <span key={code} className="inline-flex items-center gap-0.5 rounded-full border border-border bg-bg-hover px-2 py-0.5 text-[12px] text-text">
            {text}
            <button title={remove} type="button" className="icon-btn p-0.5" aria-label={remove}
              onClick={() => onChange(withValue(rule, chosen.filter((c) => c !== code)))}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )
      })}
      <select id={id} ref={controlRef} aria-label={label} aria-describedby={describedBy} className="select select-sm w-auto max-w-[14rem]" value=""
        onChange={(event) => { if (event.target.value !== '') onChange(withValue(rule, [...chosen, event.target.value])) }}>
        <option value="">{chosen.length === 0 ? t('logic.chooseOptions') : t('logic.addOption')}</option>
        {left.map((code) => <option key={code} value={code}>{codeLabel(t, form, question, code)}</option>)}
      </select>
    </span>
  )
}

/** The value control the rule's operator takes, or nothing. */
export default function RuleValue(props: ValueProps) {
  const { question, rule } = props
  if (!opTakesValue(rule.when.op) || question.type === 'consent') return null
  if (isScale(question)) return <ScoreValue {...props} />
  return opTakesCodes(rule.when.op) ? <CodesValue {...props} /> : <CodeValue {...props} />
}
