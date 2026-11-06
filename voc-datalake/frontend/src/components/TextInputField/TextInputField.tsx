/**
 * @fileoverview A labelled single-line text input (the login forms, the persona editor): the label
 * wired to the input by a generated id, the input reporting its new text. Every other input
 * attribute (type, placeholder, autoComplete, required, minLength) passes through.
 *
 * @module components/TextInputField
 */
import { useId } from 'react'
import type { InputHTMLAttributes } from 'react'

type PassThrough = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange' | 'className'>

export type TextInputFieldProps = Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
} & PassThrough>

export function TextInputField({ label, value, onChange, type = 'text', ...input }: TextInputFieldProps) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{label}</label>
      <input
        {...input}
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
      />
    </div>
  )
}
