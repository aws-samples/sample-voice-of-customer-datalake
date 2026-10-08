/**
 * @fileoverview A labelled on/off switch (design system `switch`): a real
 * checkbox with `role="switch"` stays the accessible control; the spans are
 * its visual track and knob.
 *
 * @module components/SwitchField
 */
import clsx from 'clsx'

interface SwitchFieldProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

export default function SwitchField({ checked, onChange, label, hint, disabled = false }: Readonly<SwitchFieldProps>) {
  return (
    <label className="inline-flex cursor-pointer items-start gap-2 text-sm text-text">
      <span className="relative inline-flex items-center mt-0.5">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={clsx(
            'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
            checked && 'switch-on',
          )}
        >
          <span className="switch-knob" />
        </span>
      </span>
      <span>
        <span className="block">{label}</span>
        {hint !== undefined && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  )
}
