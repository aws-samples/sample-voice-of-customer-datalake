/**
 * @fileoverview The forms builder's problem lines under what they are about (a field: questions/fields.tsx
 * `FieldProblems`; a rule: logic/RuleProblemList.tsx), linked to it by `id` (`aria-describedby`): each an icon and its
 * words at 12 px, its tone given by the caller. Nothing when there is none.
 *
 * @module pages/FeedbackForms/ui/ProblemLines
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface ProblemLine {
  readonly key: string
  /** The line's tone and spacing (`gap-1 text-danger`). */
  readonly className: string
  readonly icon: ReactNode
  readonly text: string
}

export default function ProblemLines({ id, lines }: Readonly<{ id?: string; lines: readonly ProblemLine[] }>) {
  if (lines.length === 0) return null
  return (
    <ul id={id} className="mt-1 space-y-0.5">
      {lines.map((line) => (
        <li key={line.key} className={clsx('flex items-start text-[12px]', line.className)}>
          {line.icon}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  )
}
