/** A labelled text field of a canvas popover, with its hint and its error (announced when it appears). */
import { useId } from 'react'

interface PopoverFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  /** The field's error, null while it has none. */
  readonly error: string | null
  readonly hint?: string
  readonly placeholder?: string
  readonly type?: 'text' | 'url'
}

export default function PopoverField({ label, value, onChange, error, hint, placeholder, type = 'text' }: PopoverFieldProps) {
  const id = useId()
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ')
  return (
    <div className="canvas-field">
      <label htmlFor={id} className="canvas-field__label">{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className="canvas-field__input"
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <p id={`${id}-hint`} className="canvas-field__hint">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="canvas-field__error">{error}</p>}
    </div>
  )
}
