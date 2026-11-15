/**
 * @fileoverview A labelled radio group over a closed list of choices, exactly one checked (a `<fieldset>` with its
 * `<legend>`, one named group of native radios, so the arrow keys move between them). Shared by a decision's verdict
 * and a repository connection's host; each caller keeps its own look through the class props.
 * @module components/RadioChoices
 */
import { useId } from 'react'

interface RadioChoicesProps<T extends string> {
  readonly legend: string
  readonly choices: readonly T[]
  readonly value: T
  readonly onChange: (choice: T) => void
  /** How a choice reads. */
  readonly display: (choice: T) => string
  readonly legendClassName: string
  readonly rowClassName: string
  readonly labelClassName: string
  readonly inputClassName?: string
}

export default function RadioChoices<T extends string>({
  legend, choices, value, onChange, display, legendClassName, rowClassName, labelClassName, inputClassName,
}: RadioChoicesProps<T>) {
  const name = useId()
  return (
    <fieldset className="space-y-1">
      <legend className={legendClassName}>{legend}</legend>
      <div className={rowClassName}>
        {choices.map((choice) => (
          <label key={choice} className={labelClassName}>
            <input type="radio" className={inputClassName} name={name} value={choice} checked={value === choice}
              onChange={() => onChange(choice)} />
            {display(choice)}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
