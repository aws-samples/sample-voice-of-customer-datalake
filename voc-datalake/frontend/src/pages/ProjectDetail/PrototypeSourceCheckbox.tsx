/**
 * @fileoverview The tick-box row every "Also read (optional)" input of the prototype build
 * wizard uses (product description, research, visuals, design system).
 * @module pages/ProjectDetail/PrototypeSourceCheckbox
 */

import clsx from 'clsx'

/** One tick-box with a real label, so the whole row is a hit target and the
    accessible name comes from the label rather than from an aria-label. */
export function SourceCheckbox({
  label, checked, disabled, describedBy, onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly disabled?: boolean
  /** Id of the line that explains the row — required reading when it is disabled. */
  readonly describedBy?: string
  readonly onChange: (next: boolean) => void
}) {
  return (
    <label className={clsx(
      'flex items-center gap-2 text-xs',
      // gray-500, not gray-400: #6b7280 clears 4.5:1 on white where #9ca3af does
      // not, and the disabled rows are the ones a user most needs to read to
      // understand why they cannot tick them.
      disabled === true ? 'text-muted' : 'text-text',
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded-sm"
      />
      {/* `title` because of `truncate`, not for the accessible name — that already
          comes from the label. Report titles are user-supplied and this column is
          narrow, so two reports named "Churn interviews Q1" and "Churn interviews
          Q2" render as the same visible string; the tooltip is the only way to tell
          which box is which. Sighted mouse users are exactly who needs it: a screen
          reader reads the full label regardless of the CSS clip. */}
      <span className="truncate" title={label}>{label}</span>
    </label>
  )
}
