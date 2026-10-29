/**
 * @fileoverview One bordered radio option with a title and a hint line, accent-filled when chosen.
 *
 * Shared by the choices that read as cards rather than bare radios (reprocess mode,
 * persona generation's add-or-replace). The parent supplies the fieldset and legend.
 *
 * @module components/RadioCard
 */
import clsx from 'clsx'

interface RadioCardProps<T extends string> {
  /** The radio group's `name`, shared by every card of one choice. */
  readonly name: string
  readonly value: T
  readonly checked: boolean
  readonly onSelect: (value: T) => void
  readonly title: string
  readonly hint: string
  readonly textTestId?: string
}

export default function RadioCard<T extends string>({
  name, value, checked, onSelect, title, hint, textTestId,
}: RadioCardProps<T>) {
  return (
    <label
      className={clsx(
        'flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer',
        checked ? 'border-accent bg-accent-subtle' : 'border-border hover:bg-bg-hover',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-0.5 accent-accent"
      />
      {/* min-w-0 + break-word: de "Verarbeitete Bewertungen neu kategorisieren" wraps at 390 px / 200 %. */}
      <span data-testid={textTestId} className="min-w-0 hyphens-auto [overflow-wrap:break-word]">
        <span className="block text-sm font-medium text-text-strong">{title}</span>
        <span className="block text-xs text-text">{hint}</span>
      </span>
    </label>
  )
}
