/**
 * @fileoverview A labelled `<select>` over a closed list of choices with a "none" first option
 * (empty value = `null`, e.g. "Any sentiment", "Auto"). The choice is typed: a value off the list
 * reads as none, through the list's own type guard, never an assertion. Shared by the Radar
 * reviews' sentiment filter and a Radar brand's search language.
 * @module components/ChoiceSelect
 */
import { useId } from 'react'

interface ChoiceSelectProps<T extends string> {
  readonly label: string
  /** The first option, standing for no choice. */
  readonly noneLabel: string
  readonly choices: readonly T[]
  readonly value: T | null
  readonly isChoice: (value: string) => value is T
  /** How a choice reads. */
  readonly display: (choice: T) => string
  readonly onChange: (value: T | null) => void
  readonly className?: string
}

export default function ChoiceSelect<T extends string>({
  label, noneLabel, choices, value, isChoice, display, onChange, className = 'select w-auto',
}: ChoiceSelectProps<T>) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{label}</label>
      <select id={id} className={className} value={value ?? ''} onChange={(e) => onChange(isChoice(e.target.value) ? e.target.value : null)}>
        <option value="">{noneLabel}</option>
        {choices.map((choice) => <option key={choice} value={choice}>{display(choice)}</option>)}
      </select>
    </div>
  )
}
