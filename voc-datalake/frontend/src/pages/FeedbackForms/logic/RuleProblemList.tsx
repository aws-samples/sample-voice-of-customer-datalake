/**
 * @fileoverview A rule's problems under its row (UX §5.5), each with an icon and words: an error (`text-danger`,
 * CircleX), a warning (`text-warn`, AlertTriangle) or a note (`text-muted`).
 *
 * @module pages/FeedbackForms/logic/RuleProblemList
 */
import { createElement } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertTriangle, CircleX, Info } from 'lucide-react'
import type { RuleProblem } from '../model/ruleProblems'

const TONES = {
  error: { Icon: CircleX, className: 'text-danger' },
  warning: { Icon: AlertTriangle, className: 'text-warn' },
  note: { Icon: Info, className: 'text-muted' },
} as const

function ProblemRow({ problem }: Readonly<{ problem: RuleProblem }>) {
  const { t } = useTranslation('feedbackForms')
  const { Icon, className } = TONES[problem.severity]
  return (
    <li className={clsx('flex items-start gap-1.5 text-[12px]', className)}>
      {createElement(Icon, { size: 13, className: 'mt-0.5 shrink-0', 'aria-hidden': true })}
      <span>{t(`problems.${problem.code}`, problem.params)}</span>
    </li>
  )
}

export default function RuleProblemList({ problems, id }: Readonly<{ problems: readonly RuleProblem[]; id?: string }>) {
  return problems.length === 0 ? null : (
    <ul id={id} className="mt-1 space-y-0.5">
      {problems.map((problem) => <ProblemRow key={`${problem.code}-${String(problem.ruleIndex)}`} problem={problem} />)}
    </ul>
  )
}
