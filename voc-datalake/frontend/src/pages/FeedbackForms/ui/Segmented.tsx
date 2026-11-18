/**
 * @fileoverview A segmented control (the design system's `tabs-track` recipe as toggle buttons, `aria-pressed`): Phone
 * | Desktop, Labels | Routing, Show as, Live | Test, Runs. A choice that is off keeps focus and says why in its
 * Tooltip and in the caller's visible hint (`aria-disabled`).
 *
 * @module pages/FeedbackForms/ui/Segmented
 */
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import { Tooltip } from '../../../components/Tooltip/Tooltip'

export interface SegmentedChoice<T extends string> {
  readonly value: T
  readonly label: string
  readonly icon?: LucideIcon
  /** Why the choice can't be picked; undefined: it can. */
  readonly disabledReason?: string
}

export default function Segmented<T extends string>({ label, choices, value, onChange }: Readonly<{
  /** The group's accessible name. */
  label: string
  choices: readonly SegmentedChoice<T>[]
  value: T
  onChange: (value: T) => void
}>) {
  return (
    <div role="group" aria-label={label} className="tabs-track inline-flex flex-wrap">
      {choices.map((choice) => (
        <Tooltip key={choice.value} kind="description" content={choice.disabledReason}>
          <button type="button" aria-pressed={choice.value === value}
            aria-disabled={choice.disabledReason === undefined ? undefined : true}
            className={clsx('tab', choice.value === value && 'tab-active', choice.disabledReason !== undefined && 'opacity-50')}
            onClick={() => { if (choice.disabledReason === undefined) onChange(choice.value) }}>
            {choice.icon !== undefined && <choice.icon size={14} aria-hidden="true" />}
            {choice.label}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
