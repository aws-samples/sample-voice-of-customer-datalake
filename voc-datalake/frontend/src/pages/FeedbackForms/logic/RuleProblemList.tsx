/**
 * @fileoverview A rule's problems under its row (UX §5.5), each with an icon and words: an error (`text-danger`,
 * CircleX), a warning (`text-warn`, AlertTriangle) or a note (`text-muted`).
 *
 * @module pages/FeedbackForms/logic/RuleProblemList
 */
import { createElement } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleX, Info } from 'lucide-react'
import type { RuleProblem } from '../model/ruleProblems'
import ProblemLines from '../ui/ProblemLines'

const TONES = {
  error: { Icon: CircleX, className: 'text-danger' },
  warning: { Icon: AlertTriangle, className: 'text-warn' },
  note: { Icon: Info, className: 'text-muted' },
} as const

export default function RuleProblemList({ problems, id }: Readonly<{ problems: readonly RuleProblem[]; id?: string }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <ProblemLines id={id} lines={problems.map((problem) => {
      const { Icon, className } = TONES[problem.severity]
      return {
        key: `${problem.code}-${String(problem.ruleIndex)}`, className: `gap-1.5 ${className}`,
        icon: createElement(Icon, { size: 13, className: 'mt-0.5 shrink-0', 'aria-hidden': true }),
        text: t(`problems.${problem.code}`, problem.params),
      }
    })} />
  )
}
