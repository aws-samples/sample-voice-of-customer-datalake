/**
 * @fileoverview A labelled row of toggle buttons over a closed list of choices, exactly one pressed
 * (`aria-pressed`). Shared by the Radar news-kind filter and the Connect page's `mcp.json` client picker;
 * each caller keeps its own look through the class props.
 * @module components/PressedChoices
 */

interface PressedChoicesProps<T extends string> {
  readonly label: string
  readonly choices: readonly T[]
  readonly value: T
  readonly onChange: (choice: T) => void
  /** How a choice reads. */
  readonly display: (choice: T) => string
  readonly className: string
  readonly pressedClassName: string
  readonly idleClassName: string
}

export default function PressedChoices<T extends string>({
  label, choices, value, onChange, display, className, pressedClassName, idleClassName,
}: PressedChoicesProps<T>) {
  return (
    <div role="group" aria-label={label} className={className}>
      {choices.map((choice) => (
        <button key={choice} type="button" aria-pressed={value === choice} onClick={() => onChange(choice)}
          className={value === choice ? pressedClassName : idleClassName}>
          {display(choice)}
        </button>
      ))}
    </div>
  )
}
